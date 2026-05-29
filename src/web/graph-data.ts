import type { Env } from '../env.js';
import type { NoteRow, EdgeRow } from '../db/queries.js';
import { requireSession } from './session.js';
import { newId } from '../util/id.js';
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

const CACHE_KEY = 'graph:v5'; // A.9 fórmula Obsidian exata: max(8, min(3*sqrt(d+1), 30))
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
  // Paraleliza as 2 queries independentes — D1 trata bem requests concorrentes
  // do mesmo Worker e cada uma roda em sua própria conexão.
  const [notesRes, edgesRes] = await Promise.all([
    env.DB.prepare(`SELECT id, title, domains FROM notes`).all<Pick<NoteRow, 'id' | 'title' | 'domains'>>(),
    env.DB.prepare(`SELECT id, from_id, to_id, relation_type, why, created_at FROM edges`).all<EdgeRow>(),
  ]);
  const notes = notesRes.results ?? [];
  const explicitEdges = edgesRes.results ?? [];

  const explicitPairs = new Set<string>();
  for (const e of explicitEdges) explicitPairs.add(explicitPairKey(e.from_id, e.to_id));

  // Fetch vectors for all notes from Vectorize (by id). Vectorize exposes getByIds.
  // In the test environment Vectorize may not be populated — tolerate that gracefully.
  let noteVectors: Array<{ id: string; values: number[] }> = [];
  if (notes.length > 0) {
    const ids = notes.map((n) => n.id);
    try {
      // Cloudflare Vectorize caps getByIds at 20 ids por call (erro 40007).
      // Paraleliza os chunks em vez de sequencial — pra 370 notas, vai de
      // ~19 chamadas serializadas (~2-5s) pra 19 em paralelo (~200-500ms).
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
      const results = await Promise.all(chunks.map((chunk) => env.VECTORIZE.getByIds(chunk)));
      for (const res of results) {
        for (const v of res) {
          if (v.values) noteVectors.push({ id: v.id, values: Array.from(v.values) });
        }
      }
    } catch (err) {
      console.error('graph-data: Vectorize.getByIds failed', err);
      noteVectors = [];
    }
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
      // A.9 — FÓRMULA EXATA EXTRAÍDA DO app.js DO OBSIDIAN:
      //   getSize() = max(8, min(3 * sqrt(weight+1), 30))
      // - Floor 8: todo nó tem tamanho mínimo visível
      // - Cap 30: hub gigante não estoura
      // - 3*sqrt = curva mais agressiva que sqrt simples
      // Range: 8 a 30 (4x), igual Obsidian. Linha = 1 → razão node:line de 8x-30x.
      size: Math.max(8, Math.min(3 * Math.sqrt((degree.get(n.id) ?? 0) + 1), 30)),
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

// Cache-ou-build do payload completo. Reutilizado pelo grafo principal e pelo
// subgrafo ego (mini-grafo da nota). Não cacheia payload degradado (0 notas ou
// sem edges semânticas — Vectorize falhou/ainda indexando) pra auto-curar.
async function getPayload(env: Env): Promise<GraphPayload> {
  const sourceHash = await computeSourceHash(env);
  const cached = await env.GRAPH_CACHE.get(CACHE_KEY, 'json') as GraphPayload | null;
  if (cached && cached.sourceHash === sourceHash) return cached;

  const payload = await buildPayload(env);
  const hasSimilar = payload.edges.some((e) => e.type === 'similar');
  if (payload.nodes.length === 0 || hasSimilar) {
    await env.GRAPH_CACHE.put(CACHE_KEY, JSON.stringify(payload));
  }
  return payload;
}

export async function handleGraphData(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const payload = await getPayload(env);
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
}

// Subgrafo ego (até 3 hops por edges EXPLÍCITAS) ao redor de uma nota. O BFS roda
// no servidor e devolve só os nós envolvidos + edges entre eles — o mini-grafo da
// página da nota não precisa mais baixar o grafo inteiro (era a causa da lentidão).
export async function handleNoteGraph(req: Request, env: Env, focusId: string): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const payload = await getPayload(env);
  const MAX_HOPS = 3;
  const MAX_NODES = 200; // teto pra um hub gigante não explodir o mini-grafo

  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const l = adj.get(a);
    if (l) l.push(b); else adj.set(a, [b]);
  };
  for (const e of payload.edges) {
    if (e.type !== 'explicit') continue;
    link(e.source, e.target);
    link(e.target, e.source);
  }

  const keep = new Set<string>([focusId]);
  let frontier = [focusId];
  for (let h = 0; h < MAX_HOPS && keep.size < MAX_NODES; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!keep.has(nb)) { keep.add(nb); next.push(nb); }
        if (keep.size >= MAX_NODES) break;
      }
      if (keep.size >= MAX_NODES) break;
    }
    if (next.length === 0) break;
    frontier = next;
  }

  const nodes = payload.nodes.filter((n) => keep.has(n.id));
  const edges = payload.edges.filter(
    (e) => e.type === 'explicit' && keep.has(e.source) && keep.has(e.target),
  );
  return Response.json(
    { nodes, edges, computedAt: payload.computedAt, sourceHash: payload.sourceHash },
    { headers: { 'cache-control': 'no-store' } },
  );
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
// A.32 — POST /app/graph/link: cria edge explícita justificada (Latticework).
// Aceita { source, target, why } e invalida cache.
export async function handleGraphLink(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  let body: { source?: string; target?: string; why?: string };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const source = (body.source || '').trim();
  const target = (body.target || '').trim();
  const why = (body.why || '').trim();
  if (!source || !target || source === target) {
    return new Response(JSON.stringify({ error: 'source and target required and must differ' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  if (why.length < 8) {
    return new Response(JSON.stringify({ error: 'why minimum 8 characters' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  // Verifica que ambas notas existem
  const exists = await env.DB.prepare(`SELECT id FROM notes WHERE id IN (?, ?)`).bind(source, target).all<{ id: string }>();
  if ((exists.results?.length ?? 0) < 2) {
    return new Response(JSON.stringify({ error: 'one or both notes not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const id = newId();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO edges (id, from_id, to_id, relation_type, why, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, source, target, 'analogous_to', why, Date.now()).run();
  // Invalida cache do graph
  await env.GRAPH_CACHE.delete(CACHE_KEY);
  return new Response(JSON.stringify({ ok: true, id }), { headers: { 'content-type': 'application/json' } });
}

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
