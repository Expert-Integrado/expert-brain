// Adapter do vault "contacts" — IN-PROCESS.
//
// O Console roda DENTRO do mesmo Worker do expert-contacts, então este adapter
// lê env.DB / env.VECTORIZE DIRETO (sem HTTP, sem token). Normaliza o grafo de
// entidades (pessoas/empresas + connections) pro shape comum do Brain.
//
// Nós uniformes (GraphNode), arestas discriminadas por type ('explicit' vinda de
// connections | 'similar' via Vectorize). Cor por `domain` = kind da entidade.

import type { Env } from '../env';
import type {
  VaultAdapter,
  GraphPayload,
  GraphNode,
  GraphEdge,
  ExplicitGraphEdge,
  SimilarGraphEdge,
  GraphParams,
  EntityDetail,
  EntityDetailField,
  EntityDetailConnection,
  EntityDetailEvent,
  LinkBody,
  LegendEntry,
} from './types';
import { computeLayout, computeLayoutScaled, type LayoutNode, type LayoutEdge } from '../web/layout.js';
import { getAllSimilarEdges, explicitPairKey, SIMILARITY_DISPLAY_MIN, type SimilarityEdge } from '../web/similarity.js';
import { CONN_TYPES_SET, normalizeConnPair, HIDDEN_BY_DEFAULT_CATEGORY } from '../canon';
import { getChannels, channelHref } from '../channels';

// ---- constantes ----
const VAULT_ID = 'contacts';
const VAULT_COLOR = '#22d3ee'; // ciano — bate com o tom "contatos" do Console
// Parâmetros de similaridade (SIMILARITY_TOP_K/MIN_SCORE) vivem em src/web/similarity.ts,
// fonte ÚNICA da escrita (refreshSimilarEdges) e do backfill. O read path só LÊ a
// tabela similar_edges pré-computada — sem query Vectorize por nó (spec 10-backend/21).
const DEFAULT_SAMPLE_LIMIT = 500;
const MAX_SAMPLE_LIMIT = 2000;
const MAX_EDGES = 8000;
const META_LIST_LIMIT = 2000; // teto da lista leve (id,label) pro command palette

// Loga quando uma leitura de connections ATINGE o teto MAX_EDGES — o truncamento
// continua possível (os 3 modos que precisam do conjunto global), mas nunca mais
// SILENCIOSO (spec 10-backend/21 Parte 3). Acima do teto, arestas somem do grafo.
function warnIfTruncated(rows: unknown[], ctx: string): void {
  if (rows.length >= MAX_EDGES) {
    console.warn(`[contacts] ${ctx}: connections atingiu o teto MAX_EDGES=${MAX_EDGES} — arestas podem ter sido truncadas`);
  }
}

// Tipos de aresta válidos vêm de src/canon.ts (fonte ÚNICA) — CONN_TYPES_SET.

// Cores por kind (dimensão de cor = domain = kind no shape comum).
// Sincronizar com CONTACT_KIND_COLORS do Brain (expert-brain/src/web/domain-colors.ts).
const KIND_COLORS: Record<string, string> = {
  person: '#22c55e',
  company: '#3b82f6',
  group: '#a855f7',
  place: '#f59e0b',
  event: '#ec4899',
  other: '#94a3b8',
};
const KIND_FALLBACK = '#64748b';
const KIND_LABELS: Record<string, string> = {
  person: 'Pessoa',
  company: 'Empresa',
  group: 'Grupo',
  place: 'Lugar',
  event: 'Evento',
  other: 'Outro',
};

// Rótulos PT-BR dos canais (spec 55) pros fields[] de LEITURA.
const CHANNEL_FIELD_LABELS: Record<string, string> = {
  email: 'E-mail',
  phone: 'Telefone',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  crm: 'CRM',
  manychat: 'ManyChat',
  site: 'Site',
  other: 'Outro',
};
function channelFieldLabel(kind: string, label: string | null): string {
  const base = CHANNEL_FIELD_LABELS[kind] ?? kind;
  return label ? `${base} (${label})` : base;
}

// ---- helpers internos ----

const uuid = () => crypto.randomUUID();

interface EntityRow {
  id: string;
  kind: string;
  name: string;
  company?: string | null;
  sector?: string | null;
  avatar_r2_key?: string | null;
  last_contacted?: string | null;
  // Selo de privacidade (spec 61): 0/1. Carregado em todos os loaders pra o filtro
  // ÚNICO de visibilidade em assemblePayload (nó privado nunca entra no payload).
  private?: number;
  // Carregada pro filtro default-off de 'mapeado' em assemblePayload (canon.ts).
  category?: string | null;
}

interface ConnRow {
  id: string;
  a_id: string;
  b_id: string;
  type: string;
  strength: number;
  why: string;
}

// avatar_r2_key tem formato "sha256/<hash>.<ext>". A rota pública é /media/<hash>.
function avatarImg(key?: string | null): string | undefined {
  if (!key) return undefined;
  const m = key.match(/([0-9a-f]{64})/i);
  return m ? `/media/${m[1]}` : undefined;
}

// Fórmula Obsidian (igual Brain): max(8, min(3*sqrt(grau+1), 30)).
function nodeSize(degree: number): number {
  return Math.max(8, Math.min(3 * Math.sqrt(degree + 1), 30));
}

// Texto canônico pra embedding da query (?q=) — bge-m3.
async function embedQuery(env: Env, text: string): Promise<number[] | null> {
  if (!env.VECTORIZE || !text.trim()) return null;
  try {
    const r: any = await env.AI.run('@cf/baai/bge-m3', { text });
    const vec = Array.isArray(r?.data?.[0]) ? r.data[0] : r?.data?.[0]?.embedding;
    if (Array.isArray(vec) && vec.length === 1024) return vec;
    console.warn('[contacts.embedQuery] formato inesperado', JSON.stringify(r).slice(0, 200));
    return null;
  } catch (e: any) {
    console.error('[contacts.embedQuery] error', e?.message || e);
    return null;
  }
}

// Carrega TODAS as entidades numa única query (sem WHERE/chunk) — pro modo "all",
// onde a lista por-id geraria ~68 queries (6,7k/100) e estourava o orçamento.
async function loadAllEntities(env: Env): Promise<EntityRow[]> {
  const r = await env.DB.prepare(
    `SELECT id, kind, name, company, sector, avatar_r2_key, last_contacted, private, category FROM entities`
  ).all<EntityRow>();
  return r.results ?? [];
}

// Carrega entidades por ids (chunked p/ não estourar limite de binds do D1).
async function loadEntities(env: Env, ids: string[]): Promise<EntityRow[]> {
  if (ids.length === 0) return [];
  const out: EntityRow[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT id, kind, name, company, sector, avatar_r2_key, last_contacted, private, category
         FROM entities WHERE id IN (${ph})`
    ).bind(...chunk).all<EntityRow>();
    for (const row of r.results ?? []) out.push(row);
  }
  return out;
}

// Arestas entre um conjunto de ids (ambos extremos no set), SEM full-scan.
// Chunks de até 100 ids com `WHERE a_id IN (...)` — usa idx_conn_a — e pós-filtra o
// outro extremo em JS (`ids.has(c.b_id)`). Como toda aresta do resultado precisa ter
// os DOIS extremos no set, buscar só por a_id já cobre tudo (a aresta invertida tem
// o mesmo par; connect() normaliza o par simétrico). Cada linha aparece 1x — sem dedup.
// Substitui o antigo `SELECT ... LIMIT ${MAX_EDGES}` sem WHERE que truncava silencioso
// e ignorava os índices (spec 10-backend/21 Parte 3). Exportada pra teste unitário.
export async function loadConnectionsBetween(env: Env, ids: Set<string>): Promise<ConnRow[]> {
  if (ids.size === 0) return [];
  const idList = [...ids];
  const out: ConnRow[] = [];
  for (let i = 0; i < idList.length; i += 100) {
    const chunk = idList.slice(i, i + 100);
    const ph = chunk.map(() => '?').join(',');
    const r = await env.DB.prepare(
      `SELECT id, a_id, b_id, type, strength, why FROM connections WHERE a_id IN (${ph})`
    ).bind(...chunk).all<ConnRow>();
    for (const c of r.results ?? []) {
      if (ids.has(c.b_id)) out.push(c);
    }
  }
  return out;
}

// Serialização canônica dos GraphParams — FONTE ÚNICA (usada pela chave de cache
// no graph-api E pelo escopo do sourceHash). Ordem fixa pra ser determinística.
export function serializeGraphParams(params: GraphParams): string {
  return [
    `q=${params.q ?? ''}`,
    `focus=${params.focus ?? ''}`,
    `depth=${params.depth ?? ''}`,
    `all=${params.all ? '1' : ''}`,
    `limit=${params.limit ?? ''}`,
    // Selo de privacidade (spec 61): a visibilidade entra na chave de cache pra que
    // o payload que INCLUI nós privados (dono) NUNCA seja servido a um caller que não
    // vê privados (proxy sem header) — senão o cache vazaria o que o filtro barrou.
    `priv=${params.includePrivate ? '1' : ''}`,
  ].join('&');
}

// Assinatura GLOBAL do estado (entidades+connections): max(updated_at)+count e
// max(created_at)+count. Depende só de agregados globais — NÃO do subgrafo nem
// dos params. Exposta pro graph-api computar a chave de cache ANTES do lookup,
// pra que qualquer escrita (REST/MCP: save_person, attach_media, createLink)
// auto-invalide o cache (a chave muda → MISS no próximo hit).
export async function contactsSourceHash(env: Env): Promise<string> {
  const e = await env.DB.prepare(
    `SELECT COALESCE(MAX(updated_at), '0') m, COUNT(*) c FROM entities`
  ).first<{ m: string; c: number }>();
  const c = await env.DB.prepare(
    `SELECT COALESCE(MAX(created_at), '0') m, COUNT(*) c FROM connections`
  ).first<{ m: string; c: number }>();
  // similar_edges entra no hash pra que mudanças nela (backfill, reembed, save)
  // invalidem o cache do grafo — senão o Console serve payload stale (spec 21 §1e).
  // NÃO basta COUNT: reembed faz DELETE+INSERT do top-k de UMA entidade e, se o nº de
  // vizinhos acima do minScore não muda (caso comum, segue 4), o COUNT fica igual mas o
  // CONTEÚDO mudou. COUNT + SUM(score) detecta a mudança de par/score com mesma
  // cardinalidade. try/catch: antes da migration 0005 rodar a tabela não existe —
  // degrada pra 0x0.0000 (hash estável), nunca derruba o load do grafo.
  let sc = 0, ss = 0;
  try {
    const s = await env.DB.prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(score), 0) s FROM similar_edges`
    ).first<{ c: number; s: number }>();
    sc = s?.c ?? 0;
    ss = s?.s ?? 0;
  } catch (err: any) {
    console.warn('[contacts.contactsSourceHash] similar_edges indisponível', err?.message || err);
  }
  return `e${e?.m ?? 0}x${e?.c ?? 0}_c${c?.m ?? 0}x${c?.c ?? 0}_s${sc}c${ss.toFixed(4)}`;
}

// sourceHash do payload = assinatura global + escopo (params). O mesmo banco
// produz subgrafos diferentes por modo, então o escopo entra aqui pra identidade
// do payload — mas a chave de cache já separa por paramsKey, então lá o escopo
// é redundante e usamos só o contactsSourceHash global.
async function computeSourceHash(env: Env, params: GraphParams): Promise<string> {
  const global = await contactsSourceHash(env);
  return `${global}_s${serializeGraphParams(params)}`;
}

// Meta LEVE pro /app/graph/meta — lista (id,label) pro command palette + counts
// totais. NÃO monta grafo (sem forceatlas2, sem Vectorize), só duas queries SQL.
// Exposta pro graph-api consumir sem chamar fetchGraph (que recomputa tudo).
export async function contactsMeta(
  env: Env,
  includePrivate = false,
): Promise<{ list: Array<{ id: string; label: string }>; counts: { nodes: number; edges: number } }> {
  // Privacidade (spec 61): a lista (id,label) alimenta o command palette — é a
  // superfície que carrega identificadores, então nó privado sai dela quando o
  // caller não vê privados. As contagens também excluem privados (nós) e arestas
  // com QUALQUER ponta privada — não vazar existência nem no agregado.
  const privList = includePrivate ? '' : ' AND private = 0';
  // 'mapeado' fica fora do palette e dos counts em qualquer visibilidade — o grafo
  // do console nunca o mostra (default-off, canon.ts), então o meta acompanha.
  const noMapped = ` AND COALESCE(category,'') != '${HIDDEN_BY_DEFAULT_CATEGORY}'`;
  const rows = await env.DB.prepare(
    `SELECT id, name FROM entities
       WHERE name GLOB '*[A-Za-z]*'${privList}${noMapped}
       ORDER BY last_contacted DESC LIMIT ${META_LIST_LIMIT}`
  ).all<{ id: string; name: string }>();
  const ec = await env.DB.prepare(
    includePrivate
      ? `SELECT COUNT(*) c FROM entities WHERE 1=1${noMapped}`
      : `SELECT COUNT(*) c FROM entities WHERE private = 0${noMapped}`
  ).first<{ c: number }>();
  const cc = await env.DB.prepare(
    includePrivate
      ? `SELECT COUNT(*) c FROM connections c
           WHERE NOT EXISTS (SELECT 1 FROM entities e
             WHERE (e.id = c.a_id OR e.id = c.b_id)
               AND COALESCE(e.category,'') = '${HIDDEN_BY_DEFAULT_CATEGORY}')`
      : `SELECT COUNT(*) c FROM connections c
           WHERE NOT EXISTS (SELECT 1 FROM entities e
             WHERE (e.id = c.a_id OR e.id = c.b_id)
               AND (e.private = 1 OR COALESCE(e.category,'') = '${HIDDEN_BY_DEFAULT_CATEGORY}'))`
  ).first<{ c: number }>();
  const list = (rows.results ?? []).map((r) => ({ id: r.id, label: r.name }));
  return { list, counts: { nodes: ec?.c ?? 0, edges: cc?.c ?? 0 } };
}

// Monta o payload final dado o set de ids "semente" e as connections relevantes.
async function assemblePayload(
  env: Env,
  seedIds: Set<string>,
  explicitConns: ConnRow[],
  params: GraphParams,
  opts: { skipSimilarity?: boolean; entities?: EntityRow[]; lightLayout?: boolean } = {},
): Promise<GraphPayload> {
  // Garante que todo extremo de aresta explícita também é um nó.
  for (const c of explicitConns) { seedIds.add(c.a_id); seedIds.add(c.b_id); }
  const ids = [...seedIds];
  // entities pré-carregadas (modo "all" usa 1 query só) ou busca por id (chunked).
  const loaded = opts.entities ?? await loadEntities(env, ids);
  // FILTRO ÚNICO de visibilidade (spec 61): nó privado nunca vira nó do payload
  // quando o caller não vê privados. Como toda superfície do grafo passa por aqui,
  // basta este ponto — as arestas explícitas e as similar_edges com uma ponta
  // privada caem sozinhas no filtro por aliveIds abaixo (aresta órfã é descartada).
  const includePrivate = params.includePrivate === true;
  const visible = includePrivate ? loaded : loaded.filter((e) => e.private !== 1);
  // 'mapeado' é default-off em TODA superfície de grafo (canon.ts): o nó sai aqui
  // e as arestas que o tocam caem sozinhas no filtro por aliveIds abaixo.
  const entities = visible.filter((e) => e.category !== HIDDEN_BY_DEFAULT_CATEGORY);
  const aliveIds = new Set(entities.map((e) => e.id));

  // Filtra connections cujos extremos sobreviveram.
  const explicitEdges = explicitConns.filter((c) => aliveIds.has(c.a_id) && aliveIds.has(c.b_id));
  const explicitPairs = new Set<string>();
  for (const c of explicitEdges) explicitPairs.add(explicitPairKey(c.a_id, c.b_id));

  // Arestas de similaridade (camada secundária, degradação graciosa). LIDAS da tabela
  // similar_edges PRÉ-COMPUTADA (1 query D1) — ZERO query Vectorize por nó no load.
  // Antes do fix, o loop de 1 query Vectorize/nó estourava o cap de subrequests do
  // Cloudflare acima de ~900 nós conectados (incidente 1102). O write path
  // (refreshSimilarEdges) mantém a tabela fresca; aqui só filtramos:
  //   1. ambos os extremos vivos no payload (aliveIds),
  //   2. dedup de par simétrico (each nó grava seu próprio top-k → a↔b pode vir 2x),
  //   3. descarte de pares que já têm aresta explícita.
  // skipSimilarity: no modo "todos os contatos" (?all=) o payload segue SEM arestas
  // de similaridade — comportamento preservado (spec 21 §1e).
  let similarityEdges: SimilarityEdge[] = [];
  if (!opts.skipSimilarity) {
    let rows: Array<{ from_id: string; to_id: string; score: number }> = [];
    try {
      rows = await getAllSimilarEdges(env);
    } catch (e: any) {
      // Antes da migration 0005 rodar, a tabela não existe — grafo sem similaridade.
      console.warn('[contacts.assemblePayload] getAllSimilarEdges indisponível', e?.message || e);
      rows = [];
    }
    const seen = new Set<string>();
    for (const r of rows) {
      // Corte de exibição (SIMILARITY_DISPLAY_MIN): pares fracos — tipicamente
      // "mesmo sobrenome" — ficam na tabela mas fora do grafo.
      if (r.score < SIMILARITY_DISPLAY_MIN) continue;
      if (!aliveIds.has(r.from_id) || !aliveIds.has(r.to_id)) continue;
      const key = explicitPairKey(r.from_id, r.to_id);
      if (seen.has(key) || explicitPairs.has(key)) continue;
      seen.add(key);
      const [a, b] = [r.from_id, r.to_id].sort();
      similarityEdges.push({ source: a, target: b, score: r.score });
    }
  }

  // Grau (explícitas + similares) → tamanho do nó.
  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const e of explicitEdges) { bump(e.a_id); bump(e.b_id); }
  for (const e of similarityEdges) { bump(e.source); bump(e.target); }

  // Layout (seed server-side). cluster = kind da entidade (fallback 'other') →
  // seed clusterizado por kind no computeLayout/clusteredSeed (spec 21 Parte 2).
  const layoutNodes: LayoutNode[] = entities.map((e) => ({ id: e.id, cluster: e.kind || 'other' }));
  const layoutEdges: LayoutEdge[] = [
    ...explicitEdges.map((e) => ({ source: e.a_id, target: e.b_id })),
    ...similarityEdges.map((e) => ({ source: e.source, target: e.target })),
  ];
  const laidOut = opts.lightLayout
    ? computeLayoutScaled(layoutNodes, layoutEdges)
    : computeLayout(layoutNodes, layoutEdges);
  const pos = new Map(laidOut.map((n) => [n.id, n]));

  const nodes: GraphNode[] = entities.map((e) => {
    const p = pos.get(e.id) ?? { x: 0, y: 0 };
    return {
      id: e.id,
      label: e.name,
      domain: e.kind,
      size: nodeSize(degree.get(e.id) ?? 0),
      x: p.x,
      y: p.y,
      img: avatarImg(e.avatar_r2_key),
    };
  });

  const edges: GraphEdge[] = [
    ...explicitEdges.map<ExplicitGraphEdge>((e) => ({
      id: `exp:${e.id}`,
      source: e.a_id,
      target: e.b_id,
      type: 'explicit',
      why: e.why,
      relation_type: e.type,
    })),
    // id estável: o par ordenado <source>:<target> já é único (dedup em
    // computeSimilarityEdges), então não usamos o índice de loop — id determinístico
    // entre execuções (melhor pro diffing/animação no client).
    ...similarityEdges.map<SimilarGraphEdge>((e) => ({
      id: `sim:${e.source}:${e.target}`,
      source: e.source,
      target: e.target,
      type: 'similar',
      score: e.score,
    })),
  ];

  return {
    vault: VAULT_ID,
    nodes,
    edges,
    computedAt: Math.floor(Date.now() / 1000),
    sourceHash: await computeSourceHash(env, params),
  };
}

// ---- modos de fetchGraph ----

// default: subgrafo conectado (todo nó que aparece em alguma connection).
async function fetchConnectedSubgraph(env: Env, params: GraphParams): Promise<GraphPayload> {
  const conns = await env.DB.prepare(
    `SELECT id, a_id, b_id, type, strength, why FROM connections LIMIT ${MAX_EDGES}`
  ).all<ConnRow>();
  warnIfTruncated(conns.results ?? [], 'fetchConnectedSubgraph');
  const seeds = new Set<string>();
  for (const c of conns.results ?? []) { seeds.add(c.a_id); seeds.add(c.b_id); }
  return assemblePayload(env, seeds, conns.results ?? [], params);
}

// ?q=: busca semântica → nós + subgrafo deles.
async function fetchByQuery(env: Env, q: string, params: GraphParams): Promise<GraphPayload> {
  const limit = Math.min(params.limit ?? 50, 200);
  const vec = await embedQuery(env, q);
  const seeds = new Set<string>();
  if (vec && env.VECTORIZE) {
    try {
      const res = await env.VECTORIZE.query(vec, { topK: limit, returnMetadata: 'none' });
      // Floor de relevância: com o nome fora do vetor (embedding.ts, 10/07/2026),
      // query por NOME só produz matches de score baixo — sem o floor eles enchem os
      // seeds e o fallback LIKE (que acha por nome) nunca assume.
      for (const m of res.matches ?? []) if (m.score >= 0.5) seeds.add(m.id);
    } catch (e: any) {
      console.error('[contacts.fetchByQuery] vectorize failed', e?.message || e);
    }
  }
  // Fallback SQL LIKE se Vectorize indisponível ou sem matches.
  if (seeds.size === 0) {
    const like = `%${q.toLowerCase()}%`;
    // Busca textual também alcança observações datadas (events.context) via EXISTS
    // correlacionado (spec 60 §4). Privacidade (spec 61): quando o caller não vê
    // privados, a entidade privada sai (`AND e.private = 0`) E o EXISTS ignora
    // observação privada (`AND ev.private = 0`) — senão o conteúdo de uma observação
    // privada num contato PÚBLICO vazaria por inferência na busca.
    const privE = params.includePrivate ? '' : ' AND e.private = 0';
    const privEv = params.includePrivate ? '' : ' AND ev.private = 0';
    const r = await env.DB.prepare(
      `SELECT e.id FROM entities e
        WHERE (LOWER(e.name) LIKE ? OR LOWER(COALESCE(e.company,'')) LIKE ?
              OR LOWER(COALESCE(e.role,'')) LIKE ? OR LOWER(COALESCE(e.sector,'')) LIKE ?
              OR LOWER(COALESCE(e.notes_text,'')) LIKE ?
              OR EXISTS (SELECT 1 FROM events ev WHERE ev.entity_id = e.id
                         AND LOWER(COALESCE(ev.context,'')) LIKE ?${privEv}))${privE}
        ORDER BY e.last_contacted DESC LIMIT ?`
    ).bind(like, like, like, like, like, like, limit).all<{ id: string }>();
    for (const row of r.results ?? []) seeds.add(row.id);
  }
  const conns = await loadConnectionsBetween(env, seeds);
  return assemblePayload(env, seeds, conns, params);
}

// ?focus=&depth=: vizinhança a partir de um nó (N hops via connections).
async function fetchNeighborhood(env: Env, focus: string, depth: number, params: GraphParams): Promise<GraphPayload> {
  const maxHops = Math.max(1, Math.min(depth || 1, 4));
  const MAX_NODES = 400;

  // Carrega todas connections (banco pessoal pequeno) e faz BFS em memória.
  const all = await env.DB.prepare(
    `SELECT id, a_id, b_id, type, strength, why FROM connections LIMIT ${MAX_EDGES}`
  ).all<ConnRow>();
  warnIfTruncated(all.results ?? [], 'fetchNeighborhood');
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const l = adj.get(a);
    if (l) l.push(b); else adj.set(a, [b]);
  };
  for (const c of all.results ?? []) { link(c.a_id, c.b_id); link(c.b_id, c.a_id); }

  const keep = new Set<string>([focus]);
  let frontier = [focus];
  for (let h = 0; h < maxHops && keep.size < MAX_NODES; h++) {
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
  const conns = (all.results ?? []).filter((c) => keep.has(c.a_id) && keep.has(c.b_id));
  return assemblePayload(env, keep, conns, params);
}

// ?all=true: TODOS os contatos (inclui os isolados, sem conexão — que o modo
// conectado esconde). Sem similaridade (skipSimilarity) pra não estourar o cap de
// subrequests do Vectorize com milhares de nós — mostra todos + ligações explícitas.
// O `limit` opcional ainda corta uma amostra (mais recentes) quando passado.
async function fetchAll(env: Env, params: GraphParams): Promise<GraphPayload> {
  // Carrega TODAS as entidades em 1 query (ou amostra recente se vier limit).
  const entities = params.limit
    ? (await env.DB.prepare(
        `SELECT id, kind, name, company, sector, avatar_r2_key, last_contacted, private, category
           FROM entities ORDER BY last_contacted DESC LIMIT ?`
      ).bind(Math.min(params.limit, MAX_SAMPLE_LIMIT)).all<EntityRow>()).results ?? []
    : await loadAllEntities(env);
  const seeds = new Set<string>(entities.map((e) => e.id));
  const conns = await env.DB.prepare(
    `SELECT id, a_id, b_id, type, strength, why FROM connections LIMIT ${MAX_EDGES}`
  ).all<ConnRow>();
  warnIfTruncated(conns.results ?? [], 'fetchAll');
  // skipSimilarity + lightLayout: sem Vectorize por-nó e sem forceAtlas2 em milhares
  // (força só no núcleo conectado, espalha os isolados). entities já pré-carregadas.
  return assemblePayload(env, seeds, conns.results ?? [], params, {
    skipSimilarity: true,
    entities,
    lightLayout: true,
  });
}

// ---- adapter ----

export const contactsAdapter: VaultAdapter = {
  id: VAULT_ID,
  name: 'Contatos',
  color: VAULT_COLOR,
  colorBy: 'domain',

  async fetchGraph(env: Env, params: GraphParams): Promise<GraphPayload> {
    if (params.q && params.q.trim()) return fetchByQuery(env, params.q.trim(), params);
    if (params.focus) return fetchNeighborhood(env, params.focus, params.depth ?? 1, params);
    if (params.all) return fetchAll(env, params);
    return fetchConnectedSubgraph(env, params);
  },

  async fetchEntity(env: Env, id: string, includePrivate = false): Promise<EntityDetail> {
    const e = await env.DB.prepare('SELECT * FROM entities WHERE id = ?').bind(id).first<any>();
    // Privacidade (spec 61): entidade privada é INDISTINGUÍVEL de inexistente pra
    // quem não vê privados — mesmo erro 'entity not found' (não vazar que existe).
    if (!e || (!includePrivate && e.private === 1)) throw new Error('entity not found');

    // Conexões: omite o vizinho privado quando o caller não vê privados (a aresta
    // some junto). ea.private/eb.private carregados pra filtrar em JS.
    const conns = await env.DB.prepare(
      `SELECT c.id, c.a_id, c.b_id, c.type, c.why,
              ea.name AS a_name, ea.kind AS a_kind, ea.private AS a_private,
              eb.name AS b_name, eb.kind AS b_kind, eb.private AS b_private
         FROM connections c
         JOIN entities ea ON ea.id = c.a_id
         JOIN entities eb ON eb.id = c.b_id
        WHERE c.a_id = ? OR c.b_id = ?`
    ).bind(id, id).all<any>();

    // Eventos: observação/interação privada some da timeline do proxy sem header.
    const privEv = includePrivate ? '' : ' AND private = 0';
    const events = await env.DB.prepare(
      `SELECT kind, ts, context FROM events WHERE entity_id = ?${privEv} ORDER BY ts DESC LIMIT 10`
    ).bind(id).all<any>();

    const avatar = await env.DB.prepare(
      `SELECT content_hash FROM media WHERE entity_id = ? AND kind = 'avatar' ORDER BY created_at DESC LIMIT 1`
    ).bind(id).first<{ content_hash: string }>();

    // Canais da cartela (spec 55) — fonte dos campos de contato clicáveis.
    const channelRows = await getChannels(env, id);

    // Campos montados por kind.
    const fields: EntityDetailField[] = [];
    const push = (label: string, value?: string | null, href?: string, primary?: boolean) => {
      if (value != null && String(value).trim() !== '') fields.push({ label, value: String(value), href, primary });
    };
    if (e.kind === 'company') {
      push('Setor', e.sector);
    } else {
      // person (e demais kinds) — campos de pessoa que NÃO são canais.
      push('Empresa', e.company);
      push('Cargo', e.role);
      push('Aniversário', e.birthday);
      // Perfil enriquecido pela nutrição (10/07/2026) — texto livre em attributes.
      try {
        const a = e.attributes ? JSON.parse(e.attributes) : null;
        if (a) {
          push('Cidade', typeof a.cidade === 'string' ? a.cidade : null);
          push('Família', typeof a.familia === 'string' ? a.familia : null);
          if (Array.isArray(a.interesses) && a.interesses.length) {
            push('Interesses', a.interesses.filter((x: unknown) => typeof x === 'string').join(', '));
          }
        }
      } catch { /* attributes com JSON inválido não derruba o dossiê */ }
    }
    // Canais (email/phone/instagram/linkedin/crm/manychat/site/other) com href pronto,
    // ordenados por kind→primário→posição; primário marcado com selo (spec 55 §5).
    for (const c of channelRows) {
      push(channelFieldLabel(c.kind, c.label), c.value, channelHref(c.kind, c.value) ?? undefined, c.is_primary === 1);
    }
    // Grupos em comum (pedido do dono, 10/07/2026): grupos de WhatsApp onde dono e
    // contato estão juntos. Snapshot gravado pela nutrição em attributes.shared_groups
    // via save_person — aceita ['nome'] (legado) ou [{chat_id, name}]. Quando o grupo
    // já é entidade do vault (whatsapp_links, sync de grupos), o field sai CLICÁVEL
    // pra página do grupo no console do Brain (um field por grupo).
    try {
      const attrs = e.attributes ? JSON.parse(e.attributes) : null;
      const raw: unknown[] = Array.isArray(attrs?.shared_groups) ? attrs.shared_groups : [];
      const groups = raw
        .map((g: any) => (typeof g === 'string'
          ? { chat_id: null as string | null, name: g.trim() }
          : { chat_id: typeof g?.chat_id === 'string' ? g.chat_id : null, name: typeof g?.name === 'string' ? g.name.trim() : '' }))
        .filter((g) => g.name !== '');
      if (groups.length) {
        const linkByChat = new Map<string, string>();
        const withChat = groups.filter((g) => g.chat_id);
        if (withChat.length) {
          try {
            const ph = withChat.map(() => '?').join(',');
            const rows = await env.DB.prepare(
              `SELECT chat_id, entity_id FROM whatsapp_links WHERE chat_id IN (${ph})`
            ).bind(...withChat.map((g) => g.chat_id)).all<{ chat_id: string; entity_id: string }>();
            for (const r of rows.results ?? []) linkByChat.set(r.chat_id, r.entity_id);
          } catch { /* whatsapp_links ausente (integração desligada) → fields sem href */ }
        }
        const brainBase = (env.PUBLIC_BRAIN_URL || '').replace(/\/$/, '');
        for (const g of groups) {
          const gid = g.chat_id ? linkByChat.get(g.chat_id) : undefined;
          push('Grupo em comum', g.name, gid ? `${brainBase}/app/contacts/${gid}` : undefined);
        }
      }
    } catch { /* attributes com JSON inválido não derruba o dossiê */ }
    if (e.last_contacted) push('Último contato', e.last_contacted);

    const connections: EntityDetailConnection[] = (conns.results ?? [])
      // Descarta a aresta cujo OUTRO extremo é privado (quando o caller não vê
      // privados) — o vizinho privado não aparece nem como conexão.
      .filter((c: any) => {
        if (includePrivate) return true;
        const otherPrivate = c.a_id === id ? c.b_private : c.a_private;
        return otherPrivate !== 1;
      })
      .map((c: any) => {
        const isA = c.a_id === id;
        return {
          id: c.id,
          otherId: isA ? c.b_id : c.a_id,
          otherLabel: isA ? c.b_name : c.a_name,
          rel: c.type,
          why: c.why,
        };
      });

    const detailEvents: EntityDetailEvent[] = (events.results ?? []).map((ev: any) => ({
      kind: ev.kind,
      ts: ev.ts,
      context: ev.context ?? undefined,
    }));

    // Valores CRUS pro modo de edição do Console (spec 30-features/36 fase 3).
    // Strings vazias quando null — o input renderiza vazio e o PATCH só reenvia
    // os campos que o usuário mexeu. updated_at = token de concorrência otimista.
    const s = (v: unknown): string => (v == null ? "" : String(v));
    const editable = {
      updated_at: s(e.updated_at),
      name: s(e.name),
      phone: s(e.phone),
      email: s(e.email),
      role: s(e.role),
      company: s(e.company),
      website: s(e.website),
      sector: s(e.sector),
      birthday: s(e.birthday),
      last_contacted: s(e.last_contacted),
      notes_text: s(e.notes_text),
      category: s(e.category),
      // Cartela crua pro CRUD de canais no Console (spec 55).
      channels: channelRows.map((c) => ({
        id: c.id,
        kind: c.kind,
        value: c.value,
        label: c.label,
        is_primary: c.is_primary === 1,
        position: c.position,
        href: channelHref(c.kind, c.value),
      })),
    };

    return {
      id: e.id,
      vault: VAULT_ID,
      title: e.name,
      kind: e.kind,
      fields,
      connections,
      events: detailEvents,
      img: avatar?.content_hash ? `/media/${avatar.content_hash}` : avatarImg(e.avatar_r2_key),
      editable,
      // Selo (spec 61): só o dono chega aqui numa entidade privada — a UI mostra 🔒
      // e o toggle. Boolean explícito pro client (a coluna é INTEGER 0/1).
      private: e.private === 1,
    };
  },

  async createLink(env: Env, body: LinkBody): Promise<{ ok: boolean; id?: string }> {
    const a = (body.source || '').trim();
    const b = (body.target || '').trim();
    const rel = (body.rel || '').trim();
    const why = (body.why || '').trim();

    if (!a || !b) throw new Error('source and target required');
    if (a === b) throw new Error('source and target must differ');
    if (!rel) throw new Error('rel required');
    if (!CONN_TYPES_SET.has(rel)) throw new Error(`invalid rel: ${rel}`);
    if (why.length < 20) throw new Error('why must be at least 20 chars (explain the shared mechanism)');

    let strength = typeof body.strength === 'number' ? body.strength : 0.5;
    if (strength < 0 || strength > 1) throw new Error('strength must be between 0 and 1');

    // tipos simétricos: mesma normalização de par do handleConnect (index.ts) pra
    // que a aresta invertida colida no UNIQUE(a_id,b_id,type). Fonte única em canon.
    const [na, nb] = normalizeConnPair(a, b, rel);

    const both = await env.DB.prepare('SELECT id FROM entities WHERE id IN (?, ?)').bind(na, nb).all<{ id: string }>();
    if ((both.results?.length ?? 0) !== 2) throw new Error('one or both entities not found');

    const id = uuid();
    try {
      await env.DB.prepare(
        `INSERT INTO connections (id, a_id, b_id, type, strength, why) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, na, nb, rel, strength, why).run();
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('UNIQUE')) throw new Error('connection already exists (same a,b,type)');
      if (msg.includes('CHECK')) throw new Error('check constraint failed');
      throw e;
    }
    return { ok: true, id };
  },

  legend(): LegendEntry[] {
    return Object.keys(KIND_LABELS).map((key) => ({
      key,
      label: KIND_LABELS[key],
      color: KIND_COLORS[key] ?? KIND_FALLBACK,
    }));
  },
};
