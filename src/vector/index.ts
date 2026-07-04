import type { Env } from '../env.js';

// @cf/baai/bge-m3 returns 1024-dim vectors. Multilingual (100+ languages).
// The Vectorize index must be created with dimensions=1024.
//
// Retry strategy: Workers AI has occasional transient failures (cold start,
// edge throttle, brief rate-limit). Three attempts with 200ms / 600ms backoff
// catches ~95% of transient errors without the caller needing to know.
// Non-transient errors (budget exhausted, invalid input, model unavailable)
// fail fast after 3 attempts and propagate to safeToolHandler.
const EMBED_RETRY_DELAYS_MS = [200, 600];

export async function embed(env: Env, text: string): Promise<number[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EMBED_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await env.AI.run('@cf/baai/bge-m3', { text: [text] }) as {
        data: number[][];
      };
      const v = res.data?.[0];
      if (!v) throw new Error('embed: empty response from Workers AI');
      if (attempt > 0) {
        console.log(`embed: succeeded on retry ${attempt}/${EMBED_RETRY_DELAYS_MS.length}`);
      }
      return v;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isLast = attempt === EMBED_RETRY_DELAYS_MS.length;
      console.error(`embed: attempt ${attempt + 1} failed: ${msg}${isLast ? ' (giving up)' : ' (retrying)'}`);
      if (isLast) break;
      await new Promise((r) => setTimeout(r, EMBED_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`embed: Workers AI failed after ${EMBED_RETRY_DELAYS_MS.length + 1} attempts`);
}

export interface NoteVectorMeta {
  domains: string[];
  kind: string | null;
  created_at: number;
}

export async function upsertNoteVector(
  env: Env, id: string, values: number[], meta: NoteVectorMeta
): Promise<void> {
  await env.VECTORIZE.upsert([{
    id,
    values,
    metadata: {
      domains: meta.domains.join(','),
      kind: meta.kind ?? '',
      created_at: meta.created_at,
    },
  }]);
}

export interface VectorMatch { id: string; score: number; }

export async function queryVector(
  env: Env, values: number[], topK: number
): Promise<VectorMatch[]> {
  const res = await env.VECTORIZE.query(values, { topK, returnMetadata: 'none' });
  return (res.matches ?? []).map((m) => ({ id: m.id, score: m.score }));
}
