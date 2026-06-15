import type { Env } from '../env.js';
import { requireSession } from './session.js';

// Preferências do grafo (forças, cores, anti-sobreposição etc) salvas POR DONO na
// tabela meta — sincroniza entre máquinas (PC, notebook) sem binding novo. O grafo
// é single-owner, então uma única chave global basta.
export const GRAPH_PREFS_META_KEY = 'graph_prefs';

export interface GraphPrefs {
  forces: { center: number; repel: number; link: number; distance: number };
  colorMode: 'neutral' | 'domain' | 'kind' | 'degree';
  similarOpacity: number; // 0..1
  hideSimilar: boolean;
  nodeSizeMult: number;   // 0.3..3
  lineSizeMult: number;   // 0..3
  textFadeMult: number;   // -3..3
  hideOrphans: boolean;
  noOverlap: boolean;
}

const clampNum = (v: unknown, lo: number, hi: number, def: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.min(hi, Math.max(lo, n));
};
const asBool = (v: unknown, def = false): boolean => (typeof v === 'boolean' ? v : def);

// Sanitiza um objeto arbitrário (POST do cliente OU valor legado no meta) pro shape
// canônico, clampando cada campo nos MESMOS ranges dos sliders do graph.ts. Nunca
// confia no cliente — impede lixo/abuso inflando o meta. Retorna null se nem é objeto.
export function sanitizeGraphPrefs(raw: unknown): GraphPrefs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  const f = (r.forces && typeof r.forces === 'object') ? r.forces : {};
  const mode = ['neutral', 'domain', 'kind', 'degree'].includes(r.colorMode) ? r.colorMode : 'neutral';
  return {
    forces: {
      center: clampNum(f.center, 0, 1, 0.1),
      repel: clampNum(f.repel, 0, 20, 10),
      link: clampNum(f.link, 0, 1, 1),
      distance: clampNum(f.distance, 30, 500, 250),
    },
    colorMode: mode,
    similarOpacity: clampNum(r.similarOpacity, 0, 1, 0.18),
    hideSimilar: asBool(r.hideSimilar),
    nodeSizeMult: clampNum(r.nodeSizeMult, 0.3, 3, 1),
    lineSizeMult: clampNum(r.lineSizeMult, 0, 3, 1),
    textFadeMult: clampNum(r.textFadeMult, -3, 3, 0),
    hideOrphans: asBool(r.hideOrphans),
    noOverlap: asBool(r.noOverlap),
  };
}

// Lê as prefs salvas; null se nada salvo (aí o cliente usa os defaults dos inputs).
export async function getGraphPrefs(env: Env): Promise<GraphPrefs | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(GRAPH_PREFS_META_KEY).first<{ value: string }>();
  if (!row?.value) return null;
  try { return sanitizeGraphPrefs(JSON.parse(row.value)); } catch { return null; }
}

// POST /app/graph/prefs — salva a configuração atual como padrão do dono.
export async function handleGraphPrefsPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  let body: unknown;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const prefs = sanitizeGraphPrefs(body);
  if (!prefs) {
    return new Response(JSON.stringify({ error: 'invalid prefs' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(GRAPH_PREFS_META_KEY, JSON.stringify(prefs)).run();
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
}
