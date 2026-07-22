// Arestas de similaridade PRÉ-COMPUTADAS via Vectorize — porta da migration 0005
// + refreshSimilarEdges do Expert Brain (src/web/similarity.ts + src/db/queries.ts).
//
// ANTES: 1 query Vectorize POR NÓ no LOAD do grafo (computeSimilarityEdges, o loop)
// estourava o cap de subrequests do Cloudflare acima de ~900 nós conectados —
// reprodução exata do incidente 1102 do Brain. AGORA: cada entidade grava seus
// top-k vizinhos no WRITE PATH (save_person/save_company/save_entity/reembed/backfill)
// na tabela `similar_edges`, e o grafo só LÊ dela (getAllSimilarEdges = 1 query D1,
// zero Vectorize por load).
//
// Fonte ÚNICA dos parâmetros de similaridade — os mesmos valores usados pela escrita
// (refreshSimilarEdges) e pelo backfill produziram as edges gravadas.

import type { Env } from '../env.js';

// Aresta de similaridade normalizada pro read path do grafo (par ordenado).
export interface SimilarityEdge { source: string; target: string; score: number; }
// Linha crua da tabela similar_edges (from_id = nó dono do top-k).
export interface SimilarEdgeRow { from_id: string; to_id: string; score: number; }

// topK vizinhos por entidade, acima do score mínimo (bge-m3 cosine).
export const SIMILARITY_TOP_K = 4;
export const SIMILARITY_MIN_SCORE = 0.5;

// Corte de EXIBIÇÃO (read path: grafo + vizinhos). Histórico: subiu pra 0.65 quando
// o nome abria o embedding e sobrenome comum gerava par 0.5-0.65 sem relação real.
// Em 10/07/2026 a causa morreu (nome e boilerplate saíram do vetor — embedding.ts)
// e o corte voltou ao piso da tabela: toda aresta gravada volta a aparecer.
export const SIMILARITY_DISPLAY_MIN = 0.5;

// Chave canônica de par NÃO-DIRECIONADO (a↔b == b↔a). Usada pra dedup simétrico e
// pra descartar pares que já têm aresta explícita. Mantida do código anterior.
export function explicitPairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

// Recomputa e PERSISTE as similar edges de UMA entidade (from_id = entityId):
// consulta o Vectorize pelos top-k vizinhos do vetor e grava. 1 query Vectorize +
// 1 batch D1. Chamada no write path (após o upsert do vetor) e no backfill.
// Substitui o antigo loop O(n) do read path que estourava o cap de subrequests.
// Retorna quantos vizinhos foram gravados. Deixa o erro PROPAGAR (o caller decide
// se é fatal): o backfill conta `failed` e segue; o write path engole em try/catch.
export async function refreshSimilarEdges(
  env: Env,
  entityId: string,
  vector: number[],
  opts: { topK: number; minScore: number } = { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE },
): Promise<number> {
  if (!env.VECTORIZE) return 0;
  // +1 no topK porque o próprio nó volta como o vizinho mais próximo de si mesmo.
  const res = await env.VECTORIZE.query(vector, { topK: opts.topK + 1, returnMetadata: 'none' });
  const candidates = (res.matches ?? [])
    .filter((m) => m.id !== entityId && m.score >= opts.minScore)
    .slice(0, opts.topK)
    .map((m) => ({ to_id: m.id, score: m.score }));
  // Vizinho ÓRFÃO (vetor de entidade deletada/mesclada que ficou no índice) violava a
  // FK de similar_edges e abortava o batch inteiro — 219 entidades falharam assim no
  // backfill de 10/07/2026. Filtra contra entidades vivas e apaga o vetor órfão do
  // índice (self-healing), em vez de deixar o erro derrubar a gravação.
  let neighbors = candidates;
  if (candidates.length) {
    const ids = candidates.map((c) => c.to_id);
    const ph = ids.map(() => '?').join(',');
    const aliveRows = await env.DB.prepare(`SELECT id FROM entities WHERE id IN (${ph})`)
      .bind(...ids).all<{ id: string }>();
    const alive = new Set((aliveRows.results ?? []).map((r) => r.id));
    const orphans = ids.filter((i) => !alive.has(i));
    if (orphans.length) {
      try { await env.VECTORIZE.deleteByIds(orphans); }
      catch (e: any) { console.error('[refreshSimilarEdges] deleteByIds órfãos failed', e?.message || e); }
    }
    neighbors = candidates.filter((c) => alive.has(c.to_id));
  }
  await replaceSimilarEdges(env, entityId, neighbors);
  return neighbors.length;
}

// Substitui as similar edges de UMA entidade (from_id = fromId) pelo novo conjunto.
// DELETE + INSERTs num ÚNICO env.DB.batch (1 subrequest D1, transacional) — crítico
// pro backfill caber no cap de subrequests. `neighbors = []` só limpa as antigas.
export async function replaceSimilarEdges(
  env: Env,
  fromId: string,
  neighbors: Array<{ to_id: string; score: number }>,
): Promise<void> {
  const del = env.DB.prepare(`DELETE FROM similar_edges WHERE from_id = ?`).bind(fromId);
  if (neighbors.length === 0) {
    await del.run();
    return;
  }
  const ins = env.DB.prepare(`INSERT OR IGNORE INTO similar_edges (from_id, to_id, score) VALUES (?, ?, ?)`);
  await env.DB.batch([del, ...neighbors.map((n) => ins.bind(fromId, n.to_id, n.score))]);
}

// Lê TODAS as similar edges. O filtro por nó vivo, a dedup de pares simétricos e o
// descarte de pares já explícitos ficam no read path do grafo (assemblePayload), que
// já tem os sets de nós vivos e de pares explícitos em mãos.
export async function getAllSimilarEdges(env: Env): Promise<SimilarEdgeRow[]> {
  const r = await env.DB.prepare(
    `SELECT from_id, to_id, score FROM similar_edges`,
  ).all<SimilarEdgeRow>();
  return r.results ?? [];
}
