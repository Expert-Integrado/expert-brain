import { z } from 'zod';
import type { Env } from '../../env.js';
import { newId } from '../../util/id.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { EDGE_TYPES, NOTE_KINDS, type EdgeType, type NoteKind, insertEdge, insertNote, insertTags, getNoteById } from '../../db/queries.js';
import { validateDomains } from '../../db/validation.js';
import { embed, upsertNoteVector } from '../../vector/index.js';

const edgeSchema = z.object({
  to_id: z.string().min(1),
  relation_type: z.enum(EDGE_TYPES),
  why: z.string(),
});

const inputSchema = {
  title: z.string().min(1).max(200).describe('Atomic title. No "and".'),
  body: z.string().min(1).describe('Body in markdown'),
  tldr: z.string().min(10).max(280).describe('One sentence. Feynman test.'),
  domains: z.array(z.string().min(1)).min(1).max(3).describe('Canonical English slugs (1-3). Must be one of the 12 canonical domains unless allow_new_domain is set.'),
  kind: z.enum(NOTE_KINDS).describe(
    'concept | decision | insight | fact | pattern | principle | question'
  ),
  tags: z.array(z.string()).optional(),
  edges: z.array(edgeSchema).optional(),
  allow_new_domain: z.boolean().optional().describe(
    'Escape hatch — set true to allow domains outside the 12 canonical ones. Default false. Only use when the user explicitly opens a new area; syntactic validation (kebab-case) still applies.'
  ),
};

const DESCRIPTION = `Saves an atomic note to the vault, optionally with edges to existing notes.

MANDATORY FLOW before calling:
1. Atomize: one note = one concept. If the title contains "and", split it into separate calls.
2. Call recall() first to sweep for cross-domain analogies. Even if you think the idea is original.
3. For each analogy in ANOTHER domain, include an edge in the edges array of this same call.

The tldr field is a Feynman test: if you cannot summarize the concept in one concrete sentence, the note is NOT ready — do not force it, keep talking with the user until you have clarity. Do NOT call save_note without a concrete tldr.

Write title/body/tldr in the CONVERSATION LANGUAGE (if the user is speaking Portuguese, save in Portuguese; English → English). The embedding model is multilingual.

The domains field MUST be one of the 12 canonical domains: management, sales, marketing, education, ai-applied, leadership, product, operations, personal-development, entrepreneurship, music, cognitive-science. These are the schema of the vault — kebab-case English slugs, stable identifiers, do NOT translate to other languages. If a note doesn't fit any of the 12, pick the closest match — the canon is the unit of cross-domain recall, so the analogy lives in the canonical slot, not in a bespoke one. If the user genuinely opens a new area (e.g. moves into a new market), pass allow_new_domain: true on this call to bypass the canon check; the syntactic kebab-case rule still applies. The error message on a canon violation suggests the closest canonical — re-tries are cheap.

The kind field is REQUIRED and must be one of 7 values — pick the one that best fits the note's epistemic status:
- 'concept'   — an abstract idea, model, or framework (most common default)
- 'decision'  — a choice made with preserved reasoning (design decision, strategic bet)
- 'insight'   — a personal observation or discovery ("I just realized...")
- 'fact'      — an objective data point or citable reference
- 'pattern'   — a recurring structure observed across instances
- 'principle' — a personal rule or axiom the user lives by
- 'question'  — an open question worth revisiting (not yet answered)

IMPORTANT: the why field of each edge is rejected if it has fewer than 20 characters, and edges pointing to non-existent ids are rejected. If you do not have the target note id, call recall() first. Domains that do not match the canonical slug format are rejected with an explanation.

INDEXING LATENCY: Cloudflare Vectorize is eventually consistent. After save_note returns successfully, the newly-saved note is immediately queryable via its id (get_note, expand) because D1 is strongly consistent, but the VECTOR may take up to ~1-2 minutes to become queryable via recall. If the user asks you to recall a concept right after saving it and recall returns empty or misses the fresh note, that is NOT a bug — explain the delay to the user and suggest trying again in a minute, or use get_note/expand on the id you just received if you need to reference the content immediately.`;

interface SaveNoteInput {
  title: string;
  body: string;
  tldr: string;
  domains: string[];
  kind: NoteKind;
  tags?: string[];
  edges?: Array<{ to_id: string; relation_type: EdgeType; why: string }>;
  allow_new_domain?: boolean;
}

export function registerSaveNote(server: any, env: Env): void {
  server.registerTool(
    'save_note',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Save atomic note',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: SaveNoteInput) => {
      const domainError = validateDomains(input.domains, {
        allowNewDomain: input.allow_new_domain ?? false,
      });
      if (domainError) {
        return toolError(domainError);
      }

      const now = Date.now();
      const id = newId();

      if (input.edges) {
        for (const e of input.edges) {
          if (e.why.length < 20) {
            return toolError(
              `The why field of this edge has only ${e.why.length} characters — minimum is 20 characters. ` +
              `Rewrite it naming the shared MECHANISM between the two notes, not just saying they are related. ` +
              `Good example: "Both are systems with delayed negative feedback, so both oscillate." ` +
              `Bad example: "both are about growth".`
            );
          }
          const target = await getNoteById(env, e.to_id);
          if (!target) {
            return toolError(
              `Note '${e.to_id}' not found in the vault. Call recall() first with a related query ` +
              `to discover the correct id. Do NOT retry with this id.`
            );
          }
        }
      }

      // Embed FIRST — if Workers AI fails we bail before any D1 write, so the
      // caller sees a clean error and no phantom notes are left in the database.
      const vec = await embed(env, input.tldr);

      await insertNote(env, {
        id,
        title: input.title,
        body: input.body,
        tldr: input.tldr,
        domains: JSON.stringify(input.domains),
        kind: input.kind,
        created_at: now,
        updated_at: now,
      });
      if (input.tags?.length) await insertTags(env, id, input.tags);

      if (input.edges) {
        for (const e of input.edges) {
          await insertEdge(env, {
            id: newId(),
            from_id: id,
            to_id: e.to_id,
            relation_type: e.relation_type,
            why: e.why,
            created_at: now,
          });
        }
      }

      // Upsert vector LAST. If this fails, the note is in D1 but not queryable
      // via recall until re-embedded. get_note(id) and expand(id) still work.
      await upsertNoteVector(env, id, vec, {
        domains: input.domains,
        kind: input.kind,
        created_at: now,
      });

      return toolSuccess({
        id,
        saved: { title: input.title, domains: input.domains },
        edges_created: input.edges?.length ?? 0,
      });
    }) as any
  );
}
