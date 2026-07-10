import type { Env } from '../env.js';
import { queryVector, type VectorMatch } from '../vector/index.js';
import { replaceSimilarEdges } from '../db/queries.js';

// Parâmetros da similaridade — fonte única, usada tanto pela escrita
// (refreshSimilarEdges, backfill) quanto pela leitura indireta (mesmos valores
// que produziram as edges gravadas). topK vizinhos por nota, acima do score min.
export const SIMILARITY_TOP_K = 4;
export const SIMILARITY_MIN_SCORE = 0.5;

// Bandas do gate de higiene (specs/70-grafo-higiene/71, nota z6trwoy1aqk6):
// >= 0.80 = possível DUPLICATA (gate SOFT — informa, nunca bloqueia; dups reais
// medidas em 0.80-0.85 e vizinhas legítimas em 0.75-0.80, margem estreita demais
// pra hard-block); 0.60-0.79 = candidata a LINK. Também consumidas pelo digest
// de higiene (spec 73) — mudar aqui muda o gate e o radar juntos, de propósito.
export const DEDUP_MIN_SCORE = 0.8;
export const LINK_SUGGESTION_MIN_SCORE = 0.6;

// Persiste as similar edges de uma nota a partir de matches JÁ consultados —
// permite ao save_note alimentar dedup, sugestões e edges com UMA consulta ao
// Vectorize (spec 71). Filtra self e score < min, corta em topK. Retorna quantos
// vizinhos foram gravados.
export async function persistSimilarEdgesFromMatches(
  env: Env, noteId: string, matches: VectorMatch[],
  opts: { topK: number; minScore: number } = { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE }
): Promise<number> {
  const neighbors = matches
    .filter((m) => m.id !== noteId && m.score >= opts.minScore)
    .slice(0, opts.topK)
    .map((m) => ({ to_id: m.id, score: m.score }));
  await replaceSimilarEdges(env, noteId, neighbors);
  return neighbors.length;
}

// Recomputa e PERSISTE as similar edges de uma única nota: consulta o Vectorize
// pelos top-k vizinhos do vetor e grava (from_id = noteId). 1 query Vectorize +
// 1 batch D1. Chamado no write path (update_note/reembed) e no backfill/re-pass.
// Substitui o antigo loop O(n) que rodava no carregamento do grafo e estourava o
// cap de subrequests do Cloudflare além de ~950 notas. Retorna quantos vizinhos
// foram gravados.
export async function refreshSimilarEdges(
  env: Env, noteId: string, vector: number[],
  opts: { topK: number; minScore: number } = { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE }
): Promise<number> {
  const matches = await queryVector(env, vector, opts.topK + 1); // +1 pro próprio nó
  return persistSimilarEdgesFromMatches(env, noteId, matches, opts);
}

export function explicitPairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

// "Quase idêntico" de título (spec 71): Jaccard >= 0.8 sobre os token-sets
// normalizados. O FTS (OR de prefixos) só GERA candidatos — é largo demais como
// veredito ("nota*" casa com qualquer título contendo "nota"); este corte em JS
// é quem decide. Rodar sobre o título HIDRATADO (pós-filtro de privacidade).
export function isNearDuplicateTitle(a: string, b: string): boolean {
  const ta = titleTokenSet(a);
  const tb = titleTokenSet(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return inter / union >= 0.8;
}

function titleTokenSet(s: string): Set<string> {
  return new Set(
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
}
