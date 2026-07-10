// Usuários e responsáveis (spec 37) — superfície web: seção "Usuários" do
// /app/config, CRUD por form+redirect, avatar no R2 (MEDIA) e o POST de
// responsáveis da sidebar do detalhe (/app/tasks/assignees).
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { signSession } from '../src/web/session.js';
import {
  insertTask,
  createUser,
  getUserById,
  getOwnerUser,
  setUserArchived,
  setTaskAssignees,
  listAssigneesForTask,
  listUsers,
} from '../src/db/queries.js';

const E = env as any;

async function cookie(): Promise<string> {
  const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
  return `eb_session=${token}`;
}

// Form POST com suporte a campo repetido (user_ids múltiplos).
function formPost(path: string, fields: Array<[string, string]>, ck?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (ck) headers.cookie = ck;
  const body = new URLSearchParams(fields).toString();
  return SELF.fetch(`https://x${path}`, { method: 'POST', headers, body, redirect: 'manual' });
}

async function seedTask(id: string) {
  await insertTask(E, {
    id, title: `Task ${id}`, body: 'b', tldr: `Task ${id}`, domains: '["operations"]',
    status: 'open' as any, due_at: null, priority: null, created_at: 1, updated_at: 1,
  });
}

async function seedKey(id: string, name: string, revokedAt: number | null = null) {
  await E.DB.prepare(
    `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at, revoked_at) VALUES (?,?,?,?,?,?,?)`
  ).bind(id, E.OWNER_EMAIL, name, 'eb_pat_x', 'h', 1, revokedAt).run();
}

async function reset() {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM task_assignees');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
}

describe('POST /app/config/users/* (CRUD por form)', () => {
  beforeEach(reset);

  it('create → 302 ?saved=users e a linha existe; sem sessão → redirect de login', async () => {
    const ck = await cookie();
    const res = await formPost('/app/config/users/create', [['name', 'Ana Almeida'], ['type', 'person'], ['bio', 'CS']], ck);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/config?saved=users#users');
    const created = (await listUsers(E, true)).find((u) => u.name === 'Ana Almeida');
    expect(created?.type).toBe('person');
    expect(created?.bio).toBe('CS');

    const anon = await formPost('/app/config/users/create', [['name', 'X'], ['type', 'person']]);
    expect([302, 303, 401]).toContain(anon.status);
    expect((await listUsers(E, true)).find((u) => u.name === 'X')).toBeUndefined();
  });

  it('update vincula PAT ativo; chave já usada por outro usuário → 400', async () => {
    const ck = await cookie();
    await seedKey('key_vps', 'claude-vps');
    await createUser(E, { id: 'user_1', name: 'Agente A', type: 'agent', bio: null, api_key_id: null }, 1);
    await createUser(E, { id: 'user_2', name: 'Agente B', type: 'agent', bio: null, api_key_id: null }, 2);

    const ok = await formPost('/app/config/users/update', [['id', 'user_1'], ['name', 'Agente A'], ['type', 'agent'], ['api_key_id', 'key_vps']], ck);
    expect(ok.status).toBe(302);
    expect((await getUserById(E, 'user_1'))?.api_key_id).toBe('key_vps');

    const conflict = await formPost('/app/config/users/update', [['id', 'user_2'], ['name', 'Agente B'], ['type', 'agent'], ['api_key_id', 'key_vps']], ck);
    expect(conflict.status).toBe(400);
    expect(await conflict.text()).toContain('Agente A');
  });

  it('chave revogada não vincula; tipo do dono é imutável', async () => {
    const ck = await cookie();
    await seedKey('key_dead', 'revogada', 999);
    await createUser(E, { id: 'user_1', name: 'Agente A', type: 'agent', bio: null, api_key_id: null }, 1);
    const bad = await formPost('/app/config/users/update', [['id', 'user_1'], ['name', 'Agente A'], ['type', 'agent'], ['api_key_id', 'key_dead']], ck);
    expect(bad.status).toBe(400);

    const owner = (await getOwnerUser(E))!;
    const res = await formPost('/app/config/users/update', [['id', owner.id], ['name', 'Eu'], ['type', 'agent']], ck);
    expect(res.status).toBe(302);
    expect((await getUserById(E, owner.id))?.type).toBe('person'); // não virou agente
  });

  it('archive/desarquive funciona; dono não é arquivável (404)', async () => {
    const ck = await cookie();
    await createUser(E, { id: 'user_1', name: 'Temp', type: 'person', bio: null, api_key_id: null }, 1);
    const arch = await formPost('/app/config/users/archive', [['id', 'user_1'], ['archived', '1']], ck);
    expect(arch.status).toBe(302);
    expect((await getUserById(E, 'user_1'))?.archived_at).not.toBeNull();

    const owner = (await getOwnerUser(E))!;
    const denied = await formPost('/app/config/users/archive', [['id', owner.id], ['archived', '1']], ck);
    expect(denied.status).toBe(404);
  });

  it('a seção Usuários aparece no /app/config com os perfis', async () => {
    const ck = await cookie();
    await createUser(E, { id: 'user_1', name: 'Bruno Castro', type: 'agent', bio: null, api_key_id: null }, 1);
    const res = await SELF.fetch('https://x/app/config', { headers: { cookie: ck } });
    const html = await res.text();
    expect(html).toContain('id="users"');
    expect(html).toContain('Bruno Castro');
    expect(html).toContain('/app/config/users/create');
  });
});

describe('avatar (R2/MEDIA)', () => {
  beforeEach(reset);

  it('upload multipart grava no R2 e o GET serve com o mime; remove limpa', async () => {
    const ck = await cookie();
    await createUser(E, { id: 'user_1', name: 'Ana', type: 'person', bio: null, api_key_id: null }, 1);

    const fd = new FormData();
    fd.append('id', 'user_1');
    fd.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'foto.png', { type: 'image/png' }));
    const up = await SELF.fetch('https://x/app/config/users/avatar', {
      method: 'POST', headers: { cookie: ck }, body: fd, redirect: 'manual',
    });
    expect(up.status).toBe(302);
    expect((await getUserById(E, 'user_1'))?.avatar_key).toBe('avatars/user_1');

    const got = await SELF.fetch('https://x/app/users/user_1/avatar', { headers: { cookie: ck } });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');

    const rm = await formPost('/app/config/users/avatar', [['id', 'user_1'], ['remove', '1']], ck);
    expect(rm.status).toBe(302);
    expect((await getUserById(E, 'user_1'))?.avatar_key).toBeNull();
    const gone = await SELF.fetch('https://x/app/users/user_1/avatar', { headers: { cookie: ck } });
    expect(gone.status).toBe(404);
  });

  it('mime não suportado → 415; sem foto → 404', async () => {
    const ck = await cookie();
    await createUser(E, { id: 'user_1', name: 'Ana', type: 'person', bio: null, api_key_id: null }, 1);
    const fd = new FormData();
    fd.append('id', 'user_1');
    fd.append('file', new File(['x'], 'x.txt', { type: 'text/plain' }));
    const bad = await SELF.fetch('https://x/app/config/users/avatar', {
      method: 'POST', headers: { cookie: ck }, body: fd, redirect: 'manual',
    });
    expect(bad.status).toBe(415);
    const none = await SELF.fetch('https://x/app/users/user_1/avatar', { headers: { cookie: ck } });
    expect(none.status).toBe(404);
  });
});

describe('POST /app/tasks/assignees (sidebar do detalhe)', () => {
  beforeEach(reset);

  it('replace-set via checkboxes; sem user_ids limpa; redireciona pro detalhe', async () => {
    const ck = await cookie();
    await seedTask('t1');
    await createUser(E, { id: 'user_a', name: 'Ana Almeida', type: 'person', bio: null, api_key_id: null }, 1);
    await createUser(E, { id: 'user_b', name: 'Bruno Castro', type: 'person', bio: null, api_key_id: null }, 2);

    const set = await formPost('/app/tasks/assignees', [['task_id', 't1'], ['user_ids', 'user_a'], ['user_ids', 'user_b']], ck);
    expect(set.status).toBe(302);
    expect(set.headers.get('location')).toBe('/app/tasks/t1');
    expect((await listAssigneesForTask(E, 't1')).map((a) => a.id).sort()).toEqual(['user_a', 'user_b']);

    const clear = await formPost('/app/tasks/assignees', [['task_id', 't1']], ck);
    expect(clear.status).toBe(302);
    expect(await listAssigneesForTask(E, 't1')).toEqual([]);
  });

  it('novo arquivado é rejeitado; MANTER arquivado que já era assignee pode', async () => {
    const ck = await cookie();
    await seedTask('t1');
    await createUser(E, { id: 'user_x', name: 'Xavier', type: 'agent', bio: null, api_key_id: null }, 1);
    await setTaskAssignees(E, 't1', ['user_x'], 5);
    await setUserArchived(E, 'user_x', 999);

    // manter o arquivado existente: ok
    const keep = await formPost('/app/tasks/assignees', [['task_id', 't1'], ['user_ids', 'user_x']], ck);
    expect(keep.status).toBe(302);

    // atribuir arquivado a OUTRA task: 400
    await seedTask('t2');
    const deny = await formPost('/app/tasks/assignees', [['task_id', 't2'], ['user_ids', 'user_x']], ck);
    expect(deny.status).toBe(400);
  });

  it('task inexistente → 404; detalhe da task renderiza o picker de responsáveis', async () => {
    const ck = await cookie();
    const notFound = await formPost('/app/tasks/assignees', [['task_id', 'nada'], ['user_ids', 'x']], ck);
    expect(notFound.status).toBe(404);

    await seedTask('t1');
    await createUser(E, { id: 'user_a', name: 'Ana Almeida', type: 'person', bio: null, api_key_id: null }, 1);
    await setTaskAssignees(E, 't1', ['user_a'], 5);
    const page = await SELF.fetch('https://x/app/tasks/t1', { headers: { cookie: ck } });
    const html = await page.text();
    expect(html).toContain('Responsáveis');
    expect(html).toContain('Ana Almeida');
    expect(html).toContain('/app/tasks/assignees');
  });

  it('picker de responsáveis (spec 74): dots + popover <details> com checkboxes, avatar/inicial e selo de agente', async () => {
    const ck = await cookie();
    await seedTask('t1');
    await createUser(E, { id: 'user_a', name: 'Ana Almeida', type: 'person', bio: null, api_key_id: null }, 1);
    await createUser(E, { id: 'user_x', name: 'Xavier Bot', type: 'agent', bio: null, api_key_id: null }, 2);
    await setTaskAssignees(E, 't1', ['user_a'], 5);
    const page = await SELF.fetch('https://x/app/tasks/t1', { headers: { cookie: ck } });
    const html = await page.text();
    // dots (assigneeDotsHtml) + popover nativo — abre/fecha sem JS
    expect(html).toContain('data-assignees-picker');
    expect(html).toContain('<details class="task-assignees-picker"');
    expect(html).toContain('class="task-assignees"');
    expect(html).toContain('task-assignees-addbtn');
    // form de checkboxes preservado (compat + fallback sem JS) na MESMA rota
    expect(html).toContain('data-assignees-form');
    expect(html).toContain('action="/app/tasks/assignees"');
    expect(html).toContain('name="user_ids" value="user_a" checked');
    expect(html).toContain('name="user_ids" value="user_x"');
    expect(html).toContain('agente'); // selo de tipo agente na opção
    expect(html).toContain('data-assignees-save');
    expect(html).toContain('data-assignees-cancel');
  });

  it('picker de responsáveis: usuário arquivado some da lista, exceto se já for assignee', async () => {
    const ck = await cookie();
    await seedTask('t1');
    await createUser(E, { id: 'user_old', name: 'Usuário Antigo', type: 'person', bio: null, api_key_id: null }, 1);
    await setTaskAssignees(E, 't1', ['user_old'], 5);
    await setUserArchived(E, 'user_old', 999);
    await createUser(E, { id: 'user_new_archived', name: 'Nunca Atribuído', type: 'person', bio: null, api_key_id: null }, 2);
    await setUserArchived(E, 'user_new_archived', 999);

    const page = await SELF.fetch('https://x/app/tasks/t1', { headers: { cookie: ck } });
    const html = await page.text();
    // arquivado que JÁ é assignee aparece (esmaecido, opt-out manual)
    expect(html).toContain('Usuário Antigo');
    expect(html).toContain('class="task-assignees-opt archived"');
    // arquivado que NUNCA foi assignee desta task não aparece pra atribuição nova
    expect(html).not.toContain('Nunca Atribuído');
  });

  it('Criado por: carimbo read-only com o usuário resolvido do PAT criador', async () => {
    const ck = await cookie();
    await seedKey('key_vps', 'claude-vps');
    await createUser(E, { id: 'user_vps', name: 'Claude VPS', type: 'agent', bio: null, api_key_id: 'key_vps' }, 1);
    await insertTask(E, {
      id: 'tcb', title: 'Task com autoria', body: 'b', tldr: 'Task com autoria',
      domains: '["operations"]', status: 'open' as any, due_at: null, priority: null,
      created_at: 1, updated_at: 1,
    }, 'key_vps');
    const page = await SELF.fetch('https://x/app/tasks/tcb', { headers: { cookie: ck } });
    const html = await page.text();
    expect(html).toContain('class="task-createdby"');
    expect(html).toContain('Claude VPS');
    expect(html).toContain('não editável'); // tooltip: carimbo automático, sem form
    // task SEM created_by (pré-0012) omite a seção (o seletor no CSS inline não conta)
    await seedTask('t2');
    const old = await (await SELF.fetch('https://x/app/tasks/t2', { headers: { cookie: ck } })).text();
    expect(old).not.toContain('class="task-createdby"');
  });
});

describe('board /app/tasks/data ecoa assignees', () => {
  beforeEach(reset);

  it('cada task do board traz assignees [{id,name,type,avatar}]', async () => {
    const ck = await cookie();
    // Colunas default pro board alocar a task.
    await E.DB.exec('DELETE FROM kanban_columns');
    await E.DB.prepare(
      `INSERT INTO kanban_columns (id, label, color, position, category, archived_at) VALUES ('col_aberto','A fazer',NULL,1,'open',NULL)`
    ).run();
    await seedTask('t1');
    await createUser(E, { id: 'user_a', name: 'Ana Almeida', type: 'person', bio: null, api_key_id: null }, 1);
    await setTaskAssignees(E, 't1', ['user_a'], 5);

    const res = await SELF.fetch('https://x/app/tasks/data', { headers: { cookie: ck } });
    const data = (await res.json()) as any;
    const card = data.columns.flatMap((c: any) => c.tasks).find((t: any) => t.id === 't1');
    expect(card.assignees).toEqual([{ id: 'user_a', name: 'Ana Almeida', type: 'person', avatar: false }]);
  });

  it('card SSR sem responsável mostra o slot vazio (campo sempre visível)', async () => {
    const ck = await cookie();
    await E.DB.exec('DELETE FROM kanban_columns');
    await E.DB.prepare(
      `INSERT INTO kanban_columns (id, label, color, position, category, archived_at) VALUES ('col_aberto','A fazer',NULL,1,'open',NULL)`
    ).run();
    await seedTask('t1'); // sem assignee
    const page = await SELF.fetch('https://x/app/tasks', { headers: { cookie: ck } });
    const html = await page.text();
    expect(html).toContain('assignee-dot-empty');
    expect(html).toContain('Sem responsável');
  });
});
