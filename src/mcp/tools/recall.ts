import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl, canSeePrivate } from '../helpers.js';
import { ftsSearch, getNotesByIds, NON_TASK_FILTER, PUBLIC_ONLY_FILTER, type NoteRow } from '../../db/queries.js';
import { validateDomains } from '../../db/validation.js';
import { embed, queryVector } from '../../vector/index.js';

const inputSchema = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(30).optional().default(15),
  offset: z.number().int().min(0).optional().default(0),
  domains_filter: z.array(z.string()).optional(),
};

const DESCRIPTION = `Hybrid cross-domain search in the vault (vector + FTS).

Returns up to \`limit\` results balanced by domain (at most 3 per domain, up to 5 distinct domains).
Returns only {id, title, domain, kind, tldr} — NEVER the body. To read the body, call get_note(id).

Query in any language — the embedding model is multilingual and matches across languages. A Portuguese query can surface English notes and vice versa.

QUERY STYLE: prefer the literal vocabulary of the note's domain over metaphorical paraphrases. Embeddings activate on semantic proximity to domain terms, not on figurative reinterpretation — "compound interest software" will find a note that an abstract metaphor like "compounding running to stand still" misses. If a first query returns empty, reformulate with domain-literal terms before concluding the note doesn't exist.

IMPORTANT: read ALL returned domains before answering. The valuable match often comes from the unexpected domain — that is exactly what the vault is for. If domains_filter is provided, all entries must be canonical English slugs (same rules as save_note.domains).

DOMAINS_FILTER SEMANTICS: the filter does TWO things — (a) restricts results to notes that contain at least one of the listed domains (matches on any domain in the note, not just the primary) AND (b) pulls every note in those domains into the pool even if they didn't match the query semantically. So recall("anything", domains_filter=["X"]) returns "notes in domain X, ordered by relevance to the query, with semantic matches ranked above domain-only matches". Use this when the user asks "show me everything I have on X".

WHEN domains_filter IS SET, the cross-domain balancing is TURNED OFF (you already scoped the search explicitly): results come strictly ordered by relevance (semantic matches > keyword matches > domain-only matches by recency) and \`limit\` is respected in full — no 3-per-domain / 5-domain cap. To enumerate a whole domain, paginate with \`offset\`: call limit=30, offset=0, then offset=30, then offset=60, until a page returns fewer than \`limit\` results. Up to 200 notes per domain are reachable this way. WITHOUT a filter, the exploratory balancing applies (at most 3 per domain, up to 5 distinct domains, ~15 results) and \`offset\` slices the balanced result.

SCORE (spec 71/74): each result carries \`score\` — the RAW cosine similarity from the vector index (bge-m3), NOT a calibrated probability. Reference bands: >= 0.80 near-duplicate territory (if you are about to save_note something like it, STOP and read that note first), 0.60-0.79 related (link candidate), < 0.60 weak. \`score: null\` means the note entered the results via keyword (FTS) or domain retrieval only — no vector metric available; null is honest, do not invent one.

INDEXING LATENCY: Cloudflare Vectorize is eventually consistent — a note saved via save_note can take up to ~1-2 minutes to become queryable via recall. If a user asks you to find a concept they JUST saved and the recall returns empty, that is probably indexing delay, NOT a missing note. Do NOT tell the user the vault is broken. Either (a) wait and retry, (b) use get_note on the id returned by save_note if you still have it, or (c) explain the delay and ask the user to try again in a minute. FTS5 search is strongly consistent and returns results immediately, so a recall that matches by keyword often still surfaces fresh notes even when the vector side is still indexing.`;

interface RecallHit {
  id: string; title: string; domain: string; kind: string | null; tldr: string;
  // Full list of domains on the note, used for filter matching. The `domain`
  // field above is still the primary (domains[0]) — kept for the balancing
  // logic and the external response shape. `allDomains` is only for filtering.
  allDomains: string[];
}

interface RecallInput { query: string; limit?: number; offset?: number; domains_filter?: string[]; }

export function registerRecall(server: any, env: Env, auth?: AuthContext): void {
  // Selo de privacidade (spec 31): quem não pode ver privadas recebe o filtro em TODAS
  // as 3 fontes do pool (retrieval por domínio, FTS e hidratação D1). O Vectorize pode
  // devolver ids privados — eles caem na hidratação (getNotesByIds), nunca no resultado.
  const seePrivate = canSeePrivate(auth);
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
      const offset = input.offset ?? 0;
      const vec = await embed(env, input.query);
      const [vectorMatches, ftsRows] = await Promise.all([
        queryVector(env, vec, 30),
        ftsSearch(env, input.query, 30, false, seePrivate),
      ]);

      const ids = new Set<string>();
      // Score por id (spec 74): cosseno cru do Vectorize. Id repetido no top-30
      // fica com o MAIOR score. Quem entra no pool só via FTS/domínio não tem
      // métrica vetorial — sai como null no shape final.
      const scoreById = new Map<string, number>();
      for (const m of vectorMatches) {
        ids.add(m.id);
        const prev = scoreById.get(m.id);
        if (prev === undefined || m.score > prev) scoreById.set(m.id, m.score);
      }
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
          // NON_TASK_FILTER exclui kind='task' — sem ele, tasks (que têm domains)
          // vazariam pro pool via este retrieval e sobreviveriam até o resultado
          // (o filtro em memória filtra por domínio, não por kind). LIMIT 200 é o
          // teto real de enumeração de um domínio via offset; o chunking da
          // hidratação (getNotesByIds) absorve o pool maior.
          // Selo de privacidade (spec 31): sem escopo, o pool por domínio também
          // exclui privadas (senão a nota privada entraria via retrieval de domínio).
          `SELECT DISTINCT n.id
           FROM notes n, json_each(n.domains) je
           WHERE je.value IN (${dfPlaceholders}) AND n.deleted_at IS NULL
             AND ${NON_TASK_FILTER}${seePrivate ? '' : ` AND n.${PUBLIC_ONLY_FILTER}`}
           ORDER BY n.updated_at DESC
           LIMIT 200`
        ).bind(...input.domains_filter).all<{ id: string }>();
        for (const r of domainRows.results ?? []) {
          domainFilterIds.push(r.id);
          ids.add(r.id);
        }
      }

      if (ids.size === 0) return toolSuccess({ results: [] });

      // Hidratação chunkada em lotes de 100 (getNotesByIds) — o pool pode chegar a
      // 30 (vetor) + 30 (FTS) + 200 (domain retrieval) = até 260 ids únicos, bem
      // acima do cap de ~100 binds por statement do D1 (que faria a query estourar
      // em runtime com "too many SQL variables"). getNotesByIds também aplica o
      // NON_TASK_FILTER — defesa em profundidade contra qualquer id de task no pool.
      const hydrated = await getNotesByIds(env, Array.from(ids), seePrivate);

      const byId = new Map<string, RecallHit>();
      for (const r of hydrated) {
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

      let picked: RecallHit[];
      if (input.domains_filter?.length) {
        // COM filtro explícito, o usuário já escopou a busca — desligamos o
        // balanceador cross-domain (que capava em ~3 primárias/domínio + 5
        // domínios) e servimos o pool ordenado por relevância, respeitando
        // limit+offset integralmente. É isso que habilita enumerar um domínio
        // inteiro paginando (offset=0, offset=limit, ...).
        picked = pool.slice(offset, offset + limit);
      } else {
        // SEM filtro: balanceador cross-domain exploratório INALTERADO (máx 3 por
        // domínio primário, 5 domínios distintos), depois um slice(offset) por
        // cima pra semântica uniforme de paginação.
        const perDomain = new Map<string, number>();
        const distinctDomains = new Set<string>();
        const balanced: RecallHit[] = [];
        for (const h of pool) {
          const count = perDomain.get(h.domain) ?? 0;
          if (count >= 3) continue;
          if (!distinctDomains.has(h.domain) && distinctDomains.size >= 5) continue;
          perDomain.set(h.domain, count + 1);
          distinctDomains.add(h.domain);
          balanced.push(h);
          if (balanced.length >= offset + limit) break;
        }
        picked = balanced.slice(offset, offset + limit);
      }

      // Strip allDomains before returning — it's only used internally for
      // filter matching. External shape is {id, title, domain, kind, tldr, url,
      // score} (url is a clickable link to the note, like save_note returns;
      // score é o cosseno do vetor, null pra hit só de FTS/domínio — spec 74).
      const results = picked.map(({ allDomains: _drop, ...rest }) => ({
        ...rest,
        url: noteUrl(env, rest.id),
        score: scoreById.get(rest.id) ?? null,
      }));
      return toolSuccess({ results });
    }) as any
  );
}
