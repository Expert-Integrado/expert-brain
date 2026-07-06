import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import * as queries from '../../src/db/queries.js';
import {
  buildResurfaceDigest,
  getResurfaceDigest,
  getResurfaceDigestScoped,
  pickWeeklyCentralNotes,
  isDigestEmpty,
  RESURFACE_DIGEST_META_KEY,
  RESURFACE_TTL_MS,
  DAY_MS,
} from '../../src/digest/resurface.js';

// Resurfacing digest (specs/50-console-v2/64-resurfacing-digest.md).

const E = env as any;
const NOW = 1_760_000_000_000; // "agora" fixo (Date.now() não é permitido no runner)

async function resetDb(): Promise<void> {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM inbox_items');
  await E.DB.exec('DELETE FROM edges');
  await E.DB.exec('DELETE FROM tags');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.prepare(`DELETE FROM meta WHERE key = ?`).bind(RESURFACE_DIGEST_META_KEY).run();
}

async function insertNote(id: string, opts: {
  kind?: string | null; updatedAt: number; title?: string; private?: 0 | 1;
}): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,private,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, opts.title ?? id, 'corpo', 'tldr ' + id, '["operations"]',
    opts.kind ?? 'concept', opts.private ?? 0, opts.updatedAt, opts.updatedAt
  ).run();
}

async function insertEdge(id: string, fromId: string, toId: string): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO edges (id,from_id,to_id,relation_type,why,created_at) VALUES (?,?,?,?,?,?)`
  ).bind(id, fromId, toId, 'depends_on', 'mecanismo compartilhado explicado aqui', NOW).run();
}

async function insertInboxItem(id: string, createdAt: number): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO inbox_items (id, body, source, created_at) VALUES (?, ?, ?, ?)`
  ).bind(id, 'rascunho ' + id, 'mcp', createdAt).run();
}

function mockContacts(results: any[], opts: { ok?: boolean; throws?: boolean } = {}) {
  return {
    fetch: async (_req: Request) => {
      if (opts.throws) throw new Error('contacts binding down');
      if (opts.ok === false) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify({ ok: true, count: results.length, results }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

beforeEach(async () => {
  await resetDb();
  E.WORKER_URL = 'https://brain.test';
  E.CONTACTS_PROXY_TOKEN = 'proxy-tok';
  E.CONTACTS = undefined;
});

describe('buildResurfaceDigest — 4 seções (critério 1)', () => {
  it('pergunta velha aparece / recente não', async () => {
    await insertNote('q_old', { kind: 'question', updatedAt: NOW - 40 * DAY_MS, title: 'Pergunta velha' });
    await insertNote('q_old2', { kind: 'question', updatedAt: NOW - 35 * DAY_MS, title: 'Pergunta menos velha' });
    await insertNote('q_new', { kind: 'question', updatedAt: NOW - 2 * DAY_MS, title: 'Pergunta recente' });

    const digest = await buildResurfaceDigest(E, { now: NOW, includePrivate: true });

    const ids = digest.open_questions.map((q) => q.id);
    expect(ids).toEqual(['q_old', 'q_old2']); // mais velha primeiro, recente de fora
    expect(digest.open_questions[0].url).toBe('https://brain.test/app/notes/q_old');
    expect(digest.open_questions[0].age_days).toBeGreaterThanOrEqual(40);
  });

  it('nota de grau alto e fria aparece / quente e sem grau não', async () => {
    // central1: 3 edges, parada há 95 dias — deve aparecer. As pontas (leaf*) ficam
    // RECENTES de propósito: elas contribuem grau pra central1 (o degree soma edges
    // nos dois sentidos), mas por terem updated_at recente não viram elas mesmas
    // candidatas a "nota central" — mantém o pool de candidatas em 1 item, isolando
    // o critério sob teste (o sorteio semanal entre um pool >1 é testado à parte).
    await insertNote('central1', { updatedAt: NOW - 95 * DAY_MS, title: 'Nota Central' });
    await insertNote('leaf1', { updatedAt: NOW - 1 * DAY_MS });
    await insertNote('leaf2', { updatedAt: NOW - 1 * DAY_MS });
    await insertNote('leaf3', { updatedAt: NOW - 1 * DAY_MS });
    await insertEdge('e1', 'central1', 'leaf1');
    await insertEdge('e2', 'central1', 'leaf2');
    await insertEdge('e3', 'leaf3', 'central1');

    // fresh_central: mesmo grau, mas atualizada há 5 dias — NÃO deve aparecer (não esfriou).
    await insertNote('fresh_central', { updatedAt: NOW - 5 * DAY_MS, title: 'Nota Quente' });
    await insertEdge('e4', 'fresh_central', 'leaf1');
    await insertEdge('e5', 'fresh_central', 'leaf2');

    // stale_lonely: parada há 95 dias mas SEM edges — não é "central".
    await insertNote('stale_lonely', { updatedAt: NOW - 95 * DAY_MS, title: 'Solitária' });

    const digest = await buildResurfaceDigest(E, { now: NOW, includePrivate: true });

    const ids = digest.stale_central_notes.map((n) => n.id);
    expect(ids).toEqual(['central1']);
    expect(digest.stale_central_notes[0].degree).toBe(3);
  });

  it('contato com last_contacted antigo aparece; recente e sem categoria não', async () => {
    E.CONTACTS = mockContacts([
      { id: 'c_old', name: 'Contato Antigo', category: 'cliente', last_contacted: '2020-01-01 10:00:00' },
      { id: 'c_new', name: 'Contato Recente', category: 'lead', last_contacted: new Date(NOW - 5 * DAY_MS).toISOString() },
      { id: 'c_no_cat', name: 'Sem Categoria', category: null, last_contacted: '2020-01-01 10:00:00' },
    ]);

    const digest = await buildResurfaceDigest(E, { now: NOW, includePrivate: true });

    expect(digest.contacts_degraded).toBe(false);
    const ids = digest.cooling_contacts.map((c) => c.id);
    expect(ids).toEqual(['c_old']);
    expect(digest.cooling_contacts[0].url).toBe('https://brain.test/app/contacts/c_old');
  });

  it('inbox >7d conta; pendente recente não', async () => {
    await insertInboxItem('ibx_old', NOW - 10 * DAY_MS);
    await insertInboxItem('ibx_new', NOW - 2 * DAY_MS);

    const digest = await buildResurfaceDigest(E, { now: NOW, includePrivate: true });

    expect(digest.inbox_pending_over_7d).toBe(1);
    expect(digest.inbox_url).toBe('https://brain.test/app/inbox');
  });

  it('digest totalmente vazio → isDigestEmpty true', async () => {
    const digest = await buildResurfaceDigest(E, { now: NOW, includePrivate: true });
    expect(isDigestEmpty(digest)).toBe(true);
  });
});

describe('sorteio semanal determinístico (critério 2)', () => {
  const pool = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, degree: 10 - i }));

  it('mesma semana → mesma seleção', () => {
    const a = pickWeeklyCentralNotes(pool, NOW, 2);
    const b = pickWeeklyCentralNotes(pool, NOW + 60_000, 2); // minutos depois, mesma semana
    expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id));
    expect(a).toHaveLength(2);
  });

  it('semana seguinte → pode variar (não travado no mesmo par pra sempre)', () => {
    const baseline = pickWeeklyCentralNotes(pool, NOW, 2).map((n) => n.id).join(',');
    const laterWeeks = Array.from({ length: 12 }, (_, w) =>
      pickWeeklyCentralNotes(pool, NOW + (w + 1) * 7 * DAY_MS, 2).map((n) => n.id).join(',')
    );
    expect(laterWeeks.some((sel) => sel !== baseline)).toBe(true);
  });

  it('pool menor ou igual ao cap: devolve o pool inteiro sem sortear', () => {
    const small = pool.slice(0, 2);
    expect(pickWeeklyCentralNotes(small, NOW, 2).map((n) => n.id)).toEqual(['n0', 'n1']);
  });
});

describe('falha do proxy CONTACTS não derruba o digest (critério 6)', () => {
  it('binding/token ausentes → degraded, resto do digest intacto', async () => {
    await insertNote('q_old', { kind: 'question', updatedAt: NOW - 40 * DAY_MS });
    const digest = await buildResurfaceDigest(E, { now: NOW, includePrivate: true });
    expect(digest.contacts_degraded).toBe(true);
    expect(digest.cooling_contacts).toEqual([]);
    expect(digest.open_questions).toHaveLength(1); // seção independente segue funcionando
  });

  it('fetch lança exceção → degraded (não propaga o erro)', async () => {
    E.CONTACTS = mockContacts([], { throws: true });
    const digest = await buildResurfaceDigest(E, { now: NOW, includePrivate: true });
    expect(digest.contacts_degraded).toBe(true);
    expect(digest.cooling_contacts).toEqual([]);
  });

  it('proxy responde não-ok → degraded', async () => {
    E.CONTACTS = mockContacts([], { ok: false });
    const digest = await buildResurfaceDigest(E, { now: NOW, includePrivate: true });
    expect(digest.contacts_degraded).toBe(true);
  });
});

describe('cache em meta com TTL 20h (critério 4)', () => {
  it('segunda chamada no mesmo dia não recomputa (spy nas queries)', async () => {
    await insertNote('q_old', { kind: 'question', updatedAt: NOW - 40 * DAY_MS });
    const spy = vi.spyOn(queries, 'getStaleOpenQuestions');

    const first = await getResurfaceDigest(E, NOW);
    expect(spy).toHaveBeenCalledTimes(1);

    const second = await getResurfaceDigest(E, NOW + 60_000); // minutos depois, dentro do TTL
    expect(spy).toHaveBeenCalledTimes(1); // NÃO recomputou
    expect(second).toEqual(first);

    spy.mockRestore();
  });

  it('cache vencido (>20h) recomputa', async () => {
    await insertNote('q_old', { kind: 'question', updatedAt: NOW - 40 * DAY_MS });
    const spy = vi.spyOn(queries, 'getStaleOpenQuestions');

    await getResurfaceDigest(E, NOW);
    expect(spy).toHaveBeenCalledTimes(1);

    await getResurfaceDigest(E, NOW + RESURFACE_TTL_MS + 1);
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });

  it('a linha gravada na meta usa a chave resurface_digest', async () => {
    await getResurfaceDigest(E, NOW);
    const row = await E.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(RESURFACE_DIGEST_META_KEY).first();
    expect(row).not.toBeNull();
    const parsed = JSON.parse(row.value);
    expect(parsed.version).toBe(1);
  });

  it('escopo restrito (PAT full sem private) nunca lê nem grava o cache do dono', async () => {
    await insertNote('q_priv', { kind: 'question', updatedAt: NOW - 40 * DAY_MS, private: 1 });
    const scoped = await getResurfaceDigestScoped(E, NOW, false);
    expect(scoped.open_questions).toEqual([]); // nota privada não vaza pro caller sem escopo

    const row = await E.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(RESURFACE_DIGEST_META_KEY).first();
    expect(row).toBeNull(); // não escreveu o cache do dono

    const ownerView = await getResurfaceDigestScoped(E, NOW, true);
    expect(ownerView.open_questions.map((q) => q.id)).toEqual(['q_priv']); // dono vê
  });
});
