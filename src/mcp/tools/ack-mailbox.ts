import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, canSeePrivate } from '../helpers.js';
import { ackMailboxItems, countMailboxUnread } from '../../db/mailbox.js';
import { resolveMe } from './user-ref.js';

const inputSchema = {
  ids: z.array(z.string().min(1)).max(200).optional().describe('Item ids (mbx_...) to mark as read. Only items addressed to YOUR profile are touched — acking someone else\'s id is a silent no-op.'),
  up_to: z.number().optional().describe('Marks ALL your unread items with created_at <= this unix-ms timestamp. Use the created_at of the last item you processed from check_mailbox.'),
};

const DESCRIPTION = `Marks mailbox items as read (acknowledged). Pass EITHER \`ids\` (specific items) OR \`up_to\` (everything up to a timestamp) — exactly one.

Ack AFTER acting on an item, not on read: check_mailbox never marks anything, so an item stays visible to your next session until you explicitly ack it. Only items addressed to the profile linked to THIS credential are affected — you cannot ack another user's items.

Returns { acked, unread_count } (unread_count = what remains unread for you).`;

interface AckMailboxInput { ids?: string[]; up_to?: number }

export function registerAckMailbox(server: any, env: Env, auth?: AuthContext): void {
  server.registerTool(
    'ack_mailbox',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Ack mailbox items', resource: 'mailbox', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: AckMailboxInput) => {
      const hasIds = input.ids !== undefined;
      const hasUpTo = input.up_to !== undefined;
      if (hasIds === hasUpTo) {
        return toolError('Pass exactly ONE of `ids` (specific items) or `up_to` (unix-ms timestamp).');
      }
      const me = await resolveMe(env, auth);
      if (!me) {
        return toolError(
          'This credential has no linked user profile, so it has no mailbox. ' +
          'The owner links this PAT to an agent user at /app/config (Usuários). Do NOT retry until linked.'
        );
      }
      const acked = await ackMailboxItems(env, me.id, { ids: input.ids, upTo: input.up_to });
      const unread = await countMailboxUnread(env, me.id, canSeePrivate(auth));
      return toolSuccess({ acked, unread_count: unread });
    }) as any
  );
}
