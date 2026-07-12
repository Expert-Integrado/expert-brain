import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, writeActor, canSeePrivate } from '../helpers.js';
import { getNoteById, setNotePrivate } from '../../db/queries.js';

const inputSchema = { id: z.string().min(1) };

const DESCRIPTION = `Marks a knowledge note as PRIVATE (one-way, no un-mark).

A private note becomes invisible via recall/get_note/expand/stats to any credential WITHOUT the \`private\` scope — including a \`full\` PAT (full grants CRUD, not confidentiality). Only the logged-in owner UI can make a note public again (there is intentionally NO tool to un-mark).

FLOW: call recall() or get_note() first to confirm the id. mark_private only works on a note you can currently SEE — a note already private and invisible to you returns "not found". Idempotent: marking an already-private note you can see is a no-op success.

Does NOT re-embed (privacy doesn't change the note's content/vector). Not for tasks — task privacy is handled separately.`;

export function registerMarkPrivate(server: any, env: Env, auth: AuthContext): void {
  const seePrivate = canSeePrivate(auth);
  server.registerTool(
    'mark_private',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Mark note private',
        resource: 'notes',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: { id: string }) => {
      // Só marca uma nota VISÍVEL ao caller (mesma regra de get_note): uma nota já
      // privada e invisível pra quem não tem escopo devolve "not found" — não vaza
      // que existe. Idempotente pra quem enxerga privadas (re-marcar é no-op).
      const note = await getNoteById(env, input.id, false, seePrivate);
      if (!note) {
        return toolError(
          `Note '${input.id}' not found. Call recall() or get_note() to confirm the id. Do NOT retry with this id.`
        );
      }
      if (note.kind === 'task') {
        return toolError(
          `Note '${input.id}' is a task (kind='task'), not a knowledge note. Task privacy is out of scope for mark_private.`
        );
      }
      await setNotePrivate(env, input.id, 1, Date.now(), writeActor(auth));
      return toolSuccess({ id: input.id, private: true });
    }) as any
  );
}
