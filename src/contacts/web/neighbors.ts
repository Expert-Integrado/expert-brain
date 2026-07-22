// Vizinhança de 1º e 2º nível de um contato (spec 50-console-v2/56):
//   GET /app/entity/neighbors?id=<id> — sessão OU Bearer CONTACTS_PROXY_TOKEN
//   read-only (allowlist em handler.ts).
//
// SQL puro, ZERO Vectorize em runtime: similaridade lê a tabela PRÉ-COMPUTADA
// similar_edges (migration 0005, spec 10-backend/21) em vez de consultar o
// Vectorize por-nó. Se a tabela não existir ainda (spec 21 não executada), a
// leitura falha e degrada pra só conexões explícitas com similar_available=false
// — nunca quebra a resposta.
//
// 1º nível: explícitas (`connections WHERE a_id=? OR b_id=?`) + similares
// (`similar_edges WHERE from_id=?`, top-k desta entidade). 2º nível: a partir de
// até 25 sementes do 1º nível (ordenadas por strength/score desc), mesma consulta
// em lote — exclui o ego e o 1º nível, cap de 60 resultados ordenados por
// strength/score desc. Cada item de 2º nível carrega via_id/via_label (por qual
// contato de 1º nível ele foi alcançado); se um candidato for alcançável por mais
// de uma semente, fica só a ocorrência de maior força (dedupe por id).

import type { Env } from '../env.js';
import { callerSeesPrivate } from './privacy.js';
import { SIMILARITY_DISPLAY_MIN } from './similarity.js';

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...init?.headers,
    },
  });

const LEVEL1_SEED_CAP = 25;
const LEVEL2_TOTAL_CAP = 60;

interface EntityRow { id: string; name: string; kind: string; }
interface ConnRow { id: string; a_id: string; b_id: string; type: string; strength: number; why: string; }
interface SimilarRow { from_id: string; to_id: string; score: number; }

export interface NeighborItem {
  id: string;
  label: string;
  kind: string;
  edge: 'explicit' | 'similar';
  rel?: string;
  why?: string;
  strength?: number;
  score?: number;
}
export interface NeighborLevel2Item extends NeighborItem {
  via_id: string;
  via_label: string;
}

// Resolve name/kind pra um lote de ids, chunked em 100 (mesmo padrão de
// loadConnectionsBetween em src/vaults/contacts.ts) — D1 tem teto de placeholders
// por statement.
async function resolveEntities(env: Env, ids: string[], includePrivate: boolean): Promise<Map<string, EntityRow>> {
  const map = new Map<string, EntityRow>();
  if (ids.length === 0) return map;
  // Privacidade (spec 61): vizinho privado sai do mapa quando o caller não vê
  // privados → o loop de montagem faz `if (!other) continue` e o dropa (não vira
  // vizinho de 1º/2º nível nem serve de `via`).
  const priv = includePrivate ? '' : ' AND private = 0';
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT id, name, kind FROM entities WHERE id IN (${ph})${priv}`,
    ).bind(...chunk).all<EntityRow>();
    for (const row of r.results ?? []) map.set(row.id, row);
  }
  return map;
}

const strengthOf = (n: { strength?: number; score?: number }): number => n.strength ?? n.score ?? 0;

export async function handleEntityNeighbors(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) return json({ ok: false, error: 'id_required' }, { status: 400 });

  // Privacidade (spec 61): ego privado → 404 pra quem não vê privados (não vazar
  // existência); vizinhos privados de 1º/2º nível somem via resolveEntities.
  const includePrivate = await callerSeesPrivate(req, env);
  const ego = await env.DB.prepare('SELECT id, name, kind, private FROM entities WHERE id = ?')
    .bind(id).first<EntityRow & { private: number }>();
  if (!ego || (!includePrivate && ego.private === 1)) {
    return json({ ok: false, error: 'entity_not_found', id }, { status: 404 });
  }

  // --- 1º nível: explícitas ---
  const explicitRows = (
    await env.DB.prepare(
      `SELECT id, a_id, b_id, type, strength, why FROM connections WHERE a_id = ? OR b_id = ?`,
    ).bind(id, id).all<ConnRow>()
  ).results ?? [];

  // --- 1º nível: similares (from_id=? — top-k pré-computado desta entidade) ---
  let similarAvailable = true;
  let similarRows: SimilarRow[] = [];
  try {
    // Corte de exibição (SIMILARITY_DISPLAY_MIN): mesmo racional do grafo —
    // par fraco (tipicamente sobrenome comum) fica na tabela, fora dos vínculos.
    const r = await env.DB.prepare(
      `SELECT from_id, to_id, score FROM similar_edges WHERE from_id = ? AND score >= ?`,
    ).bind(id, SIMILARITY_DISPLAY_MIN).all<SimilarRow>();
    similarRows = r.results ?? [];
  } catch (e: any) {
    // Tabela ainda não existe (spec 21 não executada) — degrada, não quebra.
    similarAvailable = false;
    console.warn('[contacts.neighbors] similar_edges indisponível (1o nivel)', e?.message || e);
  }

  const level1OtherIds = new Set<string>();
  for (const c of explicitRows) level1OtherIds.add(c.a_id === id ? c.b_id : c.a_id);
  for (const s of similarRows) level1OtherIds.add(s.to_id);

  const level1Entities = await resolveEntities(env, [...level1OtherIds], includePrivate);

  const level1: NeighborItem[] = [];
  for (const c of explicitRows) {
    const otherId = c.a_id === id ? c.b_id : c.a_id;
    const other = level1Entities.get(otherId);
    if (!other) continue; // extremo órfão (entidade removida) — não aparece
    level1.push({ id: otherId, label: other.name, kind: other.kind, edge: 'explicit', rel: c.type, why: c.why, strength: c.strength });
  }
  for (const s of similarRows) {
    const other = level1Entities.get(s.to_id);
    if (!other) continue;
    level1.push({ id: s.to_id, label: other.name, kind: other.kind, edge: 'similar', score: s.score });
  }
  level1.sort((a, b) => strengthOf(b) - strengthOf(a));

  // --- 2º nível: a partir de até LEVEL1_SEED_CAP sementes do 1º nível ---
  const seedIds = level1.slice(0, LEVEL1_SEED_CAP).map((n) => n.id);
  const excludeSet = new Set<string>([id, ...level1OtherIds]);
  const viaLabelOf = new Map(level1.map((n) => [n.id, n.label]));

  const level2Map = new Map<string, NeighborLevel2Item>();
  if (seedIds.length > 0) {
    const ph = seedIds.map(() => '?').join(',');
    const explicit2 = (
      await env.DB.prepare(
        `SELECT id, a_id, b_id, type, strength, why FROM connections WHERE a_id IN (${ph}) OR b_id IN (${ph})`,
      ).bind(...seedIds, ...seedIds).all<ConnRow>()
    ).results ?? [];

    let similar2: SimilarRow[] = [];
    if (similarAvailable) {
      try {
        const r2 = await env.DB.prepare(
          `SELECT from_id, to_id, score FROM similar_edges WHERE from_id IN (${ph}) AND score >= ?`,
        ).bind(...seedIds, SIMILARITY_DISPLAY_MIN).all<SimilarRow>();
        similar2 = r2.results ?? [];
      } catch (e: any) {
        similarAvailable = false;
        console.warn('[contacts.neighbors] similar_edges indisponível (2o nivel)', e?.message || e);
      }
    }

    const candidateIds = new Set<string>();
    for (const c of explicit2) {
      if (seedIds.includes(c.a_id)) candidateIds.add(c.b_id);
      if (seedIds.includes(c.b_id)) candidateIds.add(c.a_id);
    }
    for (const s of similar2) candidateIds.add(s.to_id);
    for (const ex of excludeSet) candidateIds.delete(ex);

    const level2Entities = await resolveEntities(env, [...candidateIds], includePrivate);

    const upsert = (item: NeighborLevel2Item) => {
      const cur = level2Map.get(item.id);
      if (!cur || strengthOf(item) > strengthOf(cur)) level2Map.set(item.id, item);
    };

    for (const c of explicit2) {
      for (const seedId of [c.a_id, c.b_id]) {
        if (!seedIds.includes(seedId)) continue;
        const candidateId = c.a_id === seedId ? c.b_id : c.a_id;
        if (candidateId === seedId || excludeSet.has(candidateId)) continue;
        const other = level2Entities.get(candidateId);
        if (!other) continue;
        upsert({
          id: candidateId, label: other.name, kind: other.kind, edge: 'explicit',
          rel: c.type, why: c.why, strength: c.strength,
          via_id: seedId, via_label: viaLabelOf.get(seedId) ?? seedId,
        });
      }
    }
    for (const s of similar2) {
      if (excludeSet.has(s.to_id)) continue;
      const other = level2Entities.get(s.to_id);
      if (!other) continue;
      upsert({
        id: s.to_id, label: other.name, kind: other.kind, edge: 'similar', score: s.score,
        via_id: s.from_id, via_label: viaLabelOf.get(s.from_id) ?? s.from_id,
      });
    }
  }

  const level2 = [...level2Map.values()]
    .sort((a, b) => strengthOf(b) - strengthOf(a))
    .slice(0, LEVEL2_TOTAL_CAP);

  return json({
    ok: true,
    ego: { id: ego.id, label: ego.name, kind: ego.kind },
    level1,
    level2,
    similar_available: similarAvailable,
  });
}
