import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl } from '../helpers.js';
import { getTaskById, addTaskComment, countTaskComments } from '../../db/queries.js';
import { resolveMe } from './user-ref.js';
import { produceCommentMailbox } from '../../db/mailbox.js';
import { sendPushToAll } from '../../web/push.js';
import { newId } from '../../util/id.js';
import { formatBrtDateTime } from '../../util/time.js';

const MAX_NAME = 60;

// Tipos de comentário (spec 88): o protocolo que a frota já escreve como prefixo
// [kind] no corpo, agora entendido pelo servidor. Parâmetro explícito vence o
// prefixo; ambos ausentes = comentário comum (kind NULL).
export const COMMENT_KINDS = ['pedido', 'entrega', 'bloqueio', 'info'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];
const KIND_PREFIX_RE = /^\[(pedido|entrega|bloqueio|info)\]/i;

const inputSchema = {
  task_id: z.string().min(1).describe('The task id to comment on (from save_task / list_tasks / get_task / the /app/tasks board).'),
  body: z.string().min(1).max(4000).describe('The comment text (plain text, 1-4000 chars). Stored and shown as INERT text everywhere — no markdown render, no HTML. Use it to log progress or context WITHOUT overwriting the task body.'),
  kind: z.enum(COMMENT_KINDS).optional().describe("Optional comment TYPE for agent-to-agent protocol: 'pedido' (request to another agent), 'entrega' (delivery/result), 'bloqueio' (BLOCKED waiting on the OWNER's decision — triggers a push notification to the owner and puts the task in the awaiting-owner queue until the owner replies), 'info' (context note). If omitted, a leading [pedido]/[entrega]/[bloqueio]/[info] prefix in the body sets it automatically."),
  author_name: z.string().max(MAX_NAME).optional().describe('Optional COMPLEMENTARY display label (≤60 chars) for the session/skill/process writing the comment. It is NOT the author identity — authorship is derived from the credential on the server and shown as the linked user. Omit unless the extra context helps.'),
};

const DESCRIPTION = `Adds a COMMENT to a task's discussion thread, signed by the credential's linked user.

Unlike complete_task's outcome (which appends to the task BODY), a comment is a separate timeline entry — it does not modify the task body, status or due date. Use it to record progress, findings or context on a task so the discussion survives instead of being lost in chat.

AUTHORSHIP IS DERIVED FROM THE CREDENTIAL (spec 81): the server resolves the calling PAT (or the owner's OAuth session) to its linked user profile and signs the comment as that user — it can NOT be overridden. A PAT with no linked user profile is REJECTED (the owner links credentials to users at /app/config). \`author_name\` is only an optional complementary label (e.g. session/skill name), never the identity.

TYPED COMMENTS (spec 88): pass \`kind\` (or start the body with [pedido]/[entrega]/[bloqueio]/[info]) to mark the comment's role in the agent protocol. 'bloqueio' means the task is WAITING ON THE OWNER: it pushes a notification to the owner's devices and keeps the task in the awaiting-owner queue (list_tasks awaiting_owner:true) until the owner replies in the thread.

Comments show up for the owner in the console, in get_task (the thread), and are counted in list_tasks. Errors (without throwing) if the id is not a task or does not exist.

Returns { id, task_id, author, author_user {id,name,type}, author_name, kind, body, created_at, created_brt, comment_count, url }.`;

interface CommentTaskInput { task_id: string; body: string; kind?: CommentKind; author_name?: string; }

export function registerCommentTask(server: any, env: Env, auth?: AuthContext): void {
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
      // Assinatura por credencial (spec 81): fail-closed. Sem usuário resolvido não
      // entra comentário de agente — autoria autodeclarada era falsificável.
      const me = await resolveMe(env, auth);
      if (!me) {
        return toolError(
          'This credential has no linked user profile, so the comment cannot be signed. ' +
          'Comments are signed by the credential-linked user (never self-declared). ' +
          'The owner links this PAT to an agent user at /app/config (Usuários). Do NOT retry until linked.'
        );
      }
      const name = input.author_name?.trim().slice(0, MAX_NAME) || null;
      // Tipo (spec 88): explícito vence; senão o prefixo [kind] que a frota já usa.
      // O corpo grava como veio (prefixo incluso — legibilidade humana preservada).
      const kind: CommentKind | null =
        input.kind ?? ((KIND_PREFIX_RE.exec(body)?.[1]?.toLowerCase() as CommentKind | undefined) ?? null);
      const now = Date.now();
      const id = `cmt_${newId()}`;
      await addTaskComment(env, {
        id, task_id: input.task_id, author: 'agent', author_name: name, body, created_at: now,
        author_user_id: me.id,
        // Forense por chave (spec 86): registra POR QUAL credencial o comentário
        // entrou. NULL em sessão OAuth do dono (sem keyId).
        author_key_id: auth?.keyId ?? null,
        kind,
      });
      // Mailbox (spec 82): @menções + comment_on_assigned pros assignees. Best-effort
      // POR CONSTRUÇÃO — o comentário acima já está commitado; falha aqui só loga.
      await produceCommentMailbox(env, {
        taskId: input.task_id, commentId: id, body, actorUserId: me.id,
      });
      // Bloqueio = agente parado esperando decisão do DONO (spec 88 §3): empurra push
      // pros dispositivos dele NA HORA (o SW monta o texto via /app/push/pending).
      // Best-effort como o mailbox — o comentário já está commitado; falha só loga.
      if (kind === 'bloqueio') {
        try {
          await sendPushToAll(env, now);
        } catch (err) {
          console.warn('comment_task: push de bloqueio falhou', err);
        }
      }
      const commentCount = await countTaskComments(env, input.task_id);
      return toolSuccess({
        id,
        task_id: input.task_id,
        author: 'agent',
        author_user: { id: me.id, name: me.name, type: me.type },
        author_name: name,
        kind,
        body,
        created_at: now,
        created_brt: formatBrtDateTime(now),
        comment_count: commentCount,
        url: noteUrl(env, input.task_id),
      });
    }) as any
  );
}
