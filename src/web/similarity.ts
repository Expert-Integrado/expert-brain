import type { Env } from '../env.js';
import { queryVector } from '../vector/index.js';
import { replaceSimilarEdges } from '../db/queries.js';

// Parâmetros da similaridade — fonte única, usada tanto pela escrita
// (refreshSimilarEdges, backfill) quanto pela leitura indireta (mesmos valores
// que produziram as edges gravadas). topK vizinhos por nota, acima do score min.
export const SIMILARITY_TOP_K = 4;
export const SIMILARITY_MIN_SCORE = 0.5;

// Recomputa e PERSISTE as similar edges de uma única nota: consulta o Vectorize
// pelos top-k vizinhos do vetor e grava (from_id = noteId). 1 query Vectorize +
// 1 batch D1. Chamado no write path (save_note/update_note/reembed) e no backfill.
// Substitui o antigo loop O(n) que rodava no carregamento do grafo e estourava o
// cap de subrequests do Cloudflare além de ~950 notas. Retorna quantos vizinhos
// foram gravados.
export async function refreshSimilarEdges(
  env: Env, noteId: string, vector: number[],
  opts: { topK: number; minScore: number } = { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE }
): Promise<number> {
  const matches = await queryVector(env, vector, opts.topK + 1); // +1 pro próprio nó
  const neighbors = matches
    .filter((m) => m.id !== noteId && m.score >= opts.minScore)
    .slice(0, opts.topK)
    .map((m) => ({ to_id: m.id, score: m.score }));
  await replaceSimilarEdges(env, noteId, neighbors);
  return neighbors.length;
}

export function explicitPairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}
