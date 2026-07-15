// Claim/lease + comentários tipados + fila "aguardando o dono" (spec
// 80-frota-agentes/88). Cobre: atomicidade do claim (corrida perde com erro
// orientado), lease vencido = livre, renovação, release, complete limpa claim,
// filtro available/awaiting_owner do list_tasks, kind derivado do prefixo e a
// contagem que alimenta o push.
import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import type { AuthContext } from '../../src/env.js';
import { OWNER_TASK_VIS } from '../../src/auth/visibility.js';
import {
  insertTask, addTaskComment, createUser,
  claimTask, releaseTaskClaim, clearTaskClaim, claimActive,
  listTasksAwaitingOwner, countTasksAwaitingOwner,
} from '../../src/db/queries.js';
import { registerClaimTask } from '../../src/mcp/tools/claim-task.js';
import { registerCommentTask } from '../../src/mcp/tools/comment-task.js';
import { registerCompleteTask } from '../../src/mcp/tools/complete-task.js';
import { registerGetTask } from '../../src/mcp/tools/get-task.js';
import { registerListTasks } from '../../src/mcp/tools/list-tasks.js';
import { registerUpdateTaskDeps } from '../../src/mcp/tools/update-task-deps.js';

const E = env as any;

// Dois PATs vinculados a dois users de agente (spec 81) — a identidade do claim.
const PAT_A: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'key_a' };
const PAT_B: AuthContext = { email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'key_b' };

function reg(auth?: AuthContext) {
  const r: any = {};
  const server = { registerTool: (n: string, _m: any, h: any) => { r[n] = h; } } as any;
  registerClaimTask(server, E, auth);
  registerCommentTask(server, E, auth);
  registerCompleteTask(server, E, auth as any);
  registerGetTask(server, E, auth);
  registerListTasks(server, E, auth);
  registerUpdateTaskDeps(server, E, auth);
  return r;
}

const parse = (res: any) => JSON.parse(res.content[0].text);

async function seedTask(id: string, status: 'open' | 'in_progress' | 'done' = 'open') {
  const now = Date.now();
  await insertTask(E, {
    id, title: id, body: 'corpo', tldr: id, domains: '["operations"]',
    status, due_at: null, priority: null, created_at: now, updated_at: now,
    completed_at: status === 'done' ? now : null,
  });
}

async function seedAgents() {
  for (const [key, user, name] of [['key_a', 'user_a', 'Agente A'], ['key_b', 'user_b', 'Agente B']] as const) {
    await E.DB.prepare(
      `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at) VALUES (?,?,?,?,?,?)`
    ).bind(key, 'o@x', name, `eb_pat_${key}`, `h_${key}`, 1).run();
    await createUser(E, { id: user, name, type: 'agent', bio: null, api_key_id: key }, 1);
  }
}

beforeEach(async () => {
  await runMigrations(E);
  await E.DB.exec('DELETE FROM task_comments');
  await E.DB.exec('DELETE FROM users WHERE is_owner = 0');
  await E.DB.exec('DELETE FROM notes');
  await E.DB.exec('DELETE FROM api_keys');
});

describe('migration 0027', () => {
  it('colunas de claim em notes e kind em task_comments (aditivas)', async () => {
    const notes = (await E.DB.prepare(`PRAGMA table_info(notes)`).all()).results.map((r: any) => r.name);
    expect(notes).toEqual(expect.arrayContaining(['claimed_by', 'claimed_at', 'claim_expires_at']));
    const comments = (await E.DB.prepare(`PRAGMA table_info(task_comments)`).all()).results.map((r: any) => r.name);
    expect(comments).toContain('kind');
  });
});

describe('claim_task (MCP)', () => {
  it('claim ganha, corrida perde com erro orientado nomeando o detentor', async () => {
    await seedAgents();
    await seedTask('t1');
    const a = await reg(PAT_A).claim_task({ task_id: 't1' });
    const pa = parse(a);
    expect(pa.claimed).toBe(true);
    expect(pa.holder.id).toBe('user_a');
    expect(pa.expires_at).toBeGreaterThan(Date.now());

    const b = await reg(PAT_B).claim_task({ task_id: 't1' });
    expect(b.isError).toBe(true);
    expect(b.content[0].text).toContain('Agente A');
    expect(b.content[0].text).toContain('available:true');
  });

  it('lease vencido = livre: outro agente claima sem cerimônia', async () => {
    await seedAgents();
    await seedTask('t1');
    // Lease já vencido, gravado direto (o tool não permite minutes<1).
    const won = await claimTask(E, 't1', 'user_a', Date.now() - 120_000, 60_000);
    expect(won).toBe(true);
    const b = await reg(PAT_B).claim_task({ task_id: 't1' });
    expect(parse(b).holder.id).toBe('user_b');
  });

  it('re-claim do próprio detentor RENOVA o lease', async () => {
    await seedAgents();
    await seedTask('t1');
    const first = parse(await reg(PAT_A).claim_task({ task_id: 't1', minutes: 5 }));
    const second = parse(await reg(PAT_A).claim_task({ task_id: 't1', minutes: 120 }));
    expect(second.claimed).toBe(true);
    expect(second.expires_at).toBeGreaterThan(first.expires_at);
  });

  it('release: detentor solta; task livre é no-op ok; não-detentor erra', async () => {
    await seedAgents();
    await seedTask('t1');
    await reg(PAT_A).claim_task({ task_id: 't1' });
    const notHolder = await reg(PAT_B).claim_task({ task_id: 't1', release: true });
    expect(notHolder.isError).toBe(true);
    const released = parse(await reg(PAT_A).claim_task({ task_id: 't1', release: true }));
    expect(released.released).toBe(true);
    // Livre: soltar de novo (por qualquer um) é no-op ok — idempotente.
    const again = parse(await reg(PAT_B).claim_task({ task_id: 't1', release: true }));
    expect(again.released).toBe(true);
  });

  it('task done não é claimável; PAT sem perfil vinculado é rejeitado', async () => {
    await seedAgents();
    await seedTask('td', 'done');
    const done = await reg(PAT_A).claim_task({ task_id: 'td' });
    expect(done.isError).toBe(true);
    await seedTask('t1');
    const orphan = await reg({ email: 'o@x', loggedInAt: 0, scopes: 'full', keyId: 'key_orfao' }).claim_task({ task_id: 't1' });
    expect(orphan.isError).toBe(true);
    expect(orphan.content[0].text).toContain('linked user profile');
  });

  it('complete_task limpa o claim', async () => {
    await seedAgents();
    await seedTask('t1');
    await reg(PAT_A).claim_task({ task_id: 't1' });
    await reg(PAT_A).complete_task({ id: 't1' });
    const row = await E.DB.prepare(`SELECT claimed_by, claim_expires_at FROM notes WHERE id='t1'`).first();
    expect(row.claimed_by).toBeNull();
    expect(row.claim_expires_at).toBeNull();
  });

  it('get_task expõe claim ativo com nome; lease vencido some (null)', async () => {
    await seedAgents();
    await seedTask('t1');
    await reg(PAT_A).claim_task({ task_id: 't1' });
    const withClaim = parse(await reg(PAT_B).get_task({ id: 't1' }));
    expect(withClaim.claim.user).toEqual({ id: 'user_a', name: 'Agente A', type: 'agent' });
    await clearTaskClaim(E, 't1');
    await claimTask(E, 't1', 'user_a', Date.now() - 120_000, 60_000); // vencido
    const expired = parse(await reg(PAT_B).get_task({ id: 't1' }));
    expect(expired.claim).toBeNull();
  });

  it('list_tasks: claim por item + filtro available (livre, vencida ou MINHA)', async () => {
    await seedAgents();
    await seedTask('livre');
    await seedTask('minha');
    await seedTask('dela');
    await seedTask('vencida');
    await reg(PAT_A).claim_task({ task_id: 'minha' });
    await reg(PAT_B).claim_task({ task_id: 'dela' });
    await claimTask(E, 'vencida', 'user_b', Date.now() - 120_000, 60_000);

    const all = parse(await reg(PAT_A).list_tasks({}));
    const byId = Object.fromEntries(all.tasks.map((t: any) => [t.id, t.claim]));
    expect(byId['livre']).toBeNull();
    expect(byId['minha'].by).toBe('user_a');
    expect(byId['dela'].by).toBe('user_b');
    expect(byId['vencida']).toBeNull();

    const avail = parse(await reg(PAT_A).list_tasks({ available: true }));
    expect(avail.tasks.map((t: any) => t.id).sort()).toEqual(['livre', 'minha', 'vencida']);
  });

  it('available exclui task bloqueada por dependência (spec 93), mesmo sem claim', async () => {
    await seedAgents();
    await seedTask('bloqueada');
    await seedTask('bloqueadora', 'open');
    await seedTask('livre');
    await reg(PAT_A).update_task_deps({ task_id: 'bloqueada', block_on: ['bloqueadora'] });

    const before = parse(await reg(PAT_A).list_tasks({ available: true }));
    expect(before.tasks.map((t: any) => t.id).sort()).toEqual(['bloqueadora', 'livre']);

    const withBlockedFlag = parse(await reg(PAT_A).list_tasks({}));
    const byId = Object.fromEntries(withBlockedFlag.tasks.map((t: any) => [t.id, t.blocked]));
    expect(byId['bloqueada']).toBe(true);
    expect(byId['bloqueadora']).toBe(false);
    expect(byId['livre']).toBe(false);

    // bloqueadora fecha (some da base ativa open+in_progress) → a bloqueada volta a
    // aparecer em available.
    await E.DB.prepare(`UPDATE notes SET status='done' WHERE id='bloqueadora'`).run();
    const after = parse(await reg(PAT_A).list_tasks({ available: true }));
    expect(after.tasks.map((t: any) => t.id).sort()).toEqual(['bloqueada', 'livre']);
  });
});

describe('comentários tipados + fila aguardando o dono (spec 88)', () => {
  it('kind deriva do prefixo [bloqueio]; explícito vence o prefixo', async () => {
    await seedAgents();
    await seedTask('t1');
    const r = reg(PAT_A);
    const fromPrefix = parse(await r.comment_task({ task_id: 't1', body: '[bloqueio] @Eric decidir X' }));
    expect(fromPrefix.kind).toBe('bloqueio');
    const explicit = parse(await r.comment_task({ task_id: 't1', body: '[info] na real é entrega', kind: 'entrega' }));
    expect(explicit.kind).toBe('entrega');
    const plain = parse(await r.comment_task({ task_id: 't1', body: 'comentário comum' }));
    expect(plain.kind).toBeNull();
    const thread = parse(await r.get_task({ id: 't1' }));
    expect(thread.comments.map((c: any) => c.kind)).toEqual(['bloqueio', 'entrega', null]);
  });

  it('bloqueio sem resposta entra na fila; resposta do OWNER limpa', async () => {
    await seedAgents();
    await seedTask('t1');
    await seedTask('t2');
    await reg(PAT_A).comment_task({ task_id: 't1', body: '[bloqueio] preciso de OK' });
    expect(await countTasksAwaitingOwner(E)).toBe(1);
    expect((await listTasksAwaitingOwner(E, OWNER_TASK_VIS)).map((t) => t.id)).toEqual(['t1']);
    // Filtro do list_tasks (a fila de aprovação do dono).
    const q = parse(await reg(PAT_B).list_tasks({ awaiting_owner: true }));
    expect(q.tasks.map((t: any) => t.id)).toEqual(['t1']);
    // Owner responde no thread → sai da fila (qualquer comentário dele).
    await addTaskComment(E, {
      id: 'c_own', task_id: 't1', author: 'owner', author_name: null,
      body: 'aprovado, segue', created_at: Date.now() + 1,
    });
    expect(await countTasksAwaitingOwner(E)).toBe(0);
    // Novo bloqueio DEPOIS da resposta reabre.
    await addTaskComment(E, {
      id: 'c_b2', task_id: 't1', author: 'agent', author_name: null,
      body: '[bloqueio] travou de novo', created_at: Date.now() + 2, kind: 'bloqueio',
    });
    expect(await countTasksAwaitingOwner(E)).toBe(1);
  });

  it('task done com bloqueio pendente NÃO polui a fila', async () => {
    await seedAgents();
    await seedTask('t1');
    await reg(PAT_A).comment_task({ task_id: 't1', body: '[bloqueio] X' });
    await reg(PAT_A).complete_task({ id: 't1' });
    expect(await countTasksAwaitingOwner(E)).toBe(0);
  });

  it('claimActive: helper avalia lease na leitura', () => {
    const now = 1000;
    expect(claimActive({ claimed_by: 'u', claim_expires_at: 2000 }, now)).toBe(true);
    expect(claimActive({ claimed_by: 'u', claim_expires_at: 999 }, now)).toBe(false);
    expect(claimActive({ claimed_by: null, claim_expires_at: null }, now)).toBe(false);
  });

  it('releaseTaskClaim só solta do detentor', async () => {
    await seedTask('t1');
    await claimTask(E, 't1', 'user_a', Date.now(), 60_000);
    expect(await releaseTaskClaim(E, 't1', 'user_b')).toBe(false);
    expect(await releaseTaskClaim(E, 't1', 'user_a')).toBe(true);
  });
});
