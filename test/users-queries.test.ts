// Usuários e responsáveis (spec 37) — camada de dados.
// Migration 0017 (users + task_assignees + seed do dono) e as queries de CRUD,
// atribuição (replace-set N:N) e resolução de autoria (resolveActorProfile).
import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  USER_CAP,
  listUsers,
  getUserById,
  getUserByIdOrName,
  getUserByApiKeyId,
  getOwnerUser,
  countUsers,
  createUser,
  updateUser,
  setUserAvatar,
  setUserArchived,
  setTaskAssignees,
  listAssigneesForTask,
  listAssigneesForTasks,
  taskIdsAssignedTo,
  resolveActorProfile,
  insertTask,
} from '../src/db/queries.js';

const E = env as any;

async function reset() {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM task_assignees');
  // Seed user_owner é INSERT OR IGNORE da migration (não re-roda) — preserva o dono.
  await E.DB.exec("DELETE FROM users WHERE is_owner = 0");
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
}

async function seedTask(id: string) {
  await insertTask(E, {
    id, title: `Task ${id}`, body: 'b', tldr: `Task ${id}`, domains: '["operations"]',
    status: 'open' as any, due_at: null, priority: null, created_at: 1, updated_at: 1,
  });
}

async function seedKey(id: string, name: string) {
  await E.DB.prepare(
    `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)`
  ).bind(id, E.OWNER_EMAIL ?? 'o@x', name, 'eb_pat_x', 'h', 1).run();
}

describe('migration 0017_users (aditiva)', () => {
  beforeEach(reset);

  it('cria users, task_assignees e o índice por usuário', async () => {
    for (const t of ['users', 'task_assignees']) {
      const row = await E.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).bind(t).first();
      expect(row?.name).toBe(t);
    }
    const idx = await E.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_assignees_user'`
    ).first();
    expect(idx?.name).toBe('idx_task_assignees_user');
  });

  it('seed: perfil do dono existe (is_owner=1) e getOwnerUser o resolve', async () => {
    const owner = await getOwnerUser(E);
    expect(owner).not.toBeNull();
    expect(owner!.is_owner).toBe(1);
    expect(owner!.type).toBe('person');
  });
});

describe('CRUD de usuário (spec 37)', () => {
  beforeEach(reset);

  it('create/list: dono primeiro, depois por criação; countUsers conta todos', async () => {
    await createUser(E, { id: 'user_b', name: 'Bruno Castro', type: 'person', bio: null, api_key_id: null }, 200);
    await createUser(E, { id: 'user_a', name: 'Agente VPS', type: 'agent', bio: 'roda crons', api_key_id: null }, 100);
    const all = await listUsers(E, true);
    expect(all[0].is_owner).toBe(1);
    expect(all.slice(1).map((u) => u.id)).toEqual(['user_a', 'user_b']);
    expect(await countUsers(E)).toBe(3);
    expect(USER_CAP).toBe(64);
  });

  it('getUserByIdOrName resolve id exato e nome case-insensitive com acento', async () => {
    await createUser(E, { id: 'user_ana', name: 'Ana Conceição', type: 'person', bio: null, api_key_id: null }, 1);
    expect((await getUserByIdOrName(E, 'user_ana', false))?.id).toBe('user_ana');
    expect((await getUserByIdOrName(E, 'ana conceição', false))?.id).toBe('user_ana');
    expect(await getUserByIdOrName(E, 'ninguem', false)).toBeNull();
  });

  it('activesOnly exclui arquivado; incluir arquivado o encontra', async () => {
    await createUser(E, { id: 'user_x', name: 'Xavier', type: 'agent', bio: null, api_key_id: null }, 1);
    await setUserArchived(E, 'user_x', 999);
    expect(await getUserByIdOrName(E, 'Xavier', true)).toBeNull();
    expect((await getUserByIdOrName(E, 'Xavier', false))?.archived_at).toBe(999);
  });

  it('update aplica patch parcial; setUserAvatar grava key+mime', async () => {
    await createUser(E, { id: 'user_u', name: 'Ana', type: 'person', bio: null, api_key_id: null }, 1);
    expect(await updateUser(E, 'user_u', { name: 'Ana Almeida', bio: 'CS' }, 2)).toBe(true);
    const u = await getUserById(E, 'user_u');
    expect(u!.name).toBe('Ana Almeida');
    expect(u!.bio).toBe('CS');
    expect(u!.type).toBe('person'); // não tocado
    await setUserAvatar(E, 'user_u', 'avatars/user_u', 'image/png', 3);
    const u2 = await getUserById(E, 'user_u');
    expect(u2!.avatar_key).toBe('avatars/user_u');
    expect(u2!.avatar_mime).toBe('image/png');
  });

  it('o perfil do dono NÃO é arquivável', async () => {
    const owner = await getOwnerUser(E);
    expect(await setUserArchived(E, owner!.id, 999)).toBe(false);
    expect((await getOwnerUser(E))).not.toBeNull();
  });

  it('getUserByApiKeyId resolve o vínculo (só ativo)', async () => {
    await seedKey('key_vps', 'claude-vps');
    await createUser(E, { id: 'user_vps', name: 'Claude VPS', type: 'agent', bio: null, api_key_id: 'key_vps' }, 1);
    expect((await getUserByApiKeyId(E, 'key_vps'))?.id).toBe('user_vps');
    await setUserArchived(E, 'user_vps', 999);
    expect(await getUserByApiKeyId(E, 'key_vps')).toBeNull();
  });
});

describe('atribuição N:N (task_assignees)', () => {
  beforeEach(reset);

  it('setTaskAssignees é replace-set com dedupe; [] limpa', async () => {
    await seedTask('t1');
    await createUser(E, { id: 'user_a', name: 'Ana Almeida', type: 'person', bio: null, api_key_id: null }, 1);
    await createUser(E, { id: 'user_b', name: 'Bruno Castro', type: 'person', bio: null, api_key_id: null }, 2);
    await setTaskAssignees(E, 't1', ['user_a', 'user_b', 'user_a'], 10);
    expect((await listAssigneesForTask(E, 't1')).map((a) => a.id).sort()).toEqual(['user_a', 'user_b']);
    await setTaskAssignees(E, 't1', ['user_b'], 20);
    expect((await listAssigneesForTask(E, 't1')).map((a) => a.id)).toEqual(['user_b']);
    await setTaskAssignees(E, 't1', [], 30);
    expect(await listAssigneesForTask(E, 't1')).toEqual([]);
  });

  it('listAssigneesForTasks agrupa por task (batch) e taskIdsAssignedTo devolve o set', async () => {
    await seedTask('t1');
    await seedTask('t2');
    await createUser(E, { id: 'user_a', name: 'Ana Almeida', type: 'person', bio: null, api_key_id: null }, 1);
    await setTaskAssignees(E, 't1', ['user_a'], 10);
    const map = await listAssigneesForTasks(E, ['t1', 't2']);
    expect(map.get('t1')!.map((a) => a.id)).toEqual(['user_a']);
    expect(map.get('t2')).toBeUndefined();
    const ids = await taskIdsAssignedTo(E, 'user_a');
    expect(ids.has('t1')).toBe(true);
    expect(ids.has('t2')).toBe(false);
  });

  it('AssigneeRef ecoa avatar=true só quando há foto', async () => {
    await seedTask('t1');
    await createUser(E, { id: 'user_a', name: 'Ana', type: 'person', bio: null, api_key_id: null }, 1);
    await setTaskAssignees(E, 't1', ['user_a'], 10);
    expect((await listAssigneesForTask(E, 't1'))[0].avatar).toBe(false);
    await setUserAvatar(E, 'user_a', 'avatars/user_a', 'image/png', 20);
    expect((await listAssigneesForTask(E, 't1'))[0].avatar).toBe(true);
  });
});

describe('resolveActorProfile (created_by → perfil legível)', () => {
  beforeEach(reset);

  it('null/ausente → null (linhas pré-0012)', async () => {
    expect(await resolveActorProfile(E, null)).toBeNull();
    expect(await resolveActorProfile(E, undefined)).toBeNull();
  });

  it('oauth:<email> → perfil do dono', async () => {
    const p = await resolveActorProfile(E, 'oauth:dono@x.com');
    expect(p!.user!.id).toBe((await getOwnerUser(E))!.id);
    expect(p!.key_name).toBeNull();
  });

  it('PAT com usuário vinculado → user + nome da chave; sem vínculo → só key_name', async () => {
    await seedKey('key_vps', 'claude-vps');
    const withoutUser = await resolveActorProfile(E, 'key_vps');
    expect(withoutUser!.user).toBeNull();
    expect(withoutUser!.key_name).toBe('claude-vps');
    await createUser(E, { id: 'user_vps', name: 'Claude VPS', type: 'agent', bio: null, api_key_id: 'key_vps' }, 1);
    const withUser = await resolveActorProfile(E, 'key_vps');
    expect(withUser!.user!.name).toBe('Claude VPS');
    expect(withUser!.key_name).toBe('claude-vps');
  });

  it('resolve mesmo com usuário ARQUIVADO (display histórico)', async () => {
    await seedKey('key_old', 'antiga');
    await createUser(E, { id: 'user_old', name: 'Agente Antigo', type: 'agent', bio: null, api_key_id: 'key_old' }, 1);
    await setUserArchived(E, 'user_old', 999);
    const p = await resolveActorProfile(E, 'key_old');
    expect(p!.user!.name).toBe('Agente Antigo');
  });
});
