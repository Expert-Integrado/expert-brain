import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl, canSeePrivate } from '../helpers.js';
import { getEdgesFrom, getEdgesTo, getNoteById, getTagsByNote, listTasksFromOrigin } from '../../db/queries.js';
import { mentionsForOutput } from '../mentions.js';

const inputSchema = { id: z.string().min(1) };

const DESCRIPTION = `Fetch the full content of a note by id (body + tags + edges).

FLOW: call recall() first to discover the id. Do not invent ids.

IMPORTANT: the body can be long — cite the relevant passages in your reply, do not dump the entire content back to the user. If you are not sure which note to pull, prefer recall() + expand() before falling back to get_note.

Works for tasks (kind='task') too, but returns a note shape WITHOUT status/due/priority — use get_task to read a task's full state.`;

export function registerGetNote(server: any, env: Env, auth?: AuthContext): void {
  // Selo de privacidade (spec 31): sem escopo, nota privada = mesmo "not found" de
  // inexistente (não vaza que existe), e vizinhos privados somem dos edges.
  const seePrivate = canSeePrivate(auth);
  server.registerTool(
    'get_note',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Get full note', resource: 'notes', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: { id: string }) => {
      const n = await getNoteById(env, input.id, false, seePrivate);
      if (!n) {
        return toolError(
          `Note '${input.id}' not found. Call recall() to discover the correct id. Do NOT retry with this id.`
        );
      }
      const [tags, edgesOut, edgesIn, mentions, tasksFromOrigin] = await Promise.all([
        getTagsByNote(env, input.id),
        getEdgesFrom(env, input.id, seePrivate),
        getEdgesTo(env, input.id, seePrivate),
        // Menções (spec 62): contatos que esta nota cita. Label omitido pra contato
        // privado quando o caller não tem escopo `private` (não vaza o nome).
        mentionsForOutput(env, input.id, seePrivate),
        // Tasks originadas desta nota ("Criar task desta nota"): gate de privacidade de task.
        listTasksFromOrigin(env, input.id, seePrivate),
      ]);
      return toolSuccess({
        id: n.id,
        url: noteUrl(env, n.id),
        title: n.title,
        body: n.body,
        tldr: n.tldr,
        domains: JSON.parse(n.domains),
        kind: n.kind,
        created_at: n.created_at,
        updated_at: n.updated_at,
        tags,
        edges: {
          out: edgesOut.map((e) => ({ id: e.id, to_id: e.to_id, relation_type: e.relation_type, why: e.why })),
          in:  edgesIn.map((e) => ({ id: e.id, from_id: e.from_id, relation_type: e.relation_type, why: e.why })),
        },
        mentions,
        tasks_from_origin: tasksFromOrigin.map((t) => ({ id: t.id, title: t.title, status: t.status })),
      });
    }) as any
  );
}
