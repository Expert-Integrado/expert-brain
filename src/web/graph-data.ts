import type { Env } from '../env.js';
import type { NoteRow, EdgeRow } from '../db/queries.js';
import { requireSession } from './session.js';
import { newId } from '../util/id.js';
import { computeLayout, type LayoutEdge, type LayoutNode } from './layout.js';
import { explicitPairKey } from './similarity.js';
import { getAllSimilarEdges } from '../db/queries.js';

// Porta de auth ADITIVA pras rotas /app/graph/*: além da sessão de cookie do
// browser, aceita `Authorization: Bearer <token>` quando o token bate com
// env.GRAPH_EXPORT_TOKEN. Usado pelo Expert Console (adapter do vault brain) pra
// ler/escrever o grafo via HTTP sem sessão. Se o secret não estiver setado ou o
// header não bater, retorna false e o chamador cai no requireSession normal —
// comportamento de browser fica intacto. Comparação de tamanho-constante pra não
// vazar o token por timing.
function authorizeGraphExport(req: Request, env: Env): boolean {
  const expected = env.GRAPH_EXPORT_TOKEN;
  if (!expected) return false;
  const header = req.headers.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const got = m[1].trim();
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

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

// v6: similar edges agora vêm pré-computadas do D1 (não mais Vectorize ao vivo).
// Bump invalida o cache antigo no deploy, forçando uma rebuild com a nova fonte.
const CACHE_KEY = 'graph:v6'; // A.9 fórmula Obsidian exata: max(8, min(3*sqrt(d+1), 30))

async function computeSourceHash(env: Env): Promise<string> {
  // COUNT só de notas vivas: soft-delete (UPDATE deleted_at) não muda updated_at,
  // mas muda o count -> hash muda -> cache do grafo invalida e a nota some.
  // similar_edges entra no hash pra que mudanças nela (backfill, reembed) invalidem o
  // cache. NÃO basta COUNT: reembed faz DELETE+INSERT do top-k de uma nota e, se o nº de
  // vizinhos acima do minScore não muda (caso comum, segue 4), o COUNT fica igual mas o
  // CONTEÚDO mudou (outros targets/scores). reembed também não toca notes.updated_at.
  // Então combinamos COUNT + SUM(score): o SUM muda quando os pares/scores mudam, mesmo
  // com cardinalidade igual — sem isso o getPayload (que agora cacheia sempre) serviria
  // uma teia stale pra sempre após um reembed em lote (uso pós-migração de modelo).
  const n = await env.DB.prepare(`SELECT COALESCE(MAX(updated_at), 0) m, COUNT(*) c FROM notes WHERE deleted_at IS NULL`).first<{ m: number; c: number }>();
  const e = await env.DB.prepare(`SELECT COALESCE(MAX(created_at), 0) m, COUNT(*) c FROM edges`).first<{ m: number; c: number }>();
  const s = await env.DB.prepare(`SELECT COUNT(*) c, COALESCE(SUM(score), 0) sum FROM similar_edges`).first<{ c: number; sum: number }>();
  return `n${n?.m ?? 0}x${n?.c ?? 0}_e${e?.m ?? 0}x${e?.c ?? 0}_s${s?.c ?? 0}c${(s?.sum ?? 0).toFixed(4)}`;
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
    env.DB.prepare(`SELECT id, title, domains FROM notes WHERE deleted_at IS NULL`).all<Pick<NoteRow, 'id' | 'title' | 'domains'>>(),
    env.DB.prepare(`SELECT id, from_id, to_id, relation_type, why, created_at FROM edges`).all<EdgeRow>(),
  ]);
  const notes = notesRes.results ?? [];
  // Edges cujo extremo foi soft-deletado (a linha fica, não cascateia) precisam
  // ser dropadas pra não referenciar nós que não estão mais no payload.
  const aliveIds = new Set(notes.map((n) => n.id));
  const explicitEdges = (edgesRes.results ?? []).filter(
    (e) => aliveIds.has(e.from_id) && aliveIds.has(e.to_id),
  );

  const explicitPairs = new Set<string>();
  for (const e of explicitEdges) explicitPairs.add(explicitPairKey(e.from_id, e.to_id));

  // Similar edges agora são LIDAS pré-computadas do D1 (gravadas no write path +
  // backfill, ver migration 0005). ZERO chamadas Vectorize aqui — o caminho antigo
  // fazia 1 query por nota num loop sequencial e estourava o cap de subrequests do
  // Cloudflare além de ~950 notas, travando o carregamento do grafo.
  // Dedup: pares simétricos (A→B e B→A viram um só) e pares que já têm edge
  // explícita são descartados. Extremos soft-deletados caem pelo filtro aliveIds.
  let similarityEdges: Array<{ source: string; target: string; score: number }> = [];
  try {
    const seen = new Set<string>();
    for (const s of await getAllSimilarEdges(env)) {
      if (!aliveIds.has(s.from_id) || !aliveIds.has(s.to_id)) continue;
      if (s.from_id === s.to_id) continue;
      const key = explicitPairKey(s.from_id, s.to_id);
      if (seen.has(key) || explicitPairs.has(key)) continue;
      seen.add(key);
      const [source, target] = [s.from_id, s.to_id].sort();
      similarityEdges.push({ source, target, score: s.score });
    }
  } catch (err) {
    console.error('graph-data: reading similar_edges failed', err);
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
// subgrafo ego (mini-grafo da nota). O payload virou determinístico e barato
// (só D1 + layout, sem Vectorize), então cacheia SEMPRE — não existe mais o
// estado "degradado" que o gate antigo (hasSimilar) tentava evitar de fixar.
// O sourceHash inclui o count de similar_edges, então o backfill invalida sozinho.
async function getPayload(env: Env): Promise<GraphPayload> {
  const sourceHash = await computeSourceHash(env);
  const cached = await env.GRAPH_CACHE.get(CACHE_KEY, 'json') as GraphPayload | null;
  if (cached && cached.sourceHash === sourceHash) return cached;

  const payload = await buildPayload(env);
  await env.GRAPH_CACHE.put(CACHE_KEY, JSON.stringify(payload));
  return payload;
}

export async function handleGraphData(req: Request, env: Env): Promise<Response> {
  if (!authorizeGraphExport(req, env)) {
    const session = await requireSession(req, env);
    if (!session.ok) return session.response;
  }
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
  if (!authorizeGraphExport(req, env)) {
    const session = await requireSession(req, env);
    if (!session.ok) return session.response;
  }
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
  const exists = await env.DB.prepare(`SELECT id FROM notes WHERE id IN (?, ?) AND deleted_at IS NULL`).bind(source, target).all<{ id: string }>();
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
  if (!authorizeGraphExport(req, env)) {
    const session = await requireSession(req, env);
    if (!session.ok) return session.response;
  }

  const rows = await env.DB.prepare(
    `SELECT id, title, COALESCE(tldr, '') AS tldr, COALESCE(kind, '') AS kind, COALESCE(domains, '') AS domains
     FROM notes WHERE deleted_at IS NULL`
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
