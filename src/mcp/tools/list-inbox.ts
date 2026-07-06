import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolSuccess } from '../helpers.js';
import { listInboxItems, countPendingInbox } from '../../db/queries.js';
import { formatBrtDateTime } from '../../util/time.js';

const inputSchema = {
  all: z.boolean().optional().describe('Include already-triaged items too. Default false (pending only).'),
  limit: z.number().int().min(1).max(500).optional().describe('Max items to return (default 200).'),
};

const DESCRIPTION = `Lists the owner's capture inbox — raw items waiting to be triaged (oldest first).

By default returns only PENDING items (not yet triaged). Pass all:true to also see triaged ones (with their triage_action + result_id). Use this to process the inbox in a session: read the pending items, decide for each whether it becomes a note (save_note), a task (save_task) or nothing, then call resolve_inbox with the id, the action and the created result's id.

Each item returns { id, body, source, created_at, created_brt } (+ triaged_at/triage_action/result_id when all:true). The response also carries pending_count.

Note: the inbox is a PRE-triage, owner-only surface — it is intentionally NOT exposed to read-scoped credentials (fail-closed).`;

interface ListInboxInput { all?: boolean; limit?: number; }

export function registerListInbox(server: any, env: Env): void {
  // readOnlyHint FALSE de propósito (spec §2): embora list_inbox só LEIA, o conteúdo é
  // pré-triagem e sensível — registrá-la como tool de escrita faz o gate de escopo
  // (registry/readOnlyGuard) SUPRIMIR a tool num PAT `read` (fail-closed: só PAT full/
  // dono enxerga o inbox). É a exceção consciente à regra "leitura = readOnlyHint:true".
  server.registerTool(
    'list_inbox',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'List inbox', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: ListInboxInput) => {
      const items = await listInboxItems(env, { pendingOnly: !input.all, limit: input.limit });
      const pending = await countPendingInbox(env);
      return toolSuccess({
        count: items.length,
        pending_count: pending,
        items: items.map((it) => ({
          id: it.id,
          body: it.body,
          source: it.source,
          created_at: it.created_at,
          created_brt: formatBrtDateTime(it.created_at),
          ...(input.all
            ? {
                triaged_at: it.triaged_at,
                triage_action: it.triage_action,
                result_id: it.result_id,
              }
            : {}),
        })),
      });
    }) as any
  );
}
