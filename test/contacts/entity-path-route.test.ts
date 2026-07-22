import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { runMigrations } from '../../src/contacts/db/migrate';
import { signSession, getSessionKeyMaterial } from '../../src/contacts/web/session';

// Spec 50-console-v2/56 §4 — GET /app/entity/<id> (path param) resolve pro MESMO
// handleEntityDetail que GET /app/entity?id=. Sessão obrigatória (console
// standalone) — o regex é checado por ÚLTIMO entre as rotas /app/entity/* pra não
// engolir os paths exatos (events/event/update/channel_delete/neighbors).

const SESSION_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

async function sessionCookie(): Promise<string> {
  const token = await signSession('owner@example.com', await getSessionKeyMaterial(env as any), Math.floor(Date.now() / 1000));
  return `mv_session=${token}`;
}

async function seedEntity(name = 'Path Route'): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', ?, 'seed')`,
  ).bind(id, name).run();
  return id;
}

function get(path: string, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return SELF.fetch(`https://x${path}`, { headers, redirect: 'manual' });
}

// whatsapp_links (migration 0009) não está no espelho do setup compartilhado —
// mesmo caminho do whatsapp-groups.test.ts: migrations reais deste módulo.
beforeAll(async () => {
  await runMigrations(env as any);
});

describe('GET /app/entity/<id> — path param (spec 56 §4)', () => {
  it('resolve o mesmo detalhe que ?id= (mesmo payload)', async () => {
    const id = await seedEntity('Fulano Path');
    const cookie = await sessionCookie();

    const byPath = await get(`/app/entity/${id}`, cookie);
    const byQuery = await get(`/app/entity?id=${id}`, cookie);
    expect(byPath.status).toBe(200);
    expect(byQuery.status).toBe(200);
    const jPath: any = await byPath.json();
    const jQuery: any = await byQuery.json();
    expect(jPath).toEqual(jQuery);
  });

  it('id inexistente → 404', async () => {
    const cookie = await sessionCookie();
    const res = await get(`/app/entity/${crypto.randomUUID()}`, cookie);
    expect(res.status).toBe(404);
  });

  it('sem sessão → 302 (não vira rota pública)', async () => {
    const id = await seedEntity();
    const res = await get(`/app/entity/${id}`);
    expect(res.status).toBe(302);
  });

  it('attributes.shared_groups vira um field "Grupo em comum" por grupo (string legada sem href)', async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, source, attributes) VALUES (?, 'person', 'Fulano Grupos', 'seed', ?)`,
    ).bind(id, JSON.stringify({ shared_groups: ['Mentoria Master +1KK', 'ACE VEGAS'] })).run();
    const cookie = await sessionCookie();

    const res = await get(`/app/entity/${id}`, cookie);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    const fields = (j.fields ?? []).filter((f: any) => f.label === 'Grupo em comum');
    expect(fields.map((f: any) => f.value)).toEqual(['Mentoria Master +1KK', 'ACE VEGAS']);
    expect(fields.every((f: any) => !f.href)).toBe(true);
  });

  it('grupo com entidade no vault (whatsapp_links) sai clicável pra página do grupo', async () => {
    const personId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, source) VALUES (?, 'group', 'Equipe Expert Integrado', 'whatsapp')`,
    ).bind(groupId).run();
    await env.DB.prepare(
      `INSERT INTO whatsapp_links (chat_id, entity_id, synced_at) VALUES ('5511000-group', ?, datetime('now'))`,
    ).bind(groupId).run();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, source, attributes) VALUES (?, 'person', 'Fulano Linkado', 'seed', ?)`,
    ).bind(personId, JSON.stringify({
      shared_groups: [
        { chat_id: '5511000-group', name: 'Equipe Expert Integrado' },
        { chat_id: '5511999-group', name: 'Grupo Sem Entidade' },
      ],
    })).run();
    const cookie = await sessionCookie();

    const res = await get(`/app/entity/${personId}`, cookie);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    const fields = (j.fields ?? []).filter((f: any) => f.label === 'Grupo em comum');
    expect(fields).toHaveLength(2);
    const linked = fields.find((f: any) => f.value === 'Equipe Expert Integrado');
    expect(linked?.href).toContain(`/app/contacts/${groupId}`);
    const semEntidade = fields.find((f: any) => f.value === 'Grupo Sem Entidade');
    expect(semEntidade?.href).toBeUndefined();
  });

  it('attributes de perfil (cidade/familia/interesses) viram fields do dossiê', async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, source, attributes) VALUES (?, 'person', 'Fulano Perfil', 'seed', ?)`,
    ).bind(id, JSON.stringify({
      cidade: 'Cotia-SP',
      familia: 'casado, 2 filhos',
      interesses: ['guitarra', 'vela'],
      relacao_sugerida: 'parceiro',
    })).run();
    const cookie = await sessionCookie();

    const res = await get(`/app/entity/${id}`, cookie);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    const byLabel = (l: string) => (j.fields ?? []).find((f: any) => f.label === l)?.value;
    expect(byLabel('Cidade')).toBe('Cotia-SP');
    expect(byLabel('Família')).toBe('casado, 2 filhos');
    expect(byLabel('Interesses')).toBe('guitarra, vela');
    // relacao_sugerida é dado interno de curadoria — NÃO vira field
    expect((j.fields ?? []).some((f: any) => /sugerida/i.test(f.label))).toBe(false);
  });

  it('attributes com JSON inválido não derruba o dossiê (field ausente)', async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, source, attributes) VALUES (?, 'person', 'Fulano Attr Quebrado', 'seed', '{nao-e-json')`,
    ).bind(id).run();
    const cookie = await sessionCookie();

    const res = await get(`/app/entity/${id}`, cookie);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect((j.fields ?? []).some((f: any) => f.label === 'Grupos em comum')).toBe(false);
  });

  it('não engole os paths exatos /app/entity/events e /app/entity/neighbors', async () => {
    const cookie = await sessionCookie();
    // sem id= na querystring — se o regex tivesse capturado "events"/"neighbors"
    // como id, cairia no handleEntityDetail (400 id_required não bateria; aqui
    // confirmamos que o handler CERTO respondeu: ambos exigem ?id= e devolvem
    // 400 (não 404 de vault/entidade, que seria a assinatura do detail errado).
    const resEvents = await get('/app/entity/events', cookie);
    expect(resEvents.status).toBe(400);
    const resNeighbors = await get('/app/entity/neighbors', cookie);
    expect(resNeighbors.status).toBe(400);
  });
});
