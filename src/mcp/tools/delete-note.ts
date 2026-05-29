import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { deleteNote, getNoteById } from '../../db/queries.js';

const inputSchema = {
  id: z.string().min(1),
  confirm: z.literal(true).describe('Must be true — acknowledges the delete is irreversible'),
};

const DESCRIPTION = `Removes a note from the vault. RECOVERABLE — this is a soft-delete.

The note disappears from recall, search, the graph and stats, and its vector is removed from the semantic index. But the content and its edges stay in D1 (flagged deleted_at), so it can be brought back with restore_note(id) at any time, with no time limit.

FLOW:
1. Call recall() or get_note() first to confirm the id is correct. Do NOT delete on an invented id.
2. Ask the USER for explicit confirmation before calling — quote the title and tldr back so they know what is being removed.
3. Only then pass confirm: true.

Use delete_note when:
- The user explicitly says "delete this note" / "remove it" / "forget this".
- A note was saved accidentally (duplicate, wrong concept, test data).

Do NOT use delete_note to "clean up" notes you judge low-quality on your own — that is a policy decision that belongs to the user. When in doubt, suggest update_note instead (refine, don't destroy).

ORDER: removes the vector FIRST, then flags the D1 row deleted. If the vector delete fails, nothing is flagged so the note stays fully accessible. restore_note re-embeds the vector so recall works again after a restore.`;

interface DeleteNoteInput { id: string; confirm: true; }

export function registerDeleteNote(server: any, env: Env): void {
  server.registerTool(
    'delete_note',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Delete note permanently',
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: DeleteNoteInput) => {
      const existing = await getNoteById(env, input.id);
      if (!existing) {
        return toolError(
          `Note '${input.id}' not found. Nothing to delete. Call recall() or get_note() to confirm the id.`
        );
      }

      const countRow = await env.DB.prepare(
        `SELECT (SELECT count(*) FROM edges WHERE from_id = ?1 OR to_id = ?1) AS e,
                (SELECT count(*) FROM tags WHERE note_id = ?1) AS t`
      ).bind(input.id).first<{ e: number; t: number }>();
      // Soft-delete: edges/tags NÃO são removidas — ficam escondidas e voltam
      // junto no restore. Reportamos como "hidden", não "removed".
      const edgesHidden = countRow?.e ?? 0;
      const tagsHidden = countRow?.t ?? 0;

      // Vectorize FIRST, D1 after. If the vector delete fails, D1 is preserved
      // so the note stays reachable via get_note/recall — no inconsistent state.
      // We catch here specifically (rather than letting safeToolHandler emit
      // the generic Vectorize error) so the user gets a clear "nothing was
      // deleted, safe to retry" signal instead of ambiguous boilerplate.
      try {
        await env.VECTORIZE.deleteByIds([input.id]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('delete_note: Vectorize.deleteByIds failed:', msg);
        return toolError(
          `Failed to remove the vector from the semantic index: ${msg}. ` +
          `The note was NOT deleted from the vault — it is still fully accessible via recall, get_note, and the dashboard. ` +
          `This is usually a transient Vectorize error. Safe to retry the same delete_note call in a few seconds.`
        );
      }

      await deleteNote(env, input.id);

      return toolSuccess({
        id: input.id,
        deleted: true,
        recoverable: true,
        restore_with: `restore_note(id: "${input.id}")`,
        title: existing.title,
        edges_hidden: edgesHidden,
        tags_hidden: tagsHidden,
      });
    }) as any
  );
}
