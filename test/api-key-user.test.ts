// Chave pertence ao usuário — 1:N + credencial privada separada (spec 80-frota-agentes/86).
// api_keys.user_id vira a fonte da verdade do vínculo credencial→usuário (N chaves por
// usuário); users.api_key_id fica como fallback LEGADO. Comentário ganha forense por
// chave (author_key_id). Identidade (quem assina) e capacidade (escopo private) são
// ortogonais por construção.
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations, MIGRATIONS } from '../src/db/migrate.js';
import type { AuthContext } from '../src/env.js';
import {
  insertTask, createUser, getUserByApiKeyId, getUserById,
} from '../src/db/queries.js';
import { registerCommentTask } from '../src/mcp/tools/comment-task.js';
import { registerGetTask } from '../src/mcp/tools/get-task.js';
import { signSession } from '../src/web/session.js';

const E = env as any;

function reg(auth: AuthContext) {
  const r: any = {};
  const server = { registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any;
  registerCommentTask(server, E, auth);
  registerGetTask(server, E, auth);
  return r;
}

const parse = (res: any) => JSON.parse(res.content[0].text);

const pat = (keyId: string, scopes = 'full'): AuthContext => ({ email: 'o@x', loggedInAt: 0, scopes, keyId });

async function seedKey(id: string, name: string, opts: { userId?: string | null; scopes?: string; revokedAt?: number | null } = {}) {
  await E.DB.prepare(
    `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, scopes, created_at, revoked_at, user_id)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, E.OWNER_EMAIL ?? 'o@x', name, `eb_pat_${id.slice(0, 4)}`, `hash_${id}`, opts.scopes ?? 'full', 1, opts.revokedAt ?? null, opts.userId ?? null).run();
}

async function seedTask(id: string, priv = 0) {
  const now = Date.now();
  await insertTask(E, {
    id, title: id, body: 'corpo', tldr: id, domains: '["operations"]',
    status: 'open', due_at: null, priority: null, created_at: now, updated_at: now,
  });
  if (priv) await E.DB.prepare(`UPDATE notes SET private = 1 WHERE id = ?`).bind(id).run();
}

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

function postForm(path: string, fields: Record<string, string>, ck?: string): Promise<Response> {
  return SELF.fetch(`https://x${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(ck ? { cookie: ck } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM task_comments');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
});

describe('migration 0021_api_key_user', () => {
  it('api_keys.user_id e task_comments.author_key_id existem', async () => {
    const keys = (await E.DB.prepare(`PRAGMA table_info(api_keys)`).all()).results.map((r: any) => r.name);
    expect(keys).toContain('user_id');
    const cmts = (await E.DB.prepare(`PRAGMA table_info(task_comments)`).all()).results.map((r: any) => r.name);
    expect(cmts).toContain('author_key_id');
  });

  it('backfill preserva os vínculos legados (users.api_key_id → api_keys.user_id)', async () => {
    await seedKey('key_leg', 'legada');
    await createUser(E, { id: 'user_leg', name: 'Legado', type: 'agent', bio: null, api_key_id: 'key_leg' }, 1);
    // Re-executa o UPDATE de backfill da própria migration (idempotente por WHERE user_id IS NULL).
    const mig = MIGRATIONS.find((m) => m.id === '0021_api_key_user')!;
    const backfill = mig.stmts.find((s) => /UPDATE api_keys/i.test(s))!;
    await E.DB.prepare(backfill).run();
    const row = await E.DB.prepare(`SELECT user_id FROM api_keys WHERE id = 'key_leg'`).first();
    expect(row.user_id).toBe('user_leg');
  });
});

describe('getUserByApiKeyId — fonte da verdade invertida', () => {
  it('duas chaves do MESMO usuário: ambas resolvem pro usuário certo', async () => {
    await createUser(E, { id: 'user_pc', name: 'PC Desktop', type: 'agent', bio: null, api_key_id: null }, 1);
    await seedKey('key_a', 'pat-pc-identidade', { userId: 'user_pc' });
    await seedKey('key_b', 'pat-pc-privada', { userId: 'user_pc', scopes: 'full,private' });
    expect((await getUserByApiKeyId(E, 'key_a'))?.id).toBe('user_pc');
    expect((await getUserByApiKeyId(E, 'key_b'))?.id).toBe('user_pc');
  });

  it('fallback legado: chave sem user_id resolve via users.api_key_id', async () => {
    await seedKey('key_leg', 'legada');
    await createUser(E, { id: 'user_leg', name: 'Legado', type: 'agent', bio: null, api_key_id: 'key_leg' }, 1);
    expect((await getUserByApiKeyId(E, 'key_leg'))?.id).toBe('user_leg');
  });

  it('api_keys.user_id VENCE o legado quando ambos existem', async () => {
    await createUser(E, { id: 'user_novo', name: 'Novo', type: 'agent', bio: null, api_key_id: null }, 1);
    await seedKey('key_x', 'disputada', { userId: 'user_novo' });
    await createUser(E, { id: 'user_velho', name: 'Velho', type: 'agent', bio: null, api_key_id: 'key_x' }, 2);
    expect((await getUserByApiKeyId(E, 'key_x'))?.id).toBe('user_novo');
  });

  it('usuário arquivado não resolve (nem via user_id, nem via legado)', async () => {
    await createUser(E, { id: 'user_arq', name: 'Arquivado', type: 'agent', bio: null, api_key_id: null }, 1);
    await seedKey('key_arq', 'x', { userId: 'user_arq' });
    await E.DB.prepare(`UPDATE users SET archived_at = 999 WHERE id = 'user_arq'`).run();
    expect(await getUserByApiKeyId(E, 'key_arq')).toBeNull();
  });
});

describe('forense por chave no comentário', () => {
  it('comment_task grava author_key_id além de author_user_id', async () => {
    await createUser(E, { id: 'user_pc', name: 'PC Desktop', type: 'agent', bio: null, api_key_id: null }, 1);
    await seedKey('key_a', 'pat-pc', { userId: 'user_pc' });
    await seedTask('t1');
    const p = parse(await reg(pat('key_a')).comment_task({ task_id: 't1', body: 'assinado' }));
    const row = await E.DB.prepare(`SELECT author_user_id, author_key_id FROM task_comments WHERE id = ?`).bind(p.id).first();
    expect(row.author_user_id).toBe('user_pc');
    expect(row.author_key_id).toBe('key_a');
  });

  it('revogar a chave-privada NÃO afeta a assinatura pela chave-identidade', async () => {
    await createUser(E, { id: 'user_pc', name: 'PC Desktop', type: 'agent', bio: null, api_key_id: null }, 1);
    await seedKey('key_id', 'identidade', { userId: 'user_pc' });
    await seedKey('key_priv', 'privada', { userId: 'user_pc', scopes: 'full,private' });
    await seedTask('t1');
    await E.DB.prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = 'key_priv'`).bind(Date.now()).run();
    const p = parse(await reg(pat('key_id')).comment_task({ task_id: 't1', body: 'segue assinando' }));
    expect(p.author_user.id).toBe('user_pc');
  });
});

describe('identidade ≠ capacidade (escopo private por chave)', () => {
  it('chave sem private não vê task privada mesmo sendo do MESMO usuário da chave privada', async () => {
    await createUser(E, { id: 'user_pc', name: 'PC Desktop', type: 'agent', bio: null, api_key_id: null }, 1);
    await seedKey('key_id', 'identidade', { userId: 'user_pc' });
    await seedKey('key_priv', 'privada', { userId: 'user_pc', scopes: 'full,private' });
    await seedTask('tsecreta', 1);
    const semPrivate = await reg(pat('key_id', 'full')).get_task({ id: 'tsecreta' });
    expect(semPrivate.isError).toBe(true);
    const comPrivate = parse(await reg(pat('key_priv', 'full,private')).get_task({ id: 'tsecreta' }));
    expect(comPrivate.id).toBe('tsecreta');
  });
});

describe('config — dono mora na chave', () => {
  it('criar chave com dono grava api_keys.user_id', async () => {
    await createUser(E, { id: 'user_pc', name: 'PC Desktop', type: 'agent', bio: null, api_key_id: null }, 1);
    const res = await postForm('/app/api-keys/create', { name: 'pat-pc-desktop', scope: 'full', user_id: 'user_pc' }, await cookie());
    expect(res.status).toBe(302);
    const row = await E.DB.prepare(`SELECT user_id FROM api_keys WHERE name = 'pat-pc-desktop'`).first();
    expect(row.user_id).toBe('user_pc');
  });

  it('chave nova sem dono não nasce pela UI (400); dono inválido → 400', async () => {
    const ck = await cookie();
    const semDono = await postForm('/app/api-keys/create', { name: 'orfa', scope: 'full' }, ck);
    expect(semDono.status).toBe(400);
    const donoRuim = await postForm('/app/api-keys/create', { name: 'x', scope: 'full', user_id: 'user_fantasma' }, ck);
    expect(donoRuim.status).toBe(400);
    const c = await E.DB.prepare(`SELECT count(*) c FROM api_keys`).first();
    expect(c.c).toBe(0);
  });

  it('update de usuário NÃO mexe mais no vínculo (api_key_id legado preservado)', async () => {
    await seedKey('key_leg', 'legada');
    await createUser(E, { id: 'user_leg', name: 'Legado', type: 'agent', bio: null, api_key_id: 'key_leg' }, 1);
    // Form de update SEM campo de chave (a UI não o envia mais) — vínculo legado fica.
    const res = await postForm('/app/config/users/update', { id: 'user_leg', name: 'Legado Renomeado', type: 'agent' }, await cookie());
    expect(res.status).toBe(302);
    const u = await getUserById(E, 'user_leg');
    expect(u?.name).toBe('Legado Renomeado');
    expect(u?.api_key_id).toBe('key_leg');
  });
});
