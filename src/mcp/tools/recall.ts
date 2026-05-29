import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl } from '../helpers.js';
import { ftsSearch, type NoteRow } from '../../db/queries.js';
import { validateDomains } from '../../db/validation.js';
import { embed, queryVector } from '../../vector/index.js';

const inputSchema = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(30).optional().default(15),
  domains_filter: z.array(z.string()).optional(),
};

const DESCRIPTION = `Hybrid cross-domain search in the vault (vector + FTS).

Returns up to \`limit\` results balanced by domain (at most 3 per domain, up to 5 distinct domains).
Returns only {id, title, domain, kind, tldr} — NEVER the body. To read the body, call get_note(id).

Query in any language — the embedding model is multilingual and matches across languages. A Portuguese query can surface English notes and vice versa.

QUERY STYLE: prefer the literal vocabulary of the note's domain over metaphorical paraphrases. Embeddings activate on semantic proximity to domain terms, not on figurative reinterpretation — "compound interest software" will find a note that an abstract metaphor like "compounding running to stand still" misses. If a first query returns empty, reformulate with domain-literal terms before concluding the note doesn't exist.

IMPORTANT: read ALL returned domains before answering. The valuable match often comes from the unexpected domain — that is exactly what the vault is for. If domains_filter is provided, all entries must be canonical English slugs (same rules as save_note.domains).

DOMAINS_FILTER SEMANTICS: the filter does TWO things — (a) restricts results to notes that contain at least one of the listed domains (matches on any domain in the note, not just the primary) AND (b) pulls every note in those domains into the pool even if they didn't match the query semantically. So recall("anything", domains_filter=["X"]) returns "notes in domain X, ordered by relevance to the query, with semantic matches ranked above domain-only matches". Use this when the user asks "show me everything I have on X".

INDEXING LATENCY: Cloudflare Vectorize is eventually consistent — a note saved via save_note can take up to ~1-2 minutes to become queryable via recall. If a user asks you to find a concept they JUST saved and the recall returns empty, that is probably indexing delay, NOT a missing note. Do NOT tell the user the vault is broken. Either (a) wait and retry, (b) use get_note on the id returned by save_note if you still have it, or (c) explain the delay and ask the user to try again in a minute. FTS5 search is strongly consistent and returns results immediately, so a recall that matches by keyword often still surfaces fresh notes even when the vector side is still indexing.`;

interface RecallHit {
  id: string; title: string; domain: string; kind: string | null; tldr: string;
  // Full list of domains on the note, used for filter matching. The `domain`
  // field above is still the primary (domains[0]) — kept for the balancing
  // logic and the external response shape. `allDomains` is only for filtering.
  allDomains: string[];
}

interface RecallInput { query: string; limit?: number; domains_filter?: string[]; }

export function registerRecall(server: any, env: Env): void {
  server.registerTool(
    'recall',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Cross-domain recall',
        readOnlyHint: true, destructiveHint: false, openWorldHint: false,
      },
    },
    safeToolHandler(async (input: RecallInput) => {
      if (input.domains_filter && input.domains_filter.length > 0) {
        const err = validateDomains(input.domains_filter);
        if (err) return toolError(err);
      }

      const limit = input.limit ?? 15;
      const vec = await embed(env, input.query);
      const [vectorMatches, ftsRows] = await Promise.all([
        queryVector(env, vec, 30),
        ftsSearch(env, input.query, 30),
      ]);

      const ids = new Set<string>();
      for (const m of vectorMatches) ids.add(m.id);
      for (const r of ftsRows) ids.add(r.id);

      // When a domain filter is set, also pull every note in those domains.
      // Without this, a query like recall("feedback loop", filter=["evolutionary-biology"])
      // returns [] whenever the evo-bio notes fall outside the top-30 semantic
      // window — the filter can only drop, never add. Union-ing the two pools
      // means domain-scoped queries always surface the domain contents.
      const domainFilterIds: string[] = [];
      if (input.domains_filter?.length) {
        const dfPlaceholders = input.domains_filter.map(() => '?').join(',');
        const domainRows = await env.DB.prepare(
          `SELECT DISTINCT n.id
           FROM notes n, json_each(n.domains) je
           WHERE je.value IN (${dfPlaceholders}) AND n.deleted_at IS NULL
           ORDER BY n.updated_at DESC
           LIMIT 50`
        ).bind(...input.domains_filter).all<{ id: string }>();
        for (const r of domainRows.results ?? []) {
          domainFilterIds.push(r.id);
          ids.add(r.id);
        }
      }

      if (ids.size === 0) return toolSuccess({ results: [] });

      const placeholders = Array.from(ids).map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT id, title, tldr, domains, kind FROM notes WHERE id IN (${placeholders}) AND deleted_at IS NULL`
      ).bind(...Array.from(ids)).all<Pick<NoteRow,'id'|'title'|'tldr'|'domains'|'kind'>>();

      const byId = new Map<string, RecallHit>();
      for (const r of rows.results ?? []) {
        const domains: string[] = JSON.parse(r.domains);
        byId.set(r.id, {
          id: r.id, title: r.title, tldr: r.tldr, kind: r.kind,
          domain: domains[0] ?? 'unknown',
          allDomains: domains,
        });
      }

      const vectorOrder = vectorMatches.map((m) => m.id).filter((id) => byId.has(id));
      const ftsOrder = ftsRows.map((r) => r.id).filter((id) => byId.has(id) && !vectorOrder.includes(id));
      // Domain-filter-injected ids go LAST so that actual semantic/keyword
      // matches stay prioritized in the final ordering; domain-retrieval
      // notes only surface after the relevant ones run out.
      const already = new Set<string>([...vectorOrder, ...ftsOrder]);
      const domainOnlyOrder = domainFilterIds.filter((id) => byId.has(id) && !already.has(id));
      const merged = [...vectorOrder, ...ftsOrder, ...domainOnlyOrder];

      let pool: RecallHit[] = merged.map((id) => byId.get(id)!).filter(Boolean);
      if (input.domains_filter?.length) {
        // Match on ANY domain in the note, not just the primary. A note with
        // domains: ["systems-thinking", "evolutionary-biology"] should pass the
        // filter ["evolutionary-biology"] even though it's not the primary —
        // otherwise asking "show me everything in X" misses notes that were
        // tagged with X as a secondary domain.
        const allow = new Set(input.domains_filter);
        pool = pool.filter((h) => h.allDomains.some((d) => allow.has(d)));
      }

      const perDomain = new Map<string, number>();
      const distinctDomains = new Set<string>();
      const picked: RecallHit[] = [];
      for (const h of pool) {
        const count = perDomain.get(h.domain) ?? 0;
        if (count >= 3) continue;
        if (!distinctDomains.has(h.domain) && distinctDomains.size >= 5) continue;
        perDomain.set(h.domain, count + 1);
        distinctDomains.add(h.domain);
        picked.push(h);
        if (picked.length >= limit) break;
      }

      // Strip allDomains before returning — it's only used internally for
      // filter matching. External response shape stays {id, title, domain, kind, tldr}.
      const results = picked.map(({ allDomains: _drop, ...rest }) => ({
        ...rest,
        url: noteUrl(env, rest.id),
      }));
      return toolSuccess({ results });
    }) as any
  );
}
