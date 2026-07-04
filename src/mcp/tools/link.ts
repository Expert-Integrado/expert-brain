import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { EDGE_TYPES, type EdgeType, getNoteById, insertEdge } from '../../db/queries.js';
import { newId } from '../../util/id.js';

const inputSchema = {
  from_id: z.string().min(1),
  to_id: z.string().min(1),
  relation_type: z.enum(EDGE_TYPES),
  why: z.string(),
};

const DESCRIPTION = `Create an edge between two existing notes.

Use ONLY when both notes already exist and you discover a new connection during the conversation. If you are creating a new concept, do NOT use link — use save_note with edges, it is cheaper.

FLOW: call recall() to confirm the ids of both notes before calling link. Self-loops (from_id == to_id) are rejected.

Both endpoints must be knowledge notes — edges to/from tasks (kind='task') are rejected; tasks live outside the graph (use the task's tags to reference context).

IMPORTANT: why minimum 20 characters, naming the shared MECHANISM, not just "related". Duplicate edges (same from_id, to_id, relation_type) return duplicate:true and keep the original why (no new edge, no id in the response).`;

interface LinkInput {
  from_id: string;
  to_id: string;
  relation_type: EdgeType;
  why: string;
}

export function registerLink(server: any, env: Env): void {
  server.registerTool(
    'link',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Create edge', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: LinkInput) => {
      if (input.from_id === input.to_id) {
        return toolError(
          `Cannot create an edge from a note to itself. ` +
          `If the goal is to capture internal tension, create a new note refining the concept and link the two with 'refines' or 'contradicts'.`
        );
      }
      if (input.why.length < 20) {
        return toolError(
          `The why field has only ${input.why.length} characters — minimum is 20. ` +
          `Explain the shared MECHANISM, not just that the notes are related.`
        );
      }
      const [from, to] = await Promise.all([
        getNoteById(env, input.from_id),
        getNoteById(env, input.to_id),
      ]);
      if (!from) {
        return toolError(`Note '${input.from_id}' not found. Call recall() to discover the correct id. Do NOT retry with this id.`);
      }
      if (!to) {
        return toolError(`Note '${input.to_id}' not found. Call recall() to discover the correct id. Do NOT retry with this id.`);
      }
      if (from.kind === 'task' || to.kind === 'task') {
        return toolError(
          `Edges cannot point to tasks — tasks live outside the graph. ` +
          `Use the task's tags (update_task) to reference context instead.`
        );
      }
      const id = newId();
      const inserted = await insertEdge(env, {
        id, from_id: input.from_id, to_id: input.to_id,
        relation_type: input.relation_type, why: input.why,
        created_at: Date.now(),
      });
      // Duplicata (INSERT OR IGNORE não inseriu): NÃO devolver id — o id gerado não
      // existe no banco. Resposta honesta com duplicate:true; o why original fica.
      if (!inserted) {
        return toolSuccess({
          duplicate: true,
          from_id: input.from_id, to_id: input.to_id, relation_type: input.relation_type,
          message: 'Edge already existed — original why kept. No new edge was created.',
        });
      }
      return toolSuccess({ id, from_id: input.from_id, to_id: input.to_id, relation_type: input.relation_type });
    }) as any
  );
}
