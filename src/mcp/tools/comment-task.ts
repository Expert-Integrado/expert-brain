import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl } from '../helpers.js';
import { getTaskById, addTaskComment, countTaskComments } from '../../db/queries.js';
import { newId } from '../../util/id.js';
import { formatBrtDateTime } from '../../util/time.js';

const MAX_NAME = 60;

const inputSchema = {
  task_id: z.string().min(1).describe('The task id to comment on (from save_task / list_tasks / get_task / the /app/tasks board).'),
  body: z.string().min(1).max(4000).describe('The comment text (plain text, 1-4000 chars). Stored and shown as INERT text everywhere — no markdown render, no HTML. Use it to log progress or context WITHOUT overwriting the task body.'),
  author_name: z.string().max(MAX_NAME).optional().describe('Optional short label for which agent/who is commenting (≤60 chars). Shown in the thread as "agente · <name>". Defaults to just "agente" when omitted.'),
};

const DESCRIPTION = `Adds a COMMENT to a task's discussion thread, as the agent.

Unlike complete_task's outcome (which appends to the task BODY), a comment is a separate timeline entry — it does not modify the task body, status or due date. Use it to record progress, findings or context on a task so the discussion survives instead of being lost in chat.

The comment is authored as 'agent' (author_name defaults to "agente"; pass author_name to identify which agent/process). Comments show up for the owner in the console, in get_task (the thread), and are counted in list_tasks. Errors (without throwing) if the id is not a task or does not exist.

Returns { id, task_id, author, author_name, body, created_at, created_brt, comment_count, url }.`;

interface CommentTaskInput { task_id: string; body: string; author_name?: string; }

export function registerCommentTask(server: any, env: Env): void {
  server.registerTool(
    'comment_task',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Comment on a task', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: CommentTaskInput) => {
      // Valida que o id é uma task viva (getTaskById filtra kind='task' + deleted_at
      // IS NULL) ANTES de gravar — mesmo padrão de share_task/complete_task.
      const task = await getTaskById(env, input.task_id);
      if (!task) {
        return toolError(
          `Task '${input.task_id}' not found (or it is not a task). Confirm the id via list_tasks or the /app/tasks board. Do NOT retry with this id.`
        );
      }
      const body = input.body.trim();
      if (!body) {
        return toolError('Comment body is empty after trimming. Provide 1-4000 chars of text.');
      }
      const name = input.author_name?.trim().slice(0, MAX_NAME) || null;
      const now = Date.now();
      const id = `cmt_${newId()}`;
      await addTaskComment(env, {
        id, task_id: input.task_id, author: 'agent', author_name: name, body, created_at: now,
      });
      const commentCount = await countTaskComments(env, input.task_id);
      return toolSuccess({
        id,
        task_id: input.task_id,
        author: 'agent',
        author_name: name ?? 'agente',
        body,
        created_at: now,
        created_brt: formatBrtDateTime(now),
        comment_count: commentCount,
        url: noteUrl(env, input.task_id),
      });
    }) as any
  );
}
