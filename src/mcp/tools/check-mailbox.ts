import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl } from '../helpers.js';
import { listMailboxItems, countMailboxUnread } from '../../db/mailbox.js';
import { resolveMe, resolveTaskVis } from './user-ref.js';
import { formatBrtDateTime } from '../../util/time.js';

const inputSchema = {
  all: z.boolean().optional().describe('true also returns items already acked (read) — history view. Default: only unread.'),
  since: z.number().optional().describe('Only items created AFTER this unix-ms timestamp. Useful for incremental polling.'),
  limit: z.number().int().min(1).max(200).optional().describe('Max items returned (default 50, max 200). Oldest first — a work queue, not a feed.'),
};

const DESCRIPTION = `Checks YOUR mailbox — unread items addressed to the user profile linked to this credential.

Items are produced when someone @mentions your profile name in a task comment ('mention'), assigns a task to you ('assignment'), or comments on a task you are assigned to ('comment_on_assigned'). Each item carries the task (id/title/url) and, when it came from a comment, the comment body and its signed author — no extra get_task round-trip needed to read the message.

READING NEVER MARKS AS READ (idempotent — safe for heartbeat polling). After you ACT on an item, call ack_mailbox to clear it. Items are returned OLDEST FIRST (work queue). \`unread_count\` is the total unread for you regardless of limit. Items whose task is outside this credential's visibility (private task without the scope, or no longer assigned/mentioned under a tasks:assigned credential) are omitted and not counted.

Identity comes from the credential (resolveMe): a PAT with no linked user profile is rejected — the owner links credentials to users at /app/config. This mailbox is per-agent messaging; it is NOT the owner's capture inbox (list_inbox), which is a different feature.

Returns { items: [{ id, kind, task {id,title,url}, comment {id,body,author_user,author_name}|null, actor {id,name,type}|null, created_at, created_brt, read_at }], unread_count }.`;

interface CheckMailboxInput { all?: boolean; since?: number; limit?: number }

export function registerCheckMailbox(server: any, env: Env, auth?: AuthContext): void {
  server.registerTool(
    'check_mailbox',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Check my mailbox', resource: 'mailbox', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: CheckMailboxInput) => {
      const me = await resolveMe(env, auth);
      if (!me) {
        return toolError(
          'This credential has no linked user profile, so it has no mailbox. ' +
          'The owner links this PAT to an agent user at /app/config (Usuários). Do NOT retry until linked.'
        );
      }
      // Visibilidade da credencial (spec 91): item cuja task saiu da visão do caller
      // (privada sem escopo, ou desatribuída sob tasks:assigned) não aparece nem conta.
      const visR = await resolveTaskVis(env, auth);
      if (!visR.ok) return toolError(visR.error);
      const [rows, unread] = await Promise.all([
        listMailboxItems(env, me.id, visR.vis, { all: input.all, since: input.since, limit: input.limit }),
        countMailboxUnread(env, me.id, visR.vis),
      ]);
      return toolSuccess({
        me: { id: me.id, name: me.name },
        unread_count: unread,
        items: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          task: { id: r.task_id, title: r.task_title, url: noteUrl(env, r.task_id) },
          comment: r.comment_id
            ? {
                id: r.comment_id,
                body: r.comment_body,
                author_user: r.comment_author_user_id
                  ? { id: r.comment_author_user_id, name: r.comment_author_user_name, type: r.comment_author_user_type }
                  : null,
                author_name: r.comment_author_name,
              }
            : null,
          actor: r.actor_user_id ? { id: r.actor_user_id, name: r.actor_name, type: r.actor_type } : null,
          created_at: r.created_at,
          created_brt: formatBrtDateTime(r.created_at),
          read_at: r.read_at,
        })),
      });
    }) as any
  );
}
