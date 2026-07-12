// GET /api/mailbox/summary (spec 80-frota-agentes/83) — heartbeat barato da frota.
// Pergunta binária "tem algo pra mim?" sem abrir sessão MCP: Bearer PAT resolve o
// usuário pela credencial (mesma identidade da spec 81/86), devolve unread + top 5
// numa query indexada, SEM side-effect (read_at intocado). Cache-Control: no-store.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, insertTask } from '../src/db/queries.js';
import { createApiKey } from '../src/auth/api-keys.js';
import { addMailboxItem } from '../src/db/mailbox.js';

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

const summary = (key?: string) =>
  SELF.fetch('https://x.test/api/mailbox/summary', {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM mailbox_items');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
});

describe('GET /api/mailbox/summary', () => {
  it('sem PAT → 401; PAT inválido → 401', async () => {
    expect((await summary()).status).toBe(401);
    expect((await summary('eb_pat_fake_key')).status).toBe(401);
  });

  it('PAT sem vínculo → 403 com corpo instrutivo', async () => {
    const { plainKey } = await createApiKey(E, E.OWNER_EMAIL ?? 'o@x', 'orfa', 'full', null);
    const res = await summary(plainKey);
    expect(res.status).toBe(403);
    const body: any = await res.json();
    expect(body.error).toContain('/app/config');
  });

  it('devolve user, unread, oldest_brt e top (máx 5, mais antigos primeiro); no-store; NÃO marca lido', async () => {
    const key = await seedUserWithKey('user_vps', 'Claude VPS');
    await seedTask('t1');
    for (let i = 1; i <= 7; i++) {
      await addMailboxItem(E, {
        user_id: 'user_vps', kind: 'mention', task_id: 't1',
        comment_id: `c${i}`, actor_user_id: null, created_at: i * 1000,
      });
    }

    const res = await summary(key);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body: any = await res.json();
    expect(body.user).toEqual({ id: 'user_vps', name: 'Claude VPS' });
    expect(body.unread).toBe(7);
    expect(body.top).toHaveLength(5);
    expect(body.top[0].kind).toBe('mention');
    expect(body.top[0].task_title).toBe('Task t1');
    expect(body.top[0].task_url).toContain('/app/notes/t1');
    expect(body.top[0].created_brt).toBeTruthy();
    expect(body.oldest_brt).toBe(body.top[0].created_brt);

    // Sem side-effect: nada virou lido.
    const c = await E.DB.prepare(`SELECT count(*) c FROM mailbox_items WHERE read_at IS NOT NULL`).first();
    expect(c.c).toBe(0);
    const again: any = await (await summary(key)).json();
    expect(again.unread).toBe(7);
  });

  it('zero itens → unread 0, top vazio, oldest_brt null', async () => {
    const key = await seedUserWithKey('user_pc', 'PC Desktop');
    const body: any = await (await summary(key)).json();
    expect(body.unread).toBe(0);
    expect(body.top).toEqual([]);
    expect(body.oldest_brt).toBeNull();
  });

  it('task privada fica fora do summary pra chave sem escopo private (fail-closed)', async () => {
    const key = await seedUserWithKey('user_vps', 'Claude VPS', 'full');
    await seedTask('tsec', true);
    await addMailboxItem(E, {
      user_id: 'user_vps', kind: 'mention', task_id: 'tsec',
      comment_id: 'c1', actor_user_id: null, created_at: 1000,
    });
    const body: any = await (await summary(key)).json();
    expect(body.unread).toBe(0);
    expect(body.top).toEqual([]);
  });

  it('tasks:assigned (spec 91): item órfão de task desatribuída fica fora do summary; mention concede', async () => {
    const key = await seedUserWithKey('user_vps', 'Claude VPS', 'full,notes:none,contacts:none,tasks:assigned');
    await seedTask('t1');
    await seedTask('t2');
    // Item 'assignment' órfão: a task não está (mais) atribuída — nada apaga
    // mailbox_items numa desatribuição, o gate é na leitura.
    await addMailboxItem(E, {
      user_id: 'user_vps', kind: 'assignment', task_id: 't1',
      comment_id: null, actor_user_id: null, created_at: 1000,
    });
    let body: any = await (await summary(key)).json();
    expect(body.unread).toBe(0);
    expect(body.top).toEqual([]);

    // Menção em OUTRA task concede visibilidade a ela (ramo mention do predicado).
    await addMailboxItem(E, {
      user_id: 'user_vps', kind: 'mention', task_id: 't2',
      comment_id: 'c1', actor_user_id: null, created_at: 2000,
    });
    body = await (await summary(key)).json();
    expect(body.unread).toBe(1);
    expect(body.top.map((i: any) => i.task_title)).toEqual(['Task t2']);
  });
});
