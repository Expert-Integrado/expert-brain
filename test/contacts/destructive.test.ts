import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

// Spec 30-features/34 — DELETE de entidade/connection e merge de duplicatas.
// Delete é HARD (decisão registrada na spec): confirm obrigatório, só OWNER_TOKEN,
// cascade D1 + limpeza de vetor + refcount de blob R2.

const E = env as any;
const OWNER = { authorization: 'Bearer test-owner-token' };
const PROXY = { authorization: 'Bearer test-proxy-token' };

const api = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { ...init, headers: { ...OWNER, 'content-type': 'application/json', ...(init.headers as any) } });

async function seedEntity(fields: Record<string, any> = {}): Promise<string> {
  const id = crypto.randomUUID();
  const cols = { kind: 'person', name: `Teste ${id.slice(0, 8)}`, source: 'seed', ...fields };
  const names = Object.keys(cols);
  await E.DB.prepare(
    `INSERT INTO entities (id, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})`
  ).bind(id, ...names.map((n) => cols[n])).run();
  return id;
}

async function seedConnection(a: string, b: string, type = 'knows'): Promise<string> {
  const id = crypto.randomUUID();
  await E.DB.prepare(
    `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, ?, 0.5, 'seed de teste com why longo o bastante')`
  ).bind(id, a, b, type).run();
  return id;
}

async function seedEvent(entityId: string, kind = 'note'): Promise<string> {
  const id = crypto.randomUUID();
  await E.DB.prepare(
    `INSERT INTO events (id, entity_id, kind, context, source) VALUES (?, ?, ?, 'ctx', 'manual')`
  ).bind(id, entityId, kind).run();
  return id;
}

async function seedMedia(entityId: string, hash: string): Promise<void> {
  const key = `sha256/${hash}.png`;
  await E.MEDIA.put(key, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/png' } });
  await E.DB.prepare(
    `INSERT INTO media (id, entity_id, kind, r2_key, content_hash, mime_type) VALUES (?, ?, 'avatar', ?, ?, 'image/png')`
  ).bind(crypto.randomUUID(), entityId, key, hash).run();
}

async function seedChannel(entityId: string, kind: string, value: string): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO entity_channels (id, entity_id, kind, value) VALUES (?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), entityId, kind, value).run();
}

const count = async (sql: string, ...binds: any[]) =>
  ((await E.DB.prepare(sql).bind(...binds).first()) as any)?.n ?? 0;

describe('DELETE /entities/:id (spec 34)', () => {
  it('sem confirm=true => 400 e nada deletado', async () => {
    const id = await seedEntity();
    const res = await api(`/entities/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(await count('SELECT COUNT(*) n FROM entities WHERE id = ?', id)).toBe(1);
  });

  it('com confirm => remove entidade + cascade e reporta contadores', async () => {
    const id = await seedEntity();
    const other = await seedEntity();
    await seedConnection(id, other);
    await seedEvent(id);
    await seedChannel(id, 'email', 'a@b.c');
    const res = await api(`/entities/${id}?confirm=true`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    expect(j.cascade).toMatchObject({ connections: 1, events: 1, channels: 1 });
    expect(await count('SELECT COUNT(*) n FROM entities WHERE id = ?', id)).toBe(0);
    expect(await count('SELECT COUNT(*) n FROM connections WHERE a_id = ? OR b_id = ?', id, id)).toBe(0);
    expect(await count('SELECT COUNT(*) n FROM events WHERE entity_id = ?', id)).toBe(0);
    expect(await count('SELECT COUNT(*) n FROM entity_channels WHERE entity_id = ?', id)).toBe(0);
    // a outra entidade fica intacta
    expect(await count('SELECT COUNT(*) n FROM entities WHERE id = ?', other)).toBe(1);
  });

  it('blob R2 compartilhado sobrevive; some quando o refcount zera', async () => {
    const hash = 'c'.repeat(64);
    const key = `sha256/${hash}.png`;
    const a = await seedEntity();
    const b = await seedEntity();
    await seedMedia(a, hash);
    await seedMedia(b, hash);

    const res1 = await api(`/entities/${a}?confirm=true`, { method: 'DELETE' });
    expect(((await res1.json()) as any).r2_blobs_deleted).toBe(0);
    expect(await E.MEDIA.get(key)).not.toBeNull();

    const res2 = await api(`/entities/${b}?confirm=true`, { method: 'DELETE' });
    expect(((await res2.json()) as any).r2_blobs_deleted).toBe(1);
    expect(await E.MEDIA.get(key)).toBeNull();
  });

  it('CONTACTS_PROXY_TOKEN (read-only) => 401', async () => {
    const id = await seedEntity();
    const res = await SELF.fetch(`https://x/entities/${id}?confirm=true`, { method: 'DELETE', headers: PROXY });
    expect(res.status).toBe(401);
    expect(await count('SELECT COUNT(*) n FROM entities WHERE id = ?', id)).toBe(1);
  });

  it('id inexistente => 404', async () => {
    const res = await api(`/entities/${crypto.randomUUID()}?confirm=true`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /connections/:id (spec 34)', () => {
  it('remove só a aresta; entidades intactas; confirm obrigatório', async () => {
    const a = await seedEntity();
    const b = await seedEntity();
    const cid = await seedConnection(a, b);

    expect((await api(`/connections/${cid}`, { method: 'DELETE' })).status).toBe(400);

    const res = await api(`/connections/${cid}?confirm=true`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await count('SELECT COUNT(*) n FROM connections WHERE id = ?', cid)).toBe(0);
    expect(await count('SELECT COUNT(*) n FROM entities WHERE id IN (?, ?)', a, b)).toBe(2);
  });
});

describe('POST /entities/merge (spec 34)', () => {
  const merge = (body: any) => api('/entities/merge', { method: 'POST', body: JSON.stringify(body) });

  it('validações: confirm, ids iguais, kind diferente, inexistente', async () => {
    const p = await seedEntity();
    const c = await seedEntity({ kind: 'company' });
    expect((await merge({ winner_id: p, loser_id: c })).status).toBe(400); // sem confirm
    expect((await merge({ winner_id: p, loser_id: p, confirm: true })).status).toBe(400);
    expect((await merge({ winner_id: p, loser_id: c, confirm: true })).status).toBe(400); // kinds
    expect((await merge({ winner_id: p, loser_id: crypto.randomUUID(), confirm: true })).status).toBe(404);
  });

  it('move connections com dedupe UNIQUE e descarta self-loop', async () => {
    const winner = await seedEntity();
    const loser = await seedEntity();
    const x = await seedEntity();
    const y = await seedEntity();
    await seedConnection(winner, x, 'knows'); // já existe no winner
    await seedConnection(loser, x, 'knows'); // duplicata → deduped
    await seedConnection(loser, y, 'knows'); // move
    await seedConnection(winner, loser, 'knows'); // self-loop → dropped

    const res = await merge({ winner_id: winner, loser_id: loser, confirm: true });
    expect(res.status).toBe(200);
    const { report }: any = await res.json();
    expect(report.connections_moved).toBe(1);
    expect(report.connections_deduped).toBe(1);
    expect(report.connections_dropped_selfloop).toBe(1);
    expect(await count('SELECT COUNT(*) n FROM connections WHERE a_id = ? OR b_id = ?', winner, winner)).toBe(2); // x + y
    expect(await count('SELECT COUNT(*) n FROM entities WHERE id = ?', loser)).toBe(0);
  });

  it('move events/media/channels, preenche campos vazios, name intocado, event merged_from', async () => {
    const winner = await seedEntity({ name: 'Nome Bom', email: 'bom@x.com' });
    const loser = await seedEntity({ name: 'Nome Ruim', phone: '5511999990000', email: 'ruim@x.com', company: 'ACME' });
    await seedEvent(loser);
    await seedMedia(loser, 'd'.repeat(64));
    await seedChannel(loser, 'instagram', '@fulano');

    const res = await merge({ winner_id: winner, loser_id: loser, confirm: true });
    expect(res.status).toBe(200);
    const { report }: any = await res.json();
    expect(report.events_moved).toBe(1);
    expect(report.media_moved).toBe(1);
    expect(report.channels_moved).toBe(1);
    expect(report.fields_filled).toContain('phone');
    expect(report.fields_filled).toContain('company');
    expect(report.fields_filled).not.toContain('email'); // winner já tinha

    const w: any = await E.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(winner).first();
    expect(w.name).toBe('Nome Bom');
    expect(w.email).toBe('bom@x.com'); // nunca sobrescrito
    expect(w.phone).toBe('5511999990000');
    expect(w.company).toBe('ACME');

    expect(await count('SELECT COUNT(*) n FROM events WHERE entity_id = ? AND kind = ?', winner, 'merged_from')).toBe(1);
    expect(await count('SELECT COUNT(*) n FROM entity_channels WHERE entity_id = ?', winner)).toBe(1);
    expect(await count('SELECT COUNT(*) n FROM entities WHERE id = ?', loser)).toBe(0);
  });

  it('canal duplicado (UNIQUE entity/kind/value) morre com o loser, sem erro', async () => {
    const winner = await seedEntity();
    const loser = await seedEntity();
    await seedChannel(winner, 'email', 'mesmo@x.com');
    await seedChannel(loser, 'email', 'mesmo@x.com');
    const res = await merge({ winner_id: winner, loser_id: loser, confirm: true });
    expect(res.status).toBe(200);
    expect(await count('SELECT COUNT(*) n FROM entity_channels WHERE kind = ? AND value = ?', 'email', 'mesmo@x.com')).toBe(1);
  });
});
