import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { EDGE_TYPES, type EdgeType, getEdge, deleteEdge } from '../../db/queries.js';
import { invalidateGraphCache } from '../../web/graph-data.js';

const inputSchema = {
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  relation_type: z.enum(EDGE_TYPES),
  confirm: z.literal(true).describe('Must be true — acknowledges the edge is removed (recreate via link if needed).'),
};

const DESCRIPTION = `Removes an edge from the graph by its natural key (from_id, to_id, relation_type).

Edges are DIRECTIONAL — from_id → to_id. The single most likely mistake is inverting from/to; if the delete says "edge not found", try swapping them.

FLOW:
1. Call expand(note_id) first to see the note's real edges (with direction and why) and confirm the exact triple.
2. Ask the USER before deleting — quote the why back so they know what is being removed.
3. Pass confirm: true.

This is a HARD delete (edges have no soft-delete), but it is cheap to recreate: the response returns the removed why, so link(from_id, to_id, relation_type, why) restores it 1:1. To EDIT a why, delete_link then link again.

Main use: curation — a wrong edge, a vague why, an orphan edge left by a reworked concept.`;

interface DeleteLinkInput {
  from_id: string;
  to_id: string;
  relation_type: EdgeType;
  confirm: true;
}

export function registerDeleteLink(server: any, env: Env): void {
  server.registerTool(
    'delete_link',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Delete edge',
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: DeleteLinkInput) => {
      // Busca a edge pela tripla pra citar o why na resposta — e pra distinguir
      // "não existe" de "removida". Edge direcional: errar from/to invertidos é o
      // erro mais provável; o texto sugere a direção inversa.
      const edge = await getEdge(env, input.from_id, input.to_id, input.relation_type);
      if (!edge) {
        return toolError(
          `No '${input.relation_type}' edge from '${input.from_id}' to '${input.to_id}'. ` +
          `Edges are directional — try the inverse direction (from_id and to_id swapped), ` +
          `or call expand('${input.from_id}') to see the note's actual edges. Nothing was changed.`
        );
      }

      await deleteEdge(env, input.from_id, input.to_id, input.relation_type);

      // Invalida o cache do grafo (best-effort — a edge já foi removida do D1;
      // falha de KV não pode falhar o delete já commitado). O sourceHash também
      // cobriria (COUNT de edges muda), mas seguimos o padrão explícito do endpoint web.
      try {
        await invalidateGraphCache(env);
      } catch (err) {
        console.error('delete_link: invalidateGraphCache failed (edge already deleted)', err);
      }

      return toolSuccess({
        deleted: true,
        from_id: input.from_id,
        to_id: input.to_id,
        relation_type: input.relation_type,
        why_removed: edge.why,
      });
    }) as any
  );
}
