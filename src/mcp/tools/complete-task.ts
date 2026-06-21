import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl } from '../helpers.js';
import { completeTask } from '../../db/queries.js';
import { formatBrtDateTime } from '../../util/time.js';

const inputSchema = {
  id: z.string().min(1).describe('The task id to complete.'),
  outcome: z.string().optional().describe('Optional short note on the result — appended to the task body as "**Resultado:** ...".'),
};

const DESCRIPTION = `Marks a task as done.

Sets status='done' and completed_at=now. If you pass \`outcome\`, it is appended to the task body so the result is preserved alongside the task. Errors if the id is not a task. Use the id returned by save_task / list_tasks_due_today.`;

interface CompleteInput { id: string; outcome?: string; }

export function registerCompleteTask(server: any, env: Env): void {
  server.registerTool(
    'complete_task',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Complete a task',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: CompleteInput) => {
      const now = Date.now();
      const task = await completeTask(env, input.id, now, input.outcome);
      if (!task) {
        return toolError(
          `Task '${input.id}' not found (or it is not a task). Confirm the id via list_tasks_due_today or the /app/tasks board. Do NOT retry with this id.`
        );
      }
      return toolSuccess({
        id: task.id,
        title: task.title,
        status: 'done',
        completed_at: now,
        completed_brt: formatBrtDateTime(now),
        url: noteUrl(env, task.id),
      });
    }) as any
  );
}
