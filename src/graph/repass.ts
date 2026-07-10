import type { Env } from '../env.js';
import { refreshSimilarEdges } from '../web/similarity.js';

// Re-pass diário das similar_edges (specs/70-grafo-higiene/72): as edges de uma
// nota são computadas no write path contra um índice que, em import em lote,
// ainda não tinha as irmãs (Vectorize é eventual-consistent) — e o write path é
// best-effort (falha deixa a nota órfã de vizinhança). Este cron re-consulta as
// notas tocadas nas últimas 48h e regrava os vizinhos.
//
// REGRA DE DEPLOY: a expressão abaixo TEM que existir em [triggers].crons do
// wrangler.toml NO MESMO deploy deste braço — o fail-safe do runScheduled manda
// expressão desconhecida pro fluxo diário (digest de tasks dispararia 2x/dia).
export const REPASS_CRON = '0 8 * * *'; // 08:00 UTC = 05:00 BRT, antes do digest

const WINDOW_MS = 48 * 3_600_000;
// Cap por invocação: cada nota custa ~2 subrequests (getByIds amortizado em
// lotes de 20 + 1 query Vectorize + 1 batch D1) — folga ampla no teto de 1000
// do scheduled. Janela maior que o cap NÃO perde nota: a watermark só avança
// quando a janela fecha inteira, e o zero-edges-primeiro garante progresso.
const DEFAULT_LIMIT = 40;
const GETBYIDS_BATCH = 20; // mesmo teto do backfill (src/auth/setup.ts)
const WATERMARK_KEY = 'repass:watermark';

export interface RepassResult {
  scanned: number;
  refreshed: number;
  no_vector: number;
  failed: number;
  completed: boolean;
}

export async function runSimilarRepass(
  env: Env, nowMs: number, opts: { limit?: number } = {}
): Promise<RepassResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // Janela [max(now-48h, watermark), now] — a watermark evita re-varrer o que a
  // invocação anterior já fechou. KV transiente nunca derruba o re-pass.
  let windowStart = nowMs - WINDOW_MS;
  try {
    const wm = await env.GRAPH_CACHE.get(WATERMARK_KEY);
    if (wm) windowStart = Math.max(windowStart, Number(wm));
  } catch (err) {
    console.error('similar-repass: leitura da watermark falhou (janela cheia)', err);
  }

  // Notas de CONHECIMENTO vivas tocadas na janela. Ordenação: quem tem ZERO
  // linhas em similar_edges primeiro (é quem mais precisa), depois a mais
  // antiga — sob cap, quem foi refeito ganha linhas e sai da frente da fila.
  const rows = await env.DB.prepare(
    `SELECT n.id,
            EXISTS (SELECT 1 FROM similar_edges s WHERE s.from_id = n.id) AS has_edges
     FROM notes n
     WHERE n.deleted_at IS NULL
       AND (n.kind IS NULL OR n.kind <> 'task')
       AND n.updated_at >= ? AND n.updated_at <= ?
     ORDER BY has_edges ASC, n.updated_at ASC`
  ).bind(windowStart, nowMs).all<{ id: string; has_edges: number }>();
  const pending = (rows.results ?? []).map((r) => r.id);
  const batch = pending.slice(0, limit);
  const completed = pending.length <= limit;

  const result: RepassResult = {
    scanned: batch.length, refreshed: 0, no_vector: 0, failed: 0, completed,
  };

  // Vetores direto do índice (getByIds) — NUNCA re-embedar: Workers AI custa e
  // o vetor já existe. Nota sem vetor conta em no_vector e fica pro reembed
  // manual (caso a caso).
  const vectors = new Map<string, number[]>();
  for (let i = 0; i < batch.length; i += GETBYIDS_BATCH) {
    const got = await env.VECTORIZE.getByIds(batch.slice(i, i + GETBYIDS_BATCH));
    for (const v of got ?? []) vectors.set(v.id, Array.from(v.values as number[]));
  }

  for (const id of batch) {
    const vec = vectors.get(id);
    if (!vec) {
      result.no_vector++;
      continue;
    }
    try {
      await refreshSimilarEdges(env, id, vec);
      result.refreshed++;
    } catch (err) {
      // Falha de UMA nota não trava as demais — ela volta na próxima invocação
      // (a watermark não avança em run incompleto de janela, e zero-edges-first
      // a mantém priorizada se continuar órfã).
      result.failed++;
      console.error(`similar-repass: nota ${id} falhou (run segue)`, err);
    }
  }

  if (completed) {
    try {
      await env.GRAPH_CACHE.put(WATERMARK_KEY, String(nowMs));
    } catch (err) {
      console.error('similar-repass: escrita da watermark falhou (próximo run re-varre)', err);
    }
  }
  return result;
}
