import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl } from '../helpers.js';
import { TASK_STATUSES, type TaskStatus, type TaskPatch, updateTask, replaceTags } from '../../db/queries.js';
import { validateDomains } from '../../db/validation.js';
import { parseDueToMs, formatBrtDateTime } from '../../util/time.js';

const inputSchema = {
  id: z.string().min(1).describe('The task id to edit (from save_task / list_tasks_due_today / the /app/tasks board).'),
  title: z.string().min(1).max(200).optional().describe('New title. Also updates the task tldr (which mirrors the title).'),
  details: z.string().optional().describe('New body/details (markdown). REPLACES the existing body — to append context, pass the full new body.'),
  due: z.string().optional().describe(
    'New due date/time in BRT. Accepts ISO ("2026-06-22T14:00"), "2026-06-22 14:00", or date-only "2026-06-22" (end of that day). Prefer this OVER due_at.'
  ),
  due_at: z.number().int().optional().describe('New due timestamp as unix epoch MILLISECONDS. Only use if you already have the exact epoch; otherwise pass `due`.'),
  priority: z.number().int().min(1).max(4).optional().describe('New priority 1 (highest) to 4 (lowest).'),
  status: z.enum(TASK_STATUSES).optional().describe("New status. done/canceled stamp completed_at=now; reopening (open/in_progress) clears it. To finish a task with an outcome note, prefer complete_task."),
  domains: z.array(z.string().min(1)).min(1).max(3).optional().describe('New canonical English slugs (1-3).'),
  tags: z.array(z.string()).optional().describe('New tags — REPLACES all existing tags. Pass [] to clear.'),
  allow_new_domain: z.boolean().optional(),
};

const DESCRIPTION = `Edits fields of an existing TASK (kind='task'). Partial patch — only the fields you pass change; the rest stay untouched.

Use this to reopen a task to attach context, reschedule, reprioritize, rename, change status, or retag — the equivalent of update_note, but for tasks (update_note rejects kind='task' on purpose). Errors if the id is not a task.

Behavior:
- At least one editable field besides id must be provided.
- \`details\` REPLACES the body (not append). \`tags\` REPLACES all tags ([] clears them).
- Changing \`title\` also updates the tldr (a task's tldr mirrors its title).
- status done/canceled stamps completed_at; reopening clears it. For finishing WITH an outcome note, prefer complete_task.
- Tasks are NOT embedded — editing one never touches recall/the graph. Cheap edit.

Returns the updated task fields (id, title, status, priority, due in BRT, url).`;

interface UpdateTaskInput {
  id: string;
  title?: string;
  details?: string;
  due?: string;
  due_at?: number;
  priority?: number;
  status?: TaskStatus;
  domains?: string[];
  tags?: string[];
  allow_new_domain?: boolean;
}

export function registerUpdateTask(server: any, env: Env): void {
  server.registerTool(
    'update_task',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Edit a task',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: UpdateTaskInput) => {
      const hasEdit =
        input.title !== undefined || input.details !== undefined ||
        input.due !== undefined || input.due_at !== undefined ||
        input.priority !== undefined || input.status !== undefined ||
        input.domains !== undefined || input.tags !== undefined;
      if (!hasEdit) {
        return toolError('Nothing to update. Pass at least one of: title, details, due/due_at, priority, status, domains, tags.');
      }

      const patch: TaskPatch = {};
      if (input.title !== undefined) patch.title = input.title.trim();
      if (input.details !== undefined) patch.body = input.details.trim();
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.status !== undefined) patch.status = input.status;

      if (input.domains !== undefined) {
        const domainError = validateDomains(input.domains, { allowNewDomain: input.allow_new_domain ?? false });
        if (domainError) return toolError(domainError);
        patch.domains = JSON.stringify(input.domains);
      }

      if (typeof input.due_at === 'number') {
        patch.due_at = input.due_at;
      } else if (input.due !== undefined) {
        const dueMs = parseDueToMs(input.due);
        if (dueMs === null) {
          return toolError(
            `Could not parse due "${input.due}". Use BRT formats like "2026-06-22T14:00", "2026-06-22 14:00", or "2026-06-22" (date only). Or pass due_at as unix ms.`
          );
        }
        patch.due_at = dueMs;
      }

      const now = Date.now();
      const task = await updateTask(env, input.id, patch, now);
      if (!task) {
        return toolError(
          `Task '${input.id}' not found (or it is not a task). Confirm the id via list_tasks_due_today or the /app/tasks board. Do NOT retry with this id.`
        );
      }

      if (input.tags !== undefined) await replaceTags(env, input.id, input.tags);

      return toolSuccess({
        id: task.id,
        url: noteUrl(env, task.id),
        title: task.title,
        status: task.status,
        priority: task.priority,
        due_at: task.due_at,
        due_brt: task.due_at !== null ? formatBrtDateTime(task.due_at) : null,
        updated_at: task.updated_at,
      });
    }) as any
  );
}
