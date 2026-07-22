// Adapter do vault "brain" — REMOTO (HTTP).
//
// Diferente do contacts (in-process, lê env.DB direto), o Brain é OUTRO Worker
// (expert-brain.contato-d9a.workers.dev). Este adapter fala com ele via HTTP,
// autenticando com Bearer <env.VAULT_BRAIN_TOKEN> (== GRAPH_EXPORT_TOKEN do Brain,
// porta de auth aditiva nas rotas /app/graph/*). Sem token → 401/redirect lá.
//
// O Brain JÁ devolve o shape comum (GraphPayload do Brain: nodes{id,label,domain,
// size,x,y} + edges explicit{relation_type,why}/similar{score} + computedAt +
// sourceHash). A normalização aqui é quase passthrough: só carimba vault:'brain'.
//
// IMPORTANTE: o endpoint /app/graph/data do Brain IGNORA query params — sempre
// devolve o grafo inteiro. Então os modos focus/q são derivados aqui em memória a
// partir do payload completo (BFS por edges explícitas pro focus; filtro de label
// pro q). É o subgrafo no servidor do Console, não no Brain.

import type { Env } from '../env';
import type {
  VaultAdapter,
  GraphPayload,
  GraphNode,
  GraphEdge,
  ExplicitGraphEdge,
  GraphParams,
  EntityDetail,
  EntityDetailField,
  EntityDetailConnection,
  LinkBody,
  LegendEntry,
} from './types';
import { DOMAIN_COLORS, DOMAIN_FALLBACK } from '../web/brain-domain-colors.js';

// ---- constantes ----
const VAULT_ID = 'brain';
const VAULT_COLOR = '#a855f7'; // roxo — distingue do ciano do Contacts no header
const BRAIN_BASE = 'https://expert-brain.contato-d9a.workers.dev';
const BRAIN_NOTE_URL = (id: string) => `${BRAIN_BASE}/app/notes/${id}`;
const MAX_FOCUS_NODES = 400; // teto do subgrafo ego pra um hub gigante não explodir

// Rótulos PT-BR pros 12 domínios canônicos do Brain (legenda dinâmica).
const DOMAIN_LABELS: Record<string, string> = {
  'management': 'Gestão',
  'sales': 'Vendas',
  'marketing': 'Marketing',
  'education': 'Educação',
  'ai-applied': 'IA Aplicada',
  'leadership': 'Liderança',
  'product': 'Produto',
  'operations': 'Operações',
  'personal-development': 'Desenvolvimento Pessoal',
  'entrepreneurship': 'Empreendedorismo',
  'cognitive-science': 'Ciência Cognitiva',
  'music': 'Música',
};

// ---- shape do payload que o Brain devolve (espelha o GraphPayload do Brain) ----
interface BrainNode { id: string; label: string; domain: string; size: number; x: number; y: number; }
interface BrainExplicitEdge { id: string; source: string; target: string; type: 'explicit'; why: string; relation_type: string; }
interface BrainSimilarEdge { id: string; source: string; target: string; type: 'similar'; score: number; }
type BrainEdge = BrainExplicitEdge | BrainSimilarEdge;
interface BrainPayload {
  nodes: BrainNode[];
  edges: BrainEdge[];
  computedAt: number;
  sourceHash: string;
}

// ---- HTTP helpers ----

function authHeaders(env: Env): Record<string, string> {
  const tok = env.VAULT_BRAIN_TOKEN;
  if (!tok) throw new Error('VAULT_BRAIN_TOKEN não configurado');
  return { authorization: `Bearer ${tok}` };
}

// Roteia a chamada pro Worker do Brain. Cloudflare bloqueia fetch() global entre
// 2 Workers da mesma conta (erro 1042), então PREFERE o service binding env.BRAIN
// (Worker-to-Worker direto). O fallback global fetch só serve dev local sem o
// binding. A requisição é HTTP normal com header Bearer — a auth aditiva do Brain
// (authorizeGraphExport) vale igual nos dois caminhos.
async function brainFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const url = `${BRAIN_BASE}${path}`;
  const headers = { ...authHeaders(env), ...(init?.headers as Record<string, string> | undefined) };
  const req = new Request(url, { ...init, headers, redirect: 'manual' });
  if (env.BRAIN) return env.BRAIN.fetch(req);
  return fetch(req);
}

// Baixa o grafo COMPLETO do Brain (o endpoint não filtra por params). Cacheado
// pelo graph-api por TTL — aqui é sempre uma chamada fresca.
async function fetchBrainGraph(env: Env): Promise<BrainPayload> {
  const res = await brainFetch(env, '/app/graph/data');
  if (res.status === 401 || res.status === 302 || res.status === 403) {
    throw new Error(`brain auth failed (${res.status}) — confira VAULT_BRAIN_TOKEN`);
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`brain /app/graph/data ${res.status} :: ${snippet}`);
  }
  return (await res.json()) as BrainPayload;
}

// Normaliza BrainPayload → GraphPayload comum (só carimba vault).
function toCommonPayload(brain: BrainPayload): GraphPayload {
  const nodes: GraphNode[] = brain.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    domain: n.domain,
    size: n.size,
    x: n.x,
    y: n.y,
  }));
  const edges: GraphEdge[] = brain.edges.map((e) =>
    e.type === 'explicit'
      ? { id: e.id, source: e.source, target: e.target, type: 'explicit', why: e.why, relation_type: e.relation_type }
      : { id: e.id, source: e.source, target: e.target, type: 'similar', score: e.score },
  );
  return {
    vault: VAULT_ID,
    nodes,
    edges,
    computedAt: brain.computedAt,
    sourceHash: brain.sourceHash,
  };
}

// Subgrafo ego (N hops por edges EXPLÍCITAS) ao redor de um nó — espelha o
// handleNoteGraph do Brain, mas roda aqui porque o endpoint remoto não foca.
function neighborhood(brain: BrainPayload, focus: string, depth: number): BrainPayload {
  const maxHops = Math.max(1, Math.min(depth || 1, 4));
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const l = adj.get(a);
    if (l) l.push(b); else adj.set(a, [b]);
  };
  for (const e of brain.edges) {
    if (e.type !== 'explicit') continue;
    link(e.source, e.target);
    link(e.target, e.source);
  }
  const keep = new Set<string>([focus]);
  let frontier = [focus];
  for (let h = 0; h < maxHops && keep.size < MAX_FOCUS_NODES; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!keep.has(nb)) { keep.add(nb); next.push(nb); }
        if (keep.size >= MAX_FOCUS_NODES) break;
      }
      if (keep.size >= MAX_FOCUS_NODES) break;
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return {
    nodes: brain.nodes.filter((n) => keep.has(n.id)),
    edges: brain.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    computedAt: brain.computedAt,
    sourceHash: brain.sourceHash,
  };
}

// Filtro por substring de label (?q=) — o endpoint do Brain não faz busca
// semântica via token, então degradamos pra match de texto + vizinhança direta.
function byQuery(brain: BrainPayload, q: string, limit: number): BrainPayload {
  const needle = q.toLowerCase();
  const seeds = new Set<string>();
  for (const n of brain.nodes) {
    if (n.label.toLowerCase().includes(needle)) seeds.add(n.id);
    if (seeds.size >= limit) break;
  }
  // Inclui vizinhos diretos (1 hop) dos seeds pra dar contexto ao subgrafo.
  const keep = new Set<string>(seeds);
  for (const e of brain.edges) {
    if (e.type !== 'explicit') continue;
    if (seeds.has(e.source)) keep.add(e.target);
    if (seeds.has(e.target)) keep.add(e.source);
  }
  return {
    nodes: brain.nodes.filter((n) => keep.has(n.id)),
    edges: brain.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    computedAt: brain.computedAt,
    sourceHash: brain.sourceHash,
  };
}

// ---- adapter ----

export const brainAdapter: VaultAdapter = {
  id: VAULT_ID,
  name: 'Brain',
  color: VAULT_COLOR,
  colorBy: 'domain',

  async fetchGraph(env: Env, params: GraphParams): Promise<GraphPayload> {
    const brain = await fetchBrainGraph(env);
    // all (ou default) → grafo inteiro. O Brain (~800-1000 notas) cabe sem
    // amostragem; o force layout já vem pré-computado (x/y) do servidor do Brain.
    if (params.q && params.q.trim()) {
      const limit = Math.min(params.limit ?? 50, 200);
      return toCommonPayload(byQuery(brain, params.q.trim(), limit));
    }
    if (params.focus) {
      return toCommonPayload(neighborhood(brain, params.focus, params.depth ?? 1));
    }
    return toCommonPayload(brain);
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetchEntity(env: Env, id: string, _includePrivate?: boolean): Promise<EntityDetail> {
    // O Brain não expõe eixo de privacidade por este proxy — ignora includePrivate.
    // O Brain não expõe endpoint de detalhe por token nesta tarefa, então montamos
    // o EntityDetail a partir do grafo completo: acha o nó + as edges explícitas
    // que o tocam (connections). Nada inventado — só o que o grafo já carrega.
    const brain = await fetchBrainGraph(env);
    const node = brain.nodes.find((n) => n.id === id);
    if (!node) throw new Error('note not found');

    const fields: EntityDetailField[] = [];
    if (node.domain) {
      fields.push({ label: 'Domínio', value: DOMAIN_LABELS[node.domain] ?? node.domain });
    }
    // Link pra abrir a nota completa no dashboard do Brain.
    fields.push({ label: 'Brain', value: 'Abrir no Brain', href: BRAIN_NOTE_URL(id) });

    // Connections = edges EXPLÍCITAS que tocam o nó. Similares são ruído de
    // vizinhança semântica, não relação justificada — ficam fora do painel.
    const connections: EntityDetailConnection[] = [];
    const labelOf = new Map(brain.nodes.map((n) => [n.id, n.label]));
    for (const e of brain.edges) {
      if (e.type !== 'explicit') continue;
      if (e.source !== id && e.target !== id) continue;
      const otherId = e.source === id ? e.target : e.source;
      connections.push({
        id: e.id,
        otherId,
        otherLabel: labelOf.get(otherId) ?? otherId,
        rel: e.relation_type,
        why: e.why,
      });
    }

    // Note não tem eventos — omitimos (events?: opcional no contrato).
    return {
      id,
      vault: VAULT_ID,
      title: node.label,
      kind: 'note',
      fields,
      connections,
    };
  },

  async createLink(env: Env, body: LinkBody): Promise<{ ok: boolean; id?: string }> {
    const source = (body.source || '').trim();
    const target = (body.target || '').trim();
    const why = (body.why || '').trim();
    if (!source || !target) throw new Error('source and target required');
    if (source === target) throw new Error('source and target must differ');
    // O Brain exige why ≥ 8 chars e ignora rel (hardcoda analogous_to). Espelhamos
    // o piso aqui pra dar erro amigável antes do round-trip.
    if (why.length < 8) throw new Error('why must be at least 8 chars');

    // O handleGraphLink do Brain espera { source, target, why } — não rel/strength.
    const res = await brainFetch(env, '/app/graph/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, target, why }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string };
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `brain link failed (${res.status})`);
    }
    return { ok: true, id: data.id };
  },

  legend(): LegendEntry[] {
    return Object.keys(DOMAIN_LABELS).map((key) => ({
      key,
      label: DOMAIN_LABELS[key],
      color: DOMAIN_COLORS[key] ?? DOMAIN_FALLBACK,
    }));
  },
};
