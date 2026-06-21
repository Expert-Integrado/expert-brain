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
  listActiveTasks,
  listRecentClosedTasks,
  listTasksDueBefore,
  setTaskStatus,
  completeTask,
} from '../db/queries.js';
import { formatBrtShort, relativeDue } from '../util/time.js';

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
  when: string | null;
  overdue: boolean;
  created_at: number;
  completed_at: number | null;
}

function toView(t: TaskRow, now: number): TaskView {
  const due = t.due_at ?? null;
  return {
    id: t.id,
    title: t.title,
    status: (t.status as TaskStatus) ?? 'open',
    priority: t.priority,
    due_at: due,
    due_brt: due !== null ? formatBrtShort(due) : null,
    when: due !== null ? relativeDue(due, now) : null,
    overdue: due !== null && due < now && t.status !== 'done' && t.status !== 'canceled',
    created_at: t.created_at,
    completed_at: t.completed_at,
  };
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

  const [active, closed] = await Promise.all([
    listActiveTasks(env),
    listRecentClosedTasks(env, 100),
  ]);
  const columns = {
    open: active.filter((t) => t.status === 'open').map((t) => toView(t, now)),
    in_progress: active.filter((t) => t.status === 'in_progress').map((t) => toView(t, now)),
    done: closed.map((t) => toView(t, now)),
  };
  return json({ now, columns });
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
  const task = await completeTask(env, id, Date.now(), body.outcome);
  if (!task) return json({ error: 'task not found' }, 404);
  return json({ ok: true, id, status: 'done' });
}

// ───────────────────────── SSR page ─────────────────────────

const COLS: Array<{ key: TaskStatus; label: string }> = [
  { key: 'open', label: 'A fazer' },
  { key: 'in_progress', label: 'Em progresso' },
  { key: 'done', label: 'Concluído' },
];

function priorityPill(p: number | null): string {
  if (p === null) return '';
  return `<span class="task-prio task-prio-p${p}" title="Prioridade ${p}">P${p}</span>`;
}

function dueBadge(v: TaskView): string {
  if (v.due_brt === null) return '';
  const cls = v.overdue ? 'task-due overdue' : 'task-due';
  return `<span class="${cls}">${esc(v.due_brt)}${v.when ? ` · ${esc(v.when)}` : ''}</span>`;
}

function renderCardSSR(v: TaskView): string {
  const canClose = v.status === 'open' || v.status === 'in_progress';
  return `<div class="task-card" data-id="${esc(v.id)}" data-status="${esc(v.status)}" draggable="true">
    <div class="task-card-head">${priorityPill(v.priority)}${dueBadge(v)}</div>
    <a class="task-card-title" href="/app/notes/${esc(v.id)}">${esc(v.title)}</a>
    <div class="task-card-actions">
      ${canClose ? `<button class="task-btn task-complete" data-id="${esc(v.id)}" type="button">✓ concluir</button>` : ''}
      <a class="task-btn task-open" href="/app/notes/${esc(v.id)}">abrir</a>
    </div>
  </div>`;
}

function renderColumnSSR(label: string, key: TaskStatus, items: TaskView[]): string {
  return `<section class="task-col" data-col="${key}">
    <header class="task-col-head"><span class="task-col-label">${esc(label)}</span><span class="task-col-count" data-count="${key}">${items.length}</span></header>
    <div class="task-col-body" data-dropzone="${key}">
      ${items.map(renderCardSSR).join('') || '<div class="task-col-empty">—</div>'}
    </div>
  </section>`;
}

export async function handleTasksPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const now = Date.now();
  const [active, closed] = await Promise.all([
    listActiveTasks(env),
    listRecentClosedTasks(env, 100),
  ]);
  const cols: Record<TaskStatus, TaskView[]> = {
    open: active.filter((t) => t.status === 'open').map((t) => toView(t, now)),
    in_progress: active.filter((t) => t.status === 'in_progress').map((t) => toView(t, now)),
    done: closed.map((t) => toView(t, now)),
    canceled: [],
  };
  const totalOpen = cols.open.length + cols.in_progress.length;

  const body = `
    <div class="page-header">
      <h1>Tarefas</h1>
      <span class="count" id="tasks-count">${totalOpen} aberta${totalOpen === 1 ? '' : 's'}</span>
    </div>

    <div class="task-toolbar" role="toolbar" aria-label="Filtros de tarefas">
      <button class="task-filter active" data-filter="all" type="button">Todas abertas</button>
      <button class="task-filter" data-filter="today" type="button">Vencem hoje</button>
      <button class="task-filter" data-filter="week" type="button">Esta semana</button>
      <button class="task-filter" data-filter="overdue" type="button">Atrasadas</button>
    </div>

    <div class="task-board" id="task-board">
      ${COLS.map((c) => renderColumnSSR(c.label, c.key, cols[c.key])).join('')}
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
export const TASKS_CSS = `
.task-toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
.task-filter {
  background: var(--surface); border: 1px solid var(--border); color: var(--text-dim);
  border-radius: 999px; padding: 6px 14px; font-size: 13px; cursor: pointer;
  transition: all 160ms var(--ease);
}
.task-filter:hover { color: var(--text); border-color: var(--border-strong); }
.task-filter.active { color: var(--accent-lav); border-color: var(--border-strong); background: rgba(167,139,250,0.1); }

.task-board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; align-items: start; }
.task-col {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 12px; min-height: 120px;
}
.task-col-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding: 0 4px; }
.task-col-label { font-size: 13px; font-weight: 600; letter-spacing: 0.02em; color: var(--text); text-transform: uppercase; }
.task-col-count {
  font-size: 11px; color: var(--text-dim); background: var(--surface-raised);
  border-radius: 999px; padding: 1px 9px; min-width: 22px; text-align: center;
}
.task-col-body { display: flex; flex-direction: column; gap: 10px; min-height: 60px; border-radius: var(--radius-sm); transition: background 160ms var(--ease); }
.task-col-body.drag-over { background: rgba(167,139,250,0.07); outline: 1px dashed var(--border-strong); }
.task-col-empty { color: var(--text-faint); font-size: 13px; text-align: center; padding: 16px 0; }

.task-card {
  background: var(--bg-accent); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 11px 12px; cursor: grab;
  transition: border-color 160ms var(--ease), transform 160ms var(--ease);
}
.task-card:hover { border-color: var(--border-strong); }
.task-card.dragging { opacity: 0.5; }
.task-card[data-status="done"], .task-card[data-status="canceled"] { opacity: 0.62; }
.task-card[data-status="done"] .task-card-title { text-decoration: line-through; color: var(--text-dim); }
.task-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; min-height: 4px; }
.task-card-title { display: block; color: var(--text); font-size: 14px; line-height: 1.35; font-weight: 500; }
.task-card-title:hover { color: var(--accent-lav); }
.task-card-actions { display: flex; gap: 10px; margin-top: 9px; }
.task-btn {
  background: none; border: none; color: var(--text-faint); font-size: 12px;
  cursor: pointer; padding: 0; transition: color 140ms var(--ease);
}
.task-btn:hover { color: var(--accent-lav); }

.task-due { font-size: 11px; color: var(--text-dim); background: var(--surface-raised); border-radius: 6px; padding: 2px 7px; }
.task-due.overdue { color: #fca5a5; background: rgba(239,68,68,0.14); }
.task-prio { font-size: 10px; font-weight: 700; border-radius: 5px; padding: 2px 6px; letter-spacing: 0.03em; }
.task-prio-p1 { color: #fca5a5; background: rgba(239,68,68,0.16); }
.task-prio-p2 { color: #fdba74; background: rgba(249,115,22,0.16); }
.task-prio-p3 { color: var(--accent-lav); background: rgba(167,139,250,0.16); }
.task-prio-p4 { color: var(--text-dim); background: var(--surface-raised); }

@media (max-width: 760px) {
  .task-board { grid-template-columns: 1fr; }
}
`;
