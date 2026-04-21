import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { deleteNote, getNoteById } from '../../db/queries.js';

const inputSchema = {
  id: z.string().min(1),
  confirm: z.literal(true).describe('Must be true — acknowledges the delete is irreversible'),
};

const DESCRIPTION = `Permanently deletes a note from the vault. IRREVERSIBLE.

Removes: the note row in D1, all edges pointing to or from it (schema cascade), all tags, and the vector in Vectorize.

FLOW:
1. Call recall() or get_note() first to confirm the id is correct. Do NOT delete on an invented id.
2. Ask the USER for explicit confirmation before calling — quote the title and tldr back so they know what is being removed.
3. Only then pass confirm: true.

Use delete_note when:
- The user explicitly says "delete this note" / "remove it" / "forget this".
- A note was saved accidentally (duplicate, wrong concept, test data).

Do NOT use delete_note to "clean up" notes you judge low-quality on your own — that is a policy decision that belongs to the user. When in doubt, suggest update_note instead (refine, don't destroy).

ORDER: deletes vector FIRST, then D1 row. If the vector delete fails, the D1 row is preserved so the note is still accessible via get_note. If the D1 delete fails after the vector was removed, the note exists in D1 without a searchable vector — use reembed to restore recall.`;

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
      const edgesRemoved = countRow?.e ?? 0;
      const tagsRemoved = countRow?.t ?? 0;

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
        title: existing.title,
        edges_removed: edgesRemoved,
        tags_removed: tagsRemoved,
      });
    }) as any
  );
}
