import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { insertInboxItem, countPendingInbox, INBOX_BODY_MAX } from '../../db/queries.js';
import { newId } from '../../util/id.js';

// `source` é string livre informativa (mcp|console|telegram|whatsapp). Cap curto pra
// não virar campo de texto arbitrário — o valor é só rótulo de origem.
const SOURCE_MAX = 40;

const inputSchema = {
  text: z.string().min(1).max(INBOX_BODY_MAX).describe(`The raw idea/reminder to capture, verbatim (1-${INBOX_BODY_MAX} chars). No structure needed — no kind, no domain, no tldr. Triage happens LATER.`),
  source: z.string().max(SOURCE_MAX).optional().describe("Optional origin label for auditing (e.g. 'telegram', 'whatsapp'). Free string; defaults to 'mcp'."),
};

const DESCRIPTION = `Instant, zero-friction CAPTURE into the owner's inbox — the triage decides LATER whether it becomes a note, a task, or nothing.

Use this when the owner drops a loose idea/reminder/thought WITHOUT asking for a structured note (no kind/domain/tldr required). It is the opposite of save_note (which demands curation): capture is for the impulse, so a fleeting idea is never lost just because structuring it would cost more than 5 seconds.

Do NOT capture ordinary conversation — only an explicit idea/reminder from the OWNER. The captured text lands in a triage queue (see /app/inbox in the console, or list_inbox + save_note/save_task + resolve_inbox in a session).

A captured item is stored in a SEPARATE table — it never appears in recall(), the graph, the notes list or stats until it is triaged into a real note/task.

Returns { id, pending_count } plus a short confirmation phrase to relay to the owner ("capturado; N pendentes na triagem").`;

interface CaptureInput { text: string; source?: string; }

export function registerCapture(server: any, env: Env): void {
  server.registerTool(
    'capture',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Capture to inbox', resource: 'notes', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: CaptureInput) => {
      const body = input.text.trim();
      if (!body) return toolError('Nothing to capture: text is empty after trimming.');
      if (body.length > INBOX_BODY_MAX) {
        return toolError(`Text too long (${body.length} chars). Max is ${INBOX_BODY_MAX}.`);
      }
      const source = (input.source?.trim().slice(0, SOURCE_MAX)) || 'mcp';
      const id = `ibx_${newId()}`;
      const now = Date.now();
      await insertInboxItem(env, { id, body, source, created_at: now });
      const pending = await countPendingInbox(env);
      return toolSuccess({
        id,
        source,
        created_at: now,
        pending_count: pending,
        message: `capturado; ${pending} ${pending === 1 ? 'pendente' : 'pendentes'} na triagem`,
      });
    }) as any
  );
}
