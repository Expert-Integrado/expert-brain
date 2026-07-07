import type { Env } from '../env.js';
import type { NoteRow, EdgeRow } from '../db/queries.js';
import { requireSession } from './session.js';
import { authorizeBearer } from './bearer-auth.js';
import { newId } from '../util/id.js';
import { computeLayout, type LayoutEdge, type LayoutNode } from './layout.js';
import { explicitPairKey } from './similarity.js';
import { getTopSimilarEdges, listAllMentions, EDGE_TYPES } from '../db/queries.js';
import { NON_TASK_FILTER } from '../db/queries.js';

// Auth das rotas /app/graph/*: escopo 'graph' (só GRAPH_EXPORT_TOKEN) via o helper
// compartilhado authorizeBearer — a cópia local authorizeGraphExport foi removida
// (spec 17), eliminando a duplicação e o early-return por tamanho de token.

interface GraphNode { id: string; label: string; domain: string; size: number; x: number; y: number; private: boolean; type?: 'note' | 'contact'; }
interface ExplicitGraphEdge { id: string; source: string; target: string; type: 'explicit'; why: string; relation_type: string; }
interface SimilarGraphEdge { id: string; source: string; target: string; type: 'similar'; score: number; }
// Aresta de MENÇÃO (spec 62): liga uma nota (source) a um NÓ DE CONTATO sintético
// (target = `contact:<entity_id>`). Estilo visual distinto de edge de conhecimento.
interface MentionGraphEdge { id: string; source: string; target: string; type: 'mention'; entity_id: string; entity_label: string | null; }
type GraphEdge = ExplicitGraphEdge | SimilarGraphEdge | MentionGraphEdge;

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  computedAt: number;
  sourceHash: string;
}

// v6: similar edges agora vêm pré-computadas do D1 (não mais Vectorize ao vivo).
// Bump invalida o cache antigo no deploy, forçando uma rebuild com a nova fonte.
//
// PREFIXO de FORMATO do payload (v10 = A.37: física reversa-engenheirada 1:1 do
// Obsidian). Spec 26: a identidade do CONTEÚDO agora vive no SUFIXO da chave
// (`${CACHE_KEY}:${sourceHash}`), então este prefixo só precisa ser bumpado quando
// o SHAPE do JSON servido muda — não mais a cada mudança de dado. O cap top-3 de
// similar edges MUDA o conteúdo do payload (menos edges), mas não o shape; a
// invalidação vem de graça pelo sourceHash no sufixo (edges/scores diferentes →
// hash diferente → chave nova).
// v11 (spec 31): GraphNode ganhou o campo `private` (badge/anel visual da nota
// privada) — bump invalida o payload cacheado sem o campo. O grafo é superfície do
// dono (sessão ou GRAPH_EXPORT_TOKEN, bearer do console pessoal), então serve TODAS
// as notas, privadas incluídas; o campo só sinaliza pro client renderizar o selo.
// v12 (spec 62): GraphNode ganhou `type?` ('note'|'contact') e a união de edges ganhou
// 'mention' (camada opt-in nota↔contato, servida em /app/graph/data?mentions=1). O SHAPE
// do JSON base é o mesmo pro grafo de conhecimento (a camada de menção só entra sob o
// query param), mas o bump garante rebuild limpo do payload cacheado no deploy.
const CACHE_KEY = 'graph:v12';

// Orçamento de payload do /app/graph/data. Gate anti-regressão (spec 26): o teste
// sintético N=5k falha se o JSON servido estourar este teto. Bem abaixo do limite
// hard de value do KV (25 MB). Calibrado com o cap top-3 ativo (ver etapa 1 da spec).
export const PAYLOAD_BUDGET_BYTES = 5_000_000;

// Cap de leitura de similar edges por nó (read-only; write path grava
// SIMILARITY_TOP_K=4). Reduz o payload em escala — reversível por config. Ver spec 26.
const GRAPH_SIMILAR_PER_NODE = 3;

// Invalida o cache do grafo (KV). Exportado pra que qualquer mutação de edge —
// endpoint web handleGraphLink E a tool MCP delete_link — chame o MESMO caminho.
//
// Spec 26: com a identidade do conteúdo NA CHAVE (`graph:vN:${sourceHash}`), o
// delete deixou de ser NECESSÁRIO pra invalidação — qualquer mutação de edge muda
// COUNT/MAX(created_at) de `edges` → sourceHash novo → chave nova → o value velho
// é ignorado (e expira sozinho pelo TTL de 7 dias). A função permanece como no-op
// documentado pra não quebrar os callers (delete_link, handleGraphLink) nem
// reintroduzir uma const CACHE_KEY duplicada neles. Best-effort: mesmo que o KV
// falhasse, a mutação já está commitada no D1 e o próximo request rebuilda. Ver spec 16 + 26.
export async function invalidateGraphCache(_env: Env): Promise<void> {
  // Intencionalmente vazio — a invalidação é automática via sourceHash na chave.
}

// Posições persistidas SEPARADAS dos dados do grafo — sobrevivem a qualquer
// invalidação de CACHE_KEY (toda escrita de nota/edge invalida os dados, mas
// não deve redistribuir os ~1800 nós já posicionados). Mesmo namespace KV
// (GRAPH_CACHE), chave própria. Reset manual: deletar esta chave no KV
// re-semeia tudo do zero (não há endpoint de reset nesta spec).
// v2 (A.36): bump força re-seed do zero — as posições em graph-layout:v1 foram
// geradas pela física antiga (bolha) e estavam PINADAS aqui; sem o bump, o
// layout novo nasceria com o dente-de-leão contaminado pelas posições velhas.
// v3 (A.37): re-seed pra física Obsidian-fiel (repel sem cap de distanceMax +
// gravidade por domínio) — sem o bump o layout novo herdaria as posições da
// física v2 (repel castrado por distanceMax=250) e o efeito não apareceria.
const LAYOUT_KEY = 'graph-layout:v3';
type StoredLayout = Record<string, { x: number; y: number }>;

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
  // 1 query D1 (spec 26): 6 subselects agregados num round-trip só, em vez de 3
  // awaits sequenciais. O filtro de notas de conhecimento reusa NON_TASK_FILTER
  // (mesma string dos outros read paths) em vez de repetir inline. Formato da
  // string-hash IDÊNTICO ao anterior — mesmo dado produz o mesmo hash, sem
  // invalidar o cache vigente à toa no deploy.
  const r = await env.DB.prepare(
    `SELECT
       (SELECT COALESCE(MAX(updated_at), 0) FROM notes WHERE deleted_at IS NULL AND ${NON_TASK_FILTER}) AS nm,
       (SELECT COUNT(*)                     FROM notes WHERE deleted_at IS NULL AND ${NON_TASK_FILTER}) AS nc,
       (SELECT COALESCE(MAX(created_at), 0) FROM edges)                        AS em,
       (SELECT COUNT(*)                     FROM edges)                        AS ec,
       (SELECT COUNT(*)                     FROM similar_edges)                AS sc,
       (SELECT COALESCE(SUM(score), 0)      FROM similar_edges)                AS ss`
  ).first<{ nm: number; nc: number; em: number; ec: number; sc: number; ss: number }>();
  return `n${r?.nm ?? 0}x${r?.nc ?? 0}_e${r?.em ?? 0}x${r?.ec ?? 0}_s${r?.sc ?? 0}c${(r?.ss ?? 0).toFixed(4)}`;
}

// Domains are stored as a JSON-encoded string array. Parse and pick the first
// entry for node coloring; fall back to CSV split for legacy rows. Exportada
// (spec 66) pro agregador de busca (/app/search/all) reusar em vez de duplicar.
export function firstDomain(raw: string): string {
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

// `knownSourceHash` (opcional): quando o caller já computou o hash (getPayload no
// caminho de cache miss), passa aqui pra não fazer a 2ª query D1 de hash — a meta
// da spec 26 é ≤1 query de hash por request. Se ausente, computa (compat).
async function buildPayload(env: Env, knownSourceHash?: string): Promise<GraphPayload> {
  // Paraleliza as 2 queries independentes — D1 trata bem requests concorrentes
  // do mesmo Worker e cada uma roda em sua própria conexão.
  const [notesRes, edgesRes] = await Promise.all([
    // Tasks (kind='task') ficam fora do grafo de conhecimento — são to-dos, não ideias.
    // `private` (spec 31) vem junto pro client renderizar o selo — o grafo é superfície
    // do dono, então NÃO filtra privadas, só as marca.
    env.DB.prepare(`SELECT id, title, domains, private FROM notes WHERE deleted_at IS NULL AND (kind IS NULL OR kind <> 'task')`).all<Pick<NoteRow, 'id' | 'title' | 'domains' | 'private'>>(),
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
    // Cap top-N por nó no D1 (window function) — não traz mais a tabela inteira.
    for (const s of await getTopSimilarEdges(env, GRAPH_SIMILAR_PER_NODE)) {
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

  const layoutNodes: LayoutNode[] = notes.map((n) => ({ id: n.id, domain: firstDomain(n.domains) }));
  const layoutEdges: LayoutEdge[] = [
    ...explicitEdges.map((e) => ({ source: e.from_id, target: e.to_id })),
    ...similarityEdges.map((e) => ({ source: e.source, target: e.target })),
  ];

  // Layout persistente: lê posições gravadas do build anterior. KV ausente ou
  // corrompida (formato inesperado) vira `undefined` — tratado como primeiro
  // build (nunca lança), computeLayout semeia tudo do zero nesse caso.
  let existingLayout: Map<string, { x: number; y: number }> | undefined;
  try {
    const stored = await env.GRAPH_CACHE.get(LAYOUT_KEY, 'json') as StoredLayout | null;
    if (stored && typeof stored === 'object') {
      existingLayout = new Map(Object.entries(stored));
    }
  } catch (err) {
    console.error('graph-data: reading layout KV failed', err);
    existingLayout = undefined;
  }

  const laidOut = computeLayout(layoutNodes, layoutEdges, existingLayout);
  const pos = new Map(laidOut.map((n) => [n.id, n]));

  // Grava de volta só os nós VIVOS (aliveIds) — poda automática de nós
  // deletados, a chave não cresce sem limite. Falha de escrita no KV não deve
  // derrubar o payload do grafo (o usuário ainda vê o grafo, só perde a
  // persistência deste rebuild específico).
  try {
    const toStore: StoredLayout = {};
    for (const n of laidOut) {
      if (aliveIds.has(n.id)) toStore[n.id] = { x: n.x, y: n.y };
    }
    await env.GRAPH_CACHE.put(LAYOUT_KEY, JSON.stringify(toStore));
  } catch (err) {
    console.error('graph-data: writing layout KV failed', err);
  }

  const nodes: GraphNode[] = notes.map((n) => {
    const p = pos.get(n.id) ?? { x: 0, y: 0 };
    return {
      id: n.id,
      label: n.title,
      domain: firstDomain(n.domains),
      // A.9/A.36 — FÓRMULA do app.js DO OBSIDIAN: getSize() = max(floor, min(3*sqrt(weight+1), 30))
      // - Floor 6 (A.36, era 8): folha fica MENOR → contraste maior com o hub,
      //   reforçando o dente-de-leão (folhinhas pequenas orbitando hub grande).
      // - Cap 30: hub gigante não estoura.
      // - 3*sqrt = curva mais agressiva que sqrt simples.
      // Range: 6 a 30 (5x), contraste node:line ainda maior com a linha em 0.8.
      size: Math.max(6, Math.min(3 * Math.sqrt((degree.get(n.id) ?? 0) + 1), 30)),
      x: p.x,
      y: p.y,
      private: (n.private ?? 0) === 1,
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
    sourceHash: knownSourceHash ?? await computeSourceHash(env),
  };
}

// Cache-ou-build do payload completo. Reutilizado pelo grafo principal e pelo
// subgrafo ego (mini-grafo da nota). O payload virou determinístico e barato
// (só D1 + layout, sem Vectorize), então cacheia SEMPRE — não existe mais o
// estado "degradado" que o gate antigo (hasSimilar) tentava evitar de fixar.
// O sourceHash inclui o count de similar_edges, então o backfill invalida sozinho.
async function getPayload(env: Env): Promise<GraphPayload> {
  const sourceHash = await computeSourceHash(env);
  // Identidade-na-chave (spec 26): o sourceHash vai NO NOME da chave, então um hit
  // já garante conteúdo fresco. A comparação `cached.sourceHash === sourceHash`
  // fica como cinto de segurança (barata) contra colisão improvável de prefixo.
  const key = `${CACHE_KEY}:${sourceHash}`;
  const cached = await env.GRAPH_CACHE.get(key, 'json') as GraphPayload | null;
  if (cached && cached.sourceHash === sourceHash) return cached;

  const payload = await buildPayload(env, sourceHash);
  // TTL de 7 dias (mesmo padrão de api-keys.ts): chaves de hashes/versões antigas
  // expiram sozinhas em vez de virar lixo permanente no KV a cada mudança de vault.
  await env.GRAPH_CACHE.put(key, JSON.stringify(payload), { expirationTtl: 7 * 24 * 3600 });
  return payload;
}

// Camada de MENÇÃO (spec 62 §3.2): estende o payload base com nós de CONTATO sintéticos
// (`contact:<entity_id>`) e arestas nota↔contato das menções. Opt-in (?mentions=1) pra
// NÃO alterar o grafo de conhecimento nem sua física (a camada é overlay visual: nós de
// contato posicionados no centróide das notas que os mencionam, sem tocar o layout KV).
// Só notas de CONHECIMENTO entram (tasks ficam fora do grafo por design); menção de task
// não gera nó aqui. O bump do CACHE_KEY (v12) cobre a extensão do shape.
async function buildMentionsLayer(
  env: Env, base: GraphPayload
): Promise<{ nodes: GraphNode[]; edges: MentionGraphEdge[] }> {
  const posById = new Map(base.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  const mentions = await listAllMentions(env);
  const contactNodes = new Map<string, { node: GraphNode; sx: number; sy: number; n: number }>();
  const edges: MentionGraphEdge[] = [];
  for (const m of mentions) {
    const notePos = posById.get(m.note_id);
    if (!notePos) continue; // note_id não é uma nota de conhecimento viva (task/deletada)
    const nodeId = `contact:${m.entity_id}`;
    let entry = contactNodes.get(nodeId);
    if (!entry) {
      entry = {
        node: { id: nodeId, label: m.entity_label ?? m.entity_id, domain: 'contact', size: 8, x: 0, y: 0, private: false, type: 'contact' },
        sx: 0, sy: 0, n: 0,
      };
      contactNodes.set(nodeId, entry);
    }
    entry.sx += notePos.x; entry.sy += notePos.y; entry.n += 1;
    edges.push({ id: `men:${m.id}`, source: m.note_id, target: nodeId, type: 'mention', entity_id: m.entity_id, entity_label: m.entity_label });
  }
  const nodes = [...contactNodes.values()].map((e) => {
    if (e.n > 0) { e.node.x = e.sx / e.n; e.node.y = e.sy / e.n; }
    return e.node;
  });
  return { nodes, edges };
}

export async function handleGraphData(req: Request, env: Env): Promise<Response> {
  if (!(await authorizeBearer(req, env, 'graph'))) {
    const session = await requireSession(req, env);
    if (!session.ok) return session.response;
  }
  const payload = await getPayload(env);
  // Camada de menção opt-in (spec 62): ?mentions=1 anexa nós de contato + arestas de
  // menção. Sem o param, o grafo de conhecimento sai idêntico (zero regressão de física).
  if (new URL(req.url).searchParams.get('mentions') === '1') {
    const layer = await buildMentionsLayer(env, payload);
    return Response.json(
      { ...payload, nodes: [...payload.nodes, ...layer.nodes], edges: [...payload.edges, ...layer.edges] },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
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
  updated_at: number; // ms — aditivo (spec 23): client de notas ordena por ele sem depender do DOM SSR paginado.
  private: boolean;   // selo de privacidade (spec 31): client renderiza o badge 🔒 na lista/grafo.
}

// Lightweight metadata for the graph slide panel and client-side fuzzy search.
// Kept out of the main graph payload so GRAPH_CACHE stays compact and this can
// be refreshed independently without invalidating layout positions.
// A.32 — POST /app/graph/link: cria edge explícita justificada (Latticework).
// Aceita { source, target, why, relation_type? } e invalida cache.
export async function handleGraphLink(req: Request, env: Env): Promise<Response> {
  if (!(await authorizeBearer(req, env, 'graph'))) {
    const session = await requireSession(req, env);
    if (!session.ok) return session.response;
  }
  let body: { source?: string; target?: string; why?: string; relation_type?: string };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const source = (body.source || '').trim();
  const target = (body.target || '').trim();
  const why = (body.why || '').trim();
  if (!source || !target || source === target) {
    return new Response(JSON.stringify({ error: 'source and target required and must differ' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  // Mesma régua do MCP (src/mcp/tools/link.ts): why nomeia o MECANISMO, mínimo 20.
  if (why.length < 20) {
    return new Response(JSON.stringify({ error: 'why minimum 20 characters — nomeie o mecanismo compartilhado' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  // relation_type opcional (spec 20-frontend/25); default preserva clients antigos
  // (Expert Console usa este endpoint via Bearer sem mandar o campo).
  const relationType = (body.relation_type || 'analogous_to').trim();
  if (!(EDGE_TYPES as readonly string[]).includes(relationType)) {
    return new Response(JSON.stringify({ error: `relation_type must be one of: ${EDGE_TYPES.join(', ')}` }), { status: 400, headers: { 'content-type': 'application/json' } });
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
  ).bind(id, source, target, relationType, why, Date.now()).run();
  // Invalida cache do graph (mesmo helper usado pela tool delete_link).
  await invalidateGraphCache(env);
  return new Response(JSON.stringify({ ok: true, id }), { headers: { 'content-type': 'application/json' } });
}

export async function handleGraphMeta(req: Request, env: Env): Promise<Response> {
  if (!(await authorizeBearer(req, env, 'graph'))) {
    const session = await requireSession(req, env);
    if (!session.ok) return session.response;
  }

  // ETag barato (spec 23): computeSourceHash são subselects agregados (MAX/COUNT),
  // não o full-scan de metadata. O hash inclui edges/similar_edges que o meta não
  // usa — over-invalidação aceitável (pior caso: um 200 a mais depois de linkar
  // notas; nunca um 304 stale, porque MAX(updated_at)/COUNT cobrem create/update/
  // soft-delete de notas). `private` porque a resposta é por-sessão — nunca deixar
  // CDN/proxy compartilhar. max-age=60: navegações em sequência dentro de 60s nem
  // revalidam; depois disso, revalidação condicional vira 304 enquanto o vault não muda.
  const sourceHash = await computeSourceHash(env);
  const etag = `W/"meta-${sourceHash}"`;
  const headers = { etag, 'cache-control': 'private, max-age=60' };
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  const rows = await env.DB.prepare(
    `SELECT id, title, COALESCE(tldr, '') AS tldr, COALESCE(kind, '') AS kind, COALESCE(domains, '') AS domains, updated_at, private
     FROM notes WHERE deleted_at IS NULL AND ${NON_TASK_FILTER}`
  ).all<{ id: string; title: string; tldr: string; kind: string; domains: string; updated_at: number; private: number }>();
  const results = rows.results ?? [];

  const meta: NoteMetaRow[] = results.map((n) => ({
    id: n.id,
    title: n.title,
    kind: n.kind || '',
    tldr: n.tldr || '',
    domains: parseDomains(n.domains),
    updated_at: n.updated_at ?? 0,
    private: (n.private ?? 0) === 1,
  }));

  return Response.json(meta, { headers });
}
