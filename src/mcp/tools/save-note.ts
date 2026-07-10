import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { newId } from '../../util/id.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl, writeActor, canSeePrivate } from '../helpers.js';
import {
  EDGE_TYPES, KNOWLEDGE_KINDS, type EdgeType, type NoteKind,
  insertEdge, insertNote, insertTags, getNoteById, getNotesByIds,
  findSimilarActiveNotesByTitle, findActiveNoteIdByTag,
} from '../../db/queries.js';
import { validateDomains } from '../../db/validation.js';
import { embed, upsertNoteVector, queryVector, type VectorMatch } from '../../vector/index.js';
import {
  DEDUP_MIN_SCORE, LINK_SUGGESTION_MIN_SCORE, SIMILARITY_TOP_K,
  persistSimilarEdgesFromMatches, isNearDuplicateTitle,
} from '../../web/similarity.js';
import { isLazyWhy, lazyWhyError } from '../why-quality.js';
import { applyMentions } from '../mentions.js';

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
  kind: z.enum(KNOWLEDGE_KINDS).describe(
    'concept | decision | insight | fact | pattern | principle | question'
  ),
  tags: z.array(z.string()).optional(),
  edges: z.array(edgeSchema).optional(),
  allow_new_domain: z.boolean().optional().describe(
    'Escape hatch — set true to allow domains outside the 12 canonical ones. Default false. Only use when the user explicitly opens a new area; syntactic validation (kebab-case) still applies.'
  ),
  private: z.boolean().optional().describe(
    'Mark the note PRIVATE (default false). A private note is invisible via recall/get_note/expand/stats to any credential WITHOUT the `private` scope. One-way from tools: only the owner UI can make it public again.'
  ),
  mentions: z.array(z.string().min(1)).optional().describe(
    'Optional CONTACT entity ids this note is about (people/companies from the Contacts vault). Get the id FIRST via get_contact_by_phone / search_contacts / list_contacts — do NOT pass a free-text name (it would create a phantom mention on typo/homonym). Each mention links the note to the contact, fires a `mentioned_in_brain` event on that contact\'s timeline, and shows on the contact\'s page. Passing an id twice is deduped.'
  ),
  dedupe_key: z.string().min(1).max(120).optional().describe(
    'Idempotency key for BATCH IMPORTS and re-runs (spec 71). If a live note already carries this key, save_note returns that note ({deduped: true, id}) and saves NOTHING — a hard gate, unlike possible_duplicates which is informational. Use ONLY when the caller controls a stable identity for the item (source id of the import, hash of the source content). NEVER invent a key for a conversational note. Stored as the reserved tag `dedupe:<key>` (normalized lowercase).'
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

IMPORTANT: the why field of each edge is rejected if it has fewer than 20 characters OR if it only says the notes are related/similar/connected without naming the shared MECHANISM. Edges pointing to non-existent ids are rejected. Edges pointing to a task (kind='task') are also rejected — tasks live outside the graph; the note is NOT saved, remove the edge and retry. If you do not have the target note id, call recall() first. Domains that do not match the canonical slug format are rejected with an explanation.

HYGIENE FIELDS IN THE RESPONSE (spec 71 — read them, they are not decoration):
- possible_duplicates: notes whose meaning (vector score >= 0.80) or title almost matches what you just saved. The save ALREADY happened (soft gate). If non-empty: show them to the user and either update_note the existing note OR keep both if they are genuinely distinct theses — NEVER merge without confirming. score is cosine similarity (not calibrated); reason 'title' entries have score null.
- link_suggestions: notes scoring 0.60-0.79 — candidates for a link() edge. Each comes with its tldr so you can judge and write a MECHANISM-based why without an extra get_note. Create the edges that have a real shared mechanism; skip the rest.

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
  private?: boolean;
  mentions?: string[];
  dedupe_key?: string;
}

interface DuplicateCandidate {
  id: string; title: string; tldr: string;
  score: number | null; reason: 'vector' | 'title';
}
interface LinkSuggestion { id: string; title: string; tldr: string; score: number; }

export function registerSaveNote(server: any, env: Env, auth: AuthContext): void {
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

      // Gate HARD de idempotência (spec 71): identidade declarada PELO caller
      // (import/re-run). Checado ANTES do embed — o hit não gasta Workers AI
      // nem toca o banco. Tag normalizada igual ao insertTags (trim+lowercase).
      const dedupeTag = input.dedupe_key ? `dedupe:${input.dedupe_key.trim().toLowerCase()}` : null;
      if (dedupeTag) {
        const existingId = await findActiveNoteIdByTag(env, dedupeTag);
        if (existingId) {
          const existing = await getNoteById(env, existingId);
          return toolSuccess({
            deduped: true,
            id: existingId,
            url: noteUrl(env, existingId),
            title: existing?.title ?? null,
            message: 'dedupe_key already present in the vault — returning the existing note; NOTHING was saved. To change it, call update_note on this id.',
          });
        }
      }

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
          if (isLazyWhy(e.why)) {
            return toolError(lazyWhyError());
          }
          const target = await getNoteById(env, e.to_id);
          if (!target) {
            return toolError(
              `Note '${e.to_id}' not found in the vault. Call recall() first with a related query ` +
              `to discover the correct id. Do NOT retry with this id.`
            );
          }
          if (target.kind === 'task') {
            return toolError(
              `Edge to '${e.to_id}' rejected: that id is a task, and tasks live outside the graph. ` +
              `Use the task's tags to reference context instead. The note was NOT saved — remove this edge and retry.`
            );
          }
        }
      }

      // Embed FIRST — if Workers AI fails we bail before any D1 write, so the
      // caller sees a clean error and no phantom notes are left in the database.
      const vec = await embed(env, input.tldr);

      // UMA consulta de vizinhança pré-insert alimenta os 3 consumidores (spec 71):
      // possible_duplicates (>= 0.80), link_suggestions (0.60-0.79) e as
      // similar_edges persistidas depois do insert — zero segunda chamada ao
      // Vectorize. Pré-insert o próprio id ainda não está no índice, então todo
      // match é candidato legítimo. Falha aqui NÃO derruba o save: listas vazias
      // e as similar_edges ficam pro re-pass diário (spec 72).
      let matches: VectorMatch[] = [];
      let vectorLookupFailed = false;
      try {
        matches = await queryVector(env, vec, SIMILARITY_TOP_K + 2);
      } catch (err) {
        vectorLookupFailed = true;
        console.error('save_note: pré-consulta de vizinhança falhou (save segue; re-pass cobre)', err);
      }

      // Candidatos por TÍTULO via FTS (D1, fortemente consistente) — pega a dup
      // intra-lote que o Vectorize eventual-consistent ainda não indexou. O FTS
      // só gera candidatos; o veredito é o Jaccard sobre o título hidratado.
      const titleCandidateIds = await findSimilarActiveNotesByTitle(env, input.title);

      // Hidratação com o selo de privacidade do CALLER (mesmo padrão do recall):
      // candidato privado simplesmente some da lista pra credencial sem escopo.
      const seePrivate = canSeePrivate(auth);
      const hydrateIds = new Set<string>();
      for (const m of matches) if (m.score >= LINK_SUGGESTION_MIN_SCORE) hydrateIds.add(m.id);
      for (const cid of titleCandidateIds) hydrateIds.add(cid);
      const hydrated = hydrateIds.size > 0
        ? await getNotesByIds(env, Array.from(hydrateIds), seePrivate)
        : [];
      const byId = new Map(hydrated.map((r) => [r.id, r]));

      const possibleDuplicates: DuplicateCandidate[] = [];
      for (const m of matches) {
        if (m.score < DEDUP_MIN_SCORE) continue;
        const row = byId.get(m.id);
        if (!row) continue;
        possibleDuplicates.push({ id: m.id, title: row.title, tldr: row.tldr, score: m.score, reason: 'vector' });
      }
      for (const cid of titleCandidateIds) {
        if (possibleDuplicates.some((d) => d.id === cid)) continue;
        const row = byId.get(cid);
        if (!row) continue;
        if (!isNearDuplicateTitle(input.title, row.title)) continue;
        possibleDuplicates.push({ id: cid, title: row.title, tldr: row.tldr, score: null, reason: 'title' });
      }

      const linkSuggestions: LinkSuggestion[] = [];
      for (const m of matches) {
        if (m.score < LINK_SUGGESTION_MIN_SCORE || m.score >= DEDUP_MIN_SCORE) continue;
        const row = byId.get(m.id);
        if (!row) continue;
        linkSuggestions.push({ id: m.id, title: row.title, tldr: row.tldr, score: m.score });
        if (linkSuggestions.length >= 3) break;
      }

      // Log dos scores do gate (spec 71) — insumo pra re-medição das bandas
      // (0.80/0.60) quando a composição do vault mudar.
      if (matches.length > 0) {
        console.log('save_note dedup', JSON.stringify({
          id, top_scores: matches.slice(0, 5).map((m) => ({ id: m.id, score: m.score })),
        }));
      }

      await insertNote(env, {
        id,
        title: input.title,
        body: input.body,
        tldr: input.tldr,
        domains: JSON.stringify(input.domains),
        kind: input.kind,
        // Selo de privacidade (spec 31): qualquer caller com a tool registrada pode
        // CRIAR privada — marcar é barato e fail-safe (one-way).
        private: input.private ? 1 : 0,
        created_at: now,
        updated_at: now,
      }, writeActor(auth));
      // A tag reservada `dedupe:<key>` entra junto das tags do caller — é ela
      // que o gate hard consulta no próximo save com a mesma chave.
      const allTags = [...(input.tags ?? []), ...(dedupeTag ? [dedupeTag] : [])];
      if (allTags.length > 0) await insertTags(env, id, allTags);

      let edgesCreated = 0;
      if (input.edges) {
        for (const e of input.edges) {
          const inserted = await insertEdge(env, {
            id: newId(),
            from_id: id,
            to_id: e.to_id,
            relation_type: e.relation_type,
            why: e.why,
            created_at: now,
          });
          if (inserted) edgesCreated++;
        }
      }

      // Upsert vector LAST. If this fails, the note is in D1 but not queryable
      // via recall until re-embedded. get_note(id) and expand(id) still work.
      await upsertNoteVector(env, id, vec, {
        domains: input.domains,
        kind: input.kind,
        created_at: now,
      });

      // Persiste as similar edges REUSANDO os matches da consulta pré-insert —
      // zero segunda chamada ao Vectorize (spec 71). Best-effort: a nota já está
      // salva; se a consulta falhou lá em cima ou o batch falhar aqui, o re-pass
      // diário (spec 72) ou o backfill preenchem. Não falha o save_note.
      if (!vectorLookupFailed) {
        try {
          await persistSimilarEdgesFromMatches(env, id, matches);
        } catch (err) {
          console.error('save_note: persistSimilarEdges failed (note saved anyway)', err);
        }
      }

      // Menções (spec 62): vínculo first-class nota→contato. Aplicadas DEPOIS do save
      // (a nota já existe) e totalmente tolerantes a falha do contacts (applyMentions
      // engole tudo — a menção D1 já grava, o evento na timeline é eco).
      let mentionsCreated = 0;
      if (input.mentions?.length) {
        const r = await applyMentions(env, {
          noteId: id,
          title: input.title,
          url: noteUrl(env, id),
          add: input.mentions,
          seePrivate: canSeePrivate(auth),
          notePrivate: input.private === true,
        });
        mentionsCreated = r.created;
      }

      return toolSuccess({
        id,
        url: noteUrl(env, id),
        saved: { title: input.title, domains: input.domains },
        edges_created: edgesCreated,
        mentions_created: mentionsCreated,
        // Gate soft de higiene (spec 71): sempre presentes, mesmo vazios — o
        // caller deve LER (dup => comparar antes de seguir; sugestão => avaliar link()).
        possible_duplicates: possibleDuplicates,
        link_suggestions: linkSuggestions,
      });
    }) as any
  );
}
