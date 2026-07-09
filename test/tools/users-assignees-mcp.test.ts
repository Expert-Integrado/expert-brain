// Usuários e responsáveis nas tools MCP (spec 37): list_users, assignees em
// save_task/update_task, filtro assignee em list_tasks (incl. 'me' por PAT) e
// eco assignees/created_by em get_task.
import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import type { AuthContext } from '../../src/env.js';
import { registerListUsers } from '../../src/mcp/tools/list-users.js';
import { registerSaveTask } from '../../src/mcp/tools/save-task.js';
import { registerUpdateTask } from '../../src/mcp/tools/update-task.js';
import { registerListTasks } from '../../src/mcp/tools/list-tasks.js';
import { registerGetTask } from '../../src/mcp/tools/get-task.js';
import { createUser, getOwnerUser, setUserArchived } from '../../src/db/queries.js';

const E = env as any;
// Sessão OAuth do dono (sem keyId) e PAT do agente (keyId presente).
const OWNER: AuthContext = { email: 'o@x', loggedInAt: 0 };
const AGENT_PAT: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'key_vps' };

function reg(auth: AuthContext) {
  const r: any = {};
  const server = { registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any;
  registerListUsers(server, E, auth);
  registerSaveTask(server, E, auth);
  registerUpdateTask(server, E, auth);
  registerListTasks(server, E, auth);
  registerGetTask(server, E, auth);
  return r;
}

const parse = (res: any) => JSON.parse(res.content[0].text);

async function seedAgentUser() {
  await E.DB.prepare(
    `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)`
  ).bind('key_vps', 'o@x', 'claude-vps', 'eb_pat_x', 'h', 1).run();
  await createUser(E, { id: 'user_vps', name: 'Claude VPS', type: 'agent', bio: null, api_key_id: 'key_vps' }, 1);
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM task_assignees');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
});

describe('list_users', () => {
  it('lista ativos com is_me da credencial; include_archived opt-in', async () => {
    await seedAgentUser();
    await createUser(E, { id: 'user_z', name: 'Zumbi', type: 'person', bio: null, api_key_id: null }, 2);
    await setUserArchived(E, 'user_z', 999);

    const asOwner = parse(await reg(OWNER).list_users({}));
    expect(asOwner.users.map((u: any) => u.id)).not.toContain('user_z');
    const ownerId = (await getOwnerUser(E))!.id;
    expect(asOwner.users.find((u: any) => u.id === ownerId).is_me).toBe(true);
    expect(asOwner.users.find((u: any) => u.id === 'user_vps').is_me).toBe(false);

    const asAgent = parse(await reg(AGENT_PAT).list_users({ include_archived: true }));
    expect(asAgent.users.find((u: any) => u.id === 'user_vps').is_me).toBe(true);
    expect(asAgent.users.find((u: any) => u.id === 'user_z').archived).toBe(true);
  });
});

describe('save_task com assignees', () => {
  it("resolve id, nome e 'me' (PAT→user vinculado); ecoa assignees", async () => {
    await seedAgentUser();
    const p = parse(await reg(AGENT_PAT).save_task({ title: 'Revisar sites', assignees: ['me'] }));
    expect(p.assignees.map((a: any) => a.id)).toEqual(['user_vps']);
    const rows = await E.DB.prepare(`SELECT user_id FROM task_assignees WHERE note_id = ?`).bind(p.id).all();
    expect(rows.results.map((r: any) => r.user_id)).toEqual(['user_vps']);
  });

  it("'me' na sessão OAuth resolve pro perfil do dono", async () => {
    const p = parse(await reg(OWNER).save_task({ title: 'Ir ao shopping', assignees: ['me'] }));
    expect(p.assignees[0].id).toBe((await getOwnerUser(E))!.id);
  });

  it('ref desconhecida ABORTA a criação com erro orientado (nunca auto-cria)', async () => {
    const res = await reg(OWNER).save_task({ title: 'X', assignees: ['Fulano Inexistente'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Fulano Inexistente');
    const c = await E.DB.prepare(`SELECT count(*) c FROM notes WHERE kind='task'`).first();
    expect(c.c).toBe(0);
  });
});

describe('update_task com assignees (replace-set)', () => {
  it('substitui o set; [] limpa; eco reflete o estado final', async () => {
    await seedAgentUser();
    await createUser(E, { id: 'user_b', name: 'Bruno Castro', type: 'person', bio: null, api_key_id: null }, 2);
    const tools = reg(OWNER);
    const t = parse(await tools.save_task({ title: 'Subir site', assignees: ['Claude VPS'] }));

    const upd = parse(await tools.update_task({ id: t.id, assignees: ['Bruno Castro', 'Claude VPS'] }));
    expect(upd.assignees.map((a: any) => a.id).sort()).toEqual(['user_b', 'user_vps']);

    const cleared = parse(await tools.update_task({ id: t.id, assignees: [] }));
    expect(cleared.assignees).toEqual([]);
    const rows = await E.DB.prepare(`SELECT count(*) c FROM task_assignees WHERE note_id = ?`).bind(t.id).first();
    expect(rows.c).toBe(0);
  });
});

describe('list_tasks com filtro assignee', () => {
  it("filtra a fila de um usuário; 'me' via PAT; cards ecoam assignees", async () => {
    await seedAgentUser();
    const tools = reg(AGENT_PAT);
    const mine = parse(await tools.save_task({ title: 'Minha task', assignees: ['me'] }));
    parse(await tools.save_task({ title: 'De ninguém' }));

    const all = parse(await tools.list_tasks({}));
    expect(all.count).toBe(2);
    const byMe = parse(await tools.list_tasks({ assignee: 'me' }));
    expect(byMe.count).toBe(1);
    expect(byMe.tasks[0].id).toBe(mine.id);
    expect(byMe.tasks[0].assignees.map((a: any) => a.name)).toEqual(['Claude VPS']);
  });

  it("'me' sem perfil vinculado → erro orientado; ref desconhecida → vazio", async () => {
    const noLink: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'key_semvinculo' };
    const res = await reg(noLink).list_tasks({ assignee: 'me' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('no linked user profile');

    const empty = parse(await reg(OWNER).list_tasks({ assignee: 'Ninguém Aqui' }));
    expect(empty.count).toBe(0);
  });
});

describe('get_task: assignees + created_by', () => {
  it('ecoa responsáveis e a credencial criadora resolvida pro perfil', async () => {
    await seedAgentUser();
    const t = parse(await reg(AGENT_PAT).save_task({ title: 'Auditar backups', assignees: ['me'] }));
    const got = parse(await reg(OWNER).get_task({ id: t.id }));
    expect(got.assignees.map((a: any) => a.id)).toEqual(['user_vps']);
    // created_by = PAT do agente (auditoria) — distinto de assignees (decisão).
    expect(got.created_by.actor).toBe('key_vps');
    expect(got.created_by.user.name).toBe('Claude VPS');
    expect(got.created_by.key_name).toBe('claude-vps');
  });

  it('task criada por OAuth → created_by aponta o perfil do dono', async () => {
    const t = parse(await reg(OWNER).save_task({ title: 'X' }));
    const got = parse(await reg(OWNER).get_task({ id: t.id }));
    expect(got.created_by.actor).toBe('oauth:o@x');
    expect(got.created_by.user.id).toBe((await getOwnerUser(E))!.id);
  });
});
