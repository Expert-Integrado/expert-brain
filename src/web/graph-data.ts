import type { Env } from '../env.js';
import type { NoteRow, EdgeRow } from '../db/queries.js';
import { requireSession } from './session.js';
import { computeLayout, type LayoutEdge, type LayoutNode } from './layout.js';
import { computeSimilarityEdges, explicitPairKey } from './similarity.js';

interface GraphNode { id: string; label: string; domain: string; size: number; x: number; y: number; }
interface ExplicitGraphEdge { id: string; source: string; target: string; type: 'explicit'; why: string; relation_type: string; }
interface SimilarGraphEdge { id: string; source: string; target: string; type: 'similar'; score: number; }
type GraphEdge = ExplicitGraphEdge | SimilarGraphEdge;

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  computedAt: number;
  sourceHash: string;
}

const CACHE_KEY = 'graph:v4'; // A.8 size: sqrt(degree)
const SIMILARITY_TOP_K = 4;
const SIMILARITY_MIN_SCORE = 0.5;

async function computeSourceHash(env: Env): Promise<string> {
  const n = await env.DB.prepare(`SELECT COALESCE(MAX(updated_at), 0) m, COUNT(*) c FROM notes`).first<{ m: number; c: number }>();
  const e = await env.DB.prepare(`SELECT COALESCE(MAX(created_at), 0) m, COUNT(*) c FROM edges`).first<{ m: number; c: number }>();
  return `n${n?.m ?? 0}x${n?.c ?? 0}_e${e?.m ?? 0}x${e?.c ?? 0}`;
}

// Domains are stored as a JSON-encoded string array. Parse and pick the first
// entry for node coloring; fall back to CSV split for legacy rows.
function firstDomain(raw: string): string {
  if (!raw) return 'misc';
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length > 0) return String(arr[0]).trim() || 'misc';
    } catch { /* fall through */ }
  }
  const first = trimmed.split(',')[0]?.trim();
  return first || 'misc';
}

async function buildPayload(env: Env): Promise<GraphPayload> {
  const notesRes = await env.DB.prepare(`SELECT id, title, domains FROM notes`).all<Pick<NoteRow, 'id' | 'title' | 'domains'>>();
  const notes = notesRes.results ?? [];

  const edgesRes = await env.DB.prepare(`SELECT id, from_id, to_id, relation_type, why, created_at FROM edges`).all<EdgeRow>();
  const explicitEdges = edgesRes.results ?? [];

  const explicitPairs = new Set<string>();
  for (const e of explicitEdges) explicitPairs.add(explicitPairKey(e.from_id, e.to_id));

  // Fetch vectors for all notes from Vectorize (by id). Vectorize exposes getByIds.
  // In the test environment Vectorize may not be populated — tolerate that gracefully.
  let noteVectors: Array<{ id: string; values: number[] }> = [];
  if (notes.length > 0) {
    const ids = notes.map((n) => n.id);
    try {
      // Cloudflare Vectorize caps getByIds at 20 ids per call (error 40007).
      for (let i = 0; i < ids.length; i += 20) {
        const chunk = ids.slice(i, i + 20);
        const res = await env.VECTORIZE.getByIds(chunk);
        for (const v of res) {
          if (v.values) noteVectors.push({ id: v.id, values: Array.from(v.values) });
        }
      }
    } catch (err) {
      console.error('graph-data: Vectorize.getByIds failed', err);
      noteVectors = [];
    }
    console.log(`graph-data: fetched ${noteVectors.length} vectors for ${notes.length} notes`);
  }

  let similarityEdges: Array<{ source: string; target: string; score: number }> = [];
  try {
    similarityEdges = await computeSimilarityEdges(env, noteVectors, explicitPairs, {
      topK: SIMILARITY_TOP_K,
      minScore: SIMILARITY_MIN_SCORE,
    });
  } catch (err) {
    console.error('graph-data: computeSimilarityEdges failed', err);
    similarityEdges = [];
  }

  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const e of explicitEdges) { bump(e.from_id); bump(e.to_id); }
  for (const e of similarityEdges) { bump(e.source); bump(e.target); }

  const layoutNodes: LayoutNode[] = notes.map((n) => ({ id: n.id }));
  const layoutEdges: LayoutEdge[] = [
    ...explicitEdges.map((e) => ({ source: e.from_id, target: e.to_id })),
    ...similarityEdges.map((e) => ({ source: e.source, target: e.target })),
  ];
  const laidOut = computeLayout(layoutNodes, layoutEdges);
  const pos = new Map(laidOut.map((n) => [n.id, n]));

  const nodes: GraphNode[] = notes.map((n) => {
    const p = pos.get(n.id) ?? { x: 0, y: 0 };
    return {
      id: n.id,
      label: n.title,
      domain: firstDomain(n.domains),
      // A.8 — Obsidian usa Math.sqrt(numLinks) que dá range 4x maior que log.
      // Hubs ficam visualmente DOMINANTES. Antes: log(degree+1) — range muito comprimido.
      size: Math.sqrt(degree.get(n.id) ?? 0),
      x: p.x,
      y: p.y,
    };
  });

  const edges: GraphEdge[] = [
    ...explicitEdges.map<ExplicitGraphEdge>((e) => ({
      id: `exp:${e.id}`,
      source: e.from_id,
      target: e.to_id,
      type: 'explicit',
      why: e.why,
      relation_type: e.relation_type,
    })),
    ...similarityEdges.map<SimilarGraphEdge>((e, i) => ({
      id: `sim:${e.source}:${e.target}:${i}`,
      source: e.source,
      target: e.target,
      type: 'similar',
      score: e.score,
    })),
  ];

  return {
    nodes,
    edges,
    computedAt: Math.floor(Date.now() / 1000),
    sourceHash: await computeSourceHash(env),
  };
}

export async function handleGraphData(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const sourceHash = await computeSourceHash(env);
  const cached = await env.GRAPH_CACHE.get(CACHE_KEY, 'json') as GraphPayload | null;
  if (cached && cached.sourceHash === sourceHash) {
    return Response.json(cached, { headers: { 'cache-control': 'no-store' } });
  }

  const payload = await buildPayload(env);
  // Don't cache obviously degraded payloads: if we have notes but zero similar
  // edges, either Vectorize failed or the index is still populating. Skip the
  // write so the next request auto-heals instead of serving the bad payload
  // until notes/edges mutate and sourceHash changes.
  const hasSimilar = payload.edges.some((e) => e.type === 'similar');
  const notesCount = payload.nodes.length;
  if (notesCount === 0 || hasSimilar) {
    await env.GRAPH_CACHE.put(CACHE_KEY, JSON.stringify(payload));
  }
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
}

// Parse the domains field: JSON-encoded array (new schema) or legacy CSV.
function parseDomains(raw: string): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map((d) => String(d).trim()).filter(Boolean);
    } catch { /* fall through */ }
  }
  return trimmed.split(',').map((d) => d.trim()).filter(Boolean);
}

export interface NoteMetaRow {
  id: string;
  title: string;
  kind: string;
  tldr: string;
  domains: string[];
}

// Lightweight metadata for the graph slide panel and client-side fuzzy search.
// Kept out of the main graph payload so GRAPH_CACHE stays compact and this can
// be refreshed independently without invalidating layout positions.
export async function handleGraphMeta(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const rows = await env.DB.prepare(
    `SELECT id, title, COALESCE(tldr, '') AS tldr, COALESCE(kind, '') AS kind, COALESCE(domains, '') AS domains
     FROM notes`
  ).all<{ id: string; title: string; tldr: string; kind: string; domains: string }>();
  const results = rows.results ?? [];

  const meta: NoteMetaRow[] = results.map((n) => ({
    id: n.id,
    title: n.title,
    kind: n.kind || '',
    tldr: n.tldr || '',
    domains: parseDomains(n.domains),
  }));

  return Response.json(meta, { headers: { 'cache-control': 'no-store' } });
}
