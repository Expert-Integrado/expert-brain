import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { embeddingTextFor, observationsTextFor, eventKindReembeds } from '../../src/contacts/embedding';
import { contactsAdapter } from '../../src/contacts/vaults/contacts';

// Spec 50-console-v2/60 — observações (events kind='note') alimentam o embedding e
// a busca textual (EXISTS em events.context). VECTORIZE/AI NÃO têm binding no harness
// (vitest.config.ts os omite de propósito) — então o upsert real do vetor e o recall
// semântico não são exercitados aqui; testamos as PEÇAS puras/D1 que o compõem:
// composição do texto, montagem do bloco de observações, predicado de reembed por
// kind e o EXISTS nas duas buscas SQL (REST + console). Mesma fronteira dos testes
// de embedding já existentes (vector-metadata.test.ts, save-entity.test.ts).

const OWNER = 'test-owner-token';
const get = (path: string) =>
  SELF.fetch(`https://x${path}`, { headers: { authorization: `Bearer ${OWNER}` } });
const post = (path: string, body: unknown) =>
  SELF.fetch(`https://x${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const seedEntity = async (id: string, extra: Record<string, string> = {}) => {
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, role, company, sector, notes_text, source)
     VALUES (?, 'person', ?, ?, ?, ?, ?, 'test')`,
  )
    .bind(
      id,
      extra.name ?? `Contato ${id.slice(0, 6)}`,
      extra.role ?? null,
      extra.company ?? null,
      extra.sector ?? null,
      extra.notes_text ?? null,
    )
    .run();
};

const seedEvent = async (entityId: string, kind: string, context: string | null, ts?: string) => {
  await env.DB.prepare(
    `INSERT INTO events (id, entity_id, kind, ts, context, source)
     VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, 'manual')`,
  )
    .bind(crypto.randomUUID(), entityId, kind, ts ?? null, context)
    .run();
};

// ---------------------------------------------------------------------------
// §1 — composição do texto de embedding (função pura)
// ---------------------------------------------------------------------------
describe('embeddingTextFor — observações + teto (spec 60 §1; nome FORA do vetor desde 10/07/2026)', () => {
  const identity = { name: 'Ana', role: 'dev', company: 'Acme', sector: 'TI', website: null as string | null, notes_text: 'nota durável' };
  const base = [identity.role, identity.company, identity.sector, identity.website, identity.notes_text]
    .filter(Boolean)
    .join(' — ')
    .slice(0, 1500);

  it('nome NÃO entra no texto de embedding (similares por grafia de nome eram ruído)', () => {
    expect(embeddingTextFor(identity)).toBe(base);
    expect(embeddingTextFor(identity)).not.toContain('Ana');
    // observations undefined ou null são equivalentes
    expect(embeddingTextFor({ ...identity, observations: null })).toBe(base);
  });

  it('entidade só-nome → texto VAZIO (sem substância = sem vetor)', () => {
    expect(embeddingTextFor({ name: 'Cíntia' })).toBe('');
    expect(embeddingTextFor({ name: '5511987654321' })).toBe('');
  });

  it('só-nome COM observações → só o bloco de observações', () => {
    const out = embeddingTextFor({ name: 'Cíntia', observations: 'arquiteta, projeto da casa' });
    expect(out).toBe('Observações: arquiteta, projeto da casa');
  });

  it('com observações → anexa bloco "Observações:" após a identidade', () => {
    const out = embeddingTextFor({ ...identity, observations: 'obs1 · obs2' });
    expect(out).toBe(`${base}\nObservações: obs1 · obs2`);
    expect(out.startsWith(base)).toBe(true);
  });

  it('bloco de identidade continua truncado em 1500 (sem observações)', () => {
    const out = embeddingTextFor({ notes_text: 'A'.repeat(2000) });
    expect(out.length).toBe(1500);
    expect(out).toBe('A'.repeat(1500));
  });

  it('teto TOTAL de 3000 chars respeitado (identidade + observações)', () => {
    const out = embeddingTextFor({ notes_text: 'A'.repeat(2000), observations: 'B'.repeat(4000) });
    expect(out.length).toBe(3000);
    // primeiros 1500 são a identidade truncada; o resto é o começo do bloco de obs
    expect(out.startsWith('A'.repeat(1500))).toBe(true);
    expect(out).toContain('Observações:');
  });
});

// ---------------------------------------------------------------------------
// §1 — observationsTextFor: monta o bloco a partir de events kind='note' (D1)
// ---------------------------------------------------------------------------
describe('observationsTextFor — bloco de observações do D1 (spec 60 §1)', () => {
  it('null quando a entidade não tem event kind=note', async () => {
    const id = crypto.randomUUID();
    await seedEntity(id);
    await seedEvent(id, 'talked', 'conversamos por telefone'); // não-note
    expect(await observationsTextFor(env, id)).toBeNull();
  });

  it('junta os contexts das notes, mais RECENTES primeiro, por " · "', async () => {
    const id = crypto.randomUUID();
    await seedEntity(id);
    await seedEvent(id, 'note', 'alpha', '2026-01-01 10:00:00');
    await seedEvent(id, 'note', 'beta', '2026-02-01 10:00:00');
    await seedEvent(id, 'note', 'gamma', '2026-03-01 10:00:00');
    expect(await observationsTextFor(env, id)).toBe('gamma · beta · alpha');
  });

  it('trunca cada context em 280 chars', async () => {
    const id = crypto.randomUUID();
    await seedEntity(id);
    await seedEvent(id, 'note', 'x'.repeat(400));
    const out = await observationsTextFor(env, id);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(280);
  });

  it('limita a 10 observações (11 inseridas → 10, exclui a mais antiga)', async () => {
    const id = crypto.randomUUID();
    await seedEntity(id);
    for (let i = 1; i <= 11; i++) {
      const n = String(i).padStart(2, '0'); // obs01..obs11
      await seedEvent(id, 'note', `obs${n}`, `2026-01-${n} 10:00:00`);
    }
    const out = await observationsTextFor(env, id);
    expect(out).not.toBeNull();
    const parts = out!.split(' · ');
    expect(parts.length).toBe(10);
    expect(out).toContain('obs11'); // mais recente entra
    expect(out).not.toContain('obs01'); // mais antiga fica de fora
  });

  it('ignora contexts nulos/vazios e kinds ≠ note', async () => {
    const id = crypto.randomUUID();
    await seedEntity(id);
    await seedEvent(id, 'note', null);
    await seedEvent(id, 'note', '   ');
    await seedEvent(id, 'talked', 'ruido de interacao');
    await seedEvent(id, 'note', 'observacao real');
    expect(await observationsTextFor(env, id)).toBe('observacao real');
  });

  it('não vaza observação de outra entidade', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await seedEntity(a);
    await seedEntity(b);
    await seedEvent(b, 'note', 'pertence ao B');
    expect(await observationsTextFor(env, a)).toBeNull();
    expect(await observationsTextFor(env, b)).toBe('pertence ao B');
  });
});

// ---------------------------------------------------------------------------
// §2 — gatilho de reembed por kind (predicado puro + regressão do /event)
// ---------------------------------------------------------------------------
describe('eventKindReembeds — só note reembeda (spec 60 §2)', () => {
  it('note → true', () => {
    expect(eventKindReembeds('note')).toBe(true);
  });

  it('demais kinds de interação → false', () => {
    for (const k of ['met', 'talked', 'saw_post', 'recommended', 'birthday_reminder', 'mentioned_in_brain', 'meeting']) {
      expect(eventKindReembeds(k)).toBe(false);
    }
  });
});

describe('/event com note não quebra o registro (spec 60 §2)', () => {
  // Sem VECTORIZE o reembed é no-op ("skipped"); o registro deve seguir 200.
  it('POST /event kind=note → 200 e evento persistido', async () => {
    const id = crypto.randomUUID();
    await seedEntity(id);
    const res = await post('/event', { entity_id: id, kind: 'note', context: 'observacao via rota' });
    expect(res.status).toBe(200);
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) c FROM events WHERE entity_id = ? AND kind = 'note'",
    ).bind(id).first<{ c: number }>();
    expect(cnt?.c).toBe(1);
  });

  it('POST /event kind=talked → 200 (não reembeda, mas registra)', async () => {
    const id = crypto.randomUUID();
    await seedEntity(id);
    const res = await post('/event', { entity_id: id, kind: 'talked', context: 'call rápida' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §4 — busca textual alcança events.context (EXISTS) em REST e console
// ---------------------------------------------------------------------------
describe('busca textual encontra por observação (spec 60 §4)', () => {
  const TOKEN = 'zztokenobs123'; // só existe na observação, em nenhum campo de entidade

  it('REST /recall_entity acha entidade por termo presente só em events.context', async () => {
    const id = crypto.randomUUID();
    await seedEntity(id, { name: 'Contato Observado', role: 'consultor', company: 'Firma X' });
    await seedEvent(id, 'note', `especialista em ${TOKEN} publica`);

    const j: any = await (await get(`/recall_entity?q=${TOKEN}`)).json();
    expect(j.ok).toBe(true);
    expect(j.results.some((r: any) => r.id === id)).toBe(true);
  });

  it('console (contactsAdapter.fetchGraph) acha a mesma entidade por observação', async () => {
    const id = crypto.randomUUID();
    await seedEntity(id, { name: 'Contato Console', role: 'analista' });
    await seedEvent(id, 'note', `atua com ${TOKEN} na prefeitura`);

    const payload = await contactsAdapter.fetchGraph(env, { q: TOKEN });
    expect(payload.nodes.some((n) => n.id === id)).toBe(true);
  });

  it('termo inexistente não traz a entidade (controle)', async () => {
    const id = crypto.randomUUID();
    await seedEntity(id, { name: 'Contato Neutro' });
    await seedEvent(id, 'note', `menciona ${TOKEN}`);
    const j: any = await (await get('/recall_entity?q=zztokennaoexiste999')).json();
    expect(j.results.some((r: any) => r.id === id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §1/§3 — composição usada pelo handleReembedAll (2 fixtures, uma com observações)
// ---------------------------------------------------------------------------
describe('composição do reembed em massa — 2 fixtures (spec 60 §3)', () => {
  it('entidade COM observações compõe "Observações:"; SEM observações fica idêntica à identidade', async () => {
    const withObs = crypto.randomUUID();
    const withoutObs = crypto.randomUUID();
    await seedEntity(withObs, { name: 'Com Obs', role: 'perito' });
    await seedEntity(withoutObs, { name: 'Sem Obs', role: 'perito' });
    await seedEvent(withObs, 'note', 'obsone', '2026-01-01 10:00:00');
    await seedEvent(withObs, 'note', 'obstwo', '2026-02-01 10:00:00');

    // Mesmo caminho de handleReembedAll: observationsTextFor + embeddingTextFor (fonte única).
    const rowWith = await env.DB.prepare(
      'SELECT name, role, company, sector, website, notes_text FROM entities WHERE id = ?',
    ).bind(withObs).first<any>();
    const rowWithout = await env.DB.prepare(
      'SELECT name, role, company, sector, website, notes_text FROM entities WHERE id = ?',
    ).bind(withoutObs).first<any>();

    const obsWith = await observationsTextFor(env, withObs);
    const obsWithout = await observationsTextFor(env, withoutObs);
    expect(obsWith).toBe('obstwo · obsone');
    expect(obsWithout).toBeNull();

    const textWith = embeddingTextFor({ ...rowWith, observations: obsWith });
    const textWithout = embeddingTextFor({ ...rowWithout, observations: obsWithout });
    expect(textWith).toContain('Observações: obstwo · obsone');
    expect(textWithout).not.toContain('Observações:');
    // sem observações a composição é a identidade SEM nome (nome fora do vetor)
    expect(textWithout).toBe(
      [rowWithout.role, rowWithout.company, rowWithout.sector, rowWithout.website, rowWithout.notes_text]
        .filter(Boolean)
        .join(' — ')
        .slice(0, 1500),
    );
    expect(textWithout).not.toContain(rowWithout.name);
  });
});
