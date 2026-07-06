import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl } from '../helpers.js';
import { TASK_STATUSES, type TaskStatus, type TaskPatch, updateTask, getTaskById, getProjectById } from '../../db/queries.js';
import { validateDomains } from '../../db/validation.js';
import { parseDueToMs, formatBrtDateTime } from '../../util/time.js';
import { resolveProjectForWrite } from './project-ref.js';

const inputSchema = {
  id: z.string().min(1).describe('The task id to edit (from save_task / list_tasks_due_today / the /app/tasks board).'),
  title: z.string().min(1).max(200).optional().describe('New title. Also updates the task tldr (which mirrors the title).'),
  details: z.string().optional().describe('New body/details (markdown). REPLACES the existing body — to append context, pass the full new body.'),
  due: z.string().optional().describe(
    'New due date/time in BRT. Accepts ISO ("2026-06-22T14:00"), "2026-06-22 14:00", or date-only "2026-06-22" (end of that day). Pass "none" (or "clear") to REMOVE the due date. Prefer this OVER due_at. Cannot be passed together with due_at.'
  ),
  due_at: z.number().int().optional().describe('New due timestamp as unix epoch MILLISECONDS. Only use if you already have the exact epoch; otherwise pass `due`. Cannot be passed together with due.'),
  priority: z.union([z.number().int().min(1).max(4), z.null()]).optional().describe('New priority 1 (highest) to 4 (lowest). Pass null to REMOVE the priority.'),
  status: z.enum(TASK_STATUSES).optional().describe("New status. done/canceled stamp completed_at=now; reopening (open/in_progress) clears it. To finish a task with an outcome note, prefer complete_task."),
  domains: z.array(z.string().min(1)).min(1).max(3).optional().describe('New canonical English slugs (1-3).'),
  tags: z.array(z.string()).optional().describe('New tags — REPLACES all existing tags. Pass [] to clear. Reserved dedupe: tags are preserved automatically unless you pass a new dedupe: tag explicitly.'),
  project: z.string().max(40).optional().describe(
    "Move the task to a PROJECT (folder). Accepts a project id (proj_...) or label (case-insensitive); a new label AUTO-CREATES the project. Pass an EMPTY string \"\" to remove the task from its project. Archived projects are not assignable. Distinct from tags (multi/transversal)."
  ),
  expected_updated_at: z.number().int().optional().describe(
    'Optimistic concurrency (optional): pass the `updated_at` you last read (from list_tasks / get_task / a prior write). The edit is applied only if the task has NOT changed since; if it changed, the call fails with a conflict error so you can re-read and reapply. Omit for last-write-wins.'
  ),
  allow_new_domain: z.boolean().optional(),
};

const DESCRIPTION = `Edits fields of an existing TASK (kind='task'). Partial patch — only the fields you pass change; the rest stay untouched.

Use this to reopen a task to attach context, reschedule, reprioritize, rename, change status, or retag — the equivalent of update_note, but for tasks (update_note rejects kind='task' on purpose). Errors if the id is not a task.

Behavior:
- At least one editable field besides id must be provided.
- \`details\` REPLACES the body (not append). \`tags\` REPLACES all tags ([] clears them).
- Move to a project with \`project\` (id or label; a new label auto-creates it); remove from its project with \`project: ""\`. Projects are single-valued, distinct from tags.
- Remove a due date with \`due: "none"\` (or "clear"); remove a priority with \`priority: null\`.
- Pass either \`due\` (BRT string) or \`due_at\` (unix ms), never both — passing both errors.
- Changing \`title\` also updates the tldr (a task's tldr mirrors its title).
- status done/canceled stamps completed_at; reopening clears it. For finishing WITH an outcome note, prefer complete_task.
- Tasks are NOT embedded — editing one never touches recall/the graph. Cheap edit.
- Optimistic concurrency (optional): pass \`expected_updated_at\` (the updated_at you last read) to guard against concurrent writes — if the task changed since, the edit fails with a conflict error instead of silently overwriting. Omit for last-write-wins.
- Reserved \`dedupe:\` tags are preserved automatically when you pass \`tags\` (so a dedupe key survives a retag), unless the new array explicitly includes a \`dedupe:\` tag.

Returns the updated task fields (id, title, status, priority, due in BRT, url, updated_at). Use the returned updated_at as the next expected_updated_at.`;

interface UpdateTaskInput {
  id: string;
  title?: string;
  details?: string;
  due?: string;
  due_at?: number;
  priority?: number | null;
  status?: TaskStatus;
  domains?: string[];
  tags?: string[];
  project?: string;
  expected_updated_at?: number;
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
        input.domains !== undefined || input.tags !== undefined ||
        input.project !== undefined;
      if (!hasEdit) {
        return toolError('Nothing to update. Pass at least one of: title, details, due/due_at, priority, status, domains, tags, project.');
      }

      const patch: TaskPatch = {};
      if (input.title !== undefined) patch.title = input.title.trim();
      if (input.details !== undefined) patch.body = input.details.trim();
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.status !== undefined) patch.status = input.status;
      // updateTask aplica a preservação da tag reservada dedupe: (replaceTaskTagsPreservingDedupe) —
      // mesma lógica compartilhada com /app/tasks/update (spec 52).
      if (input.tags !== undefined) patch.tags = input.tags;

      // Projeto (spec 58): resolve id/label (auto-create em label novo); "" desvincula.
      // Resolvido ANTES do updateTask pra um erro de projeto (arquivado/cap) não gravar
      // nada. O now é usado tanto no auto-create do projeto quanto no updateTask.
      const now = Date.now();
      if (input.project !== undefined) {
        const pr = await resolveProjectForWrite(env, input.project, now);
        if (!pr.ok) return toolError(pr.error);
        patch.project_id = pr.projectId;
      }

      if (input.domains !== undefined) {
        const domainError = validateDomains(input.domains, { allowNewDomain: input.allow_new_domain ?? false });
        if (domainError) return toolError(domainError);
        patch.domains = JSON.stringify(input.domains);
      }

      // due + due_at simultâneos: erro em vez de deixar um vencer em silêncio (spec 15 item 6).
      if (typeof input.due_at === 'number' && input.due !== undefined) {
        return toolError('Pass either due (BRT string) or due_at (unix ms), not both.');
      }

      if (typeof input.due_at === 'number') {
        patch.due_at = input.due_at;
      } else if (input.due !== undefined) {
        // Sentinela pra LIMPAR o prazo (spec 15 item 4). 'none'/'clear' → due_at = null.
        const sentinel = input.due.trim().toLowerCase();
        if (sentinel === 'none' || sentinel === 'clear') {
          patch.due_at = null;
        } else {
          const dueMs = parseDueToMs(input.due);
          if (dueMs === null) {
            return toolError(
              `Could not parse due "${input.due}". Use BRT formats like "2026-06-22T14:00", "2026-06-22 14:00", or "2026-06-22" (date only). Pass "none" to remove the due date. Or pass due_at as unix ms.`
            );
          }
          patch.due_at = dueMs;
        }
      }

      const result = await updateTask(env, input.id, patch, now, input.expected_updated_at);
      if (result === 'not-found') {
        return toolError(
          `Task '${input.id}' not found (or it is not a task). Confirm the id via list_tasks_due_today or the /app/tasks board. Do NOT retry with this id.`
        );
      }
      if (result === 'conflict') {
        // Reler pra devolver o updated_at atual + campos, evitando um round-trip.
        const current = await getTaskById(env, input.id);
        const currentUpdated = current?.updated_at ?? null;
        return toolError(
          `Task '${input.id}' changed since you read it (current updated_at: ${currentUpdated}). ` +
          `Your edit was NOT applied. Re-read the task via list_tasks / get_task and reapply your patch with the fresh expected_updated_at.`
        );
      }
      const task = result;
      const proj = task.project_id ? await getProjectById(env, task.project_id) : null;

      return toolSuccess({
        id: task.id,
        url: noteUrl(env, task.id),
        title: task.title,
        status: task.status,
        priority: task.priority,
        due_at: task.due_at,
        due_brt: task.due_at !== null ? formatBrtDateTime(task.due_at) : null,
        project: proj ? { id: proj.id, label: proj.label } : null,
        updated_at: task.updated_at,
      });
    }) as any
  );
}
