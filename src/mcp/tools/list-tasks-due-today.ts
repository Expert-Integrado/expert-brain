import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolSuccess, noteUrl, canSeePrivate } from '../helpers.js';
import { listTasksDueBefore, listAssigneesForTasks } from '../../db/queries.js';
import { formatBrtDateTime, relativeDue } from '../../util/time.js';

const inputSchema = {
  horizon_hours: z.number().int().min(1).max(168).optional().describe('How far ahead to look, in hours. Default 24 (today + overdue).'),
};

const DESCRIPTION = `Lists OPEN/IN-PROGRESS tasks that are due soon or already overdue.

By default returns tasks whose due date is within the next 24h OR already past — i.e. "what's on my plate today". Pass horizon_hours to widen (e.g. 168 = this week). Overdue tasks are always included. Results are ordered by due date, then priority (1 = highest).

Each task includes: id, title, due (BRT), a human "when" string (e.g. "vence em 2h" / "vencida há 1d"), priority, status, assignees ([{id,name,type}] — who is responsible), and whether it is overdue. Read-only.`;

interface ListInput { horizon_hours?: number; }

export function registerListTasksDueToday(server: any, env: Env, auth?: AuthContext): void {
  // Selo de privacidade (spec 59): sem escopo `private`, task privada não entra no digest.
  const seePrivate = canSeePrivate(auth);
  server.registerTool(
    'list_tasks_due_today',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'List tasks due today',
        resource: 'tasks',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: ListInput) => {
      const now = Date.now();
      const horizon = (input.horizon_hours ?? 24) * 60 * 60 * 1000;
      const tasks = await listTasksDueBefore(env, now + horizon, seePrivate);
      // Responsáveis em lote (spec 37): 1 query (chunked), nunca N+1.
      const assigneesById = await listAssigneesForTasks(env, tasks.map((t) => t.id));

      const items = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        due_at: t.due_at,
        due_brt: t.due_at !== null ? formatBrtDateTime(t.due_at) : null,
        when: t.due_at !== null ? relativeDue(t.due_at, now) : null,
        overdue: t.due_at !== null && t.due_at < now,
        assignees: (assigneesById.get(t.id) ?? []).map((a) => ({ id: a.id, name: a.name, type: a.type })),
        url: noteUrl(env, t.id),
      }));

      return toolSuccess({
        count: items.length,
        overdue_count: items.filter((i) => i.overdue).length,
        horizon_hours: input.horizon_hours ?? 24,
        tasks: items,
      });
    }) as any
  );
}
