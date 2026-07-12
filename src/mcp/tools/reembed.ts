import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { getNoteById } from '../../db/queries.js';
import { embed, upsertNoteVector } from '../../vector/index.js';
import { refreshSimilarEdges } from '../../web/similarity.js';

const inputSchema = {
  id: z.string().min(1).describe('The id of the note to re-embed'),
};

const DESCRIPTION = `Regenerate the vector embedding for an existing note and upsert it to the semantic search index.

Use this as a RESCUE when:
- A save_note succeeded but the subsequent vector upsert failed (the note is in the database and accessible via get_note/expand, but not queryable via recall).
- The user reports "I saved X earlier but recall() cannot find it" AND you already confirmed via get_note that the note exists.
- A future migration changes the embedding model — a batch of reembed calls re-populates the index with new vectors.

Idempotent and safe to call repeatedly. Looks up the note by id, calls the embedding model on the note tldr, and upserts the resulting vector with the same metadata (domains, kind, created_at).

IMPORTANT: do NOT call reembed reflexively every time recall returns empty. Recall can legitimately return empty for (a) a truly empty vault, (b) a query with no matches, or (c) indexing latency of ~1-2 minutes after a fresh save. Only call reembed when you have evidence that a specific id exists in the database but is unreachable via recall after the latency window.`;

interface ReembedInput { id: string; }

export function registerReembed(server: any, env: Env): void {
  server.registerTool(
    'reembed',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Re-embed note vector',
        resource: 'notes',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: ReembedInput) => {
      const n = await getNoteById(env, input.id);
      if (!n) {
        return toolError(
          `Note '${input.id}' not found. Call recall() or get_note() to discover the correct id. Do NOT retry with this id.`
        );
      }
      const domains: string[] = JSON.parse(n.domains);
      const vec = await embed(env, n.tldr);
      await upsertNoteVector(env, input.id, vec, {
        domains,
        kind: n.kind,
        created_at: n.created_at,
      });
      // Reembed também atualiza a vizinhança semântica gravada. Best-effort.
      try {
        await refreshSimilarEdges(env, input.id, vec);
      } catch (err) {
        console.error('reembed: refreshSimilarEdges failed (vector re-embedded anyway)', err);
      }
      return toolSuccess({
        id: input.id,
        reembedded: true,
        dimensions: vec.length,
        tldr: n.tldr.slice(0, 80),
      });
    }) as any
  );
}
