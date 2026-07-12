import { env, SELF } from 'cloudflare:test';
import { taskVisPublic } from '../../src/auth/visibility.js';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { signSession } from '../../src/web/session.js';
import { registerListTasks } from '../../src/mcp/tools/list-tasks.js';
import { registerListTasksDueToday } from '../../src/mcp/tools/list-tasks-due-today.js';
import { registerGetTask } from '../../src/mcp/tools/get-task.js';
import { registerSaveTask } from '../../src/mcp/tools/save-task.js';
import { registerUpdateTask } from '../../src/mcp/tools/update-task.js';
import { registerShareTask } from '../../src/mcp/tools/share-task.js';
import { createShare, resolveShare } from '../../src/web/share.js';
import { getTaskById, setTaskPrivate, listTasksDueBefore } from '../../src/db/queries.js';
import type { AuthContext } from '../../src/env.js';

// Suíte do SELO DE PRIVACIDADE DE TASK (spec 50-console-v2/59): teste de vazamento POR
// SUPERFÍCIE. Uma task `private = 1` NUNCA pode aparecer (nem em contagem) pra uma
// credencial sem o escopo `private`, em NENHUM read path de task (list_tasks com/sem
// query/status/tag, list_tasks_due_today, get_task). O share público é BLOQUEADO na
// task privada e REVOGADO ao marcar privada; a rota /s/<token> tem `AND private = 0`.
// A sessão do dono e o PAT com escopo `private` veem tudo; o board/cron do dono incluem.
const E = env as any;

// Callers (AuthContext): PAT full SEM private (não vê), PAT full,private (vê), sessão
// OAuth do dono (sem keyId → vê).
const NO_PRIV: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'k_nopriv' };
const WITH_PRIV: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full,private', keyId: 'k_priv' };
const OWNER_OAUTH: AuthContext = { email: 'o@x', loggedInAt: 0 }; // sem keyId = dono logado

function collector() {
  const tools: Record<string, any> = {};
  const server: any = { registerTool: (n: string, _c: any, h: any) => { tools[n] = h; } };
  return { server, tools };
}

const T0 = 1_000_000;
let dueSoon: number;

async function insertTask(
  id: string, title: string, priv: 0 | 1, status: string,
  dueAt: number | null, completedAt: number | null, body: string, tag: string,
): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO notes (id,title,body,tldr,domains,kind,private,status,due_at,priority,completed_at,created_at,updated_at,deleted_at)
     VALUES (?,?,?,?, '["operations"]', 'task', ?, ?, ?, NULL, ?, ?, ?, NULL)`
  ).bind(id, title, body, 'tl', priv, status, dueAt, completedAt, T0, T0).run();
  await E.DB.prepare(`INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)`).bind(id, tag).run();
}

// pub1 (open, vence logo) + pub2 (done) públicas; priv1 (open, vence logo) + priv2 (done)
// privadas. Todas com 'quantum' no corpo pra casar no FTS. Tag 'secret' só nas privadas.
async function seed(): Promise<void> {
  dueSoon = Date.now() + 3600_000;
  await insertTask('pub1', 'Public one', 0, 'open', dueSoon, null, 'quantum public body one', 'work');
  await insertTask('pub2', 'Public two', 0, 'done', null, T0, 'quantum public body two', 'work');
  await insertTask('priv1', 'Secret one', 1, 'open', dueSoon, null, 'quantum private body one', 'secret');
  await insertTask('priv2', 'Secret two', 1, 'done', null, T0, 'quantum private body two', 'secret');
}

async function resetDb(): Promise<void> {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM edges');
  await E.DB.exec('DELETE FROM tags');
  await E.DB.exec('DELETE FROM notes');
}

async function privateOf(id: string): Promise<number | null> {
  const r = await E.DB.prepare('SELECT private FROM notes WHERE id = ?').bind(id).first();
  return (r?.private as number | undefined) ?? null;
}
async function shareTokenOf(id: string): Promise<string | null> {
  const r = await E.DB.prepare('SELECT share_token FROM notes WHERE id = ?').bind(id).first();
  return (r?.share_token as string | null | undefined) ?? null;
}

describe('privacidade de task — read paths (vazamento por superfície)', () => {
  beforeEach(async () => {
    await resetDb();
    await seed();
  });

  // ── list_tasks base (ativas) ──────────────────────────────────────────────
  it('list_tasks base: SEM escopo não lista nem conta a privada', async () => {
    const { tools } = (() => { const c = collector(); registerListTasks(c.server, E, NO_PRIV); return c; })();
    const out = JSON.parse((await tools.list_tasks({})).content[0].text);
    const ids = out.tasks.map((t: any) => t.id);
    expect(ids).toContain('pub1');
    expect(ids).not.toContain('priv1');
    expect(out.count).toBe(1);
  });

  it('list_tasks base: COM escopo lista a privada; dono OAuth idem', async () => {
    const c1 = collector(); registerListTasks(c1.server, E, WITH_PRIV);
    const withPriv = JSON.parse((await c1.tools.list_tasks({})).content[0].text);
    expect(withPriv.tasks.map((t: any) => t.id)).toContain('priv1');
    expect(withPriv.count).toBe(2);

    const c2 = collector(); registerListTasks(c2.server, E, OWNER_OAUTH);
    const owner = JSON.parse((await c2.tools.list_tasks({})).content[0].text);
    expect(owner.tasks.map((t: any) => t.id)).toContain('priv1');
  });

  // ── list_tasks include_closed (base ativa + fechadas) ─────────────────────
  it('list_tasks include_closed: SEM escopo esconde as duas privadas', async () => {
    const c = collector(); registerListTasks(c.server, E, NO_PRIV);
    const out = JSON.parse((await c.tools.list_tasks({ include_closed: true })).content[0].text);
    const ids = out.tasks.map((t: any) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['pub1', 'pub2']));
    expect(ids).not.toContain('priv1');
    expect(ids).not.toContain('priv2');
  });

  it('list_tasks include_closed: COM escopo mostra as 4', async () => {
    const c = collector(); registerListTasks(c.server, E, WITH_PRIV);
    const out = JSON.parse((await c.tools.list_tasks({ include_closed: true })).content[0].text);
    const ids = out.tasks.map((t: any) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['pub1', 'pub2', 'priv1', 'priv2']));
  });

  // ── list_tasks ?query (caminho FTS) ───────────────────────────────────────
  it('list_tasks query: SEM escopo o FTS não vaza privada', async () => {
    const c = collector(); registerListTasks(c.server, E, NO_PRIV);
    const out = JSON.parse((await c.tools.list_tasks({ query: 'quantum' })).content[0].text);
    const ids = out.tasks.map((t: any) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['pub1', 'pub2']));
    expect(ids).not.toContain('priv1');
    expect(ids).not.toContain('priv2');
  });

  it('list_tasks query: COM escopo o FTS traz as privadas', async () => {
    const c = collector(); registerListTasks(c.server, E, WITH_PRIV);
    const out = JSON.parse((await c.tools.list_tasks({ query: 'quantum' })).content[0].text);
    expect(out.tasks.map((t: any) => t.id)).toEqual(expect.arrayContaining(['priv1', 'priv2']));
  });

  // ── list_tasks ?status ────────────────────────────────────────────────────
  it("list_tasks status ['done']: SEM escopo não traz a privada fechada", async () => {
    const c = collector(); registerListTasks(c.server, E, NO_PRIV);
    const out = JSON.parse((await c.tools.list_tasks({ status: ['done'] })).content[0].text);
    const ids = out.tasks.map((t: any) => t.id);
    expect(ids).toContain('pub2');
    expect(ids).not.toContain('priv2');
  });

  // ── list_tasks ?tag ───────────────────────────────────────────────────────
  it("list_tasks tag 'secret': SEM escopo = vazio; COM escopo = as 2 privadas", async () => {
    const c1 = collector(); registerListTasks(c1.server, E, NO_PRIV);
    const noPriv = JSON.parse((await c1.tools.list_tasks({ tag: 'secret', include_closed: true })).content[0].text);
    expect(noPriv.count).toBe(0);

    const c2 = collector(); registerListTasks(c2.server, E, WITH_PRIV);
    const withPriv = JSON.parse((await c2.tools.list_tasks({ tag: 'secret', include_closed: true })).content[0].text);
    expect(withPriv.tasks.map((t: any) => t.id)).toEqual(expect.arrayContaining(['priv1', 'priv2']));
  });

  // ── list_tasks_due_today ──────────────────────────────────────────────────
  it('list_tasks_due_today: SEM escopo não conta a privada que vence', async () => {
    const c = collector(); registerListTasksDueToday(c.server, E, NO_PRIV);
    const out = JSON.parse((await c.tools.list_tasks_due_today({})).content[0].text);
    const ids = out.tasks.map((t: any) => t.id);
    expect(ids).toContain('pub1');
    expect(ids).not.toContain('priv1');
    expect(out.count).toBe(1);
  });

  it('list_tasks_due_today: COM escopo conta a privada que vence', async () => {
    const c = collector(); registerListTasksDueToday(c.server, E, WITH_PRIV);
    const out = JSON.parse((await c.tools.list_tasks_due_today({})).content[0].text);
    expect(out.tasks.map((t: any) => t.id)).toEqual(expect.arrayContaining(['pub1', 'priv1']));
    expect(out.count).toBe(2);
  });

  // ── get_task ──────────────────────────────────────────────────────────────
  it('get_task(priv): SEM escopo = mesmo "not found" de task inexistente', async () => {
    const c = collector(); registerGetTask(c.server, E, NO_PRIV);
    const res = await c.tools.get_task({ id: 'priv1' });
    expect(res.isError).toBe(true);
    // Indistinguível de inexistente: a mensagem é byte-idêntica à de um id ausente
    // (só troca o id ecoado) — nada denuncia que priv1 existe.
    const ghost = await c.tools.get_task({ id: 'priv1x' });
    expect(res.content[0].text).toBe(ghost.content[0].text.replace('priv1x', 'priv1'));
    expect(res.content[0].text).not.toMatch(/privad|private|scope|escopo/i);
  });

  it('get_task(priv): COM escopo retorna a task com private:true', async () => {
    const c = collector(); registerGetTask(c.server, E, WITH_PRIV);
    const res = await c.tools.get_task({ id: 'priv1' });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.id).toBe('priv1');
    expect(parsed.private).toBe(true);
  });

  it('get_task(pub): SEM escopo funciona normalmente', async () => {
    const c = collector(); registerGetTask(c.server, E, NO_PRIV);
    const res = await c.tools.get_task({ id: 'pub1' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text).private).toBe(false);
  });

  // ── query-level (listTasksDueBefore) ──────────────────────────────────────
  it('listTasksDueBefore: includePrivate=false esconde a privada; true a revela', async () => {
    const beforeMs = Date.now() + 24 * 3600_000;
    const without = await listTasksDueBefore(E, beforeMs, taskVisPublic(false));
    expect(without.map((t) => t.id)).toContain('pub1');
    expect(without.map((t) => t.id)).not.toContain('priv1');
    const withPriv = await listTasksDueBefore(E, beforeMs, taskVisPublic(true));
    expect(withPriv.map((t) => t.id)).toContain('priv1');
  });
});

describe('privacidade de task — share público', () => {
  beforeEach(async () => {
    await resetDb();
    await seed();
  });

  it('createShare numa task privada → reason "private" e nada persiste', async () => {
    const res = await createShare(E, 'priv1', {}, Date.now());
    expect(res.ok).toBe(false);
    expect((res as any).reason).toBe('private');
    expect(await shareTokenOf('priv1')).toBeNull();
  });

  it('share_task (tool) em privada: SEM escopo = not found (anti-oráculo); COM escopo = erro PRIVATE; pública cria link', async () => {
    // Pre-check de visibilidade (spec 91): caller sem escopo private nem descobre que
    // a task existe — antes o erro "is PRIVATE" vazava existência + status.
    const c0 = collector(); registerShareTask(c0.server, E, NO_PRIV);
    const ghost = await c0.tools.share_task({ id: 'priv1' });
    expect(ghost.isError).toBe(true);
    expect(ghost.content[0].text).not.toMatch(/PRIVATE/);
    expect(ghost.content[0].text).toMatch(/not found/);

    // Quem VÊ a privada ainda não pode compartilhá-la (selo da spec 59, intocado).
    const c = collector(); registerShareTask(c.server, E, WITH_PRIV);
    const err = await c.tools.share_task({ id: 'priv1' });
    expect(err.isError).toBe(true);
    expect(err.content[0].text).toMatch(/PRIVATE/);
    expect(await shareTokenOf('priv1')).toBeNull();

    const ok = await c.tools.share_task({ id: 'pub1' });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content[0].text).url).toMatch(/\/s\/ebs_/);
  });

  it('share_task (tool) numa NOTA de conhecimento por id → not found (kind gate, spec 91)', async () => {
    await E.DB.prepare(
      `INSERT INTO notes (id,title,body,tldr,domains,kind,private,created_at,updated_at)
       VALUES ('note1','Nota','corpo','tl','["operations"]','insight',0,?,?)`
    ).bind(T0, T0).run();
    const c = collector(); registerShareTask(c.server, E, WITH_PRIV);
    const res = await c.tools.share_task({ id: 'note1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found|not a task/);
    expect(await shareTokenOf('note1')).toBeNull();
  });

  it('marcar privada (setTaskPrivate) revoga o share vivo na mesma escrita → /s/<token> 404', async () => {
    const share = await createShare(E, 'pub1', {}, Date.now());
    expect(share.ok).toBe(true);
    const token = (share as any).token as string;
    expect(await shareTokenOf('pub1')).not.toBeNull();
    // sanidade: enquanto pública, o link resolve
    expect(await resolveShare(E, token, Date.now())).not.toBeNull();

    const r = await setTaskPrivate(E, 'pub1', 1, Date.now(), 'oauth:o@x');
    expect(r).toEqual({ ok: true, shareRevoked: true });
    expect(await privateOf('pub1')).toBe(1);
    expect(await shareTokenOf('pub1')).toBeNull();
    // link antigo morre no request seguinte
    expect(await resolveShare(E, token, Date.now())).toBeNull();
  });

  it('setTaskPrivate: sem share vivo → shareRevoked false; id inexistente → ok false', async () => {
    const r1 = await setTaskPrivate(E, 'pub1', 1, Date.now(), null);
    expect(r1).toEqual({ ok: true, shareRevoked: false });
    const r2 = await setTaskPrivate(E, 'nope', 1, Date.now(), null);
    expect(r2).toEqual({ ok: false, shareRevoked: false });
  });

  it('resolveShare: estado forjado (privada + token vivo) responde null (AND private = 0)', async () => {
    const share = await createShare(E, 'pub1', {}, Date.now());
    const token = (share as any).token as string;
    // Força o estado proibido SEM limpar o token (escrita manual no banco).
    await E.DB.prepare(`UPDATE notes SET private = 1 WHERE id = 'pub1'`).run();
    expect(await shareTokenOf('pub1')).not.toBeNull();
    expect(await resolveShare(E, token, Date.now())).toBeNull();
  });
});

describe('privacidade de task — escrita da flag (save/update)', () => {
  beforeEach(async () => {
    await resetDb();
    await seed();
  });

  it('save_task private:true grava private = 1; sem a flag grava 0', async () => {
    const c = collector(); registerSaveTask(c.server, E, WITH_PRIV);
    const priv = JSON.parse((await c.tools.save_task({ title: 'nova privada', private: true })).content[0].text);
    expect(await privateOf(priv.id)).toBe(1);
    expect(priv.private).toBe(true);

    const pub = JSON.parse((await c.tools.save_task({ title: 'nova publica' })).content[0].text);
    expect(await privateOf(pub.id)).toBe(0);
    expect(pub.private).toBe(false);
  });

  it('update_task private:false → erro orientando pra UI logada', async () => {
    const c = collector(); registerUpdateTask(c.server, E, WITH_PRIV);
    const res = await c.tools.update_task({ id: 'pub1', private: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('/app/tasks/pub1');
  });

  it('update_task private:true marca (one-way) e revoga share vivo', async () => {
    const share = await createShare(E, 'pub1', {}, Date.now());
    const token = (share as any).token as string;
    const c = collector(); registerUpdateTask(c.server, E, WITH_PRIV);
    const out = JSON.parse((await c.tools.update_task({ id: 'pub1', private: true })).content[0].text);
    expect(out.private).toBe(true);
    expect(out.share_revoked).toBe(true);
    expect(await privateOf('pub1')).toBe(1);
    expect(await shareTokenOf('pub1')).toBeNull();
    expect(await resolveShare(E, token, Date.now())).toBeNull();
  });

  it('update_task private:true: caller SEM escopo não marca task que não pode ver (= not found)', async () => {
    const c = collector(); registerUpdateTask(c.server, E, NO_PRIV);
    const res = await c.tools.update_task({ id: 'priv1', private: true });
    expect(res.isError).toBe(true);
    // priv1 continua privada (não foi tocada) e não vazou
    expect(res.content[0].text).not.toMatch(/privad|private|scope|escopo/i);
  });

  it('update_task private:true junto de edição de campo aplica os dois', async () => {
    const c = collector(); registerUpdateTask(c.server, E, WITH_PRIV);
    const out = JSON.parse((await c.tools.update_task({ id: 'pub1', priority: 1, private: true })).content[0].text);
    expect(out.priority).toBe(1);
    expect(out.private).toBe(true);
    expect(await privateOf('pub1')).toBe(1);
  });
});

describe('privacidade de task — toggle web POST /app/tasks/private', () => {
  async function cookie(): Promise<string> {
    const token = await signSession(E.OWNER_EMAIL, E.SESSION_SECRET, Math.floor(Date.now() / 1000));
    return `eb_session=${token}`;
  }
  function post(id: string, priv: boolean, ck?: string): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (ck) headers.cookie = ck;
    return SELF.fetch('https://x/app/tasks/private', {
      method: 'POST', headers, body: JSON.stringify({ id, private: priv }), redirect: 'manual',
    });
  }

  beforeEach(async () => {
    await resetDb();
    await seed();
  });

  it('marca e DESMARCA nos dois sentidos com sessão', async () => {
    const ck = await cookie();
    const r1 = await post('pub1', true, ck);
    expect(r1.status).toBe(200);
    expect(await privateOf('pub1')).toBe(1);
    const r2 = await post('pub1', false, ck);
    expect(r2.status).toBe(200);
    expect(await privateOf('pub1')).toBe(0);
  });

  it('marcar privada via web revoga o link público na mesma escrita', async () => {
    const share = await createShare(E, 'pub1', {}, Date.now());
    const token = (share as any).token as string;
    const ck = await cookie();
    const res = await post('pub1', true, ck);
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text()).share_revoked).toBe(true);
    expect(await shareTokenOf('pub1')).toBeNull();
    expect(await resolveShare(E, token, Date.now())).toBeNull();
  });

  it('sem sessão: 401 e NÃO altera o estado (PAT/bearer não têm cookie de sessão)', async () => {
    const res = await post('pub1', true);
    expect(res.status).toBe(401);
    expect(await privateOf('pub1')).toBe(0);
  });

  it('task inexistente com sessão → 404', async () => {
    const ck = await cookie();
    const res = await post('nope', true, ck);
    expect(res.status).toBe(404);
  });
});

describe('privacidade de task — comentário de convidado no link (spec 53)', () => {
  beforeEach(async () => {
    await resetDb();
    await seed();
  });

  it('task que virou privada: GET /s/<token> 404 e POST /s/<token>/comment 404', async () => {
    const share = await createShare(E, 'pub1', {}, Date.now());
    const token = (share as any).token as string;
    // sanidade: público resolve antes
    expect((await SELF.fetch(`https://x/s/${token}`)).status).toBe(200);

    await setTaskPrivate(E, 'pub1', 1, Date.now(), 'oauth:o@x');

    const get = await SELF.fetch(`https://x/s/${token}`);
    expect(get.status).toBe(404);

    const form = new URLSearchParams({ name: 'Alguem', body: 'oi' });
    const postComment = await SELF.fetch(`https://x/s/${token}/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    expect(postComment.status).toBe(404);
  });
});
