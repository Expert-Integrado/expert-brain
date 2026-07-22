import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';

// handleConnect — validações (self-loop, tipo, strength range, why>=20).

const OWNER = 'test-owner-token';
const authHeaders = { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' };

function post(path: string, body: unknown) {
  return SELF.fetch(`https://x${path}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body),
  });
}

let idA = '';
let idB = '';

beforeAll(async () => {
  idA = crypto.randomUUID();
  idB = crypto.randomUUID();
  for (const [id, name] of [[idA, 'Conn A'], [idB, 'Conn B']] as const) {
    await env.DB.prepare(
      `INSERT INTO entities (id, kind, name, source) VALUES (?, 'person', ?, 'test')`
    ).bind(id, name).run();
  }
});

const VALID_WHY = 'ambos fundadores da mesma cohort do G4 em 2024';

describe('handleConnect', () => {
  it('self-loop (a_id === b_id) => 400', async () => {
    const res = await post('/connect', { a_id: idA, b_id: idA, type: 'friend', strength: 0.5, why: VALID_WHY });
    expect(res.status).toBe(400);
  });

  it('a_id/b_id ausentes => 400', async () => {
    const res = await post('/connect', { type: 'friend', strength: 0.5, why: VALID_WHY });
    expect(res.status).toBe(400);
  });

  it('type ausente => 400', async () => {
    const res = await post('/connect', { a_id: idA, b_id: idB, strength: 0.5, why: VALID_WHY });
    expect(res.status).toBe(400);
  });

  it('type inválido => 400 com allowed', async () => {
    const res = await post('/connect', { a_id: idA, b_id: idB, type: 'banana', strength: 0.5, why: VALID_WHY });
    expect(res.status).toBe(400);
    const j: any = await res.json();
    expect(Array.isArray(j.detail?.allowed)).toBe(true);
  });

  it('strength fora do range [0,1] => 400', async () => {
    expect((await post('/connect', { a_id: idA, b_id: idB, type: 'friend', strength: 1.5, why: VALID_WHY })).status).toBe(400);
    expect((await post('/connect', { a_id: idA, b_id: idB, type: 'friend', strength: -0.1, why: VALID_WHY })).status).toBe(400);
  });

  it('strength não-numérico => 400', async () => {
    const res = await post('/connect', { a_id: idA, b_id: idB, type: 'friend', why: VALID_WHY });
    expect(res.status).toBe(400);
  });

  it('why < 20 chars => 400', async () => {
    const res = await post('/connect', { a_id: idA, b_id: idB, type: 'friend', strength: 0.5, why: 'curto' });
    expect(res.status).toBe(400);
  });

  it('entidade inexistente => 404', async () => {
    const res = await post('/connect', { a_id: idA, b_id: crypto.randomUUID(), type: 'friend', strength: 0.5, why: VALID_WHY });
    expect(res.status).toBe(404);
  });

  it('conexão válida => 200', async () => {
    const res = await post('/connect', { a_id: idA, b_id: idB, type: 'friend', strength: 0.7, why: VALID_WHY });
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.ok).toBe(true);
    // 'friend' é simétrico (spec 19 §5): o par é ordenado lexicograficamente no
    // insert, então a resposta reflete o par ordenado — não necessariamente idA→idB.
    expect(j.edge.type).toBe('friend');
    expect(new Set([j.edge.a_id, j.edge.b_id])).toEqual(new Set([idA, idB]));
    const [expA, expB] = idA < idB ? [idA, idB] : [idB, idA];
    expect(j.edge).toMatchObject({ a_id: expA, b_id: expB, type: 'friend' });
  });
});
