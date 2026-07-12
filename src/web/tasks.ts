import type { Env } from '../env.js';
import { OWNER_TASK_VIS, taskVisPublic } from '../auth/visibility.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { authorizeBearer } from './bearer-auth.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { formError, formErrorBanner } from './form-error.js';
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
  setTaskPrivate,
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
  getTagsForNotes,
  getTagsByNote,
  type TaskProject,
  listTaskProjects,
  getProjectById,
  createTaskProject,
  updateTaskProject,
  reorderTaskProject,
  setProjectArchived,
  countTaskProjects,
  TASK_PROJECT_CAP,
  listAssigneesForTasks,
  getOwnerUser,
  listUsers,
  claimActive,
  listAwaitingOwnerBanner,
} from '../db/queries.js';
import {
  addTaskSubtasks,
  setSubtaskDone,
  retitleSubtask,
  deleteSubtask,
  countTaskSubtasksBatch,
  MAX_SUBTASKS_PER_TASK,
  type SubtaskProgress,
} from '../db/subtasks.js';
import { renameTag, deleteTag } from '../db/tag-admin.js';
import { produceCommentMailbox, getBoardMailboxInfo } from '../db/mailbox.js';
import { validateDomains } from '../db/validation.js';
import { logTaskActivity } from '../db/task-activity.js';
import { createShare, revokeShare } from './share.js';
import { newId } from '../util/id.js';
import { PRIORITIES, priorityMeta, flagSvg } from '../util/priority.js';
import { commentBadge } from '../util/comment-badge.js';
import { tagChipsHtml, shareIconHtml, projectCrumbHtml, assigneeDotsHtml, claimChipHtml, awaitingBannerHtml, subtaskBadge, type AssigneeDot, type ClaimChip, type AwaitingItem } from '../util/task-badges.js';
import { formatBrtShort, relativeDue, parseDueToMs, formatBrtDateTime, brtDatetimeLocal, brtDateOnly, brtTimeOnly } from '../util/time.js';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Auth: Bearer (VPS/Console) OU sessão de browser. Igual ao padrão das rotas
// /app/graph/*. Retorna null quando autorizado, ou a Response de erro/redirect.
async function authTask(req: Request, env: Env): Promise<Response | null> {
  if (await authorizeBearer(req, env, 'tasks')) return null;
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
  tags: string[]; // sem tags reservadas dedupe:* — nunca aparecem na UI (spec 52)
  shared: boolean; // link público ATIVO (não-expirado) — pro ícone 🔗 do card (spec 52)
  share_expires_brt: string | null; // "DD/MM" — tooltip do ícone quando shared=true
  project_id: string | null; // pasta/projeto (spec 58); null = "Sem projeto". Chip resolvido via board.projects
  private: boolean; // selo de privacidade (spec 59): badge 🔒 no card + detalhe
  search_text: string; // título + descrição + tags, minúsculo e sem acento — busca client-side (Onda 8)
  assignees: AssigneeDot[]; // responsáveis (spec 37): bolinhas no card
  mention_me: boolean; // menção NÃO-LIDA ao dono nesta task (spec 82) — filtro "menções a mim"
  // Claim/lease ATIVO (spec 88/89): quem está trabalhando AGORA e até quando —
  // chip no card. null = livre (inclui lease vencido, filtrado no buildBoard).
  claim: ClaimChip | null;
  // Checklist (spec 38): badge "3/8" no card; null = task sem subtarefas.
  subtask_progress: SubtaskProgress | null;
}

// Texto de busca do card (Onda 8): título + corpo (quando não é eco do título) +
// tags, minúsculo e SEM acentos (fold) — o client só precisa foldar a query.
// Cap de 800 chars segura o payload do board (corpo longo raramente importa além disso).
export function foldSearchText(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Tags reservadas (`dedupe:*`) são um detalhe interno de dedupe do save_task —
// nunca devem aparecer em UI nenhuma (card, sidebar do detalhe). Compartilhado
// pelos dois pontos que expõem tags de task ao dono (board + detalhe).
export function visibleTags(tags: string[]): string[] {
  return tags.filter((t) => !t.startsWith('dedupe:'));
}

function toView(t: TaskRow, now: number, commentCount = 0, tags: string[] = [], assignees: AssigneeDot[] = [], mentionMe = false, claim: ClaimChip | null = null, subtaskProgress: SubtaskProgress | null = null): TaskView {
  const due = t.due_at ?? null;
  const shared = t.share_token != null && t.share_expires_at != null && t.share_expires_at > now;
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
    tags,
    shared,
    share_expires_brt: shared ? formatBrtShort(t.share_expires_at!) : null,
    project_id: t.project_id,
    private: t.private === 1,
    search_text: foldSearchText(
      `${t.title}\n${t.body && t.body !== t.title ? t.body : ''}\n${tags.join(' ')}`
    ).slice(0, 800),
    assignees,
    mention_me: mentionMe,
    claim,
    subtask_progress: subtaskProgress,
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

// Projeto no payload do board (spec 58): usado pelo select de filtro no header e
// pra resolver o chip de cada card (por project_id). Inclui arquivados (archived=true)
// pra o subgrupo "Arquivados" do filtro e o chip esmaecido.
interface BoardProject {
  id: string;
  label: string;
  color: string | null;
  archived: boolean;
}

interface BoardPayload {
  columns: BoardColumn[];
  projects: BoardProject[];
  // Mailbox (spec 82): contagem de não-lidas por usuário (badge da toolbar).
  mailbox_unread: Array<{ id: string; name: string; count: number }>;
  // "Aguardando você" (spec 89): tasks com bloqueio pendente de resposta do dono —
  // banner acima do board (fila de aprovações da frota). Ordem: bloqueio mais antigo primeiro.
  awaiting: AwaitingItem[];
}

// Monta o board a partir das colunas ATIVAS do banco + tasks ativas e fechadas
// recentes. Cada task é alocada na coluna do seu column_id (quando ativa e coerente
// com o status) ou, como fallback, na coluna default (menor position) da categoria
// do status — assim uma task com column_id NULL/órfão nunca some do board. Tasks
// cuja categoria não tem NENHUMA coluna ativa (ex.: canceladas com col_cancelado
// arquivado) simplesmente não renderizam, mantendo o comportamento histórico do board.
async function buildBoard(env: Env, now: number): Promise<BoardPayload> {
  const [activeCols, active, closed, allProjects, allUsers, awaiting] = await Promise.all([
    listKanbanColumns(env, false),
    // OWNER_TASK_VIS (specs 59 + 91): o board é superfície do dono (sessão OU bearer de
    // tasks) — mostra task privada com badge 🔒. O gate por escopo é dos read paths MCP.
    listActiveTasks(env, OWNER_TASK_VIS),
    listRecentClosedTasks(env, 100, OWNER_TASK_VIS),
    listTaskProjects(env, true),
    // Usuários (spec 89): resolver claimed_by → nome pro chip de claim do card.
    listUsers(env, true),
    // "Aguardando você" (spec 89): best-effort — o board nunca quebra por causa disto.
    listAwaitingOwnerBanner(env).catch((err) => {
      console.error('awaiting-owner: banner do board falhou (best-effort):', err instanceof Error ? err.message : err);
      return [];
    }),
  ]);
  const userNameById = new Map(allUsers.map((u) => [u.id, u.name]));
  const activeById = new Map<string, KanbanColumn>(activeCols.map((c) => [c.id, c]));
  // Primeira coluna ativa (menor position) por categoria — activeCols já vem ordenado.
  const defaultByCat = new Map<string, KanbanColumn>();
  for (const c of activeCols) if (!defaultByCat.has(c.category)) defaultByCat.set(c.category, c);

  // Contagem de comentários + tags em lote (spec 53/52): 1 query (chunked) cada
  // pro board inteiro, nunca N+1. Cobre tasks ativas + fechadas recentes que serão
  // renderizadas. Tags reservadas dedupe:* são filtradas AQUI — nunca chegam ao
  // TaskView (defesa única, board e nenhum outro read path de card as vaza).
  const allIds = [...active, ...closed].map((t) => t.id);
  const [commentCounts, tagsById, assigneesById, subtaskCounts, mailboxInfo] = await Promise.all([
    countTaskCommentsBatch(env, allIds),
    getTagsForNotes(env, allIds),
    // Responsáveis em lote (spec 37): bolinhas do card, 1 query chunked.
    listAssigneesForTasks(env, allIds),
    // Progresso do checklist em lote (spec 38): badge "3/8", 1 query chunked.
    countTaskSubtasksBatch(env, allIds),
    // Mailbox (spec 82): badge por usuário + tasks com menção não-lida ao dono.
    // Best-effort: o board nunca quebra por causa do mailbox.
    getBoardMailboxInfo(env).catch((err) => {
      console.error('mailbox: info do board falhou (best-effort):', err instanceof Error ? err.message : err);
      return { unreadByUser: [], ownerMentionTaskIds: new Set<string>() };
    }),
  ]);

  const buckets = new Map<string, TaskView[]>();
  for (const c of activeCols) buckets.set(c.id, []);

  const place = (t: TaskRow) => {
    const status = t.status ?? 'open';
    let colId: string | null = null;
    const assigned = t.column_id ? activeById.get(t.column_id) : undefined;
    if (assigned && assigned.category === status) colId = assigned.id;
    else colId = defaultByCat.get(status)?.id ?? null;
    const tags = visibleTags(tagsById.get(t.id) ?? []);
    // Chip de claim (spec 89): só claim ATIVO (lease vencido = livre = null).
    const claim: ClaimChip | null = claimActive(t, now)
      ? { name: userNameById.get(t.claimed_by!) ?? t.claimed_by!, expires_brt: formatBrtShort(t.claim_expires_at!) }
      : null;
    if (colId) buckets.get(colId)?.push(toView(t, now, commentCounts.get(t.id) ?? 0, tags, assigneesById.get(t.id) ?? [], mailboxInfo.ownerMentionTaskIds.has(t.id), claim, subtaskCounts.get(t.id) ?? null));
  };
  for (const t of active) place(t);
  for (const t of closed) place(t);

  const columns = activeCols.map((c) => ({
    id: c.id,
    label: c.label,
    color: c.color,
    position: c.position,
    category: c.category as TaskStatus,
    tasks: buckets.get(c.id) ?? [],
  }));
  const projects: BoardProject[] = allProjects.map((p) => ({
    id: p.id,
    label: p.label,
    color: p.color,
    archived: p.archived_at !== null,
  }));
  const awaitingViews: AwaitingItem[] = awaiting.map((a) => ({
    id: a.id,
    title: a.title,
    block_body: a.block_body,
    block_author: a.block_author,
    block_at_brt: formatBrtShort(a.block_at),
  }));
  return { columns, projects, mailbox_unread: mailboxInfo.unreadByUser, awaiting: awaitingViews };
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
    // OWNER_TASK_VIS (specs 59 + 91): superfície do dono (sessão OU bearer de tasks).
    const rows = await listTasksDueBefore(env, now + horizon * 3600_000, OWNER_TASK_VIS);
    return json({ now, horizon_hours: horizon, tasks: rows.map((t) => toView(t, now)) });
  }

  const { columns, projects, mailbox_unread, awaiting } = await buildBoard(env, now);
  return json({ now, columns, projects, mailbox_unread, awaiting });
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
  // Autoria (spec 74, log de atividade): authTask aceita Bearer (cron/VPS, sem
  // identidade individual) OU sessão de browser — resolve o email só quando é sessão;
  // Bearer loga com actor null (mesmo racional de created_by/updated_by).
  const moveSession = await requireSession(req, env);
  const moveActor = moveSession.ok ? `oauth:${moveSession.email}` : null;
  const result = await moveTaskToColumn(env, id, columnId, Date.now(), moveActor);
  if (result === 'column-not-found') return json({ error: 'column not found' }, 404);
  if (result === 'not-found') return json({ error: 'task not found' }, 404);
  // updated_at aditivo (spec 52): o detalhe da task usa o select de coluna como
  // substituto do antigo select de status — precisa da base fresca de versionamento
  // otimista pra continuar salvando título/corpo/tags sem 409 auto-infligido.
  return json({ ok: true, id, column_id: columnId, status: result.status, updated_at: result.updated_at });
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
  // Autoria (spec 74, log de atividade): idem handleTaskMovePost — Bearer sem
  // identidade individual loga null, sessão de browser loga oauth:<email>.
  const completeSession = await requireSession(req, env);
  const completeActor = completeSession.ok ? `oauth:${completeSession.email}` : null;
  // completeTask agora devolve a task OU um sentinel de controle (spec 14):
  // 'not-found' | 'conflict' | 'already-done'. O board não usa versionamento
  // otimista (sem expected_updated_at), então 'conflict' não ocorre aqui;
  // 'already-done' é um no-op idempotente que também terminou como done.
  const result = await completeTask(env, id, OWNER_TASK_VIS, Date.now(), body.outcome, undefined, completeActor);
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
      tags?: unknown;
      project_id?: unknown;
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

  // tags — REPLACE de todas as tags (mesma semântica de update_task MCP); []
  // limpa as não-reservadas. Reservadas dedupe:* são preservadas automaticamente
  // por replaceTaskTagsPreservingDedupe dentro de updateTask.
  if (p.tags !== undefined) {
    if (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== 'string')) {
      return json({ error: 'tags must be an array of strings' }, 400);
    }
    patch.tags = p.tags as string[];
  }

  // project_id — id de projeto ATIVO pra vincular, ou null/'' pra DESvincular (spec 58).
  // O select do detalhe só oferece projetos ativos + "Sem projeto"; aqui aceitamos só
  // id (não label — o auto-create por label é caminho do MCP, não da UI). Projeto
  // inexistente/arquivado → 400.
  if (p.project_id !== undefined) {
    if (p.project_id === null || p.project_id === '') {
      patch.project_id = null;
    } else if (typeof p.project_id === 'string') {
      const proj = await getProjectById(env, p.project_id.trim());
      if (!proj || proj.archived_at !== null) {
        return json({ error: 'project not found (or archived)' }, 404);
      }
      patch.project_id = proj.id;
    } else {
      return json({ error: 'project_id must be a project id string or null' }, 400);
    }
  }

  // Precisa de ao menos um campo editável.
  if (Object.keys(patch).length === 0) {
    return json({ error: 'patch must include at least one of: title, body, due, priority, status, domains, tags, project_id' }, 400);
  }

  const result = await updateTask(env, id, patch, OWNER_TASK_VIS, Date.now(), expectedUpdatedAt);
  if (result === 'not-found') return json({ error: 'task not found' }, 404);
  if (result === 'conflict') {
    // 409: relê pra devolver o updated_at atual — a UI mostra "editado em outro
    // lugar, recarregue" sem sobrescrever. Mesmo espírito do erro do MCP.
    const current = await getTaskById(env, id, OWNER_TASK_VIS);
    return json({
      error: 'conflict',
      message: 'Esta task foi editada em outro lugar. Recarregue antes de salvar.',
      current_updated_at: current?.updated_at ?? null,
    }, 409);
  }

  const task = result;
  // tags só entra na resposta quando o patch mexeu nelas (evita 1 query extra nos
  // outros patches, muito mais frequentes) — devolve já sem as reservadas dedupe:*,
  // pro chip editor da sidebar (spec 52) atualizar sem precisar de reload.
  const tagsOut = patch.tags !== undefined ? visibleTags(await getTagsByNote(env, task.id)) : undefined;
  return json({
    ok: true,
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due_at: task.due_at,
    due_brt: task.due_at !== null ? formatBrtDateTime(task.due_at) : null,
    updated_at: task.updated_at,
    ...(tagsOut !== undefined ? { tags: tagsOut } : {}),
  });
}

// POST /app/tasks/create — cria task pela UI (spec 36, fase 2). Espelha o padrão
// do /update: mesmo authTask (Bearer OU sessão) + validações 1:1 com a tool MCP
// save_task (title 1-200, priority 1-4 ou null, due via parseDueToMs). Reusa
// insertTask + newId; domains default ['operations']. Sem embedding (task não vira
// vetor). Body: { title, body?, priority?, due?, domains?, column_id? }.
//   - `column_id` (spec 52, criação inline no rodapé da coluna do board): opcional,
//     deve ser uma coluna ATIVA existente. Quando presente, a task nasce JÁ na
//     coluna (e status = categoria dela) em vez do default 'open'/col_aberto.
export async function handleTaskCreatePost(req: Request, env: Env): Promise<Response> {
  const denied = await authTask(req, env);
  if (denied) return denied;

  let body: {
    title?: unknown;
    body?: unknown;
    priority?: unknown;
    due?: unknown;
    domains?: unknown;
    column_id?: unknown;
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

  // column_id — opcional (spec 52). Deve resolver pra uma coluna ATIVA; a categoria
  // dela vira o status inicial da task (default sem column_id: 'open', igual antes).
  let status: TaskStatus = 'open';
  let columnId: string | null = null;
  if (body.column_id !== undefined && body.column_id !== null) {
    if (typeof body.column_id !== 'string' || !body.column_id.trim()) {
      return json({ error: 'column_id must be a non-empty string' }, 400);
    }
    const col = await getColumnById(env, body.column_id.trim());
    if (!col || col.archived_at !== null) {
      return json({ error: 'column not found (or archived)' }, 404);
    }
    columnId = col.id;
    status = col.category;
  }

  const now = Date.now();
  const id = newId();
  // Autoria (spec 74, log de atividade): idem handleTaskMovePost/handleTaskCompletePost.
  const createSession = await requireSession(req, env);
  const createActor = createSession.ok ? `oauth:${createSession.email}` : null;
  await insertTask(env, {
    id,
    title,
    body: details || title,
    tldr: title.slice(0, 280),
    domains: JSON.stringify(domains),
    status,
    due_at: dueMs,
    priority,
    completed_at: null,
    created_at: now,
    updated_at: now,
    column_id: columnId,
  }, createActor);

  return json({
    ok: true,
    id,
    title,
    status,
    priority,
    due_at: dueMs,
    due_brt: dueMs !== null ? formatBrtDateTime(dueMs) : null,
    updated_at: now,
    column_id: columnId,
  }, 201);
}

// ─────────────────── Compartilhamento público (spec 33) ───────────────────
// POST /app/tasks/share e /app/tasks/unshare reusam a MESMA lógica das tools
// share_task/unshare_task (src/web/share.ts). Desde a reconciliação da spec 33 o
// createShare/revokeShare aceitam QUALQUER nota viva — estes handlers servem também
// as rotas /app/notes/share e /app/notes/unshare (alias no web/handler.ts). SÓ sessão
// de browser (sem Bearer): gerar/revogar link público é ação de UI logada.

// POST /app/tasks/share — { id, expires_days?, renew?, include_media? }. Cria/renova
// o link e devolve { url, expires_at, expires_brt } (o url só aparece aqui, uma vez).
// already_shared sem renew → 200 com { already_shared: true } (o link antigo segue
// valendo). include_media (default false) liga a mídia na página pública (só notas).
export async function handleTaskSharePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  let body: { id?: unknown; expires_days?: unknown; renew?: unknown; include_media?: unknown };
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
  const includeMedia = body.include_media === true;

  const now = Date.now();
  const result = await createShare(env, id, { expiresDays, renew, includeMedia }, now);
  if (!result.ok) {
    if (result.reason === 'not-found') return json({ error: 'not found' }, 404);
    // Selo de privacidade (spec 31/59): nota/task privada não pode ter link público.
    if (result.reason === 'private') {
      return json({ error: 'private', message: 'Item privado não pode ter link público. Tire-o do modo privado primeiro.' }, 409);
    }
    // already-shared (sem renew): não é erro — devolve a expiração atual.
    return json({
      ok: true,
      already_shared: true,
      expires_at: result.expires_at,
      expires_brt: result.expires_brt,
    });
  }
  // Log de atividade (spec 74): só quando o alvo é uma TASK — este handler também
  // atende nota de conhecimento (alias /app/notes/share), que não tem feed de
  // atividade de task. createShare não devolve o `kind`, então confirma via getTaskById
  // (mesma leitura que já filtra kind='task' + viva).
  const sharedTask = await getTaskById(env, id, OWNER_TASK_VIS);
  if (sharedTask) {
    const days = Math.round((result.expires_at - now) / (24 * 60 * 60 * 1000));
    await logTaskActivity(env, id, `oauth:${session.email}`, [
      { field: 'share', old_value: null, new_value: `link público criado (${days}d)` },
    ]);
  }
  return json({
    ok: true,
    url: result.url,
    expires_at: result.expires_at,
    expires_brt: result.expires_brt,
  }, 201);
}

// ─────────────────── Selo de privacidade de task (spec 59) ───────────────────
// POST /app/tasks/private — { id, private: boolean }. É a ÚNICA superfície que DESMARCA
// (torna pública). SÓ sessão de browser (requireSession, sem Bearer/PAT — PAT/bearer
// caem em 401 antes daqui). Marcar privada revoga QUALQUER link público na mesma escrita
// (setTaskPrivate). Aceita JSON { private } OU form-encoded (private=1|0), espelhando o
// toggle de nota (handleNotePrivatePost) — o form do detalhe é CSP-safe.
export async function handleTaskPrivatePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const ct = req.headers.get('content-type') || '';
  const wantsJson = ct.includes('application/json');
  let id: string;
  let makePrivate: boolean;
  if (wantsJson) {
    let body: { id?: unknown; private?: unknown };
    try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
    id = typeof body.id === 'string' ? body.id.trim() : '';
    if (typeof body.private !== 'boolean') return json({ error: 'private must be a boolean' }, 400);
    makePrivate = body.private;
  } else {
    const form = await req.formData();
    id = String(form.get('id') ?? '').trim();
    makePrivate = String(form.get('private') ?? '') === '1';
  }
  if (!id) return wantsJson ? json({ error: 'id required' }, 400) : formError(req, 'id obrigatório', { field: 'id', returnTo: '/app/tasks' });

  const r = await setTaskPrivate(env, id, makePrivate ? 1 : 0, Date.now(), `oauth:${session.email}`);
  if (!r.ok) {
    return wantsJson
      ? json({ error: 'task not found' }, 404)
      : new Response(null, { status: 302, headers: { location: '/app/tasks' } });
  }
  return wantsJson
    ? json({ ok: true, id, private: makePrivate, share_revoked: r.shareRevoked })
    : new Response(null, { status: 302, headers: { location: `/app/tasks/${encodeURIComponent(id)}` } });
}

// POST /app/tasks/unshare — { id }. Revoga o link (limpa o token). Idempotente.
// Aceita qualquer nota viva (task ou conhecimento) — mesmo trilho da criação.
export async function handleTaskUnsharePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  let body: { id?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return json({ error: 'id required' }, 400);

  // `kind` já vem nesta MESMA leitura (zero query extra) pra decidir se loga
  // atividade de task (spec 74) — nota de conhecimento não tem feed de task.
  const note = await env.DB.prepare(
    `SELECT id, kind FROM notes WHERE id = ? AND deleted_at IS NULL`
  ).bind(id).first<{ id: string; kind: string | null }>();
  if (!note) return json({ error: 'not found' }, 404);
  const revoked = await revokeShare(env, id);
  if (revoked && note.kind === 'task') {
    await logTaskActivity(env, id, `oauth:${session.email}`, [
      { field: 'share', old_value: 'ativo', new_value: 'revogado' },
    ]);
  }
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
  if (!taskId) return formError(req, 'task_id obrigatório', { returnTo: '/app/tasks' });
  const body = String(form.get('body') ?? '').trim().slice(0, OWNER_COMMENT_MAX);
  if (!body) return formError(req, 'Comentário vazio', { field: 'body', returnTo: `/app/tasks/${encodeURIComponent(taskId)}#atividade` });

  // OWNER_TASK_VIS: form da sessão do dono — de carona conserta o dono não conseguir
  // comentar task privada pelo console (a leitura era public-only).
  const task = await getTaskById(env, taskId, OWNER_TASK_VIS);
  if (!task) return formError(req, 'Tarefa não encontrada', { status: 404, returnTo: '/app/tasks' });

  // Assinatura (spec 81): o comentário do console também aponta pro perfil do dono
  // (mesma resolução do resolveMe em sessão OAuth). Se o seed user_owner sumir
  // (estado impossível em prática), grava sem assinatura — comportamento legado.
  const owner = await getOwnerUser(env);
  const commentId = `cmt_${newId()}`;
  await addTaskComment(env, {
    id: commentId, task_id: taskId, author: 'owner', author_name: null, body, created_at: Date.now(),
    author_user_id: owner?.id ?? null,
  });
  // Mailbox (spec 82): @menções do dono + comment_on_assigned. Best-effort.
  await produceCommentMailbox(env, {
    taskId, commentId, body, actorUserId: owner?.id ?? null,
  });
  return taskDetailRedirect(taskId);
}

// POST /app/tasks/comment/delete — form { id, task_id? }. Apaga qualquer comentário.
export async function handleTaskCommentDeletePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  if (!id) return formError(req, 'id do comentário obrigatório', { returnTo: '/app/tasks' });
  const taskId = String(form.get('task_id') ?? '').trim();

  await deleteTaskComment(env, id);
  return taskId
    ? taskDetailRedirect(taskId)
    : new Response(null, { status: 302, headers: { location: '/app/tasks' } });
}

// ─────────────── Subtarefas / checklist (spec 38) ───────────────
// 4 endpoints JSON no padrão das rotas irmãs (/app/tasks/update|move): Bearer
// 'tasks' OU sessão de browser; o client bundle do detalhe consome sem reload.
// Mutação de subtask NÃO toca notes.updated_at (tick não pode invalidar o
// expected_updated_at de quem edita a task ao lado) — por isso a resposta também
// não devolve updated_at novo. Cada mutação loga task_activity field='subtask'
// (old_value = ação PT, new_value = título truncado — formato do historyPhrase).

const SUBTASK_LOG_MAX = 80;

// Auth + identidade comum dos 4 endpoints: sessão do dono enxerga task privada
// (seePrivate) e assina o log como 'oauth:<email>'; Bearer genérico não enxerga
// privada e loga actor null (mesmo racional de handleTaskMovePost).
async function subtaskAuth(
  req: Request, env: Env
): Promise<{ denied: Response } | { denied: null; actor: string | null; seePrivate: boolean }> {
  const denied = await authTask(req, env);
  if (denied) return { denied };
  const session = await requireSession(req, env);
  return session.ok
    ? { denied: null, actor: `oauth:${session.email}`, seePrivate: true }
    : { denied: null, actor: null, seePrivate: false };
}

async function subtaskProgressOf(env: Env, taskId: string): Promise<SubtaskProgress> {
  return (await countTaskSubtasksBatch(env, [taskId])).get(taskId) ?? { done: 0, total: 0 };
}

// POST /app/tasks/subtask/add — { task_id, title }. Anexa 1 item ao fim do checklist.
export async function handleSubtaskAddPost(req: Request, env: Env): Promise<Response> {
  const auth = await subtaskAuth(req, env);
  if (auth.denied) return auth.denied;
  let body: { task_id?: string; title?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const taskId = (body.task_id || '').trim();
  if (!taskId) return json({ error: 'task_id required' }, 400);
  const title = (typeof body.title === 'string' ? body.title : '').trim();
  if (title.length < 1 || title.length > 200) return json({ error: 'title must be 1-200 chars' }, 400);

  const task = await getTaskById(env, taskId, taskVisPublic(auth.seePrivate));
  if (!task) return json({ error: 'task not found' }, 404);
  const created = await addTaskSubtasks(env, taskId, [title], auth.actor, Date.now());
  if (created === 'cap-exceeded') return json({ error: `subtask limit reached (${MAX_SUBTASKS_PER_TASK} per task)` }, 400);
  await logTaskActivity(env, taskId, auth.actor, [
    { field: 'subtask', old_value: 'adicionada', new_value: title.slice(0, SUBTASK_LOG_MAX) },
  ]);
  return json({ ok: true, subtask: created[0], progress: await subtaskProgressOf(env, taskId) });
}

// POST /app/tasks/subtask/toggle — { task_id, id, done }. Marca/desmarca um item.
export async function handleSubtaskTogglePost(req: Request, env: Env): Promise<Response> {
  const auth = await subtaskAuth(req, env);
  if (auth.denied) return auth.denied;
  let body: { task_id?: string; id?: string; done?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const taskId = (body.task_id || '').trim();
  const subId = (body.id || '').trim();
  if (!taskId || !subId) return json({ error: 'task_id and id required' }, 400);
  const done = body.done === true;

  const task = await getTaskById(env, taskId, taskVisPublic(auth.seePrivate));
  if (!task) return json({ error: 'task not found' }, 404);
  const r = await setSubtaskDone(env, taskId, subId, done, auth.actor, Date.now());
  if (r === 'not-found') return json({ error: 'subtask not found' }, 404);
  await logTaskActivity(env, taskId, auth.actor, [
    { field: 'subtask', old_value: done ? 'concluída' : 'reaberta', new_value: r.title.slice(0, SUBTASK_LOG_MAX) },
  ]);
  return json({ ok: true, subtask: r, progress: await subtaskProgressOf(env, taskId) });
}

// POST /app/tasks/subtask/update — { task_id, id, title }. Renomeia um item.
export async function handleSubtaskUpdatePost(req: Request, env: Env): Promise<Response> {
  const auth = await subtaskAuth(req, env);
  if (auth.denied) return auth.denied;
  let body: { task_id?: string; id?: string; title?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const taskId = (body.task_id || '').trim();
  const subId = (body.id || '').trim();
  if (!taskId || !subId) return json({ error: 'task_id and id required' }, 400);
  const title = (typeof body.title === 'string' ? body.title : '').trim();
  if (title.length < 1 || title.length > 200) return json({ error: 'title must be 1-200 chars' }, 400);

  const task = await getTaskById(env, taskId, taskVisPublic(auth.seePrivate));
  if (!task) return json({ error: 'task not found' }, 404);
  const r = await retitleSubtask(env, taskId, subId, title);
  if (r === 'not-found') return json({ error: 'subtask not found' }, 404);
  await logTaskActivity(env, taskId, auth.actor, [
    { field: 'subtask', old_value: 'renomeada', new_value: title.slice(0, SUBTASK_LOG_MAX) },
  ]);
  return json({ ok: true, subtask: r, progress: await subtaskProgressOf(env, taskId) });
}

// POST /app/tasks/subtask/delete — { task_id, id }. Remove um item (hard — não é nota,
// não tem soft-delete próprio; o histórico guarda o título removido).
export async function handleSubtaskDeletePost(req: Request, env: Env): Promise<Response> {
  const auth = await subtaskAuth(req, env);
  if (auth.denied) return auth.denied;
  let body: { task_id?: string; id?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const taskId = (body.task_id || '').trim();
  const subId = (body.id || '').trim();
  if (!taskId || !subId) return json({ error: 'task_id and id required' }, 400);

  const task = await getTaskById(env, taskId, taskVisPublic(auth.seePrivate));
  if (!task) return json({ error: 'task not found' }, 404);
  const removed = await deleteSubtask(env, taskId, subId);
  if (removed === 'not-found') return json({ error: 'subtask not found' }, 404);
  await logTaskActivity(env, taskId, auth.actor, [
    { field: 'subtask', old_value: 'removida', new_value: removed.title.slice(0, SUBTASK_LOG_MAX) },
  ]);
  return json({ ok: true, progress: await subtaskProgressOf(env, taskId) });
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
  if (label.length < 1 || label.length > 40) return formError(req, 'Nome da coluna deve ter 1 a 40 caracteres', { field: 'label', returnTo: '/app/config#board' });

  const category = String(form.get('category') ?? '').trim() as TaskStatus;
  if (!TASK_STATUSES.includes(category)) {
    return formError(req, `Categoria inválida (use uma de: ${TASK_STATUSES.join(', ')})`, { field: 'category', returnTo: '/app/config#board' });
  }

  const color = parseColumnColor(String(form.get('color') ?? ''));
  if (color === 'invalid') return formError(req, 'Cor deve estar no formato #rrggbb ou vazia', { field: 'color', returnTo: '/app/config' });

  await createKanbanColumn(env, { id: `col_${newId().slice(0, 8)}`, label, color, category });
  return boardRedirect();
}

// POST /app/tasks/columns/update — form { id, label?, color? }. Categoria é travada.
export async function handleColumnUpdatePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  if (!id) return formError(req, 'id da coluna obrigatório', { returnTo: '/app/config#board' });

  const patch: { label?: string; color?: string | null } = {};
  if (form.has('label')) {
    const label = String(form.get('label') ?? '').trim();
    if (label.length < 1 || label.length > 40) return formError(req, 'Nome da coluna deve ter 1 a 40 caracteres', { field: 'label', returnTo: '/app/config#board' });
    patch.label = label;
  }
  if (form.has('color')) {
    const color = parseColumnColor(String(form.get('color') ?? ''));
    if (color === 'invalid') return formError(req, 'Cor deve estar no formato #rrggbb ou vazia', { field: 'color', returnTo: '/app/config' });
    patch.color = color;
  }

  const ok = await updateKanbanColumn(env, id, patch);
  if (!ok) return formError(req, 'Coluna não encontrada', { status: 404, returnTo: '/app/config#board' });
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
  if (!id) return formError(req, 'id da coluna obrigatório', { returnTo: '/app/config#board' });
  if (direction !== 'up' && direction !== 'down') return formError(req, 'direction deve ser up ou down', { returnTo: '/app/config' });

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
  if (!id) return formError(req, 'id da coluna obrigatório', { returnTo: '/app/config#board' });

  const col = await getColumnById(env, id);
  if (!col) return formError(req, 'Coluna não encontrada', { status: 404, returnTo: '/app/config#board' });

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
      return formError(req, 'Não é possível arquivar a última coluna ativa dessa categoria', { returnTo: '/app/config#board' });
    }
  }

  // Coluna com tasks precisa de destino da MESMA categoria (ativa, != id).
  const taskCount = await countTasksInColumn(env, id);
  if (taskCount > 0) {
    const to = String(form.get('to') ?? '').trim();
    if (!to) return formError(req, 'Escolha uma coluna destino pras tarefas antes de arquivar', { field: 'to', returnTo: '/app/config#board' });
    if (to === id) return formError(req, 'A coluna destino não pode ser a própria coluna arquivada', { field: 'to', returnTo: '/app/config#board' });
    const dest = await getColumnById(env, to);
    if (!dest || dest.archived_at !== null || dest.category !== col.category) {
      return formError(req, 'Coluna destino inválida (deve ser ativa e da mesma categoria)', { field: 'to', returnTo: '/app/config#board' });
    }
    await reassignColumn(env, id, to);
  }

  await setColumnArchived(env, id, Date.now());
  return boardRedirect();
}

// ─────────────── Gestão de projetos/pastas (spec 58) ───────────────
// Seção "Projetos" em /app/config. Form-encoded + redirect (mesmo padrão das colunas
// do Kanban), sessão de browser obrigatória (sem Bearer — gestão de UI). Arquivar um
// projeto NÃO realoca tasks (só some dos selects; o chip esmaece). NÃO há excluir —
// só arquivar (evita órfãos). Cap de 64 aplicado no create.

const PROJECTS_REDIRECT = '/app/config?saved=projects#projects';
const projectsRedirect = (): Response =>
  new Response(null, { status: 302, headers: { location: PROJECTS_REDIRECT } });

// POST /app/tasks/projects/create — form { label, color? }.
export async function handleProjectCreatePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const label = String(form.get('label') ?? '').trim();
  if (label.length < 1 || label.length > 40) return formError(req, 'Nome do projeto deve ter 1 a 40 caracteres', { field: 'label', returnTo: '/app/config#projects' });

  const color = parseColumnColor(String(form.get('color') ?? ''));
  if (color === 'invalid') return formError(req, 'Cor deve estar no formato #rrggbb ou vazia', { field: 'color', returnTo: '/app/config' });

  // Cap 64 (ativos + arquivados) — mesma regra do auto-create do MCP.
  const count = await countTaskProjects(env);
  if (count >= TASK_PROJECT_CAP) {
    return formError(req, `Limite de ${TASK_PROJECT_CAP} projetos atingido. Arquive um projeto sem uso antes de criar outro.`, { returnTo: '/app/config#projects' });
  }

  await createTaskProject(env, { id: `proj_${newId().slice(0, 8)}`, label, color }, Date.now());
  return projectsRedirect();
}

// POST /app/tasks/projects/update — form { id, label?, color? }.
export async function handleProjectUpdatePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  if (!id) return formError(req, 'id do projeto obrigatório', { returnTo: '/app/config#projects' });

  const patch: { label?: string; color?: string | null } = {};
  if (form.has('label')) {
    const label = String(form.get('label') ?? '').trim();
    if (label.length < 1 || label.length > 40) return formError(req, 'Nome do projeto deve ter 1 a 40 caracteres', { field: 'label', returnTo: '/app/config#projects' });
    patch.label = label;
  }
  if (form.has('color')) {
    const color = parseColumnColor(String(form.get('color') ?? ''));
    if (color === 'invalid') return formError(req, 'Cor deve estar no formato #rrggbb ou vazia', { field: 'color', returnTo: '/app/config' });
    patch.color = color;
  }

  const ok = await updateTaskProject(env, id, patch);
  if (!ok) return formError(req, 'Projeto não encontrado', { status: 404, returnTo: '/app/config#projects' });
  return projectsRedirect();
}

// POST /app/tasks/projects/reorder — form { id, direction: up|down }. Sem vizinha =
// no-op (redireciona mesmo assim).
export async function handleProjectReorderPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  const direction = String(form.get('direction') ?? '').trim();
  if (!id) return formError(req, 'id do projeto obrigatório', { returnTo: '/app/config#projects' });
  if (direction !== 'up' && direction !== 'down') return formError(req, 'direction deve ser up ou down', { returnTo: '/app/config' });

  await reorderTaskProject(env, id, direction);
  return projectsRedirect();
}

// POST /app/tasks/projects/archive — form { id, archived: 1|0 }. Arquivar NÃO
// realoca tasks (project_id fica; chip esmaece). Idempotente.
export async function handleProjectArchivePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  if (!id) return formError(req, 'id do projeto obrigatório', { returnTo: '/app/config#projects' });

  const proj = await getProjectById(env, id);
  if (!proj) return formError(req, 'Projeto não encontrado', { status: 404, returnTo: '/app/config#projects' });

  const archived = String(form.get('archived') ?? '1').trim() !== '0';
  await setProjectArchived(env, id, archived ? Date.now() : null);
  return projectsRedirect();
}

// ─────────────── Gestão global de tags (seção Tags de /app/config) ───────────────
// Tags são vocabulário aberto (nascem na edição de nota/task); aqui só renomear em
// massa e apagar. Lógica de banco em db/tag-admin.ts.

const TAGS_REDIRECT = '/app/config?saved=tags#tags';
const tagsRedirect = (): Response =>
  new Response(null, { status: 302, headers: { location: TAGS_REDIRECT } });

// POST /app/tasks/tags/rename — form { from, to }. Merge-safe (nota que já tem a
// tag destino não duplica).
export async function handleTagRenamePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const from = String(form.get('from') ?? '').trim();
  const to = String(form.get('to') ?? '').trim();
  if (!from || !to) return formError(req, 'Tag de origem e novo nome são obrigatórios', { field: 'to', returnTo: '/app/config#tags' });
  if (to.length > 60) return formError(req, 'Nome da tag deve ter até 60 caracteres', { field: 'to', returnTo: '/app/config#tags' });
  if (to.toLowerCase().startsWith('dedupe:')) return formError(req, 'Prefixo dedupe: é reservado', { field: 'to', returnTo: '/app/config#tags' });

  const n = await renameTag(env, from, to);
  if (n === null) return formError(req, 'Tag não encontrada', { status: 404, returnTo: '/app/config#tags' });
  return tagsRedirect();
}

// POST /app/tasks/tags/delete — form { tag }. Remove a tag de todas as notas.
export async function handleTagDeletePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const tag = String(form.get('tag') ?? '').trim();
  if (!tag) return formError(req, 'tag obrigatória', { returnTo: '/app/config#tags' });

  await deleteTag(env, tag);
  return tagsRedirect();
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

// Breadcrumb de projeto do card (Onda 5): resolve o project_id da task no
// BoardProject (do payload) pra pegar label/cor/arquivado. Órfão/ausente → nada.
function cardProjectCrumb(v: TaskView, projectsById: Map<string, BoardProject>): string {
  if (!v.project_id) return '';
  const p = projectsById.get(v.project_id);
  return p ? projectCrumbHtml({ label: p.label, color: p.color, archived: p.archived }) : '';
}

// Badge 🔒 do card/detalhe (spec 59) — mesma classe global .private-badge das notas.
const PRIVATE_TASK_BADGE = '<span class="private-badge" title="Tarefa privada — invisível pra credenciais sem escopo private">🔒 privada</span>';

// Anatomia do card no padrão ClickUp (Onda 5, decisão do gate da Onda 1): título
// PRIMEIRO (clamp 2 linhas), breadcrumb de projeto muted, UMA linha de meta
// (prio + prazo + comentários + selo privada + link) e UMA linha de tags sem wrap.
// Mesma estrutura do cardHTML do client (src/web/client/tasks.ts) — manter em sincronia.
function renderCardSSR(v: TaskView, projectsById: Map<string, BoardProject>): string {
  const canClose = v.status === 'open' || v.status === 'in_progress';
  const tags = tagChipsHtml(v.tags);
  return `<div class="task-card" data-id="${esc(v.id)}" data-status="${esc(v.status)}"${v.project_id ? ` data-project="${esc(v.project_id)}"` : ''}>
    <div class="task-card-top"><a class="task-card-title" href="/app/tasks/${esc(v.id)}" draggable="false">${esc(v.title)}</a></div>
    ${cardProjectCrumb(v, projectsById)}
    <div class="task-card-meta">${priorityPill(v.priority)}${dueBadge(v)}${commentBadge(v.comment_count)}${subtaskBadge(v.subtask_progress)}${v.private ? PRIVATE_TASK_BADGE : ''}${shareIconHtml(v.share_expires_brt)}${claimChipHtml(v.claim)}${assigneeDotsHtml(v.assignees)}</div>
    ${tags ? `<div class="task-card-tags">${tags}</div>` : ''}
    ${canClose ? `<div class="task-card-actions"><button class="btn btn-sm btn-ghost task-complete" data-id="${esc(v.id)}" type="button">✓ concluir</button></div>` : ''}
  </div>`;
}

function columnSwatch(color: string | null): string {
  const c = safeColumnColor(color);
  return `<span class="task-col-dot"${c ? ` style="background:${esc(c)}"` : ''}></span>`;
}

function renderColumnSSR(col: BoardColumn, projectsById: Map<string, BoardProject>): string {
  const c = safeColumnColor(col.color);
  return `<section class="task-col" data-col="${esc(col.id)}" data-category="${esc(col.category)}"${c ? ` style="--col-accent:${esc(c)}"` : ''}>
    <header class="task-col-head"><span class="task-col-label">${columnSwatch(col.color)}${esc(col.label)}</span><span class="task-col-count" data-count="${esc(col.id)}">${col.tasks.length}</span></header>
    <div class="task-col-body" data-dropzone="${esc(col.id)}">
      ${col.tasks.map((t) => renderCardSSR(t, projectsById)).join('') || '<div class="task-col-empty">Solte tarefas aqui</div>'}
    </div>
  </section>`;
}

// Select de filtro por projeto no header do board (spec 58). "Todos os projetos"
// (default) | "Sem projeto" | cada ativo (com bolinha de cor) | subgrupo
// "Arquivados". O estado real (query param + localStorage) é aplicado no client;
// o SSR só monta o select com todos os projetos. `selected` marca a opção inicial
// (vinda do ?project=… pra o primeiro paint bater com o client).
function renderProjectFilter(projects: BoardProject[], selected: string): string {
  const actives = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);
  const opt = (value: string, label: string) =>
    `<option value="${esc(value)}"${selected === value ? ' selected' : ''}>${esc(label)}</option>`;
  const activeOpts = actives.map((p) => opt(p.id, p.label)).join('');
  const archivedOpts = archived.length
    ? `<optgroup label="Arquivados">${archived.map((p) => opt(p.id, p.label)).join('')}</optgroup>`
    : '';
  return `<select class="task-project-filter" id="task-project-filter" aria-label="Filtrar por projeto">
    ${opt('all', 'Todos os projetos')}
    ${opt('none', 'Sem projeto')}
    ${activeOpts}
    ${archivedOpts}
  </select>`;
}

export async function handleTasksPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const now = Date.now();
  const { columns, projects, awaiting } = await buildBoard(env, now);
  const totalOpen = countOpenOnBoard(columns);
  const projectsById = new Map<string, BoardProject>(projects.map((p) => [p.id, p]));

  // Filtro inicial vindo do ?project= (id|none|all) — o client reconcilia com
  // localStorage, mas o SSR já marca a opção pra o primeiro paint bater.
  const url = new URL(req.url);
  const initialProject = url.searchParams.get('project') || 'all';

  // Options de prioridade do form de criação (bandeirinha + rótulo estilo ClickUp).
  const createPrioOptions = [
    `<option value="" selected>Sem prioridade</option>`,
    ...PRIORITIES.map((m) => `<option value="${m.value}">${esc(m.label)}</option>`),
  ].join('');

  // Filtro por prioridade (Onda 8): Todas | cada uma das 4 | Sem prioridade.
  const prioFilterOptions = [
    `<option value="all" selected>Todas as prioridades</option>`,
    ...PRIORITIES.map((m) => `<option value="${m.value}">${esc(m.label)}</option>`),
    `<option value="none">Sem prioridade</option>`,
  ].join('');

  // Filtro por tag (Onda 8 → P1 audit ui-audit/RELATORIO.md item T1): união das
  // tags visíveis de todos os cards do board, num popover com busca (o vocabulário
  // de tags do dono passa de centenas de itens — um <select> nativo era inviável
  // sem typeahead). O client re-popula a lista a cada load() (tags mudam com edição
  // inline) e refaz a busca client-side (fold, sem acento/caixa).
  const allTags = new Set<string>();
  for (const col of columns) for (const t of col.tasks) for (const tag of t.tags) allTags.add(tag);
  const sortedTags = [...allTags].sort((a, b) => a.localeCompare(b));
  const tagOptionsHtml = sortedTags
    .map((t) => `<button type="button" class="task-tag-opt" data-tag-value="${esc(t)}">${esc(t)}</button>`)
    .join('');

  const body = `
    <div class="page-header">
      <h1>Tarefas</h1>
      <span class="count" id="tasks-count">${totalOpen} aberta${totalOpen === 1 ? '' : 's'}</span>
      <button class="btn btn-primary task-new-btn" id="task-new-btn" type="button">
        <span class="task-new-plus" aria-hidden="true">+</span> Nova tarefa
      </button>
    </div>
    ${formErrorBanner(url)}
    ${columns.every((c) => c.tasks.length === 0) ? `<div class="empty-state tasks-empty-state">
      <p class="empty-state-title">Nenhuma task ainda</p>
      <p>O board organiza o que você e seus agentes estão tocando — comece pela primeira.</p>
      <button type="button" class="btn btn-primary" data-click-proxy="task-new-btn">Criar primeira tarefa</button>
    </div>` : ''}

    <div class="task-toolbar" role="toolbar" aria-label="Filtros de tarefas">
      <input type="search" class="task-search" id="task-search" placeholder="Buscar por título, descrição ou tag…"
        aria-label="Buscar tarefas por título, descrição ou tag" autocomplete="off" />
      <button class="task-filter active" data-filter="all" type="button">Todas abertas</button>
      <button class="task-filter" data-filter="today" type="button">Vencem hoje</button>
      <button class="task-filter" data-filter="week" type="button">Esta semana</button>
      <button class="task-filter" data-filter="overdue" type="button">Atrasadas</button>
      <button class="task-filter" data-filter="mentions" type="button">Menções a mim</button>
      <span class="task-mailbox-badges" id="task-mailbox-badges"></span>
      <div class="task-date-filter" id="task-date-filter" title="Filtrar por intervalo de vencimento">
        <input type="date" class="task-date-input" id="task-date-from" aria-label="Vencimento a partir de" />
        <span class="task-date-sep">até</span>
        <input type="date" class="task-date-input" id="task-date-to" aria-label="Vencimento até" />
        <button type="button" class="task-date-clear" id="task-date-clear" hidden aria-label="Limpar filtro de data" title="Limpar filtro de data">✕</button>
      </div>
      <span class="task-toolbar-spacer"></span>
      <select class="task-project-filter" id="task-prio-filter" aria-label="Filtrar por prioridade">${prioFilterOptions}</select>
      <div class="task-tag-filter" id="task-tag-filter">
        <button type="button" class="task-tag-trigger" id="task-tag-trigger" aria-haspopup="true" aria-expanded="false">
          <span id="task-tag-trigger-label">Todas as tags</span>
        </button>
        <button type="button" class="task-tag-clear" id="task-tag-clear" hidden aria-label="Limpar filtro de tag" title="Limpar filtro de tag">✕</button>
        <div class="task-tag-panel" id="task-tag-panel" hidden>
          <input type="search" class="task-tag-search" id="task-tag-search" placeholder="Buscar tag…"
            autocomplete="off" aria-label="Buscar tag" />
          <div class="task-tag-list" id="task-tag-list" role="listbox" aria-label="Tags">
            <button type="button" class="task-tag-opt selected" data-tag-value="all">Todas as tags</button>
            ${tagOptionsHtml}
          </div>
        </div>
      </div>
      ${renderProjectFilter(projects, initialProject)}
    </div>

    <div class="task-awaiting" id="task-awaiting"${awaiting.length ? '' : ' hidden'}>
      ${awaitingBannerHtml(awaiting)}
    </div>

    <div class="task-board" id="task-board">
      ${columns.map((c) => renderColumnSSR(c, projectsById)).join('')}
    </div>

    <div class="task-modal" id="task-create-modal" hidden aria-hidden="true">
      <div class="task-modal-backdrop" data-close-modal></div>
      <div class="task-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="task-create-title">
        <div class="task-modal-head">
          <h2 id="task-create-title">Nova tarefa</h2>
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
              <button class="btn btn-primary task-create-submit" type="submit">Criar tarefa</button>
            </div>
          </div>
        </form>
      </div>
    </div>

    <script src="/app/tasks/bundle.js?v=${assetVersion('tasks.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    await renderShell({
      title: 'Tarefas',
      active: 'tasks',
      email: session.email,
      env,
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
/* Botão "Nova task" — hierarquia vem do .btn-primary (Onda 3); aqui só o posicionamento */
.task-new-btn { margin-left: auto; }
.task-new-plus { font-size: 17px; line-height: 1; font-weight: 400; }

.task-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
/* Busca do board (Onda 8): título + descrição + tags, client-side sobre o payload */
.task-search {
  flex: 1 1 240px; min-width: 180px; max-width: 380px;
  background: var(--surface); border: 1px solid var(--border); color: var(--text);
  border-radius: 999px; padding: 6px 14px; font-size: 13px; font-family: inherit;
  transition: border-color 160ms var(--ease);
}
.task-search::placeholder { color: var(--text-subtle); }
.task-search:focus { outline: none; border-color: var(--accent-lav); }
.task-filter {
  background: var(--surface); border: 1px solid var(--border); color: var(--text-dim);
  border-radius: 999px; padding: 6px 14px; font-size: 13px; cursor: pointer;
  transition: all 160ms var(--ease);
}
.task-filter:hover { color: var(--text); border-color: var(--border-strong); }
.task-filter.active { color: var(--accent-lav); border-color: var(--border-strong); background: rgba(167,139,250,0.1); }
.task-mailbox-badges { display: inline-flex; gap: 6px; align-items: center; }
.task-mailbox-chip {
  font-size: 11px; color: var(--text-dim); border: 1px solid var(--border);
  border-radius: 999px; padding: 2px 9px; white-space: nowrap;
}
.task-mailbox-chip b { color: var(--accent-lav); font-weight: 600; margin-left: 2px; }

/* Banner "Aguardando você" (spec 89): fila de bloqueios da frota pendentes de
   resposta do dono, acima do board. Some inteiro quando vazio ([hidden]). */
.task-awaiting {
  background: rgba(251,191,36,0.06); border: 1px solid rgba(251,191,36,0.35);
  border-radius: var(--radius); padding: 12px 14px; margin-bottom: 20px;
}
.task-awaiting[hidden] { display: none; }
.task-awaiting-head {
  font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: #fbbf24; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;
}
.task-awaiting-count {
  font-size: 11px; background: rgba(251,191,36,0.15); border-radius: 999px;
  padding: 1px 8px; font-variant-numeric: tabular-nums;
}
.task-awaiting-list { display: flex; flex-direction: column; gap: 6px; }
.task-awaiting-item {
  display: flex; align-items: baseline; gap: 10px; text-decoration: none;
  padding: 6px 8px; border-radius: var(--radius-sm); transition: background 140ms var(--ease);
}
.task-awaiting-item:hover { background: rgba(251,191,36,0.08); }
.task-awaiting-title { font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; flex: none; }
.task-awaiting-body { font-size: 12px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
.task-awaiting-meta { font-size: 11px; color: var(--text-subtle); white-space: nowrap; flex: none; }

/* Chip de claim do card (spec 88/89): quem detém o lease de trabalho agora. */
.task-claim-chip {
  font-size: 11px; color: #6ee7b7; border: 1px solid rgba(110,231,183,0.35);
  background: rgba(110,231,183,0.08); border-radius: 999px; padding: 1px 8px;
  white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis;
}

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
.task-col-head-right { display: flex; align-items: center; gap: 6px; }
.task-col-count {
  font-size: 11px; font-weight: 600; color: var(--text-dim); background: var(--surface-raised);
  border-radius: 999px; padding: 2px 9px; min-width: 24px; text-align: center;
  font-variant-numeric: tabular-nums;
}
/* Colapsar coluna (spec 52): estado persiste em localStorage (kanban_collapsed).
   --text-dim no lugar de --text-subtle (P2 audit item 4/T4): o botão fica ao lado
   da contagem da coluna — apagado demais deixava a dupla contagem+chevron ilegível. */
.task-col-collapse-btn {
  background: none; border: none; color: var(--text-dim); font-size: 11px; line-height: 1;
  cursor: pointer; padding: 3px 5px; border-radius: 5px; transition: color 140ms var(--ease), background 140ms var(--ease);
}
.task-col-collapse-btn:hover { color: var(--text); background: rgba(255,255,255,0.06); }
.task-col.collapsed { padding-bottom: 12px; }
.task-col.collapsed .task-col-body,
.task-col.collapsed .task-col-inline-create { display: none; }
.task-col-body {
  display: flex; flex-direction: column; gap: 10px; min-height: 72px;
  border-radius: var(--radius-sm); padding: 2px;
  transition: background 160ms var(--ease), box-shadow 160ms var(--ease);
}
/* Alvo do drop (spec 65): borda + header da coluna acendem — nunca o fundo inteiro.
   A classe .drag-target vai na <section class="task-col"> (board-dnd.ts). */
.task-col.drag-target {
  border-color: var(--accent-lav); border-top-color: var(--accent-lav);
  box-shadow: inset 0 0 0 1px var(--accent-lav);
}
.task-col.drag-target .task-col-label { color: var(--accent-lav); }
/* Coluna vazia — definição ÚNICA (Onda 5 consolidou; a duplicata do styles.ts saiu).
   Tracejado invisível em repouso; acende como convite durante o drag (spec 65). */
.task-col-empty {
  margin: 4px 2px; padding: 20px 10px;
  color: var(--text-subtle); font-size: 13px; text-align: center;
  border: 1px dashed transparent; border-radius: var(--radius-sm);
  user-select: none;
  transition: border-color 160ms var(--ease);
}
/* Durante o drag, TODA coluna vazia mostra o tracejado (convite sutil); a coluna
   alvo destaca mais forte. */
body.task-dragging .task-col-empty { border-color: var(--border); }
.task-col.drag-target .task-col-empty { border-color: var(--border-strong); color: var(--text-dim); }

/* "+ Nova tarefa" inline no rodapé da coluna (spec 52) — cria já na coluna certa */
.task-col-inline-create { margin-top: 8px; padding: 0 2px; }
.task-col-inline-input {
  width: 100%; box-sizing: border-box; background: transparent; border: 1px dashed var(--border);
  color: var(--text); border-radius: var(--radius-sm); padding: 7px 10px; font-family: inherit;
  font-size: 12.5px; transition: border-color 160ms var(--ease), background 160ms var(--ease);
}
.task-col-inline-input::placeholder { color: var(--text-subtle); }
.task-col-inline-input:focus { outline: none; border-style: solid; border-color: var(--accent-lav); background: var(--bg-accent); }
.task-col-inline-input:disabled { opacity: 0.5; }

/* Anatomia ClickUp (Onda 5): flex column com gap único entre as linhas (título →
   breadcrumb → meta → tags → concluir) e altura mínima consistente entre cards. */
.task-card {
  display: flex; flex-direction: column; gap: 7px; min-height: 86px;
  background: var(--bg-accent); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 12px 13px; cursor: pointer;
  transition: border-color 160ms var(--ease), transform 160ms var(--ease), box-shadow 160ms var(--ease), opacity 160ms var(--ease);
}
.task-card:hover { border-color: var(--border-strong); box-shadow: 0 6px 18px -12px rgba(0,0,0,0.6); }
/* O <a> do título segue sendo o único tab stop; o anel de foco vai pro card todo */
.task-card:focus-within { border-color: var(--accent-lav); }
/* Card sendo arrastado: esmaece no lugar de origem (o clone .task-card-ghost segue o ponteiro) */
.task-card.dragging { opacity: 0.35; box-shadow: 0 10px 30px -12px rgba(0,0,0,0.7); border-color: var(--accent-lav); }
/* Clone que segue o ponteiro durante o drag (board-dnd.ts) — fora do fluxo, sem hit-test */
.task-card-ghost {
  position: fixed; z-index: 400; margin: 0; pointer-events: none;
  background: var(--bg-accent); border: 1px solid var(--accent-lav);
  border-radius: var(--radius-sm); padding: 12px 13px;
  opacity: 0.95; box-shadow: 0 18px 44px -12px rgba(0,0,0,0.75);
  transform: rotate(1.5deg); transition: none;
}
.task-card[data-status="done"], .task-card[data-status="canceled"] { opacity: 0.62; }
.task-card[data-status="done"] .task-card-title { text-decoration: line-through; color: var(--text-dim); }
/* Card focado via ?task=<id> (spec 66: paleta abre o board com o card em destaque) —
   anel temporário, remove sozinho depois de scrollar até ele. */
.task-card.task-card-focused { border-color: var(--accent-lav); box-shadow: 0 0 0 2px var(--accent-lav); }
/* Título PRIMEIRO (clamp 2 linhas); o ✎ de edição rápida fica ao lado, no topo */
.task-card-top { display: flex; align-items: flex-start; gap: 8px; }
.task-card-title {
  flex: 1; min-width: 0;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  color: var(--text); font-size: 14px; line-height: 1.4; font-weight: 500;
}
.task-card-title:hover { color: var(--accent-lav); }
/* Breadcrumb de projeto muted "Em <projeto>" (substitui o chip colorido no head) */
.task-card-crumb {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--text-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.task-card-crumb.archived { opacity: 0.5; }
/* UMA linha de meta: prio + prazo + comentários + selo privada + link público */
.task-card-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.task-card-meta:empty { display: none; }
/* UMA linha de tags, sem wrap — excesso corta (o helper já limita a 3 + "+N") */
.task-card-tags { display: flex; align-items: center; gap: 5px; flex-wrap: nowrap; overflow: hidden; }
/* "concluir" gruda no rodapé do card — cards curtos ficam com altura consistente */
.task-card-actions { display: flex; gap: 12px; margin-top: auto; }
/* --text-dim no lugar de --text-subtle (P2 audit item 4): "concluir", o ✎ de edição
   rápida e "limpar prazo" são controles funcionais sobre metadados do card, não
   decoração — mereciam mais contraste que o texto auxiliar puro. */
.task-btn {
  background: none; border: none; color: var(--text-dim); font-size: 12px;
  cursor: pointer; padding: 0; transition: color 140ms var(--ease);
}
.task-btn:hover { color: var(--accent-lav); }

.task-due { font-size: 11px; color: var(--text-dim); background: var(--surface-raised); border-radius: 6px; padding: 2px 8px; font-variant-numeric: tabular-nums; }
.task-due.overdue { color: var(--danger); background: var(--danger-bg); }

/* Contagem de comentários (spec 53): ícone bolha + número, tom discreto */
.task-comments { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); background: var(--surface-raised); border-radius: 6px; padding: 2px 8px; }
.task-comments-n { font-variant-numeric: tabular-nums; line-height: 1; }

/* Progresso do checklist (spec 38): "3/8" no card, visual casado com .task-comments */
.task-subs { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-dim); background: var(--surface-raised); border-radius: 6px; padding: 2px 8px; }
.task-subs-n { font-variant-numeric: tabular-nums; line-height: 1; }
.task-subs-complete { color: var(--success); }

/* Responsáveis (spec 37): bolinhas empilhadas no fim da linha de meta, estilo
   ClickUp. Foto quando tem; senão iniciais sobre cor derivada do id. Agente
   ganha anel tracejado (máquina ≠ pessoa à primeira vista). */
.task-assignees { display: inline-flex; align-items: center; margin-left: auto; }
.task-assignees .assignee-dot { margin-left: -6px; }
.task-assignees .assignee-dot:first-child { margin-left: 0; }
.assignee-dot {
  width: 20px; height: 20px; border-radius: 50%; object-fit: cover;
  border: 1.5px solid var(--bg-accent); box-sizing: content-box;
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.assignee-dot-initials { color: #fff; font-size: 9px; font-weight: 600; letter-spacing: 0.3px; line-height: 1; }
.assignee-dot-agent { outline: 1px dashed var(--text-dim); outline-offset: 1px; }
.assignee-dot-more { background: var(--surface-raised); color: var(--text-dim); }
/* Slot vazio (sem responsável): tracejado, sempre visível — ausência é informação */
.assignee-dot-empty { border: 1.5px dashed var(--border-strong); background: transparent; color: var(--text-dim); }

/* Tags no card (spec 52): até 3 chips + "+N", cor neutra — nunca dedupe:* */
.task-tag-chip {
  display: inline-flex; align-items: center; font-size: 10.5px; font-weight: 500;
  color: var(--text-dim); background: var(--surface-raised); border-radius: 6px; padding: 2px 7px;
}
/* Contraste (P2 audit item 4): "+N" é contagem informativa (quantas tags o card
   esconde) — --text-subtle (6.0:1) é passável mas apagado demais pra um número que
   importa; --text-dim (9.7:1, mesma escala das demais contagens do board) resolve
   sem mexer em layout. */
.task-tag-more { color: var(--text-dim); }
/* Ícone de link público ativo (spec 52) — discreto, só title explica a validade */
.task-share-icon { display: inline-flex; align-items: center; color: var(--accent-lav); }

/* Bolinha de cor do projeto — usada pelo breadcrumb do card (Onda 5) */
.task-project-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong); flex: none; }

/* Filtro de vencimento por intervalo (pedido 10/07): pill com dois date inputs */
.task-date-filter {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 999px; padding: 2px 10px;
  transition: border-color 160ms var(--ease);
}
.task-date-filter.has-value { border-color: var(--accent-lav); }
.task-date-input {
  background: none; border: none; color: var(--text); font-size: 12.5px; font-family: inherit;
  padding: 4px 0; width: 118px; cursor: pointer;
}
.task-date-input:focus { outline: none; }
.task-date-input::-webkit-calendar-picker-indicator { filter: invert(0.7); cursor: pointer; }
.task-date-sep { font-size: 11.5px; color: var(--text-subtle); }
.task-date-clear {
  background: none; border: none; color: var(--accent-lav); font-size: 12px; line-height: 1;
  cursor: pointer; padding: 4px 2px; display: inline-flex; align-items: center;
}
.task-date-clear:hover { color: var(--text); }
.task-date-clear[hidden] { display: none; }

/* Filtro de projeto no header do board (spec 58) */
.task-toolbar-spacer { flex: 1 1 auto; }
.task-project-filter {
  background: var(--surface); border: 1px solid var(--border); color: var(--text);
  border-radius: 999px; padding: 6px 12px; font-size: 13px; font-family: inherit; cursor: pointer;
  transition: border-color 160ms var(--ease);
}
.task-project-filter:focus { outline: none; border-color: var(--accent-lav); }

/* Filtro de tag (P1 audit item T1): popover com busca no lugar do <select> nativo
   de centenas de opções — padrão ClickUp (botão abre painel com input no topo +
   lista filtrada; tag selecionada vira chip com × pra limpar). */
.task-tag-filter { position: relative; display: inline-flex; align-items: stretch; }
.task-tag-trigger {
  background: var(--surface); border: 1px solid var(--border); color: var(--text);
  border-radius: 999px; padding: 6px 12px; font-size: 13px; font-family: inherit; cursor: pointer;
  transition: border-color 160ms var(--ease), color 160ms var(--ease), background 160ms var(--ease);
  display: inline-flex; align-items: center; gap: 6px; max-width: 160px;
}
.task-tag-trigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-tag-trigger:hover { border-color: var(--border-strong); }
.task-tag-trigger[aria-expanded="true"] { border-color: var(--accent-lav); }
/* Tag ativa: o gatilho vira o "corpo" do chip — a cor lavanda comunica filtro ligado */
.task-tag-filter.has-value .task-tag-trigger {
  border-radius: 999px 0 0 999px; border-right: none; color: var(--accent-lav);
  border-color: var(--accent-lav); background: rgba(167,139,250,0.1);
}
.task-tag-clear {
  background: var(--surface); border: 1px solid var(--border); border-left: none; color: var(--text-dim);
  border-radius: 0 999px 999px 0; padding: 6px 10px; font-size: 12px; line-height: 1; cursor: pointer;
  display: inline-flex; align-items: center; transition: color 140ms var(--ease), background 140ms var(--ease);
}
.task-tag-filter.has-value .task-tag-clear {
  border-color: var(--accent-lav); color: var(--accent-lav); background: rgba(167,139,250,0.1); border-left: none;
}
.task-tag-clear:hover { color: var(--text); background: rgba(255,255,255,0.08); }
.task-tag-clear[hidden] { display: none; }
.task-tag-panel {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 60;
  width: 240px; max-height: 320px;
  background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius);
  box-shadow: 0 16px 40px -12px rgba(0,0,0,0.6);
  padding: 8px; display: flex; flex-direction: column; gap: 6px;
}
.task-tag-panel[hidden] { display: none; }
.task-tag-search {
  background: var(--bg-accent); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 7px 10px; font-size: 13px; font-family: inherit;
  transition: border-color 160ms var(--ease);
}
.task-tag-search::placeholder { color: var(--text-subtle); }
.task-tag-search:focus { outline: none; border-color: var(--accent-lav); }
.task-tag-list { display: flex; flex-direction: column; gap: 1px; max-height: 240px; overflow-y: auto; }
.task-tag-opt {
  background: none; border: none; color: var(--text); text-align: left;
  font-size: 13px; padding: 7px 9px; border-radius: var(--radius-sm); cursor: pointer;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: background 120ms var(--ease);
  /* flex:none é o FIX do texto cortado (bug reportado 10/07): a lista é flex column
     com max-height+overflow, e overflow:hidden no botão zera o min-height automático
     — sem isso o flex-shrink esmaga cada linha verticalmente quando há muitas tags. */
  flex: none;
}
.task-tag-opt:hover { background: rgba(167,139,250,0.12); }
.task-tag-opt.selected { color: var(--accent-lav); font-weight: 600; }
.task-tag-empty { padding: 10px 9px; font-size: 12.5px; color: var(--text-dim); text-align: center; }

/* Bandeirinha de prioridade estilo ClickUp: flag colorida + rótulo, fundo tênue */
.task-prio {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 600; border-radius: 6px; padding: 2px 8px 2px 6px; letter-spacing: 0.01em;
}
.task-prio-lbl { line-height: 1; }
.task-prio-p1 { color: var(--prio-1); background: color-mix(in srgb, var(--prio-1) 14%, transparent); }
.task-prio-p2 { color: var(--prio-2); background: color-mix(in srgb, var(--prio-2) 14%, transparent); }
.task-prio-p3 { color: var(--prio-3); background: color-mix(in srgb, var(--prio-3) 14%, transparent); }
.task-prio-p4 { color: var(--prio-4); background: var(--surface-raised); }

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
.task-card-edit-msg { font-size: 11px; color: var(--text-subtle); }
.task-card-edit-msg.saving { color: var(--text-dim); }
.task-card-edit-msg.ok { color: var(--success); }
.task-card-edit-msg.err { color: var(--danger); }

/* ── Modal "Nova task" (spec 36 fase 2): painel leve, mesma linguagem do cmd-palette ── */
.task-modal { position: fixed; inset: 0; z-index: 1000; }
.task-modal[hidden] { display: none; }
.task-modal-backdrop {
  position: absolute; inset: 0; background: var(--backdrop);
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
  background: none; border: none; color: var(--text-subtle); font-size: 18px; line-height: 1;
  cursor: pointer; padding: 4px 6px; border-radius: 6px; transition: background 160ms var(--ease), color 160ms var(--ease);
}
.task-modal-x:hover { background: rgba(255,255,255,0.08); color: var(--text); }
.task-create-form { display: flex; flex-direction: column; gap: 16px; }
.task-create-ctl { display: flex; flex-direction: column; gap: 6px; }
.task-create-lbl {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-subtle);
  display: flex; align-items: center; gap: 8px;
}
.task-create-req { color: var(--danger); text-transform: none; letter-spacing: 0; font-weight: 500; }
.task-create-opt { color: var(--text-subtle); text-transform: none; letter-spacing: 0; opacity: 0.8; }
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
.task-create-msg { font-size: 12px; color: var(--text-subtle); }
.task-create-msg.saving { color: var(--text-dim); }
.task-create-msg.err { color: var(--danger); }
.task-create-actions { display: flex; gap: 10px; align-items: center; }
/* Submit do modal usa .btn-primary (Onda 3); só o disabled zera o efeito de hover */
.task-create-submit:disabled { transform: none; box-shadow: none; }

/* Enquanto arrasta: cursor grabbing na página toda, seleção de texto suspensa e
   colunas com corpo mínimo pra receber o drop */
body.task-dragging { cursor: grabbing; user-select: none; }
body.task-dragging .task-card { cursor: grabbing; }
body.task-dragging .task-col-body { min-height: 90px; }

@keyframes taskFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes taskSlideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }

/* Breakpoint canônico 767px (Onda 5 — alinhado ao shell) */
@media (max-width: 767px) {
  .task-board { grid-auto-flow: row; grid-auto-columns: auto; grid-template-columns: 1fr; }
  .task-create-grid { grid-template-columns: 1fr 1fr; }
  .task-modal-dialog { margin: 6vh 16px 0; }
  .task-search { flex-basis: 100%; max-width: none; }
  .task-tag-panel { width: min(240px, calc(100vw - 32px)); }
}
`;
