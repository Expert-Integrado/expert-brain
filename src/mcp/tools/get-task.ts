import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl, canSeePrivate } from '../helpers.js';
import { getTaskById, getTagsByNote, listKanbanColumns, resolveTaskColumn, listTaskComments, countTaskComments, getProjectById, listAssigneesForTask, resolveActorProfile } from '../../db/queries.js';
import { formatBrtDateTime, relativeDue } from '../../util/time.js';
import { mentionsForOutput } from '../mentions.js';

const inputSchema = {
  id: z.string().min(1).describe('The task id (from save_task / list_tasks / list_tasks_due_today / the /app/tasks board).'),
};

const DESCRIPTION = `Reads a single TASK by id, with its full task state.

get_note returns a NOTE shape (title/body/tldr/domains) WITHOUT status/due/priority — it does NOT serve tasks. Use get_task to read a task's status, due date, priority, completed_at, tags and body in one call.

Returns { id, title, body, status, priority, due_at, due_brt, when, completed_at, completed_brt, domains, tags, project, assignees, created_by, comments, comment_count, created_at, updated_at, url }. \`project\` is { id, label } | null (the folder the task belongs to). \`assignees\` is who is RESPONSIBLE for the task ([{id,name,type}], set via save_task/update_task). \`created_by\` is which credential CREATED it ({actor, user, key_name} | null — automatic audit trail, distinct from assignees). \`comments\` is the discussion thread (chronological, most recent 50) with { author (owner|guest|agent), author_name, body, created_at, created_brt }; add one with comment_task. Errors (without throwing) if the id is not a task or does not exist. Read-only.`;

interface GetTaskInput { id: string; }

export function registerGetTask(server: any, env: Env, auth?: AuthContext): void {
  // Selo de privacidade (spec 59): sem escopo `private`, task privada = mesmo "not found"
  // de inexistente (não vaza que existe).
  const seePrivate = canSeePrivate(auth);
  server.registerTool(
    'get_task',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Get a task', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: GetTaskInput) => {
      const t = await getTaskById(env, input.id, seePrivate);
      if (!t) {
        return toolError(
          `Task '${input.id}' not found (or it is not a task). Confirm the id via list_tasks or the /app/tasks board. Do NOT retry with this id.`
        );
      }
      const tags = await getTagsByNote(env, input.id);
      // Coluna do Kanban (aditivo — spec 51): resolve o estágio visual da task.
      const columns = await listKanbanColumns(env, true);
      const col = resolveTaskColumn(t, columns);
      // Thread de comentários (spec 53): últimos 50 em ordem cronológica. offset =
      // count-50 quando há mais de 50, pra pegar os MAIS RECENTES mas exibi-los na
      // ordem em que foram escritos.
      const commentCount = await countTaskComments(env, input.id);
      const offset = commentCount > 50 ? commentCount - 50 : 0;
      const comments = await listTaskComments(env, input.id, 50, offset);
      // Projeto/pasta (spec 58): resolve {id,label} da task (mesmo arquivado — o
      // get_task não esconde a pasta; o chip é que esmaece na UI).
      const proj = t.project_id ? await getProjectById(env, t.project_id) : null;
      // Menções (spec 62): contatos que esta task cita. Label omitido pra contato privado
      // quando o caller não tem escopo `private`.
      const mentions = await mentionsForOutput(env, input.id, seePrivate);
      // Responsáveis + autoria (spec 37): quem É responsável (decisão de quem criou) vs
      // qual credencial CRIOU (automático). Campos distintos por design.
      const assignees = await listAssigneesForTask(env, input.id);
      const createdBy = t.created_by ? await resolveActorProfile(env, t.created_by) : null;
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
        project: proj ? { id: proj.id, label: proj.label } : null,
        assignees: assignees.map((a) => ({ id: a.id, name: a.name, type: a.type })),
        created_by: createdBy,
        private: t.private === 1,
        origin_note_id: t.origin_note_id ?? null,
        mentions,
        comment_count: commentCount,
        comments: comments.map((c) => ({
          id: c.id,
          author: c.author,
          author_name: c.author_name,
          body: c.body,
          created_at: c.created_at,
          created_brt: formatBrtDateTime(c.created_at),
        })),
        created_at: t.created_at,
        updated_at: t.updated_at,
      });
    }) as any
  );
}
