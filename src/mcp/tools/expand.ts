import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl, canSeePrivate } from '../helpers.js';
import { EDGE_TYPES, getEdgesFrom, getEdgesTo, getNoteById, PUBLIC_ONLY_FILTER, type EdgeRow, type NoteRow } from '../../db/queries.js';

const inputSchema = {
  note_id: z.string().min(1),
  relation_types: z.array(z.enum(EDGE_TYPES as unknown as [string, ...string[]])).optional(),
  direction: z.enum(['in','out','both']).optional().default('both'),
};

const DESCRIPTION = `Immediate neighbors (1 hop) of a note in the graph.

FLOW: call recall() first to discover the note_id. Do not call expand with an invented id.

Returns {neighbors: [{note, edge}]} where edge includes relation_type and why.
To navigate deeper, call expand recursively on the returned ids — but think twice before going more than 2 hops, it is usually noise.

IMPORTANT: if recall already surfaces the analogy you need, do not reflexively call expand. Use expand when you want to follow a specific reasoning line through the graph.

Works for tasks (kind='task') too — but tasks have no edges (they live outside the graph), so expand on a task id returns an empty neighbor set.`;

interface ExpandInput {
  note_id: string;
  relation_types?: string[];
  direction?: 'in'|'out'|'both';
}

export function registerExpand(server: any, env: Env, auth?: AuthContext): void {
  // Selo de privacidade (spec 31): base privada = "not found" pra caller sem escopo;
  // vizinhos privados somem tanto no JOIN dos edges quanto na hidratação abaixo
  // (defesa em profundidade — o JOIN já filtra, mas a hidratação não pode reabrir).
  const seePrivate = canSeePrivate(auth);
  server.registerTool(
    'expand',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Expand neighbors', resource: 'notes', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: ExpandInput) => {
      const base = await getNoteById(env, input.note_id, false, seePrivate);
      if (!base) {
        return toolError(
          `Note '${input.note_id}' not found. Call recall() first to discover the correct id. Do NOT retry with this id.`
        );
      }
      const dir = input.direction ?? 'both';
      const edges: Array<{ edge: EdgeRow; otherId: string }> = [];
      if (dir === 'out' || dir === 'both') {
        for (const e of await getEdgesFrom(env, input.note_id, seePrivate)) edges.push({ edge: e, otherId: e.to_id });
      }
      if (dir === 'in' || dir === 'both') {
        for (const e of await getEdgesTo(env, input.note_id, seePrivate)) edges.push({ edge: e, otherId: e.from_id });
      }
      const filtered = input.relation_types
        ? edges.filter((x) => input.relation_types!.includes(x.edge.relation_type))
        : edges;

      const ids = Array.from(new Set(filtered.map((x) => x.otherId)));
      if (ids.length === 0) return toolSuccess({ neighbors: [] });
      const placeholders = ids.map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT id,title,tldr,domains FROM notes WHERE id IN (${placeholders}) AND deleted_at IS NULL${seePrivate ? '' : ` AND ${PUBLIC_ONLY_FILTER}`}`
      ).bind(...ids).all<Pick<NoteRow,'id'|'title'|'tldr'|'domains'>>();
      const byId = new Map((rows.results ?? []).map((r) => [r.id, r]));

      const neighbors = filtered.map((x) => {
        const n = byId.get(x.otherId);
        if (!n) return null;
        const domains: string[] = JSON.parse(n.domains);
        return {
          note: { id: n.id, url: noteUrl(env, n.id), title: n.title, domain: domains[0] ?? 'unknown', tldr: n.tldr },
          edge: { relation_type: x.edge.relation_type, why: x.edge.why },
        };
      }).filter(Boolean);

      return toolSuccess({ neighbors });
    }) as any
  );
}
