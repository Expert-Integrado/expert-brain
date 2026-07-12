import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolSuccess, toolError, noteUrl, canSeePrivate } from '../helpers.js';
import { TASK_STATUSES, listActiveTasks, listRecentClosedTasks, ftsSearchTasks, getTagsForNotes, listKanbanColumns, resolveTaskColumn, countTaskCommentsBatch, listTaskProjects, getProjectByIdOrLabel, listNoteIdsMentioning, getUserByIdOrName, taskIdsAssignedTo, listAssigneesForTasks, claimActive, listTasksAwaitingOwner, type TaskRow, type TaskProject } from '../../db/queries.js';
import { resolveMe } from './user-ref.js';
import { formatBrtDateTime, relativeDue } from '../../util/time.js';

const inputSchema = {
  query: z.string().optional().describe('Optional full-text search over task title + body (prefix match). Runs ONLY over tasks and includes ALL statuses by default (searching also covers done/canceled, so dedup can see finished tasks). status/tag filters still apply on top.'),
  status: z.array(z.enum(TASK_STATUSES)).optional().describe("Filter by status (e.g. ['open'] or ['open','in_progress']). Default: open + in_progress. Passing ['done'] (or ['canceled']) returns closed tasks automatically — no need for include_closed — limited to the most recent N (by `limit`), not the full history."),
  include_closed: z.boolean().optional().describe('Also include done/canceled tasks (most recent first). Redundant when status already lists done/canceled or when query is set. Default false.'),
  tag: z.string().optional().describe('Only tasks carrying this tag (case-insensitive). Tag is a MULTI-valued, transversal label (e.g. a contact name, maquina:pc-principal) — for a single-valued folder use `project` instead.'),
  project: z.string().optional().describe('Only tasks in this PROJECT (folder). Accepts a project id (proj_...) or label (case-insensitive); resolves among BOTH active AND archived projects (so you can list a finished project’s history). A single-valued grouping, distinct from `tag`. No match → empty result.'),
  mentions_entity: z.string().optional().describe('Only tasks that MENTION this CONTACT (entity id from the Contacts vault) — "tasks with this person". Get the id via get_contact_by_phone / search_contacts. No match → empty result. Composes with status/tag/project/query.'),
  assignee: z.string().optional().describe('Only tasks ASSIGNED to this user (responsible). Ref by user id (user_...), name (case-insensitive), or "me" (the profile linked to this credential — an agent\'s own queue). Unknown ref → empty result; "me" without a linked profile → error explaining how to link. Composes with the other filters. See list_users.'),
  available: z.boolean().optional().describe('Only tasks AVAILABLE to work on (spec 88): not claimed, claim expired, or claimed by ME. An agent picking work should use assignee:"me" + available:true, then claim_task the chosen one. Composes with the other filters.'),
  awaiting_owner: z.boolean().optional().describe("Only tasks WAITING ON THE OWNER's decision (spec 88): the latest [bloqueio] comment has no owner reply after it. The owner's approval queue — replying in the thread clears the task from it. Composes with the other filters."),
  limit: z.number().int().min(1).max(500).optional().describe('Max tasks to return (default 200).'),
};

const DESCRIPTION = `Lists tasks regardless of due date — including tasks WITHOUT a due date (which list_tasks_due_today never shows).

This is the complete task view: by default returns all OPEN + IN-PROGRESS tasks (ordered by due date then priority). Pass \`query\` for full-text search over tasks (title+body, all statuses), \`status\` to filter (asking for ['done']/['canceled'] auto-includes closed tasks — no include_closed needed, capped to the most recent by \`limit\`), \`tag\` to scope by a transversal label (multi), \`project\` to scope by a folder (single-valued, resolves active+archived), \`limit\` to cap. \`project\` and \`tag\` compose with \`status\`/\`query\`.

Use this to (a) see everything on the plate, (b) find or check if a task already exists BEFORE creating a new one (use \`query\` for dedup — it reaches finished tasks too), (c) pull everything in one project ("puxa as tarefas do projeto X"), (d) pull a user's queue with \`assignee\` — an agent instance lists ITS OWN work with \`assignee: 'me'\`, adding \`available: true\` to skip tasks another agent is already working (claim_task lease, spec 88), (e) pull the owner's APPROVAL QUEUE with \`awaiting_owner: true\` (tasks whose latest [bloqueio] comment has no owner reply). Each task returns id, title, status, priority, due (BRT) + "when", tags, project {id,label}|null, assignees [{id,name,type}], claim ({by,expires_at,expires_brt}|null — the ACTIVE work lease; null = free), comment_count, url, updated_at. A task with \`stale: true\` (open/in-progress with no update for 60+ days) is likely dead weight — suggest the owner cancel it (update_task with status 'canceled') or reprioritize; never close it yourself without asking. Read-only. NOTE: tasks are intentionally OUT of recall()/the graph — this is the only text search over them.`;

interface ListInput { query?: string; status?: string[]; include_closed?: boolean; tag?: string; project?: string; mentions_entity?: string; assignee?: string; available?: boolean; awaiting_owner?: boolean; limit?: number; }

export function registerListTasks(server: any, env: Env, auth?: AuthContext): void {
  // Selo de privacidade (spec 59): sem escopo `private`, task privada some de TODAS as
  // superfícies deste tool (base ativa/fechada e o caminho FTS de ?query).
  const seePrivate = canSeePrivate(auth);
  server.registerTool(
    'list_tasks',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'List tasks',
        resource: 'tasks',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: ListInput) => {
      const now = Date.now();
      const limit = input.limit ?? 200;

      let tasks: TaskRow[];
      if (input.query) {
        // Busca textual sobre TASKS (título+corpo), cobre TODOS os status — dedup
        // precisa enxergar fechadas. Filtros de status/tag aplicam por cima.
        tasks = await ftsSearchTasks(env, input.query, limit, seePrivate);
      } else {
        // base set: ativas (open+in_progress) + fechadas recentes quando pedidas.
        // Fechadas entram se include_closed OU se o status pedido inclui done/canceled
        // (senão status:['done'] sem include_closed retornaria [] em silêncio).
        const wantsClosed =
          input.include_closed === true ||
          (input.status?.some((s) => s === 'done' || s === 'canceled') ?? false);
        tasks = await listActiveTasks(env, seePrivate);
        if (wantsClosed) {
          tasks = tasks.concat(await listRecentClosedTasks(env, limit, seePrivate));
        }
      }

      // filtro de status explícito (sobrepõe o default)
      if (input.status && input.status.length) {
        const set = new Set(input.status);
        tasks = tasks.filter((t) => t.status !== null && set.has(t.status));
      }

      // filtro de projeto (spec 58): resolve id/label entre ativos E arquivados
      // (histórico). Ref sem match → resultado vazio (não silencia como "todas").
      // Compõe com status/tag/query — aplicado antes do slice/tag.
      if (input.project !== undefined && input.project.trim() !== '') {
        const proj = await getProjectByIdOrLabel(env, input.project, false);
        if (!proj) return toolSuccess({ count: 0, tasks: [] });
        tasks = tasks.filter((t) => t.project_id === proj.id);
      }

      // filtro de menção (spec 62): "tasks com essa pessoa". Cruza com o conjunto de
      // note_ids que mencionam a entidade. As tasks já vêm gateadas por privacidade
      // (listActiveTasks/ftsSearchTasks com seePrivate), então filtrar aqui é seguro.
      if (input.mentions_entity !== undefined && input.mentions_entity.trim() !== '') {
        const mentioned = await listNoteIdsMentioning(env, input.mentions_entity.trim());
        if (mentioned.size === 0) return toolSuccess({ count: 0, tasks: [] });
        tasks = tasks.filter((t) => mentioned.has(t.id));
      }

      // filtro de responsável (spec 37): "minhas tasks" / fila de um usuário. 'me' sem
      // perfil vinculado é ERRO orientado (problema de config, não de dados); ref
      // desconhecida devolve vazio (espelha o filtro de projeto). Resolve entre ativos
      // E arquivados — a fila histórica de um agente desligado continua consultável.
      if (input.assignee !== undefined && input.assignee.trim() !== '') {
        const ref = input.assignee.trim();
        let userId: string | null = null;
        if (ref.toLowerCase() === 'me') {
          const me = await resolveMe(env, auth);
          if (!me) {
            return toolError(
              'This credential has no linked user profile, so assignee "me" cannot be resolved. ' +
              'The owner can link this PAT to an agent user at /app/config (Usuários), or pass an explicit user id/name (see list_users).'
            );
          }
          userId = me.id;
        } else {
          const user = await getUserByIdOrName(env, ref, false);
          if (!user) return toolSuccess({ count: 0, tasks: [] });
          userId = user.id;
        }
        const assigned = await taskIdsAssignedTo(env, userId);
        if (assigned.size === 0) return toolSuccess({ count: 0, tasks: [] });
        tasks = tasks.filter((t) => assigned.has(t.id));
      }

      // Filtro available (spec 88): só tasks LIVRES pra trabalhar — sem claim, lease
      // vencido, ou claimada por MIM (renovar e seguir é legítimo). Credencial sem
      // perfil vinculado ainda filtra (só não reconhece claims próprios).
      if (input.available === true) {
        const meId = (await resolveMe(env, auth))?.id ?? null;
        tasks = tasks.filter((t) => !claimActive(t, now) || t.claimed_by === meId);
      }

      // Filtro awaiting_owner (spec 88 §3): a fila de aprovação do dono — interseção
      // com o conjunto "último bloqueio sem resposta do owner" (SQL dedicado; a base
      // já veio gateada por privacidade, então intersectar por id é seguro).
      if (input.awaiting_owner === true) {
        const awaiting = new Set((await listTasksAwaitingOwner(env, seePrivate)).map((t) => t.id));
        if (awaiting.size === 0) return toolSuccess({ count: 0, tasks: [] });
        tasks = tasks.filter((t) => awaiting.has(t.id));
      }

      // Sem filtro de tag: corta ANTES de buscar tags (não busca tags de itens que
      // serão descartados). Com filtro de tag: precisa das tags de todas pra filtrar,
      // então o slice vem depois. Ver spec 15 item 8.
      let tagsById: Map<string, string[]>;
      if (!input.tag) {
        tasks = tasks.slice(0, limit);
        tagsById = await getTagsForNotes(env, tasks.map((t) => t.id));
      } else {
        tagsById = await getTagsForNotes(env, tasks.map((t) => t.id));
        // Tag case-insensitive nos dois lados (a escrita já normaliza pra lowercase).
        const wanted = input.tag.trim().toLowerCase();
        tasks = tasks.filter((t) => (tagsById.get(t.id) ?? []).some((tag) => tag.toLowerCase() === wanted));
        tasks = tasks.slice(0, limit);
      }

      // Colunas do Kanban carregadas UMA vez (aditivo — spec 51): resolve o estágio
      // visual de cada task em memória, sem N queries.
      const columns = await listKanbanColumns(env, true);
      // Projetos carregados UMA vez (spec 58): mapa id→{id,label} pra resolver o
      // projeto de cada task em memória (inclui arquivados). Cap 64 = carga barata.
      const projectsById = new Map<string, TaskProject>(
        (await listTaskProjects(env, true)).map((p) => [p.id, p])
      );
      // Contagem de comentários em lote (spec 53): 1 query (chunked), nunca N+1.
      const commentCounts = await countTaskCommentsBatch(env, tasks.map((t) => t.id));
      // Responsáveis em lote (spec 37): 1 query (chunked), nunca N+1.
      const assigneesById = await listAssigneesForTasks(env, tasks.map((t) => t.id));
      const items = tasks.map((t) => {
        const col = resolveTaskColumn(t, columns);
        const proj = t.project_id ? projectsById.get(t.project_id) ?? null : null;
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          due_at: t.due_at,
          due_brt: t.due_at !== null ? formatBrtDateTime(t.due_at) : null,
          when: t.due_at !== null ? relativeDue(t.due_at, now) : null,
          overdue: t.due_at !== null && t.due_at < now && t.status !== 'done' && t.status !== 'canceled',
          // spec 30-features/32: task ativa sem update há 60+ dias — o agente deve
          // sugerir cancelar/repriorizar (nunca fechar sozinho).
          stale: (t.status === 'open' || t.status === 'in_progress') && now - t.updated_at > 60 * 86_400_000,
          tags: tagsById.get(t.id) ?? [],
          column: col ? { id: col.id, label: col.label } : null,
          project: proj ? { id: proj.id, label: proj.label } : null,
          assignees: (assigneesById.get(t.id) ?? []).map((a) => ({ id: a.id, name: a.name, type: a.type })),
          // Claim ATIVO (spec 88): quem está trabalhando agora e até quando. null =
          // livre (inclui lease vencido). `by` é user_id — nome completo no get_task.
          claim: claimActive(t, now)
            ? { by: t.claimed_by, expires_at: t.claim_expires_at, expires_brt: formatBrtDateTime(t.claim_expires_at!) }
            : null,
          comment_count: commentCounts.get(t.id) ?? 0,
          updated_at: t.updated_at,
          url: noteUrl(env, t.id),
        };
      });

      return toolSuccess({ count: items.length, tasks: items });
    }) as any
  );
}
