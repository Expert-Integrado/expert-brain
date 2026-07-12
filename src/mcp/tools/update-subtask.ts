import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl, writeActor } from '../helpers.js';
import { getTaskById } from '../../db/queries.js';
import { resolveTaskVis } from './user-ref.js';
import {
  addTaskSubtasks,
  listTaskSubtasks,
  setSubtaskDone,
  retitleSubtask,
  deleteSubtask,
  subtaskProgress,
  MAX_SUBTASKS_PER_TASK,
  type TaskSubtask,
} from '../../db/subtasks.js';
import { logTaskActivity } from '../../db/task-activity.js';
import type { TaskActivityInput } from '../../db/task-activity.js';

// Título truncado no log de atividade — mesmo teto dos handlers web (spec 38).
const SUBTASK_LOG_MAX = 80;

const inputSchema = {
  task_id: z.string().min(1).describe('The task id whose checklist to edit (from save_task / list_tasks / get_task / the /app/tasks board).'),
  add: z.array(z.string().min(1).max(200)).max(50).optional()
    .describe('New checklist items to APPEND, in order (1-200 chars each). The checklist caps at 100 items per task.'),
  check: z.array(z.string().min(1)).max(50).optional()
    .describe("Items to mark DONE — each ref is a subtask id ('sub_...') or an EXACT title. An ambiguous title (2+ items share it) errors listing the ids; retry with the id. Checking an already-done item is a no-op (the original completion stays)."),
  uncheck: z.array(z.string().min(1)).max(50).optional()
    .describe('Items to REOPEN — same refs as check (id or exact title).'),
  remove: z.array(z.string().min(1)).max(50).optional()
    .describe("Items to DELETE — by subtask id ONLY ('sub_...'); titles are not accepted here because deletion is destructive."),
  retitle: z.array(z.object({
    id: z.string().min(1).describe("The subtask id ('sub_...')."),
    title: z.string().min(1).max(200).describe('The new title (1-200 chars).'),
  })).max(50).optional()
    .describe('Items to RENAME: { id, title }.'),
};

const DESCRIPTION = `Edits the CHECKLIST (subtasks) of a task: add, check/uncheck, rename and remove items — one call covers the whole cycle.

MULTI-PART WORK = ONE CARD: when a task has several deliverables (specs, steps, files), keep ONE task and break it into subtasks — NEVER create N sibling tasks on the board. The card then shows "3/8" progress at a glance. Create the checklist at birth via save_task's \`subtasks\` param; use this tool to tick items as you finish each part, and to adjust the list as scope evolves.

ALL refs are resolved BEFORE anything is written: one invalid/ambiguous ref aborts the whole call with no partial writes — fix the ref and retry. check/uncheck accept a subtask id ('sub_...') or an EXACT title; remove and retitle require the id (get them from get_task or from this tool's output).

Checklist edits never touch the task's updated_at (they won't conflict with a concurrent update_task using expected_updated_at), and completing a task does NOT auto-check its checklist. Every mutation is logged in the task's activity history.

Returns { task_id, subtasks: [{id, title, done, position, done_by, done_at}], subtask_progress: {done, total}, url }.`;

interface RetitleRef { id: string; title: string }
interface UpdateSubtaskInput {
  task_id: string;
  add?: string[];
  check?: string[];
  uncheck?: string[];
  remove?: string[];
  retitle?: RetitleRef[];
}

// Resolve uma ref (id 'sub_...' OU título exato) contra o checklist atual.
// Devolve a row, ou uma mensagem de erro pronta (não encontrada / ambígua).
function resolveRef(subs: TaskSubtask[], ref: string): { ok: true; sub: TaskSubtask } | { ok: false; error: string } {
  const byId = subs.find((s) => s.id === ref);
  if (byId) return { ok: true, sub: byId };
  const byTitle = subs.filter((s) => s.title === ref);
  if (byTitle.length === 1) return { ok: true, sub: byTitle[0] };
  if (byTitle.length > 1) {
    const ids = byTitle.map((s) => `${s.id} ("${s.title}")`).join(', ');
    return { ok: false, error: `Ref '${ref}' is AMBIGUOUS — ${byTitle.length} items share this title: ${ids}. Retry using the id.` };
  }
  const available = subs.length
    ? `Current items: ${subs.map((s) => `${s.id} ("${s.title}")`).join(', ')}.`
    : 'This task has no subtasks yet — add some with the `add` param.';
  return { ok: false, error: `Subtask '${ref}' not found on this task (no id or exact-title match). ${available}` };
}

// Vista enxuta de um item no output da tool (done como boolean derivado).
function subView(s: TaskSubtask) {
  return { id: s.id, title: s.title, done: s.done_at !== null, position: s.position, done_by: s.done_by, done_at: s.done_at };
}

export function registerUpdateSubtask(server: any, env: Env, auth?: AuthContext): void {
  server.registerTool(
    'update_subtask',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Edit a task checklist', resource: 'tasks', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    safeToolHandler(async (input: UpdateSubtaskInput) => {
      const add = input.add ?? [];
      const check = input.check ?? [];
      const uncheck = input.uncheck ?? [];
      const remove = input.remove ?? [];
      const retitle = input.retitle ?? [];
      if (add.length + check.length + uncheck.length + remove.length + retitle.length === 0) {
        return toolError('Nothing to do — pass at least one of: add, check, uncheck, remove, retitle.');
      }

      // Visibilidade row-level (spec 91): task invisível pra credencial = 'not found'
      // idêntico a inexistente (mesmo contrato de update_task/comment_task).
      const visR = await resolveTaskVis(env, auth);
      if (!visR.ok) return toolError(visR.error);
      const task = await getTaskById(env, input.task_id, visR.vis);
      if (!task) {
        return toolError(
          `Task '${input.task_id}' not found (or it is not a task). Confirm the id via list_tasks or the /app/tasks board. Do NOT retry with this id.`
        );
      }

      // ── Resolução TOTAL antes de qualquer escrita (aborta sem escrita parcial) ──
      const current = await listTaskSubtasks(env, input.task_id);
      if (current.length + add.length > MAX_SUBTASKS_PER_TASK) {
        return toolError(
          `Checklist limit: this task has ${current.length} subtasks and adding ${add.length} would exceed the cap of ${MAX_SUBTASKS_PER_TASK}. Remove items first or split the work differently.`
        );
      }

      const addTitles = add.map((t) => t.trim());
      const emptyAdd = addTitles.findIndex((t) => t.length === 0);
      if (emptyAdd !== -1) return toolError(`add[${emptyAdd}] is empty after trimming. Each item needs 1-200 chars.`);

      const toCheck: TaskSubtask[] = [];
      for (const ref of check) {
        const r = resolveRef(current, ref);
        if (!r.ok) return toolError(r.error);
        toCheck.push(r.sub);
      }
      const toUncheck: TaskSubtask[] = [];
      for (const ref of uncheck) {
        const r = resolveRef(current, ref);
        if (!r.ok) return toolError(r.error);
        toUncheck.push(r.sub);
      }
      const overlap = toCheck.find((s) => toUncheck.some((u) => u.id === s.id));
      if (overlap) {
        return toolError(`Subtask '${overlap.id}' ("${overlap.title}") appears in BOTH check and uncheck — remove it from one of them.`);
      }

      const byId = new Map(current.map((s) => [s.id, s]));
      const toRemove: TaskSubtask[] = [];
      for (const ref of remove) {
        const sub = byId.get(ref);
        if (!sub) {
          return toolError(
            `remove ref '${ref}' is not a subtask id of this task. remove requires the id ('sub_...') — get it from get_task. ` +
            (current.length ? `Current items: ${current.map((s) => `${s.id} ("${s.title}")`).join(', ')}.` : 'This task has no subtasks.')
          );
        }
        toRemove.push(sub);
      }
      const toRetitle: Array<{ sub: TaskSubtask; title: string }> = [];
      for (const r of retitle) {
        const sub = byId.get(r.id);
        if (!sub) return toolError(`retitle ref '${r.id}' is not a subtask id of this task. Get ids from get_task.`);
        const title = r.title.trim();
        if (!title) return toolError(`retitle for '${r.id}' is empty after trimming. Titles need 1-200 chars.`);
        toRetitle.push({ sub, title });
      }

      // ── Escritas (refs todas válidas) + log de atividade ──
      const actor = auth ? writeActor(auth) : null;
      const now = Date.now();
      const activity: TaskActivityInput[] = [];

      if (addTitles.length > 0) {
        const created = await addTaskSubtasks(env, input.task_id, addTitles, actor, now);
        if (created === 'cap-exceeded') {
          // Corrida entre a checagem acima e a escrita — mesma mensagem do cap.
          return toolError(`Checklist limit of ${MAX_SUBTASKS_PER_TASK} reached while adding. Re-read with get_task and retry.`);
        }
        for (const s of created) activity.push({ field: 'subtask', old_value: 'adicionada', new_value: s.title.slice(0, SUBTASK_LOG_MAX) });
      }
      for (const s of toCheck) {
        await setSubtaskDone(env, input.task_id, s.id, true, actor, now);
        activity.push({ field: 'subtask', old_value: 'concluída', new_value: s.title.slice(0, SUBTASK_LOG_MAX) });
      }
      for (const s of toUncheck) {
        await setSubtaskDone(env, input.task_id, s.id, false, actor, now);
        activity.push({ field: 'subtask', old_value: 'reaberta', new_value: s.title.slice(0, SUBTASK_LOG_MAX) });
      }
      for (const { sub, title } of toRetitle) {
        await retitleSubtask(env, input.task_id, sub.id, title);
        activity.push({ field: 'subtask', old_value: 'renomeada', new_value: title.slice(0, SUBTASK_LOG_MAX) });
      }
      for (const s of toRemove) {
        await deleteSubtask(env, input.task_id, s.id);
        activity.push({ field: 'subtask', old_value: 'removida', new_value: s.title.slice(0, SUBTASK_LOG_MAX) });
      }
      await logTaskActivity(env, input.task_id, actor, activity);

      const after = await listTaskSubtasks(env, input.task_id);
      return toolSuccess({
        task_id: input.task_id,
        subtasks: after.map(subView),
        subtask_progress: subtaskProgress(after),
        url: noteUrl(env, input.task_id),
      });
    }) as any
  );
}
