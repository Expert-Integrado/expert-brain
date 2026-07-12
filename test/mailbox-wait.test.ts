// GET /api/mailbox/wait (spec 80-frota-agentes/90) — wake fast-path por long-poll.
// Mesma identidade/visibilidade do summary (Bearer PAT, fail-closed pra task privada),
// SEM side-effect. O loop de espera é a função pura waitForUnread, testada sem
// relógio real; os testes de rota usam timeout=0 (check único) pra não segurar a suite.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, insertTask } from '../src/db/queries.js';
import { createApiKey } from '../src/auth/api-keys.js';
import { addMailboxItem } from '../src/db/mailbox.js';
import { waitForUnread, WAIT_MAX_TIMEOUT_S, WAIT_POLL_MS } from '../src/web/mailbox-api.js';

const E = env as any;

async function seedUserWithKey(userId: string, name: string, scopes = 'full'): Promise<string> {
  await createUser(E, { id: userId, name, type: 'agent', bio: null, api_key_id: null }, 1);
  const { plainKey } = await createApiKey(E, E.OWNER_EMAIL ?? 'o@x', `pat-${userId}`, scopes, userId);
  return plainKey;
}

async function seedTask(id: string, priv = false) {
  const now = Date.now();
  await insertTask(E, {
    id, title: `Task ${id}`, body: 'corpo', tldr: id, domains: '["operations"]',
    status: 'open', due_at: null, priority: null, created_at: now, updated_at: now,
  });
  if (priv) await E.DB.prepare(`UPDATE notes SET private = 1 WHERE id = ?`).bind(id).run();
}

const wait = (key?: string, qs = '?timeout=0') =>
  SELF.fetch(`https://x.test/api/mailbox/wait${qs}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM mailbox_items');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
});

describe('waitForUnread (núcleo puro do long-poll)', () => {
  it('unread na entrada → responde sem dormir', async () => {
    let sleeps = 0;
    const r = await waitForUnread(async () => 3, 25000, 3000, async () => { sleeps++; });
    expect(r.unread).toBe(3);
    expect(sleeps).toBe(0);
  });

  it('item nasce durante a espera → acorda no próximo poll', async () => {
    const seq = [0, 0, 5];
    let sleeps = 0;
    const r = await waitForUnread(async () => seq.shift() ?? 5, 25000, 3000, async () => { sleeps++; });
    expect(r.unread).toBe(5);
    expect(sleeps).toBe(2);
  });

  it('nada nasce → devolve 0 no timeout (sleep real curto)', async () => {
    const r = await waitForUnread(async () => 0, 40, 10);
    expect(r.unread).toBe(0);
    expect(r.waitedMs).toBeGreaterThanOrEqual(30);
  });

  it('teto de iterações segura o loop mesmo com clock congelado (sleep que não avança)', async () => {
    let checks = 0;
    const r = await waitForUnread(async () => { checks++; return 0; }, 25000, 3000, async () => {});
    expect(r.unread).toBe(0);
    // 1 check inicial + maxIters (ceil(25000/3000)+1 = 10) — nunca infinito.
    expect(checks).toBeLessThanOrEqual(11);
  });
});

describe('GET /api/mailbox/wait', () => {
  it('sem PAT → 401; PAT inválido → 401', async () => {
    expect((await wait()).status).toBe(401);
    expect((await wait('eb_pat_fake_key')).status).toBe(401);
  });

  it('PAT sem vínculo → 403 com corpo instrutivo', async () => {
    const { plainKey } = await createApiKey(E, E.OWNER_EMAIL ?? 'o@x', 'orfa', 'full', null);
    const res = await wait(plainKey);
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error).toContain('/app/config');
  });

  it('unread > 0 → wake:true imediato mesmo com timeout cheio; no-store; NÃO marca lido', async () => {
    const key = await seedUserWithKey('user_pc', 'PC Desktop');
    await seedTask('t1');
    await addMailboxItem(E, {
      user_id: 'user_pc', kind: 'mention', task_id: 't1',
      comment_id: 'c1', actor_user_id: null, created_at: 1000,
    });
    const res = await wait(key, `?timeout=${WAIT_MAX_TIMEOUT_S}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body: any = await res.json();
    expect(body.user).toEqual({ id: 'user_pc', name: 'PC Desktop' });
    expect(body.wake).toBe(true);
    expect(body.unread).toBe(1);
    // Respondeu na entrada, não esperou o timeout de 25s.
    expect(body.waited_ms).toBeLessThan(WAIT_POLL_MS);

    // Sem side-effect: nada virou lido.
    const c = await E.DB.prepare(`SELECT count(*) c FROM mailbox_items WHERE read_at IS NOT NULL`).first();
    expect(c.c).toBe(0);
  });

  it('mailbox vazio + timeout=0 → wake:false imediato', async () => {
    const key = await seedUserWithKey('user_pc', 'PC Desktop');
    const body: any = await (await wait(key)).json();
    expect(body.wake).toBe(false);
    expect(body.unread).toBe(0);
  });

  it('timeout fora da faixa é clampado (negativo/lixo → check único, sem 4xx)', async () => {
    const key = await seedUserWithKey('user_pc', 'PC Desktop');
    expect((await wait(key, '?timeout=-5')).status).toBe(200);
    expect((await wait(key, '?timeout=abc')).status).toBe(200);
  });

  it('task privada não acorda chave sem escopo private (fail-closed)', async () => {
    const key = await seedUserWithKey('user_vps', 'Claude VPS', 'full');
    await seedTask('tsec', true);
    await addMailboxItem(E, {
      user_id: 'user_vps', kind: 'mention', task_id: 'tsec',
      comment_id: 'c1', actor_user_id: null, created_at: 1000,
    });
    const body: any = await (await wait(key)).json();
    expect(body.wake).toBe(false);
    expect(body.unread).toBe(0);
  });
});
