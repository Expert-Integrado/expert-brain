import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { getNoteById, restoreNote } from '../../db/queries.js';
import { embed, upsertNoteVector } from '../../vector/index.js';

const inputSchema = {
  id: z.string().min(1),
};

const DESCRIPTION = `Restores a note that was soft-deleted by delete_note. Reversal of delete_note.

Brings the note back into recall, search, the graph and stats, and re-embeds its vector into the semantic index so recall works again. The edges that were hidden with it come back too (soft-delete never removed them). No time limit — a note deleted weeks ago is still restorable.

Use restore_note when the user says "undo that delete", "bring it back", "restore the note I deleted", or when a note was removed by mistake.

Pass the note id (the same id delete_note reported). If the note is not in the trash (never deleted, or already restored), this reports that and does nothing.`;

interface RestoreNoteInput { id: string; }

export function registerRestoreNote(server: any, env: Env): void {
  server.registerTool(
    'restore_note',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Restore a soft-deleted note',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: RestoreNoteInput) => {
      // includeDeleted: precisa enxergar a nota na lixeira pra recuperar.
      const note = await getNoteById(env, input.id, true);
      if (!note) {
        return toolError(
          `Note '${input.id}' not found at all (not even in the trash). Nothing to restore.`
        );
      }
      if (note.deleted_at == null) {
        return toolSuccess({
          id: input.id,
          restored: false,
          title: note.title,
          message: 'This note is not deleted — it is already active. Nothing to do.',
        });
      }

      // Tira da lixeira e re-embed o vetor (delete_note tinha removido do Vectorize).
      await restoreNote(env, input.id);
      const vec = await embed(env, note.tldr);
      await upsertNoteVector(env, input.id, vec, {
        domains: JSON.parse(note.domains) as string[],
        kind: note.kind,
        created_at: note.created_at,
      });

      return toolSuccess({
        id: input.id,
        restored: true,
        title: note.title,
        message: 'Note restored — back in recall, search, the graph and stats, with its edges.',
      });
    }) as any
  );
}
