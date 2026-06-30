import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolSuccess, noteUrl } from '../helpers.js';
import { TASK_STATUSES, listActiveTasks, listRecentClosedTasks, getTagsForNotes, type TaskRow } from '../../db/queries.js';
import { formatBrtDateTime, relativeDue } from '../../util/time.js';

const inputSchema = {
  status: z.array(z.enum(TASK_STATUSES)).optional().describe("Filter by status (e.g. ['open'] or ['open','in_progress']). Default: open + in_progress."),
  include_closed: z.boolean().optional().describe('Also include done/canceled tasks (most recent first). Default false.'),
  tag: z.string().optional().describe('Only tasks carrying this tag (e.g. a contact name, a project, or maquina:pc-principal).'),
  limit: z.number().int().min(1).max(500).optional().describe('Max tasks to return (default 200).'),
};

const DESCRIPTION = `Lists tasks regardless of due date — including tasks WITHOUT a due date (which list_tasks_due_today never shows).

This is the complete task view: by default returns all OPEN + IN-PROGRESS tasks (ordered by due date then priority). Pass include_closed for done/canceled too, status to filter, tag to scope (e.g. maquina:pc-principal), limit to cap.

Use this to (a) see everything on the plate, (b) check if a task already exists BEFORE creating a new one (dedup), (c) filter by machine/project tag. Each task returns id, title, status, priority, due (BRT) + "when", tags, url. Read-only.`;

interface ListInput { status?: string[]; include_closed?: boolean; tag?: string; limit?: number; }

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

      // base set: ativas (open+in_progress) + opcionalmente fechadas recentes
      let tasks: TaskRow[] = await listActiveTasks(env);
      if (input.include_closed) {
        tasks = tasks.concat(await listRecentClosedTasks(env, limit));
      }
      // filtro de status explícito (sobrepõe o default)
      if (input.status && input.status.length) {
        const set = new Set(input.status);
        tasks = tasks.filter((t) => t.status !== null && set.has(t.status));
      }

      // tags em batch (1 query) — pro retorno e pro filtro por tag
      const tagsById = await getTagsForNotes(env, tasks.map((t) => t.id));
      if (input.tag) {
        tasks = tasks.filter((t) => (tagsById.get(t.id) ?? []).includes(input.tag as string));
      }

      tasks = tasks.slice(0, limit);

      const items = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        due_at: t.due_at,
        due_brt: t.due_at !== null ? formatBrtDateTime(t.due_at) : null,
        when: t.due_at !== null ? relativeDue(t.due_at, now) : null,
        overdue: t.due_at !== null && t.due_at < now && t.status !== 'done' && t.status !== 'canceled',
        tags: tagsById.get(t.id) ?? [],
        url: noteUrl(env, t.id),
      }));

      return toolSuccess({ count: items.length, tasks: items });
    }) as any
  );
}
