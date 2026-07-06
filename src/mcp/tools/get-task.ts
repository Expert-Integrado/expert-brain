import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl } from '../helpers.js';
import { getTaskById, getTagsByNote, listKanbanColumns, resolveTaskColumn } from '../../db/queries.js';
import { formatBrtDateTime, relativeDue } from '../../util/time.js';

const inputSchema = {
  id: z.string().min(1).describe('The task id (from save_task / list_tasks / list_tasks_due_today / the /app/tasks board).'),
};

const DESCRIPTION = `Reads a single TASK by id, with its full task state.

get_note returns a NOTE shape (title/body/tldr/domains) WITHOUT status/due/priority — it does NOT serve tasks. Use get_task to read a task's status, due date, priority, completed_at, tags and body in one call.

Returns { id, title, body, status, priority, due_at, due_brt, when, completed_at, completed_brt, domains, tags, created_at, updated_at, url }. Errors (without throwing) if the id is not a task or does not exist. Read-only.`;

interface GetTaskInput { id: string; }

export function registerGetTask(server: any, env: Env): void {
  server.registerTool(
    'get_task',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Get a task', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: GetTaskInput) => {
      const t = await getTaskById(env, input.id);
      if (!t) {
        return toolError(
          `Task '${input.id}' not found (or it is not a task). Confirm the id via list_tasks or the /app/tasks board. Do NOT retry with this id.`
        );
      }
      const tags = await getTagsByNote(env, input.id);
      // Coluna do Kanban (aditivo — spec 51): resolve o estágio visual da task.
      const columns = await listKanbanColumns(env, true);
      const col = resolveTaskColumn(t, columns);
      const now = Date.now();
      return toolSuccess({
        id: t.id,
        url: noteUrl(env, t.id),
        title: t.title,
        body: t.body,
        status: t.status,
        priority: t.priority,
        due_at: t.due_at,
        due_brt: t.due_at !== null ? formatBrtDateTime(t.due_at) : null,
        when: t.due_at !== null ? relativeDue(t.due_at, now) : null,
        completed_at: t.completed_at,
        completed_brt: t.completed_at !== null ? formatBrtDateTime(t.completed_at) : null,
        domains: JSON.parse(t.domains),
        tags,
        column: col ? { id: col.id, label: col.label } : null,
        created_at: t.created_at,
        updated_at: t.updated_at,
      });
    }) as any
  );
}
