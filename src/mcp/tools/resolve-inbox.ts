import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { resolveInboxItem, getInboxItem, countPendingInbox, INBOX_ACTIONS, type InboxAction } from '../../db/queries.js';

const inputSchema = {
  id: z.string().min(1).describe('The inbox item id (from list_inbox / capture).'),
  action: z.enum(INBOX_ACTIONS).describe("How the item was triaged: 'note' (turned into a note via save_note), 'task' (turned into a task via save_task), or 'discard' (dropped)."),
  result_id: z.string().optional().describe("For action 'note'/'task': the id of the note/task you created for this item (audit trail). Omit for 'discard'."),
};

const DESCRIPTION = `Marks an inbox item as TRIAGED — records the decision, does NOT create anything.

This is the second half of the capture→triage flow: YOU (or the owner in the console) first create the real note/task via save_note/save_task with full curation, THEN call resolve_inbox with the item id, the action taken, and the created result's id. Keeping creation in save_note/save_task means there is ONE knowledge-write route (kind/domain/tldr validation is not duplicated here).

- action 'note' or 'task': pass result_id = the created note/task id.
- action 'discard': no result_id needed; the item is dropped (it stays in the table for audit, it just leaves the pending queue).

Idempotent: resolving an already-triaged item is a safe no-op (reports already_triaged). Returns { id, action, result_id, pending_count }.`;

interface ResolveInboxInput { id: string; action: InboxAction; result_id?: string; }

export function registerResolveInbox(server: any, env: Env): void {
  server.registerTool(
    'resolve_inbox',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Resolve inbox item', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: ResolveInboxInput) => {
      const resultId = input.result_id?.trim() || null;
      const now = Date.now();
      const res = await resolveInboxItem(env, input.id, input.action, resultId, now);
      if (!res.ok && !res.alreadyTriaged) {
        return toolError(
          `Inbox item '${input.id}' not found. Confirm the id via list_inbox. Do NOT retry with this id.`
        );
      }
      const pending = await countPendingInbox(env);
      if (res.alreadyTriaged) {
        const existing = await getInboxItem(env, input.id);
        return toolSuccess({
          id: input.id,
          already_triaged: true,
          triage_action: existing?.triage_action ?? null,
          result_id: existing?.result_id ?? null,
          pending_count: pending,
        });
      }
      return toolSuccess({
        id: input.id,
        action: input.action,
        result_id: resultId,
        pending_count: pending,
      });
    }) as any
  );
}
