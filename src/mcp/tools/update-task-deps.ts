import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl, writeActor } from '../helpers.js';
import { getTaskById, type TaskRow } from '../../db/queries.js';
import { resolveTaskVis } from './user-ref.js';
import { addTaskDep, removeTaskDep, listBlockedBy, listBlocks, type BlockedTaskRef } from '../../db/task-deps.js';
import { logTaskActivity } from '../../db/task-activity.js';
import type { TaskActivityInput } from '../../db/task-activity.js';
import type { TaskVisibility } from '../../auth/visibility.js';

// Título truncado no log de atividade — mesmo teto do checklist (spec 38/93).
const DEP_LOG_MAX = 80;

const inputSchema = {
  task_id: z.string().min(1).describe('The task id to edit dependencies for (from save_task / list_tasks / get_task / the /app/tasks board).'),
  block_on: z.array(z.string().min(1)).max(20).optional()
    .describe("Tasks that BLOCK this one — this task cannot be picked up (available:true) until ALL of these are done/canceled. Each ref is a task id or an EXACT title. Rejects self-reference and a DIRECT cycle (the other task already depends on this one)."),
  unblock_from: z.array(z.string().min(1)).max(20).optional()
    .describe('Remove a dependency previously declared via block_on. Same refs as block_on (id or exact title).'),
};

const DESCRIPTION = `Declares or removes dependencies between tasks (spec 80-frota-agentes/93): "this task is BLOCKED BY that other task" — different from the checklist (update_subtask), which decomposes ONE card into ticked items. Use this when you split work into SEPARATE cards (own due date/assignee/project) that must happen in order.

block_on adds "blocked by" links (task ids or exact titles); unblock_from removes them. ALL refs are resolved and validated BEFORE any write: self-reference and a DIRECT cycle (the other task already blocked_by this one) abort the WHOLE call with no partial write — a transitive cycle (A→B→C→A) is not detected (out of scope v1).

While ANY declared blocker is not done/canceled, the task is \`blocked: true\` and disappears from \`list_tasks available:true\` (the fleet queue) — an agent picking work won't grab a task whose precondition isn't finished yet. The last blocker closing does NOT auto-move or auto-complete the blocked task; it just stops being blocked.

Every mutation is logged in the task's activity history. Returns { task_id, blocked_by: [{id,title,status}], blocks: [{id,title,status}], blocked, url }.`;

interface UpdateDepsInput { task_id: string; block_on?: string[]; unblock_from?: string[]; }

function pendingOf(refs: BlockedTaskRef[]): boolean {
  return refs.some((r) => r.status === 'open' || r.status === 'in_progress' || r.status === null);
}

// Resolve uma ref (id OU título exato, entre tasks vivas e visíveis) pra {id,title}.
async function resolveTaskRef(
  env: Env, vis: TaskVisibility, ref: string
): Promise<{ ok: true; task: TaskRow } | { ok: false; error: string }> {
  const byId = await getTaskById(env, ref, vis);
  if (byId) return { ok: true, task: byId };
  const row = await env.DB.prepare(
    `SELECT id FROM notes WHERE kind = 'task' AND deleted_at IS NULL AND title = ? LIMIT 2`
  ).bind(ref).all<{ id: string }>();
  const matches = row.results ?? [];
  if (matches.length === 1) {
    const t = await getTaskById(env, matches[0].id, vis);
    if (t) return { ok: true, task: t };
  }
  if (matches.length > 1) {
    return { ok: false, error: `Ref '${ref}' is AMBIGUOUS — multiple tasks share this exact title. Retry using the id (see list_tasks).` };
  }
  return { ok: false, error: `Task '${ref}' not found (no id or exact-title match among visible tasks). Confirm via list_tasks.` };
}

export function registerUpdateTaskDeps(server: any, env: Env, auth?: AuthContext): void {
  server.registerTool(
    'update_task_deps',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Edit task dependencies (blocked_by)', resource: 'tasks', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safeToolHandler(async (input: UpdateDepsInput) => {
      const blockOn = input.block_on ?? [];
      const unblockFrom = input.unblock_from ?? [];
      if (blockOn.length + unblockFrom.length === 0) {
        return toolError('Nothing to do — pass at least one of: block_on, unblock_from.');
      }

      const visR = await resolveTaskVis(env, auth);
      if (!visR.ok) return toolError(visR.error);
      const vis = visR.vis;
      const task = await getTaskById(env, input.task_id, vis);
      if (!task) {
        return toolError(
          `Task '${input.task_id}' not found (or it is not a task). Confirm the id via list_tasks or the /app/tasks board. Do NOT retry with this id.`
        );
      }

      // ── Resolução TOTAL de todas as refs ANTES de qualquer escrita ──
      const toBlockOn: TaskRow[] = [];
      for (const ref of blockOn) {
        const r = await resolveTaskRef(env, vis, ref);
        if (!r.ok) return toolError(r.error);
        if (r.task.id === input.task_id) {
          return toolError(`A task cannot depend on itself ('${ref}' resolves to ${input.task_id}).`);
        }
        toBlockOn.push(r.task);
      }
      const toUnblockFrom: TaskRow[] = [];
      for (const ref of unblockFrom) {
        const r = await resolveTaskRef(env, vis, ref);
        if (!r.ok) return toolError(r.error);
        toUnblockFrom.push(r.task);
      }

      // ── Escrita (add é a única que pode rejeitar por ciclo/self — checar antes) ──
      const actor = auth ? writeActor(auth) : null;
      const now = Date.now();
      const activity: TaskActivityInput[] = [];

      for (const t of toBlockOn) {
        const res = await addTaskDep(env, input.task_id, t.id, actor, now);
        if (!res.ok) {
          const reason = res.error === 'self' ? 'a task cannot depend on itself' : 'this would create a direct cycle (that task is already blocked by this one)';
          return toolError(`Cannot block on '${t.id}' ("${t.title}"): ${reason}.`);
        }
        activity.push({ field: 'dependency', old_value: 'bloqueada por', new_value: t.title.slice(0, DEP_LOG_MAX) });
      }
      for (const t of toUnblockFrom) {
        await removeTaskDep(env, input.task_id, t.id);
        activity.push({ field: 'dependency', old_value: 'desbloqueada de', new_value: t.title.slice(0, DEP_LOG_MAX) });
      }
      await logTaskActivity(env, input.task_id, actor, activity);

      const blockedBy = await listBlockedBy(env, input.task_id);
      const blocks = await listBlocks(env, input.task_id);
      return toolSuccess({
        task_id: input.task_id,
        blocked_by: blockedBy,
        blocks,
        blocked: pendingOf(blockedBy),
        url: noteUrl(env, input.task_id),
      });
    }) as any
  );
}
