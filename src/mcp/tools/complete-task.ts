import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl } from '../helpers.js';
import { completeTask, getTaskById } from '../../db/queries.js';
import { formatBrtDateTime } from '../../util/time.js';

const inputSchema = {
  id: z.string().min(1).describe('The task id to complete.'),
  outcome: z.string().optional().describe('Optional short note on the result — appended to the task body as "**Resultado:** ...".'),
  expected_updated_at: z.number().int().optional().describe(
    'Optimistic concurrency (optional): pass the `updated_at` you last read. Complete only if the task has NOT changed since; if it changed, the call fails with a conflict error. Omit for last-write-wins.'
  ),
};

const DESCRIPTION = `Marks a task as done.

Sets status='done' and completed_at=now. If you pass \`outcome\`, it is appended to the task body (in a single atomic SQL write) so the result is preserved alongside the task. Errors if the id is not a task. Use the id returned by save_task / list_tasks_due_today.

IDEMPOTENT: calling complete_task on a task that is ALREADY done is a safe no-op — it does NOT re-append the outcome or move completed_at; it returns { already_done: true } with the original completed_at. Safe under network retries.

Optional \`expected_updated_at\` guards against concurrent writes (see update_task). Returns updated_at so you can chain it as the next expected_updated_at.`;

interface CompleteInput { id: string; outcome?: string; expected_updated_at?: number; }

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
      const result = await completeTask(env, input.id, now, input.outcome, input.expected_updated_at);

      if (result === 'not-found') {
        return toolError(
          `Task '${input.id}' not found (or it is not a task). Confirm the id via list_tasks_due_today or the /app/tasks board. Do NOT retry with this id.`
        );
      }
      if (result === 'conflict') {
        const current = await getTaskById(env, input.id);
        const currentUpdated = current?.updated_at ?? null;
        return toolError(
          `Task '${input.id}' changed since you read it (current updated_at: ${currentUpdated}). ` +
          `It was NOT completed. Re-read via list_tasks / get_task and retry with the fresh expected_updated_at.`
        );
      }
      if (result === 'already-done') {
        // Idempotência: nada foi escrito; devolvemos o completed_at ORIGINAL.
        const existing = await getTaskById(env, input.id);
        return toolSuccess({
          id: input.id,
          title: existing?.title ?? null,
          status: 'done',
          already_done: true,
          completed_at: existing?.completed_at ?? null,
          completed_brt: existing?.completed_at != null ? formatBrtDateTime(existing.completed_at) : null,
          updated_at: existing?.updated_at ?? null,
          url: noteUrl(env, input.id),
        });
      }

      // Sucesso: usar os valores efetivamente persistidos (não hardcodar `now`).
      const task = result;
      return toolSuccess({
        id: task.id,
        title: task.title,
        status: task.status,
        completed_at: task.completed_at,
        completed_brt: task.completed_at != null ? formatBrtDateTime(task.completed_at) : null,
        updated_at: task.updated_at,
        url: noteUrl(env, task.id),
      });
    }) as any
  );
}
