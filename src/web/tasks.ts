import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { authorizeBearer } from './bearer-auth.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { assetVersion } from './asset-version.js';
import {
  TASK_STATUSES,
  type TaskStatus,
  type TaskRow,
  type TaskPatch,
  type KanbanColumn,
  listActiveTasks,
  listRecentClosedTasks,
  listTasksDueBefore,
  setTaskStatus,
  completeTask,
  updateTask,
  insertTask,
  getTaskById,
  listKanbanColumns,
  moveTaskToColumn,
  getColumnById,
  createKanbanColumn,
  updateKanbanColumn,
  reorderKanbanColumn,
  setColumnArchived,
  reassignColumn,
  countTasksInColumn,
  countActiveColumnsInCategory,
  addTaskComment,
  deleteTaskComment,
  countTaskCommentsBatch,
} from '../db/queries.js';
import { validateDomains } from '../db/validation.js';
import { createShare, revokeShare } from './share.js';
import { newId } from '../util/id.js';
import { PRIORITIES, priorityMeta, flagSvg } from '../util/priority.js';
import { commentBadge } from '../util/comment-badge.js';
import { formatBrtShort, relativeDue, parseDueToMs, formatBrtDateTime, brtDatetimeLocal, brtDateOnly, brtTimeOnly } from '../util/time.js';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Auth: Bearer (VPS/Console) OU sessão de browser. Igual ao padrão das rotas
// /app/graph/*. Retorna null quando autorizado, ou a Response de erro/redirect.
async function authTask(req: Request, env: Env): Promise<Response | null> {
  if (authorizeBearer(req, env)) return null;
  const session = await requireSession(req, env);
  return session.ok ? null : session.response;
}

interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number | null;
  due_at: number | null;
  due_brt: string | null;
  due_local: string | null; // "2026-06-22T14:00" p/ <input type="datetime-local"> (legado)
  due_date: string | null; // "2026-06-22" p/ <input type="date">
  due_time: string | null; // "14:00" p/ <input type="time"> — '' quando é fim-de-dia-sem-hora
  when: string | null;
  overdue: boolean;
  created_at: number;
  completed_at: number | null;
  updated_at: number; // base do versionamento otimista na edição inline (spec 36)
  comment_count: number; // contagem da thread de comentários (spec 53)
}

function toView(t: TaskRow, now: number, commentCount = 0): TaskView {
  const due = t.due_at ?? null;
  return {
    id: t.id,
    title: t.title,
    status: (t.status as TaskStatus) ?? 'open',
    priority: t.priority,
    due_at: due,
    due_brt: due !== null ? formatBrtShort(due) : null,
    due_local: due !== null ? brtDatetimeLocal(due) : null,
    due_date: due !== null ? brtDateOnly(due) : null,
    due_time: due !== null ? brtTimeOnly(due) : null,
    when: due !== null ? relativeDue(due, now) : null,
    overdue: due !== null && due < now && t.status !== 'done' && t.status !== 'canceled',
    created_at: t.created_at,
    completed_at: t.completed_at,
    updated_at: t.updated_at,
    comment_count: commentCount,
  };
}

// Uma coluna do board já com as tasks resolvidas (spec 51). Substitui o objeto
// fixo { open, in_progress, done } — as colunas agora vêm do banco.
interface BoardColumn {
  id: string;
  label: string;
  color: string | null;
  position: number;
  category: TaskStatus;
  tasks: TaskView[];
}

// Monta o board a partir das colunas ATIVAS do banco + tasks ativas e fechadas
// recentes. Cada task é alocada na coluna do seu column_id (quando ativa e coerente
// com o status) ou, como fallback, na coluna default (menor position) da categoria
// do status — assim uma task com column_id NULL/órfão nunca some do board. Tasks
// cuja categoria não tem NENHUMA coluna ativa (ex.: canceladas com col_cancelado
// arquivado) simplesmente não renderizam, mantendo o comportamento histórico do board.
async function buildBoard(env: Env, now: number): Promise<BoardColumn[]> {
  const [activeCols, active, closed] = await Promise.all([
    listKanbanColumns(env, false),
    listActiveTasks(env),
    listRecentClosedTasks(env, 100),
  ]);
  const activeById = new Map<string, KanbanColumn>(activeCols.map((c) => [c.id, c]));
  // Primeira coluna ativa (menor position) por categoria — activeCols já vem ordenado.
  const defaultByCat = new Map<string, KanbanColumn>();
  for (const c of activeCols) if (!defaultByCat.has(c.category)) defaultByCat.set(c.category, c);

  // Contagem de comentários em lote (spec 53): 1 query (chunked) pro board inteiro,
  // nunca N+1. Cobre tasks ativas + fechadas recentes que serão renderizadas.
  const commentCounts = await countTaskCommentsBatch(
    env, [...active, ...closed].map((t) => t.id)
  );

  const buckets = new Map<string, TaskView[]>();
  for (const c of activeCols) buckets.set(c.id, []);

  const place = (t: TaskRow) => {
    const status = t.status ?? 'open';
    let colId: string | null = null;
    const assigned = t.column_id ? activeById.get(t.column_id) : undefined;
    if (assigned && assigned.category === status) colId = assigned.id;
    else colId = defaultByCat.get(status)?.id ?? null;
    if (colId) buckets.get(colId)?.push(toView(t, now, commentCounts.get(t.id) ?? 0));
  };
  for (const t of active) place(t);
  for (const t of closed) place(t);

  return activeCols.map((c) => ({
    id: c.id,
    label: c.label,
    color: c.color,
    position: c.position,
    category: c.category as TaskStatus,
    tasks: buckets.get(c.id) ?? [],
  }));
}

// Total de tasks abertas (categorias open + in_progress) no board — pro contador do
// header, sempre sem filtro de vencimento.
function countOpenOnBoard(columns: BoardColumn[]): number {
  return columns
    .filter((c) => c.category === 'open' || c.category === 'in_progress')
    .reduce((n, c) => n + c.tasks.length, 0);
}

// GET /app/tasks/data — board (default) ou due-soon (?scope=due&horizon_hours=N).
export async function handleTasksData(req: Request, env: Env): Promise<Response> {
  const denied = await authTask(req, env);
  if (denied) return denied;

  const url = new URL(req.url);
  const scope = url.searchParams.get('scope') ?? 'board';
  const now = Date.now();

  if (scope === 'due') {
    const horizon = Math.min(Math.max(Number(url.searchParams.get('horizon_hours')) || 24, 1), 168);
    const rows = await listTasksDueBefore(env, now + horizon * 3600_000);
    return json({ now, horizon_hours: horizon, tasks: rows.map((t) => toView(t, now)) });
  }

  const columns = await buildBoard(env, now);
  return json({ now, columns });
}

// POST /app/tasks/move — { id, column_id }. Move um card pra uma coluna do Kanban
// (drag & drop). moveTaskToColumn resolve a coluna, seta column_id + status =
// category + completed_at coerente. Aceita Bearer OU sessão (igual /status). Substitui
// /status como o caminho primário do board (o /status segue aceito p/ compat).
export async function handleTaskMovePost(req: Request, env: Env): Promise<Response> {
  const denied = await authTask(req, env);
  if (denied) return denied;
  let body: { id?: string; column_id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const id = (body.id || '').trim();
  const columnId = (body.column_id || '').trim();
  if (!id) return json({ error: 'id required' }, 400);
  if (!columnId) return json({ error: 'column_id required' }, 400);
  const result = await moveTaskToColumn(env, id, columnId, Date.now());
  if (result === 'column-not-found') return json({ error: 'column not found' }, 404);
  if (result === 'not-found') return json({ error: 'task not found' }, 404);
  return json({ ok: true, id, column_id: columnId, status: result.status });
}

// POST /app/tasks/status — { id, status }
export async function handleTaskStatusPost(req: Request, env: Env): Promise<Response> {
  const denied = await authTask(req, env);
  if (denied) return denied;
  let body: { id?: string; status?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const id = (body.id || '').trim();
  const status = (body.status || '').trim() as TaskStatus;
  if (!id) return json({ error: 'id required' }, 400);
  if (!TASK_STATUSES.includes(status)) {
    return json({ error: `status must be one of ${TASK_STATUSES.join(', ')}` }, 400);
  }
  const ok = await setTaskStatus(env, id, status, Date.now());
  if (!ok) return json({ error: 'task not found' }, 404);
  return json({ ok: true, id, status });
}

// POST /app/tasks/complete — { id, outcome? }
export async function handleTaskCompletePost(req: Request, env: Env): Promise<Response> {
  const denied = await authTask(req, env);
  if (denied) return denied;
  let body: { id?: string; outcome?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const id = (body.id || '').trim();
  if (!id) return json({ error: 'id required' }, 400);
  // completeTask agora devolve a task OU um sentinel de controle (spec 14):
  // 'not-found' | 'conflict' | 'already-done'. O board não usa versionamento
  // otimista (sem expected_updated_at), então 'conflict' não ocorre aqui;
  // 'already-done' é um no-op idempotente que também terminou como done.
  const result = await completeTask(env, id, Date.now(), body.outcome);
  if (result === 'not-found') return json({ error: 'task not found' }, 404);
  return json({ ok: true, id, status: 'done' });
}

// POST /app/tasks/update — edição inline de task pela UI (spec 36, fase 1).
// Body: { id, patch: { title?, body?, due?, priority?, status?, domains? }, expected_updated_at? }.
//   - `due`: string BRT ("2026-06-22 14:00" / "2026-06-22T14:00" / "2026-06-22")
//     OU null pra LIMPAR o prazo. Omitir mantém. Reusa parseDueToMs (mesma regra
//     que update_task MCP — nada de parse próprio).
//   - `priority`: 1-4 OU null pra remover.
//   - `status`: um de TASK_STATUSES.
//   - `expected_updated_at`: versionamento otimista — o updated_at que a página
//     leu. Se a task mudou desde então, updateTask devolve 'conflict' → 409 aqui.
// Toda a validação/patch espelha `update_task` (src/mcp/tools/update-task.ts):
// zero lógica duplicada de regra de negócio — só marshalling de HTTP → TaskPatch.
export async function handleTaskUpdatePost(req: Request, env: Env): Promise<Response> {
  const denied = await authTask(req, env);
  if (denied) return denied;

  let body: {
    id?: string;
    patch?: {
      title?: unknown;
      body?: unknown;
      due?: unknown;
      priority?: unknown;
      status?: unknown;
      domains?: unknown;
    };
    expected_updated_at?: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const id = (body.id || '').trim();
  if (!id) return json({ error: 'id required' }, 400);
  const p = body.patch;
  if (!p || typeof p !== 'object') return json({ error: 'patch required' }, 400);

  // expected_updated_at (opcional): número inteiro (ms). Aceita null/omitido =
  // last-write-wins; string/NaN = 400.
  let expectedUpdatedAt: number | undefined;
  if (body.expected_updated_at !== undefined && body.expected_updated_at !== null) {
    if (typeof body.expected_updated_at !== 'number' || !Number.isFinite(body.expected_updated_at)) {
      return json({ error: 'expected_updated_at must be a number (unix ms)' }, 400);
    }
    expectedUpdatedAt = body.expected_updated_at;
  }

  const patch: TaskPatch = {};

  // title — texto livre, 1..200 (mesma faixa do inputSchema de update_task).
  if (p.title !== undefined) {
    if (typeof p.title !== 'string') return json({ error: 'title must be a string' }, 400);
    const t = p.title.trim();
    if (t.length < 1 || t.length > 200) return json({ error: 'title must be 1-200 chars' }, 400);
    patch.title = t;
  }

  // body — texto livre (markdown). REPLACE, igual `details` no MCP.
  if (p.body !== undefined) {
    if (typeof p.body !== 'string') return json({ error: 'body must be a string' }, 400);
    patch.body = p.body.trim();
  }

  // priority — 1..4 ou null pra limpar.
  if (p.priority !== undefined) {
    if (p.priority === null) {
      patch.priority = null;
    } else if (typeof p.priority === 'number' && Number.isInteger(p.priority) && p.priority >= 1 && p.priority <= 4) {
      patch.priority = p.priority;
    } else {
      return json({ error: 'priority must be an integer 1-4 or null' }, 400);
    }
  }

  // status — enum canônico.
  if (p.status !== undefined) {
    const status = String(p.status).trim() as TaskStatus;
    if (!TASK_STATUSES.includes(status)) {
      return json({ error: `status must be one of ${TASK_STATUSES.join(', ')}` }, 400);
    }
    patch.status = status;
  }

  // domains — 1..3 slugs canônicos, validados por validateDomains (mesma função do MCP).
  if (p.domains !== undefined) {
    if (!Array.isArray(p.domains) || p.domains.some((d) => typeof d !== 'string')) {
      return json({ error: 'domains must be an array of strings' }, 400);
    }
    const domains = p.domains as string[];
    const domainError = validateDomains(domains, { allowNewDomain: false });
    if (domainError) return json({ error: domainError }, 400);
    patch.domains = JSON.stringify(domains);
  }

  // due — string BRT (parseDueToMs) OU null pra LIMPAR. Só entra se a chave existir.
  if (p.due !== undefined) {
    if (p.due === null) {
      patch.due_at = null;
    } else if (typeof p.due === 'string') {
      const sentinel = p.due.trim().toLowerCase();
      if (sentinel === '' || sentinel === 'none' || sentinel === 'clear') {
        patch.due_at = null;
      } else {
        const dueMs = parseDueToMs(p.due);
        if (dueMs === null) {
          return json({
            error: `Could not parse due "${p.due}". Use BRT formats like "2026-06-22T14:00", "2026-06-22 14:00", or "2026-06-22". Send null (or "none") to clear.`,
          }, 400);
        }
        patch.due_at = dueMs;
      }
    } else {
      return json({ error: 'due must be a BRT string or null' }, 400);
    }
  }

  // Precisa de ao menos um campo editável.
  if (Object.keys(patch).length === 0) {
    return json({ error: 'patch must include at least one of: title, body, due, priority, status, domains' }, 400);
  }

  const result = await updateTask(env, id, patch, Date.now(), expectedUpdatedAt);
  if (result === 'not-found') return json({ error: 'task not found' }, 404);
  if (result === 'conflict') {
    // 409: relê pra devolver o updated_at atual — a UI mostra "editado em outro
    // lugar, recarregue" sem sobrescrever. Mesmo espírito do erro do MCP.
    const current = await getTaskById(env, id);
    return json({
      error: 'conflict',
      message: 'Esta task foi editada em outro lugar. Recarregue antes de salvar.',
      current_updated_at: current?.updated_at ?? null,
    }, 409);
  }

  const task = result;
  return json({
    ok: true,
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due_at: task.due_at,
    due_brt: task.due_at !== null ? formatBrtDateTime(task.due_at) : null,
    updated_at: task.updated_at,
  });
}

// POST /app/tasks/create — cria task pela UI (spec 36, fase 2). Espelha o padrão
// do /update: mesmo authTask (Bearer OU sessão) + validações 1:1 com a tool MCP
// save_task (title 1-200, priority 1-4 ou null, due via parseDueToMs). Reusa
// insertTask + newId; domains default ['operations']. Sem embedding (task não vira
// vetor). Body: { title, body?, priority?, due?, domains? }.
export async function handleTaskCreatePost(req: Request, env: Env): Promise<Response> {
  const denied = await authTask(req, env);
  if (denied) return denied;

  let body: {
    title?: unknown;
    body?: unknown;
    priority?: unknown;
    due?: unknown;
    domains?: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  // title — obrigatório, 1..200 (mesma faixa do inputSchema de save_task).
  if (typeof body.title !== 'string') return json({ error: 'title must be a string' }, 400);
  const title = body.title.trim();
  if (title.length < 1 || title.length > 200) return json({ error: 'title must be 1-200 chars' }, 400);

  // body/descrição — opcional, texto livre (markdown). Vazio → cai no título (igual save_task).
  let details = '';
  if (body.body !== undefined) {
    if (typeof body.body !== 'string') return json({ error: 'body must be a string' }, 400);
    details = body.body.trim();
  }

  // priority — 1..4 ou null/omitido (sem prioridade).
  let priority: number | null = null;
  if (body.priority !== undefined && body.priority !== null) {
    if (typeof body.priority === 'number' && Number.isInteger(body.priority) && body.priority >= 1 && body.priority <= 4) {
      priority = body.priority;
    } else {
      return json({ error: 'priority must be an integer 1-4 or null' }, 400);
    }
  }

  // due — string BRT (parseDueToMs) ou null/omitido (sem prazo).
  let dueMs: number | null = null;
  if (body.due !== undefined && body.due !== null) {
    if (typeof body.due !== 'string') return json({ error: 'due must be a BRT string or null' }, 400);
    const raw = body.due.trim();
    if (raw !== '') {
      dueMs = parseDueToMs(raw);
      if (dueMs === null) {
        return json({
          error: `Could not parse due "${body.due}". Use BRT formats like "2026-06-22T14:00", "2026-06-22 14:00", or "2026-06-22".`,
        }, 400);
      }
    }
  }

  // domains — 1..3 slugs canônicos (validateDomains, mesma função do MCP). Default ['operations'].
  let domains = ['operations'];
  if (body.domains !== undefined) {
    if (!Array.isArray(body.domains) || body.domains.some((d) => typeof d !== 'string')) {
      return json({ error: 'domains must be an array of strings' }, 400);
    }
    domains = body.domains as string[];
    const domainError = validateDomains(domains, { allowNewDomain: false });
    if (domainError) return json({ error: domainError }, 400);
  }

  const now = Date.now();
  const id = newId();
  await insertTask(env, {
    id,
    title,
    body: details || title,
    tldr: title.slice(0, 280),
    domains: JSON.stringify(domains),
    status: 'open',
    due_at: dueMs,
    priority,
    completed_at: null,
    created_at: now,
    updated_at: now,
  });

  return json({
    ok: true,
    id,
    title,
    status: 'open',
    priority,
    due_at: dueMs,
    due_brt: dueMs !== null ? formatBrtDateTime(dueMs) : null,
    updated_at: now,
  }, 201);
}

// ─────────────────── Compartilhamento público (spec 33) ───────────────────
// POST /app/tasks/share e /app/tasks/unshare reusam a MESMA lógica das tools
// share_task/unshare_task (src/web/share.ts). SÓ sessão de browser (sem Bearer):
// gerar/revogar link público é ação de UI logada, não de cron/Console.

// POST /app/tasks/share — { id, expires_days?, renew? }. Cria/renova o link e devolve
// { url, expires_at, expires_brt } (o url só aparece aqui, uma vez). already_shared
// sem renew → 200 com { already_shared: true } (o link antigo segue valendo).
export async function handleTaskSharePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  let body: { id?: unknown; expires_days?: unknown; renew?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json({ error: 'id required' }, 400);

  let expiresDays: number | undefined;
  if (body.expires_days !== undefined && body.expires_days !== null) {
    if (typeof body.expires_days !== 'number' || !Number.isInteger(body.expires_days) ||
        body.expires_days < 1 || body.expires_days > 365) {
      return json({ error: 'expires_days must be an integer 1-365' }, 400);
    }
    expiresDays = body.expires_days;
  }
  const renew = body.renew === true;

  const result = await createShare(env, id, { expiresDays, renew }, Date.now());
  if (!result.ok) {
    if (result.reason === 'not-found') return json({ error: 'not found' }, 404);
    // already-shared (sem renew): não é erro — devolve a expiração atual.
    return json({
      ok: true,
      already_shared: true,
      expires_at: result.expires_at,
      expires_brt: result.expires_brt,
    });
  }
  return json({
    ok: true,
    url: result.url,
    expires_at: result.expires_at,
    expires_brt: result.expires_brt,
  }, 201);
}

// POST /app/tasks/unshare — { id }. Revoga o link (limpa o token). Idempotente.
export async function handleTaskUnsharePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  let body: { id?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json({ error: 'id required' }, 400);

  const task = await getTaskById(env, id);
  if (!task) return json({ error: 'not found' }, 404);
  const revoked = await revokeShare(env, id);
  return json({ ok: true, revoked });
}

// ─────────────────── Comentários de task (spec 53) ───────────────────
// Console do dono: adiciona comentário 'owner' e apaga QUALQUER comentário (moderação,
// inclusive de convidado). Form-encoded + redirect de volta ao detalhe da task (mesmo
// padrão das colunas do Kanban) — funciona sob a CSP sem JS inline. Sessão de browser
// obrigatória (sem Bearer): comentar/moderar é ação do dono logado, não de cron.
const OWNER_COMMENT_MAX = 4000;

function taskDetailRedirect(taskId: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `/app/tasks/${encodeURIComponent(taskId)}#atividade` },
  });
}

// POST /app/tasks/comment — form { task_id, body }. author='owner'.
export async function handleTaskCommentPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const taskId = String(form.get('task_id') ?? '').trim();
  if (!taskId) return htmlResponse('task_id obrigatório', 400);
  const body = String(form.get('body') ?? '').trim().slice(0, OWNER_COMMENT_MAX);
  if (!body) return htmlResponse('Comentário vazio', 400);

  const task = await getTaskById(env, taskId);
  if (!task) return htmlResponse('Task não encontrada', 404);

  await addTaskComment(env, {
    id: `cmt_${newId()}`, task_id: taskId, author: 'owner', author_name: null, body, created_at: Date.now(),
  });
  return taskDetailRedirect(taskId);
}

// POST /app/tasks/comment/delete — form { id, task_id? }. Apaga qualquer comentário.
export async function handleTaskCommentDeletePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id do comentário obrigatório', 400);
  const taskId = String(form.get('task_id') ?? '').trim();

  await deleteTaskComment(env, id);
  return taskId
    ? taskDetailRedirect(taskId)
    : new Response(null, { status: 302, headers: { location: '/app/tasks' } });
}

// ─────────────── Gestão de colunas do Kanban (spec 51) ───────────────
// Endpoints da seção "Quadro de tarefas" em /app/config. Form-encoded + redirect
// (mesmo padrão de /app/config/prefs e /app/api-keys/*), sessão de browser
// obrigatória (sem Bearer — é gestão de UI, não automação).

const BOARD_REDIRECT = '/app/config?saved=board#board';
const boardRedirect = (): Response =>
  new Response(null, { status: 302, headers: { location: BOARD_REDIRECT } });

// Normaliza a cor: '' → null (neutro); #rrggbb → lowercase; qualquer outra coisa →
// 'invalid' (o caller devolve 400).
function parseColumnColor(raw: string): string | null | 'invalid' {
  const c = raw.trim();
  if (c === '') return null;
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  return 'invalid';
}

// POST /app/tasks/columns/create — form { label, color?, category }.
export async function handleColumnCreatePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const label = String(form.get('label') ?? '').trim();
  if (label.length < 1 || label.length > 40) return htmlResponse('Nome da coluna deve ter 1 a 40 caracteres', 400);

  const category = String(form.get('category') ?? '').trim() as TaskStatus;
  if (!TASK_STATUSES.includes(category)) {
    return htmlResponse(`Categoria inválida (use uma de: ${TASK_STATUSES.join(', ')})`, 400);
  }

  const color = parseColumnColor(String(form.get('color') ?? ''));
  if (color === 'invalid') return htmlResponse('Cor deve estar no formato #rrggbb ou vazia', 400);

  await createKanbanColumn(env, { id: `col_${newId().slice(0, 8)}`, label, color, category });
  return boardRedirect();
}

// POST /app/tasks/columns/update — form { id, label?, color? }. Categoria é travada.
export async function handleColumnUpdatePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id da coluna obrigatório', 400);

  const patch: { label?: string; color?: string | null } = {};
  if (form.has('label')) {
    const label = String(form.get('label') ?? '').trim();
    if (label.length < 1 || label.length > 40) return htmlResponse('Nome da coluna deve ter 1 a 40 caracteres', 400);
    patch.label = label;
  }
  if (form.has('color')) {
    const color = parseColumnColor(String(form.get('color') ?? ''));
    if (color === 'invalid') return htmlResponse('Cor deve estar no formato #rrggbb ou vazia', 400);
    patch.color = color;
  }

  const ok = await updateKanbanColumn(env, id, patch);
  if (!ok) return htmlResponse('Coluna não encontrada', 404);
  return boardRedirect();
}

// POST /app/tasks/columns/reorder — form { id, direction: up|down }. Sem vizinha =
// no-op (redireciona mesmo assim, não é erro).
export async function handleColumnReorderPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  const direction = String(form.get('direction') ?? '').trim();
  if (!id) return htmlResponse('id da coluna obrigatório', 400);
  if (direction !== 'up' && direction !== 'down') return htmlResponse('direction deve ser up ou down', 400);

  await reorderKanbanColumn(env, id, direction);
  return boardRedirect();
}

// POST /app/tasks/columns/archive — form { id, archived: 1|0, to? }.
//   - archived=0 → desarquiva (só limpa archived_at).
//   - archived=1 → arquiva. Se a coluna tem tasks, exige `to` (coluna ATIVA da MESMA
//     categoria, != id) e realoca as tasks antes de arquivar. Seeds col_aberto/
//     col_concluido não podem ser arquivados se forem a última coluna ativa da categoria.
export async function handleColumnArchivePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id da coluna obrigatório', 400);

  const col = await getColumnById(env, id);
  if (!col) return htmlResponse('Coluna não encontrada', 404);

  const archived = String(form.get('archived') ?? '1').trim() !== '0';

  if (!archived) {
    await setColumnArchived(env, id, null);
    return boardRedirect();
  }

  // Já arquivada → no-op.
  if (col.archived_at !== null) return boardRedirect();

  // Guard: não deixar uma categoria essencial sem coluna ativa.
  if ((id === 'col_aberto' || id === 'col_concluido')) {
    const activeInCat = await countActiveColumnsInCategory(env, col.category);
    if (activeInCat <= 1) {
      return htmlResponse('Não é possível arquivar a última coluna ativa dessa categoria', 400);
    }
  }

  // Coluna com tasks precisa de destino da MESMA categoria (ativa, != id).
  const taskCount = await countTasksInColumn(env, id);
  if (taskCount > 0) {
    const to = String(form.get('to') ?? '').trim();
    if (!to) return htmlResponse('Escolha uma coluna destino pras tasks antes de arquivar', 400);
    if (to === id) return htmlResponse('A coluna destino não pode ser a própria coluna arquivada', 400);
    const dest = await getColumnById(env, to);
    if (!dest || dest.archived_at !== null || dest.category !== col.category) {
      return htmlResponse('Coluna destino inválida (deve ser ativa e da mesma categoria)', 400);
    }
    await reassignColumn(env, id, to);
  }

  await setColumnArchived(env, id, Date.now());
  return boardRedirect();
}

// ───────────────────────── SSR page ─────────────────────────

// Cor de coluna só é aceita como hex #rrggbb (validada na escrita); qualquer outra
// coisa vira neutro. Defesa dupla no render (o valor vai pra um atributo style).
function safeColumnColor(color: string | null): string | null {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}

// Bandeirinha de prioridade estilo ClickUp (flag colorida + rótulo). Compartilha
// PRIORITIES/flagSvg com o client (util/priority.ts) — server e client renderizam
// idêntico. null → nada no card.
function priorityPill(p: number | null): string {
  const m = priorityMeta(p);
  if (!m) return '';
  return `<span class="task-prio task-prio-p${m.value}" title="Prioridade: ${esc(m.label)}">${flagSvg(m.color)}<span class="task-prio-lbl">${esc(m.label)}</span></span>`;
}

function dueBadge(v: TaskView): string {
  if (v.due_brt === null) return '';
  const cls = v.overdue ? 'task-due overdue' : 'task-due';
  return `<span class="${cls}">${esc(v.due_brt)}${v.when ? ` · ${esc(v.when)}` : ''}</span>`;
}

function renderCardSSR(v: TaskView): string {
  const canClose = v.status === 'open' || v.status === 'in_progress';
  return `<div class="task-card" data-id="${esc(v.id)}" data-status="${esc(v.status)}" draggable="true">
    <div class="task-card-head">${priorityPill(v.priority)}${dueBadge(v)}${commentBadge(v.comment_count)}</div>
    <a class="task-card-title" href="/app/tasks/${esc(v.id)}">${esc(v.title)}</a>
    <div class="task-card-actions">
      ${canClose ? `<button class="task-btn task-complete" data-id="${esc(v.id)}" type="button">✓ concluir</button>` : ''}
      <a class="task-btn task-open" href="/app/tasks/${esc(v.id)}">abrir</a>
    </div>
  </div>`;
}

function columnSwatch(color: string | null): string {
  const c = safeColumnColor(color);
  return `<span class="task-col-dot"${c ? ` style="background:${esc(c)}"` : ''}></span>`;
}

function renderColumnSSR(col: BoardColumn): string {
  const c = safeColumnColor(col.color);
  return `<section class="task-col" data-col="${esc(col.id)}" data-category="${esc(col.category)}"${c ? ` style="--col-accent:${esc(c)}"` : ''}>
    <header class="task-col-head"><span class="task-col-label">${columnSwatch(col.color)}${esc(col.label)}</span><span class="task-col-count" data-count="${esc(col.id)}">${col.tasks.length}</span></header>
    <div class="task-col-body" data-dropzone="${esc(col.id)}">
      ${col.tasks.map(renderCardSSR).join('') || '<div class="task-col-empty">—</div>'}
    </div>
  </section>`;
}

export async function handleTasksPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const now = Date.now();
  const columns = await buildBoard(env, now);
  const totalOpen = countOpenOnBoard(columns);

  // Options de prioridade do form de criação (bandeirinha + rótulo estilo ClickUp).
  const createPrioOptions = [
    `<option value="" selected>Sem prioridade</option>`,
    ...PRIORITIES.map((m) => `<option value="${m.value}">${esc(m.label)}</option>`),
  ].join('');

  const body = `
    <div class="page-header">
      <h1>Tarefas</h1>
      <span class="count" id="tasks-count">${totalOpen} aberta${totalOpen === 1 ? '' : 's'}</span>
      <button class="task-new-btn" id="task-new-btn" type="button">
        <span class="task-new-plus" aria-hidden="true">+</span> Nova task
      </button>
    </div>

    <div class="task-toolbar" role="toolbar" aria-label="Filtros de tarefas">
      <button class="task-filter active" data-filter="all" type="button">Todas abertas</button>
      <button class="task-filter" data-filter="today" type="button">Vencem hoje</button>
      <button class="task-filter" data-filter="week" type="button">Esta semana</button>
      <button class="task-filter" data-filter="overdue" type="button">Atrasadas</button>
    </div>

    <div class="task-board" id="task-board">
      ${columns.map(renderColumnSSR).join('')}
    </div>

    <div class="task-modal" id="task-create-modal" hidden aria-hidden="true">
      <div class="task-modal-backdrop" data-close-modal></div>
      <div class="task-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="task-create-title">
        <div class="task-modal-head">
          <h2 id="task-create-title">Nova task</h2>
          <button class="task-modal-x" data-close-modal type="button" aria-label="Fechar">✕</button>
        </div>
        <form class="task-create-form" id="task-create-form">
          <label class="task-create-ctl">
            <span class="task-create-lbl">Título <span class="task-create-req">obrigatório</span></span>
            <input type="text" name="title" id="task-create-title-input" maxlength="200"
              placeholder="O que precisa ser feito?" autocomplete="off" required />
          </label>
          <label class="task-create-ctl">
            <span class="task-create-lbl">Descrição <span class="task-create-opt">opcional</span></span>
            <textarea name="body" rows="3" placeholder="Contexto, detalhes (markdown)"></textarea>
          </label>
          <div class="task-create-grid">
            <label class="task-create-ctl">
              <span class="task-create-lbl">Prioridade</span>
              <select name="priority" class="task-create-prio">${createPrioOptions}</select>
            </label>
            <label class="task-create-ctl">
              <span class="task-create-lbl">Data</span>
              <input type="date" name="due_date" />
            </label>
            <label class="task-create-ctl">
              <span class="task-create-lbl">Hora <span class="task-create-opt">opcional</span></span>
              <input type="time" name="due_time" />
            </label>
          </div>
          <div class="task-create-foot">
            <span class="task-create-msg" data-create-msg role="status" aria-live="polite"></span>
            <div class="task-create-actions">
              <button class="task-d-btn" type="button" data-close-modal>Cancelar</button>
              <button class="task-create-submit" type="submit">Criar task</button>
            </div>
          </div>
        </form>
      </div>
    </div>

    <script src="/app/tasks/bundle.js?v=${assetVersion('tasks.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    renderShell({
      title: 'Tarefas',
      active: 'tasks',
      email: session.email,
      body,
      extraHead: `<style>${TASKS_CSS}</style>`,
      sidebarCollapsed: sidebarCollapsedFromReq(req),
    })
  );
}

// CSS isolado da página de tarefas (injetado via extraHead — CSP permite inline
// style). Usa as variáveis do tema Nebula (--surface, --border, --accent-*).
// Espaçamento em grid consistente + bandeirinhas de prioridade + drag-drop com
// feedback visual (spec 36 fase 2). Escala de espaçamento: 8/12/16/20/24.
export const TASKS_CSS = `
/* Botão "Nova task" no header — ação primária, hierarquia clara (gradiente lavanda) */
.task-new-btn {
  margin-left: auto;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 9px 16px; border: none; border-radius: var(--radius-sm);
  background: linear-gradient(135deg, var(--accent-lav), var(--accent-violet));
  color: #fff; font-family: inherit; font-size: 13px; font-weight: 600; letter-spacing: 0.01em;
  cursor: pointer;
  box-shadow: 0 8px 22px -10px rgba(167,139,250,0.6);
  transition: transform 150ms var(--ease), box-shadow 180ms var(--ease);
}
.task-new-btn:hover { transform: translateY(-1px); box-shadow: 0 12px 28px -10px rgba(167,139,250,0.75); }
.task-new-btn:active { transform: translateY(0); }
.task-new-plus { font-size: 17px; line-height: 1; font-weight: 400; }

.task-toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
.task-filter {
  background: var(--surface); border: 1px solid var(--border); color: var(--text-dim);
  border-radius: 999px; padding: 6px 14px; font-size: 13px; cursor: pointer;
  transition: all 160ms var(--ease);
}
.task-filter:hover { color: var(--text); border-color: var(--border-strong); }
.task-filter.active { color: var(--accent-lav); border-color: var(--border-strong); background: rgba(167,139,250,0.1); }

/* Board: colunas customizáveis (N variável) — grid horizontal com scroll quando
   passa da largura, cada coluna com largura mínima confortável (spec 51). */
.task-board { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(260px, 1fr); gap: 16px; align-items: start; overflow-x: auto; padding-bottom: 4px; }
.task-col {
  background: var(--surface); border: 1px solid var(--border);
  border-top: 3px solid var(--col-accent, var(--border));
  border-radius: var(--radius); padding: 14px; min-height: 140px;
  transition: border-color 160ms var(--ease);
}
.task-col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; padding: 0 2px; }
.task-col-label { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; color: var(--text); text-transform: uppercase; }
/* Bolinha na cor da coluna (neutra quando sem cor definida) */
.task-col-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--border-strong); flex: none; }
.task-col-count {
  font-size: 11px; font-weight: 600; color: var(--text-dim); background: var(--surface-raised);
  border-radius: 999px; padding: 2px 9px; min-width: 24px; text-align: center;
  font-variant-numeric: tabular-nums;
}
.task-col-body {
  display: flex; flex-direction: column; gap: 10px; min-height: 72px;
  border-radius: var(--radius-sm); padding: 2px;
  transition: background 160ms var(--ease), box-shadow 160ms var(--ease);
}
/* Drop target destacado: fundo lavanda + moldura tracejada generosa (spec 36 fase 2) */
.task-col-body.drag-over {
  background: rgba(167,139,250,0.09);
  box-shadow: inset 0 0 0 2px var(--border-strong);
}
.task-col-empty {
  color: var(--text-faint); font-size: 13px; text-align: center; padding: 20px 0;
  border: 1px dashed transparent; border-radius: var(--radius-sm);
  transition: border-color 160ms var(--ease);
}
.task-col-body.drag-over .task-col-empty { border-color: var(--border-strong); color: var(--text-dim); }

.task-card {
  background: var(--bg-accent); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 12px 13px; cursor: grab;
  transition: border-color 160ms var(--ease), transform 160ms var(--ease), box-shadow 160ms var(--ease), opacity 160ms var(--ease);
}
.task-card:hover { border-color: var(--border-strong); box-shadow: 0 6px 18px -12px rgba(0,0,0,0.6); }
.task-card:active { cursor: grabbing; }
/* Card sendo arrastado: quase invisível no lugar de origem (é o "fantasma") */
.task-card.dragging { opacity: 0.35; box-shadow: 0 10px 30px -12px rgba(0,0,0,0.7); border-color: var(--accent-lav); cursor: grabbing; }
.task-card[data-status="done"], .task-card[data-status="canceled"] { opacity: 0.62; }
.task-card[data-status="done"] .task-card-title { text-decoration: line-through; color: var(--text-dim); }
.task-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; min-height: 4px; }
.task-card-head:empty { display: none; }
.task-card-title { display: block; color: var(--text); font-size: 14px; line-height: 1.4; font-weight: 500; }
.task-card-title:hover { color: var(--accent-lav); }
.task-card-actions { display: flex; gap: 12px; margin-top: 10px; }
.task-btn {
  background: none; border: none; color: var(--text-faint); font-size: 12px;
  cursor: pointer; padding: 0; transition: color 140ms var(--ease);
}
.task-btn:hover { color: var(--accent-lav); }

.task-due { font-size: 11px; color: var(--text-dim); background: var(--surface-raised); border-radius: 6px; padding: 2px 8px; font-variant-numeric: tabular-nums; }
.task-due.overdue { color: #fca5a5; background: rgba(239,68,68,0.14); }

/* Contagem de comentários (spec 53): ícone bolha + número, tom discreto */
.task-comments { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); background: var(--surface-raised); border-radius: 6px; padding: 2px 8px; }
.task-comments-n { font-variant-numeric: tabular-nums; line-height: 1; }

/* Bandeirinha de prioridade estilo ClickUp: flag colorida + rótulo, fundo tênue */
.task-prio {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 600; border-radius: 6px; padding: 2px 8px 2px 6px; letter-spacing: 0.01em;
}
.task-prio-lbl { line-height: 1; }
.task-prio-p1 { color: #fca5a5; background: rgba(248,113,113,0.14); }
.task-prio-p2 { color: #fdba74; background: rgba(251,146,60,0.14); }
.task-prio-p3 { color: #93c5fd; background: rgba(96,165,250,0.14); }
.task-prio-p4 { color: var(--text-dim); background: var(--surface-raised); }

.task-quickedit-btn { margin-left: auto; font-size: 12px; line-height: 1; }
.task-card-edit {
  margin-top: 10px; padding: 11px; border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--surface); display: flex; flex-direction: column; gap: 10px;
}
.task-card-edit[hidden] { display: none; }
.task-card-edit-ctl { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-dim); }
.task-card-edit-daterow { display: flex; gap: 8px; }
.task-card-edit-daterow .task-card-due-date { flex: 1 1 60%; }
.task-card-edit-daterow .task-card-due-time { flex: 1 1 40%; min-width: 0; }
.task-card-prio, .task-card-due-date, .task-card-due-time {
  background: var(--bg-accent); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 5px 8px; font-size: 12px; font-family: inherit;
}
.task-card-prio:focus, .task-card-due-date:focus, .task-card-due-time:focus { outline: none; border-color: var(--accent-lav); }
.task-card-edit-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.task-card-edit-msg { font-size: 11px; color: var(--text-faint); }
.task-card-edit-msg.saving { color: var(--text-dim); }
.task-card-edit-msg.ok { color: #86efac; }
.task-card-edit-msg.err { color: #fca5a5; }

/* ── Modal "Nova task" (spec 36 fase 2): painel leve, mesma linguagem do cmd-palette ── */
.task-modal { position: fixed; inset: 0; z-index: 1000; }
.task-modal[hidden] { display: none; }
.task-modal-backdrop {
  position: absolute; inset: 0; background: rgba(4,2,14,0.72);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  animation: taskFadeIn 160ms var(--ease);
}
.task-modal-dialog {
  position: relative; max-width: 520px; margin: 12vh auto 0;
  background: rgba(16,11,36,0.97); border: 1px solid var(--border-strong);
  border-radius: var(--radius); box-shadow: 0 40px 80px -20px rgba(0,0,0,0.7);
  padding: 22px 24px 24px; animation: taskSlideIn 200ms var(--ease);
}
.task-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.task-modal-head h2 { font-family: var(--font-display); font-weight: 500; font-size: 20px; margin: 0; }
.task-modal-x {
  background: none; border: none; color: var(--text-faint); font-size: 18px; line-height: 1;
  cursor: pointer; padding: 4px 6px; border-radius: 6px; transition: background 160ms var(--ease), color 160ms var(--ease);
}
.task-modal-x:hover { background: rgba(255,255,255,0.08); color: var(--text); }
.task-create-form { display: flex; flex-direction: column; gap: 16px; }
.task-create-ctl { display: flex; flex-direction: column; gap: 6px; }
.task-create-lbl {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint);
  display: flex; align-items: center; gap: 8px;
}
.task-create-req { color: #fca5a5; text-transform: none; letter-spacing: 0; font-weight: 500; }
.task-create-opt { color: var(--text-faint); text-transform: none; letter-spacing: 0; opacity: 0.8; }
.task-create-form input, .task-create-form textarea, .task-create-form select {
  background: var(--surface); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 9px 12px; font-family: inherit; font-size: 14px;
  transition: border-color 160ms var(--ease), background 160ms var(--ease);
}
.task-create-form textarea { resize: vertical; line-height: 1.5; }
.task-create-form input:focus, .task-create-form textarea:focus, .task-create-form select:focus {
  outline: none; border-color: var(--accent-lav); background: rgba(167,139,250,0.05);
}
.task-create-grid { display: grid; grid-template-columns: 1.2fr 1fr 0.9fr; gap: 12px; }
.task-create-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 4px; }
.task-create-msg { font-size: 12px; color: var(--text-faint); }
.task-create-msg.saving { color: var(--text-dim); }
.task-create-msg.err { color: #fca5a5; }
.task-create-actions { display: flex; gap: 10px; align-items: center; }
.task-create-submit {
  padding: 9px 18px; border: none; border-radius: var(--radius-sm);
  background: linear-gradient(135deg, var(--accent-lav), var(--accent-violet));
  color: #fff; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  box-shadow: 0 8px 22px -10px rgba(167,139,250,0.6);
  transition: transform 150ms var(--ease), box-shadow 180ms var(--ease), opacity 160ms var(--ease);
}
.task-create-submit:hover { transform: translateY(-1px); }
.task-create-submit:disabled { opacity: 0.55; cursor: default; transform: none; box-shadow: none; }

/* Enquanto arrasta: cursor grabbing em toda a página + colunas convidam o drop */
body.task-dragging { cursor: grabbing; }
body.task-dragging .task-col-body { min-height: 90px; }

@keyframes taskFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes taskSlideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }

@media (max-width: 760px) {
  .task-board { grid-auto-flow: row; grid-auto-columns: auto; grid-template-columns: 1fr; }
  .task-create-grid { grid-template-columns: 1fr 1fr; }
  .task-modal-dialog { margin: 6vh 16px 0; }
}
`;
