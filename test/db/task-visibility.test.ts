// Predicado row-level de visibilidade de task (spec 80-frota-agentes/91), nível
// QUERY: taskVisFilter aplicado nas 8 funções base de queries.ts. Cobre os 3 ramos
// do EXISTS (atribuída a mim / mention no mailbox / created_by de uma chave minha),
// a composição com o filtro private e a revogação por desatribuição (item de
// mailbox kind='assignment' NÃO concede — só 'mention').
import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { OWNER_TASK_VIS, taskVisPublic, type TaskVisibility } from '../../src/auth/visibility.js';
import {
  insertTask, createUser, setTaskAssignees,
  getTaskById, listActiveTasks, listRecentClosedTasks, listTasksDueBefore,
  ftsSearchTasks, findActiveTaskByTag, findSimilarActiveTasksByTitle,
  listTasksAwaitingOwner, addTaskComment,
} from '../../src/db/queries.js';
import { addMailboxItem } from '../../src/db/mailbox.js';

const E = env as any;

// Visibilidade do robô colaborador: só públicas E (atribuída/mencionada/criada por mim).
const ROBOT_VIS: TaskVisibility = { includePrivate: false, assignedOnlyUserId: 'user_r' };

const T0 = 1_000_000;

async function seedRobot(): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)`
  ).bind('key_r', 'o@x', 'Robô', 'eb_pat_key_r', 'h_key_r', 1).run();
  await createUser(E, { id: 'user_r', name: 'Robô Colaborador', type: 'agent', bio: null, api_key_id: 'key_r' }, 1);
}

async function seedTask(
  id: string,
  opts: { status?: string; priv?: 0 | 1; due?: number | null; createdBy?: string | null; tag?: string; body?: string } = {},
): Promise<void> {
  const { status = 'open', priv = 0, due = null, createdBy = null, tag, body = `corpo ${id}` } = opts;
  await insertTask(E, {
    id, title: `Tarefa ${id}`, body, tldr: id, domains: '["operations"]',
    status: status as any, due_at: due, priority: null, created_at: T0, updated_at: T0,
    completed_at: status === 'done' ? T0 : null, private: priv,
  } as any, createdBy);
  if (tag) await E.DB.prepare(`INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)`).bind(id, tag).run();
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM mailbox_items');
  await E.DB.exec('DELETE FROM task_assignees');
  await E.DB.exec('DELETE FROM task_comments');
  await E.DB.exec('DELETE FROM tags');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
  await seedRobot();
});

describe('taskVisFilter — ramo 1: atribuída a mim', () => {
  it('listActiveTasks/getTaskById só devolvem a atribuída; a alheia some', async () => {
    await seedTask('mine');
    await seedTask('other');
    await setTaskAssignees(E, 'mine', ['user_r'], T0);

    const active = await listActiveTasks(E, ROBOT_VIS);
    expect(active.map((t) => t.id)).toEqual(['mine']);

    expect(await getTaskById(E, 'mine', ROBOT_VIS)).not.toBeNull();
    expect(await getTaskById(E, 'other', ROBOT_VIS)).toBeNull();
    // Dono continua vendo tudo (OWNER_TASK_VIS não restringe).
    expect((await listActiveTasks(E, OWNER_TASK_VIS)).length).toBe(2);
  });

  it('desatribuir REVOGA na hora (mesmo com item assignment histórico no mailbox)', async () => {
    await seedTask('t1');
    await setTaskAssignees(E, 't1', ['user_r'], T0);
    // Item de mailbox kind='assignment' (o que a atribuição gera) fica pra trás.
    await addMailboxItem(E, { user_id: 'user_r', kind: 'assignment', task_id: 't1', comment_id: null, actor_user_id: null, created_at: T0 });
    expect(await getTaskById(E, 't1', ROBOT_VIS)).not.toBeNull();

    await setTaskAssignees(E, 't1', [], T0 + 1);
    // 'assignment' NÃO concede visibilidade — só 'mention'. Revogação efetiva.
    expect(await getTaskById(E, 't1', ROBOT_VIS)).toBeNull();
    expect(await listActiveTasks(E, ROBOT_VIS)).toEqual([]);
  });
});

describe('taskVisFilter — ramo 2: mention no mailbox concede', () => {
  it("item kind='mention' pra mim torna a task visível sem atribuição", async () => {
    await seedTask('t1');
    expect(await getTaskById(E, 't1', ROBOT_VIS)).toBeNull();

    await addMailboxItem(E, { user_id: 'user_r', kind: 'mention', task_id: 't1', comment_id: null, actor_user_id: null, created_at: T0 });
    expect(await getTaskById(E, 't1', ROBOT_VIS)).not.toBeNull();
  });

  it('mention de OUTRO user não concede nada a mim', async () => {
    await createUser(E, { id: 'user_z', name: 'Outro Agente', type: 'agent', bio: null, api_key_id: null }, 1);
    await seedTask('t1');
    await addMailboxItem(E, { user_id: 'user_z', kind: 'mention', task_id: 't1', comment_id: null, actor_user_id: null, created_at: T0 });
    expect(await getTaskById(E, 't1', ROBOT_VIS)).toBeNull();
  });
});

describe('taskVisFilter — ramo 3: created_by de uma chave do meu user', () => {
  it('task criada pelo MEU PAT continua visível (fluxo [pedido]) mesmo sem atribuição', async () => {
    await seedTask('pedido', { createdBy: 'key_r' });
    expect(await getTaskById(E, 'pedido', ROBOT_VIS)).not.toBeNull();
    expect((await listActiveTasks(E, ROBOT_VIS)).map((t) => t.id)).toEqual(['pedido']);
  });

  it('task criada por chave de OUTRO user não entra', async () => {
    await E.DB.prepare(
      `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)`
    ).bind('key_z', 'o@x', 'Outro', 'eb_pat_key_z', 'h_key_z', 1).run();
    await createUser(E, { id: 'user_z', name: 'Outro Agente', type: 'agent', bio: null, api_key_id: 'key_z' }, 1);
    await seedTask('alheia', { createdBy: 'key_z' });
    expect(await getTaskById(E, 'alheia', ROBOT_VIS)).toBeNull();
  });
});

describe('taskVisFilter — composição com private e demais funções', () => {
  it('privada ATRIBUÍDA a mim sem includePrivate = invisível (os eixos compõem em AND)', async () => {
    await seedTask('secreta', { priv: 1 });
    await setTaskAssignees(E, 'secreta', ['user_r'], T0);
    expect(await getTaskById(E, 'secreta', ROBOT_VIS)).toBeNull();
    // Com includePrivate (preset que carrega `private`), a mesma credencial vê.
    expect(await getTaskById(E, 'secreta', { includePrivate: true, assignedOnlyUserId: 'user_r' })).not.toBeNull();
  });

  it('ftsSearchTasks não vaza task não-atribuída pelo corpo', async () => {
    await seedTask('mine', { body: 'quantum alpha mine' });
    await seedTask('other', { body: 'quantum alpha other' });
    await setTaskAssignees(E, 'mine', ['user_r'], T0);
    const hits = await ftsSearchTasks(E, 'quantum', 10, ROBOT_VIS);
    expect(hits.map((t) => t.id)).toEqual(['mine']);
  });

  it('findActiveTaskByTag: dedupe_key colidindo com task invisível NÃO ecoa', async () => {
    await seedTask('other', { tag: 'dedupe:relatorio-semanal' });
    expect(await findActiveTaskByTag(E, 'dedupe:relatorio-semanal', ROBOT_VIS)).toBeNull();
    expect(await findActiveTaskByTag(E, 'dedupe:relatorio-semanal', OWNER_TASK_VIS)).not.toBeNull();
  });

  it('findSimilarActiveTasksByTitle não ecoa títulos de tasks invisíveis', async () => {
    await seedTask('other');
    // Título de 'other' é "Tarefa other" — busca por título quase idêntico.
    const similar = await findSimilarActiveTasksByTitle(E, 'Tarefa other', ROBOT_VIS);
    expect(similar).toEqual([]);
    expect((await findSimilarActiveTasksByTitle(E, 'Tarefa other', OWNER_TASK_VIS)).length).toBeGreaterThan(0);
  });

  it('listTasksDueBefore e listRecentClosedTasks respeitam o filtro', async () => {
    const soon = Date.now() + 3600_000;
    await seedTask('due-mine', { due: soon });
    await seedTask('due-other', { due: soon });
    await seedTask('done-mine', { status: 'done' });
    await seedTask('done-other', { status: 'done' });
    await setTaskAssignees(E, 'due-mine', ['user_r'], T0);
    await setTaskAssignees(E, 'done-mine', ['user_r'], T0);

    const due = await listTasksDueBefore(E, Date.now() + 24 * 3600_000, ROBOT_VIS);
    expect(due.map((t) => t.id)).toEqual(['due-mine']);

    const closed = await listRecentClosedTasks(E, 100, ROBOT_VIS);
    expect(closed.map((t) => t.id)).toEqual(['done-mine']);
  });

  it('listTasksAwaitingOwner só conta bloqueio de task visível', async () => {
    await seedTask('blk-mine', { status: 'in_progress' });
    await seedTask('blk-other', { status: 'in_progress' });
    await setTaskAssignees(E, 'blk-mine', ['user_r'], T0);
    // [bloqueio] sem resposta nas duas (kind='bloqueio' entra na fila awaiting_owner).
    for (const id of ['blk-mine', 'blk-other']) {
      await addTaskComment(E, {
        id: `c_${id}`, task_id: id, author: 'agent', author_name: 'Robô',
        body: '[bloqueio] preciso de decisão', created_at: T0, kind: 'bloqueio',
      } as any);
    }
    const mine = await listTasksAwaitingOwner(E, ROBOT_VIS);
    expect(mine.map((t) => t.id)).toEqual(['blk-mine']);
    expect((await listTasksAwaitingOwner(E, OWNER_TASK_VIS)).length).toBe(2);
  });

  it('taskVisPublic(bool) preserva o comportamento legado (sem restrição por assignee)', async () => {
    await seedTask('pub');
    await seedTask('priv', { priv: 1 });
    const pub = await listActiveTasks(E, taskVisPublic(false));
    expect(pub.map((t) => t.id)).toEqual(['pub']);
    const all = await listActiveTasks(E, taskVisPublic(true));
    expect(all.length).toBe(2);
  });
});
