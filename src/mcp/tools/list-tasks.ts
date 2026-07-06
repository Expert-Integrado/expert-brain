import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolSuccess, noteUrl } from '../helpers.js';
import { TASK_STATUSES, listActiveTasks, listRecentClosedTasks, ftsSearchTasks, getTagsForNotes, listKanbanColumns, resolveTaskColumn, type TaskRow } from '../../db/queries.js';
import { formatBrtDateTime, relativeDue } from '../../util/time.js';

const inputSchema = {
  query: z.string().optional().describe('Optional full-text search over task title + body (prefix match). Runs ONLY over tasks and includes ALL statuses by default (searching also covers done/canceled, so dedup can see finished tasks). status/tag filters still apply on top.'),
  status: z.array(z.enum(TASK_STATUSES)).optional().describe("Filter by status (e.g. ['open'] or ['open','in_progress']). Default: open + in_progress. Passing ['done'] (or ['canceled']) returns closed tasks automatically — no need for include_closed — limited to the most recent N (by `limit`), not the full history."),
  include_closed: z.boolean().optional().describe('Also include done/canceled tasks (most recent first). Redundant when status already lists done/canceled or when query is set. Default false.'),
  tag: z.string().optional().describe('Only tasks carrying this tag (case-insensitive, e.g. a contact name, a project, or maquina:pc-principal).'),
  limit: z.number().int().min(1).max(500).optional().describe('Max tasks to return (default 200).'),
};

const DESCRIPTION = `Lists tasks regardless of due date — including tasks WITHOUT a due date (which list_tasks_due_today never shows).

This is the complete task view: by default returns all OPEN + IN-PROGRESS tasks (ordered by due date then priority). Pass \`query\` for full-text search over tasks (title+body, all statuses), \`status\` to filter (asking for ['done']/['canceled'] auto-includes closed tasks — no include_closed needed, capped to the most recent by \`limit\`), \`tag\` to scope (case-insensitive, e.g. maquina:pc-principal), \`limit\` to cap.

Use this to (a) see everything on the plate, (b) find or check if a task already exists BEFORE creating a new one (use \`query\` for dedup — it reaches finished tasks too), (c) filter by machine/project tag. Each task returns id, title, status, priority, due (BRT) + "when", tags, url, updated_at. Read-only. NOTE: tasks are intentionally OUT of recall()/the graph — this is the only text search over them.`;

interface ListInput { query?: string; status?: string[]; include_closed?: boolean; tag?: string; limit?: number; }

export function registerListTasks(server: any, env: Env): void {
  server.registerTool(
    'list_tasks',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'List tasks',
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
        tasks = await ftsSearchTasks(env, input.query, limit);
      } else {
        // base set: ativas (open+in_progress) + fechadas recentes quando pedidas.
        // Fechadas entram se include_closed OU se o status pedido inclui done/canceled
        // (senão status:['done'] sem include_closed retornaria [] em silêncio).
        const wantsClosed =
          input.include_closed === true ||
          (input.status?.some((s) => s === 'done' || s === 'canceled') ?? false);
        tasks = await listActiveTasks(env);
        if (wantsClosed) {
          tasks = tasks.concat(await listRecentClosedTasks(env, limit));
        }
      }

      // filtro de status explícito (sobrepõe o default)
      if (input.status && input.status.length) {
        const set = new Set(input.status);
        tasks = tasks.filter((t) => t.status !== null && set.has(t.status));
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
      const items = tasks.map((t) => {
        const col = resolveTaskColumn(t, columns);
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          due_at: t.due_at,
          due_brt: t.due_at !== null ? formatBrtDateTime(t.due_at) : null,
          when: t.due_at !== null ? relativeDue(t.due_at, now) : null,
          overdue: t.due_at !== null && t.due_at < now && t.status !== 'done' && t.status !== 'canceled',
          tags: tagsById.get(t.id) ?? [],
          column: col ? { id: col.id, label: col.label } : null,
          updated_at: t.updated_at,
          url: noteUrl(env, t.id),
        };
      });

      return toolSuccess({ count: items.length, tasks: items });
    }) as any
  );
}
