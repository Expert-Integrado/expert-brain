// Robô colaborador ponta a ponta (spec 80-frota-agentes/91): credencial preset
// task-worker (`full,notes:none,contacts:none,tasks:assigned`) vinculada a um user
// agent. Cobre: anti-oráculo (invisível = MESMO "not found" de inexistente em toda
// tool de leitura E escrita), filtros de lista/FTS/due, dedupe sem eco, mention
// concede / desatribuir revoga (inclusive no mailbox), PAT sem vínculo = erro
// instrutivo, proibição de reatribuição (só remover a si), rejeições por token
// (origin_note_id/mentions) e gate de LEITURA de menções sob contacts:none.
import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import type { AuthContext } from '../../src/env.js';
import {
  insertTask, createUser, setTaskAssignees, getTaskById, addTaskComment,
} from '../../src/db/queries.js';
import { addMailboxItem } from '../../src/db/mailbox.js';
import { OWNER_TASK_VIS } from '../../src/auth/visibility.js';
import { registerGetTask } from '../../src/mcp/tools/get-task.js';
import { registerListTasks } from '../../src/mcp/tools/list-tasks.js';
import { registerListTasksDueToday } from '../../src/mcp/tools/list-tasks-due-today.js';
import { registerSaveTask } from '../../src/mcp/tools/save-task.js';
import { registerUpdateTask } from '../../src/mcp/tools/update-task.js';
import { registerCompleteTask } from '../../src/mcp/tools/complete-task.js';
import { registerCommentTask } from '../../src/mcp/tools/comment-task.js';
import { registerClaimTask } from '../../src/mcp/tools/claim-task.js';
import { registerCheckMailbox } from '../../src/mcp/tools/check-mailbox.js';
import { registerAckMailbox } from '../../src/mcp/tools/ack-mailbox.js';

const E = env as any;

const TASK_WORKER_SCOPES = 'full,notes:none,contacts:none,tasks:assigned';
// PAT do robô colaborador, vinculado ao user_r (seed abaixo).
const ROBOT: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: TASK_WORKER_SCOPES, keyId: 'key_r' };
// PAT com os mesmos escopos mas SEM user vinculado — fail-closed instrutivo.
const ORPHAN: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: TASK_WORKER_SCOPES, keyId: 'key_orphan' };

function reg(auth: AuthContext) {
  const tools: any = {};
  const server = { registerTool: (n: string, _m: any, h: any) => { tools[n] = h; } } as any;
  registerGetTask(server, E, auth);
  registerListTasks(server, E, auth);
  registerListTasksDueToday(server, E, auth);
  registerSaveTask(server, E, auth);
  registerUpdateTask(server, E, auth);
  registerCompleteTask(server, E, auth as any);
  registerCommentTask(server, E, auth);
  registerClaimTask(server, E, auth);
  registerCheckMailbox(server, E, auth);
  registerAckMailbox(server, E, auth);
  return tools;
}

const parse = (res: any) => JSON.parse(res.content[0].text);
const T0 = 1_000_000;

async function seedTask(id: string, opts: { status?: string; due?: number | null; tag?: string; body?: string } = {}): Promise<void> {
  const { status = 'open', due = null, tag, body = `corpo ${id}` } = opts;
  await insertTask(E, {
    id, title: `Tarefa ${id}`, body, tldr: id, domains: '["operations"]',
    status: status as any, due_at: due, priority: null, created_at: T0, updated_at: T0,
    completed_at: status === 'done' ? T0 : null,
  } as any);
  if (tag) await E.DB.prepare(`INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)`).bind(id, tag).run();
}

async function seedIdentities(): Promise<void> {
  for (const key of ['key_r', 'key_orphan']) {
    await E.DB.prepare(
      `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, scopes, created_at) VALUES (?,?,?,?,?,?,?)`
    ).bind(key, 'o@x', key, `eb_pat_${key}`, `h_${key}`, TASK_WORKER_SCOPES, 1).run();
  }
  await createUser(E, { id: 'user_r', name: 'Robô Colaborador', type: 'agent', bio: null, api_key_id: 'key_r' }, 1);
  // Segundo e terceiro agentes pra testes de reatribuição.
  await createUser(E, { id: 'user_z', name: 'Outro Agente', type: 'agent', bio: null, api_key_id: null }, 1);
  await createUser(E, { id: 'user_w', name: 'Terceiro Agente', type: 'agent', bio: null, api_key_id: null }, 1);
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
  await seedIdentities();
});

describe('assigned-only — leitura (anti-oráculo)', () => {
  it('get_task de não-atribuída = erro byte-idêntico ao de id inexistente', async () => {
    await seedTask('other');
    const t = reg(ROBOT);
    const invisible = await t.get_task({ id: 'other' });
    expect(invisible.isError).toBe(true);
    const ghost = await t.get_task({ id: 'otherx' });
    expect(invisible.content[0].text).toBe(ghost.content[0].text.replace('otherx', 'other'));
    expect(invisible.content[0].text).not.toMatch(/assign|atribu|scope|escopo/i);
  });

  it('list_tasks (base, query FTS, tag) e list_tasks_due_today só trazem as minhas', async () => {
    const soon = Date.now() + 3600_000;
    await seedTask('mine', { due: soon, tag: 'work', body: 'quantum mine' });
    await seedTask('other', { due: soon, tag: 'work', body: 'quantum other' });
    await setTaskAssignees(E, 'mine', ['user_r'], T0);
    const t = reg(ROBOT);

    const base = parse(await t.list_tasks({}));
    expect(base.tasks.map((x: any) => x.id)).toEqual(['mine']);
    expect(base.count).toBe(1);

    const fts = parse(await t.list_tasks({ query: 'quantum' }));
    expect(fts.tasks.map((x: any) => x.id)).toEqual(['mine']);

    const byTag = parse(await t.list_tasks({ tag: 'work' }));
    expect(byTag.tasks.map((x: any) => x.id)).toEqual(['mine']);

    const due = parse(await t.list_tasks_due_today({}));
    expect(due.tasks.map((x: any) => x.id)).toEqual(['mine']);
    expect(due.count).toBe(1);
  });

  it('mention concede visibilidade; desatribuir revoga', async () => {
    await seedTask('t1');
    const t = reg(ROBOT);
    expect((await t.get_task({ id: 't1' })).isError).toBe(true);

    await addMailboxItem(E, { user_id: 'user_r', kind: 'mention', task_id: 't1', comment_id: null, actor_user_id: null, created_at: T0 });
    expect(parse(await t.get_task({ id: 't1' })).id).toBe('t1');

    // Revogação: atribuída → visível; desatribuída (sem mention) → some de novo.
    await seedTask('t2');
    await setTaskAssignees(E, 't2', ['user_r'], T0);
    expect(parse(await t.get_task({ id: 't2' })).id).toBe('t2');
    await setTaskAssignees(E, 't2', [], T0 + 1);
    expect((await t.get_task({ id: 't2' })).isError).toBe(true);
  });

  it('list_tasks sob contacts:none rejeita o filtro mentions_entity (oráculo de associação task↔contato)', async () => {
    await seedTask('mine');
    await setTaskAssignees(E, 'mine', ['user_r'], T0);
    await E.DB.prepare(
      `INSERT INTO mentions (id, note_id, entity_id, entity_label, created_at) VALUES ('mnt_2', 'mine', 'ent_x', 'Contato X', ?)`
    ).bind(T0).run();

    const res = await reg(ROBOT).list_tasks({ mentions_entity: 'ent_x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/contacts:none/);
    // Sem o filtro, a task continua acessível normalmente.
    expect(parse(await reg(ROBOT).list_tasks({})).tasks.map((t: any) => t.id)).toEqual(['mine']);
  });

  it('get_task sob contacts:none não ecoa menções da task (leitura gated, espelho da rejeição de escrita)', async () => {
    await seedTask('mine');
    await setTaskAssignees(E, 'mine', ['user_r'], T0);
    // Menção semeada direto no DB (a escrita via tool é rejeitada pra este preset).
    await E.DB.prepare(
      `INSERT INTO mentions (id, note_id, entity_id, entity_label, created_at) VALUES ('mnt_1', 'mine', 'ent_secreto', 'Contato Sigiloso', ?)`
    ).bind(T0).run();

    const res = await reg(ROBOT).get_task({ id: 'mine' });
    expect(parse(res).mentions).toEqual([]);
    expect(res.content[0].text).not.toContain('ent_secreto');
    expect(res.content[0].text).not.toContain('Contato Sigiloso');

    // Contraste: o dono (sessão sem tokens subtrativos) segue vendo a menção.
    const owner = reg({ email: 'o@x', loggedInAt: 0 });
    expect(parse(await owner.get_task({ id: 'mine' })).mentions)
      .toEqual([{ entity_id: 'ent_secreto', label: 'Contato Sigiloso' }]);
  });

  it('PAT tasks:assigned SEM user vinculado = erro instrutivo (nunca vê-tudo nem vazio silencioso)', async () => {
    await seedTask('t1');
    const t = reg(ORPHAN);
    for (const res of [await t.list_tasks({}), await t.get_task({ id: 't1' }), await t.list_tasks_due_today({})]) {
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/no linked user profile/);
      expect(res.content[0].text).toMatch(/\/app\/config/);
    }
  });
});

describe('assigned-only — escrita gated (not found idêntico, sem escrita parcial)', () => {
  it('update/complete/comment/claim em task não-atribuída = not found e nada persiste', async () => {
    await seedTask('other');
    const t = reg(ROBOT);

    const upd = await t.update_task({ id: 'other', priority: 1 });
    expect(upd.isError).toBe(true);
    expect(upd.content[0].text).not.toMatch(/assign|atribu|scope|escopo/i);

    const done = await t.complete_task({ id: 'other' });
    expect(done.isError).toBe(true);

    const cmt = await t.comment_task({ task_id: 'other', body: 'oi' });
    expect(cmt.isError).toBe(true);

    const clm = await t.claim_task({ task_id: 'other' });
    expect(clm.isError).toBe(true);

    // Nada mudou na task: prioridade, status, claim e comentários intactos.
    const row = await getTaskById(E, 'other', OWNER_TASK_VIS);
    expect(row?.priority).toBeNull();
    expect(row?.status).toBe('open');
    expect((row as any)?.claimed_by ?? null).toBeNull();
    const nComments = await E.DB.prepare(`SELECT count(*) AS c FROM task_comments WHERE task_id = 'other'`).first();
    expect(nComments?.c).toBe(0);
  });

  it('o ciclo completo funciona na task ATRIBUÍDA (claim, comment, update, complete)', async () => {
    await seedTask('mine');
    await setTaskAssignees(E, 'mine', ['user_r'], T0);
    const t = reg(ROBOT);

    expect(parse(await t.claim_task({ task_id: 'mine' })).claimed).toBe(true);
    expect((await t.comment_task({ task_id: 'mine', body: 'andamento' })).isError).toBeUndefined();
    expect(parse(await t.update_task({ id: 'mine', priority: 1 })).priority).toBe(1);
    expect(parse(await t.complete_task({ id: 'mine' })).status).toBe('done');
  });

  it('reatribuição PROIBIDA: adicionar outro ou remover terceiro = erro; remover A SI é permitido', async () => {
    await seedTask('mine');
    await setTaskAssignees(E, 'mine', ['user_r', 'user_z'], T0);
    const t = reg(ROBOT);

    // Adicionar alguém que NÃO está na task = reatribuir → bloqueado.
    const add = await t.update_task({ id: 'mine', assignees: ['user_r', 'user_z', 'Terceiro Agente'] });
    expect(add.isError).toBe(true);
    expect(add.content[0].text).toMatch(/REASSIGN|removing YOURSELF/);

    // Remover TERCEIRO (user_z) mantendo a si → bloqueado.
    const removeOther = await t.update_task({ id: 'mine', assignees: ['user_r'] });
    expect(removeOther.isError).toBe(true);

    // Remover A SI (fica só user_z) → permitido.
    const removeSelf = await t.update_task({ id: 'mine', assignees: ['user_z'] });
    expect(removeSelf.isError).toBeUndefined();
  });
});

describe('assigned-only — save_task (dedupe sem eco + rejeições por token)', () => {
  it('dedupe_key colidindo com task INVISÍVEL cria nova sem ecoar a existente', async () => {
    await seedTask('other', { tag: 'dedupe:relatorio' });
    const t = reg(ROBOT);
    const out = parse(await t.save_task({ title: 'Relatório semanal', dedupe_key: 'relatorio' }));
    // Não reutilizou a invisível: nasceu task nova, sem nenhum eco de 'other'.
    expect(out.id).not.toBe('other');
    expect(out.deduped ?? false).toBe(false);
    expect(JSON.stringify(out)).not.toContain('Tarefa other');
  });

  it('possible_duplicates não ecoa título de task invisível', async () => {
    await seedTask('other');
    const t = reg(ROBOT);
    const out = parse(await t.save_task({ title: 'Tarefa other' }));
    expect(JSON.stringify(out.possible_duplicates ?? [])).not.toContain('other');
  });

  it('origin_note_id sob notes:none = rejeitado ANTES de qualquer leitura (sem oráculo de nota)', async () => {
    const t = reg(ROBOT);
    const res = await t.save_task({ title: 'Nova', origin_note_id: 'note_x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/notes:none/);
    // Nada foi criado.
    const n = await E.DB.prepare(`SELECT count(*) AS c FROM notes WHERE kind = 'task'`).first();
    expect(n?.c).toBe(0);
  });

  it('mentions sob contacts:none = rejeitado no save_task e no update_task', async () => {
    const t = reg(ROBOT);
    const save = await t.save_task({ title: 'Nova', mentions: ['ent_1'] });
    expect(save.isError).toBe(true);
    expect(save.content[0].text).toMatch(/contacts:none/);

    await seedTask('mine');
    await setTaskAssignees(E, 'mine', ['user_r'], T0);
    const upd = await t.update_task({ id: 'mine', mentions: ['ent_1'] });
    expect(upd.isError).toBe(true);
    expect(upd.content[0].text).toMatch(/contacts:none/);
  });

  it('save_task PODE atribuir a terceiros (fluxo [pedido]) e a task criada fica visível pro criador', async () => {
    const t = reg(ROBOT);
    const out = parse(await t.save_task({ title: 'Pedido pro dono', assignees: ['Outro Agente'] }));
    expect(out.assignees?.map((a: any) => a.id)).toContain('user_z');
    // Ramo created_by do predicado: o robô segue vendo a task que criou.
    expect(parse(await t.get_task({ id: out.id })).id).toBe(out.id);
  });
});

// O mailbox era o furo do gate row-level (achado da auditoria adversarial pós-spec):
// desatribuir remove a linha de task_assignees mas NADA apaga mailbox_items — sem o
// taskVisFilter na leitura, os itens 'assignment'/'comment_on_assigned' órfãos
// entregariam título AO VIVO + corpo de comentário de task revogada, e unread_count
// viraria oráculo de existência.
describe('assigned-only — mailbox (desatribuir revoga; ack sem oráculo)', () => {
  it('itens assignment/comment_on_assigned somem do check_mailbox após desatribuição; título renomeado não vaza', async () => {
    await seedTask('t1');
    await setTaskAssignees(E, 't1', ['user_r'], T0);
    await addMailboxItem(E, { user_id: 'user_r', kind: 'assignment', task_id: 't1', comment_id: null, actor_user_id: null, created_at: T0 });
    await addTaskComment(E, { id: 'cmt_1', task_id: 't1', author: 'owner', author_name: null, body: 'briefing sigiloso', created_at: T0 + 1, author_user_id: null });
    await addMailboxItem(E, { user_id: 'user_r', kind: 'comment_on_assigned', task_id: 't1', comment_id: 'cmt_1', actor_user_id: null, created_at: T0 + 1 });
    const t = reg(ROBOT);

    expect(parse(await t.check_mailbox({})).unread_count).toBe(2);

    // Desatribuição não apaga mailbox_items — o gate é na leitura. Renomeia a task
    // pra provar que nem o título AO VIVO vaza depois da revogação.
    await setTaskAssignees(E, 't1', [], T0 + 2);
    await E.DB.prepare(`UPDATE notes SET title = 'Reestruturação confidencial' WHERE id = 't1'`).run();

    const after = await t.check_mailbox({});
    expect(parse(after).unread_count).toBe(0);
    expect(parse(after).items).toHaveLength(0);
    expect(after.content[0].text).not.toContain('confidencial');
    expect(after.content[0].text).not.toContain('briefing sigiloso');
  });

  it('item mention segue visível (mention concede) e é ackável', async () => {
    await seedTask('t1');
    await addMailboxItem(E, { user_id: 'user_r', kind: 'mention', task_id: 't1', comment_id: null, actor_user_id: null, created_at: T0 });
    const t = reg(ROBOT);

    const out = parse(await t.check_mailbox({}));
    expect(out.unread_count).toBe(1);
    expect(out.items[0].kind).toBe('mention');

    const ack = parse(await t.ack_mailbox({ ids: [out.items[0].id] }));
    expect(ack.acked).toBe(1);
    expect(ack.unread_count).toBe(0);
  });

  it('ack up_to ignora item de task invisível: acked=0 (sem oráculo) e o item não é tocado no DB', async () => {
    await seedTask('other');
    await addMailboxItem(E, { user_id: 'user_r', kind: 'assignment', task_id: 'other', comment_id: null, actor_user_id: null, created_at: T0 });
    const t = reg(ROBOT);

    const res = parse(await t.ack_mailbox({ up_to: Date.now() }));
    expect(res.acked).toBe(0);
    expect(res.unread_count).toBe(0);

    const row = await E.DB.prepare(`SELECT read_at FROM mailbox_items WHERE task_id = 'other'`).first();
    expect(row?.read_at).toBeNull();
  });
});
