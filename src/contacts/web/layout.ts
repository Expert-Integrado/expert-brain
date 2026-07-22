// Layout de força (forceatlas2) — porta direta do Expert Brain (src/web/layout.ts).
// Recebe nós+arestas (só ids) e devolve x/y por nó. O servidor só gera um SEED
// inicial razoável; o refino fino fica pro client.
//
// Determinístico: mesmo grafo → mesmo layout (cache estável por sourceHash).
//
// Duas defesas portadas do incidente 1102 do Brain (spec 10-backend/21):
//  1. GUARD DE ESCALA (FA2_MAX_NODES): acima do teto, PULA o forceAtlas2 (que
//     estourava o CPU do Worker — Error 1102) e devolve direto o seed clusterizado
//     O(n). Como computeLayoutScaled delega o núcleo pro computeLayout, o guard
//     protege TODOS os modos.
//  2. SEED CLUSTERIZADO por cluster (kind da entidade): nós do mesmo cluster
//     nascem próximos, em vez de espalhados ao acaso pelo hash puro do id.

import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

// `cluster` é opcional (aditivo) pra não quebrar chamadores que só passam `{ id }`.
// Quando ausente, o nó cai no cluster 'other' (ver clusteredSeed).
export interface LayoutNode { id: string; cluster?: string; }
export interface LayoutEdge { source: string; target: string; }
export interface LaidOutNode { id: string; x: number; y: number; }

// GUARD DE ESCALA (fix Error 1102 — Worker exceeded resource limits). Exportado
// pra virar assert explícito em teste de regressão — nada impede um refactor futuro
// de reativar o FA2 acima do teto sem esse assert.
export const FA2_MAX_NODES = 900;

// Seed determinístico por hash do id, pra grafos idênticos darem layout idêntico.
// Fallback quando o nó não tem cluster (mantém o comportamento anterior).
function seededPosition(id: string): { x: number; y: number } {
  let h1 = 2166136261;
  let h2 = 5381;
  for (let i = 0; i < id.length; i++) {
    h1 = Math.imul(h1 ^ id.charCodeAt(i), 16777619);
    h2 = ((h2 << 5) + h2) ^ id.charCodeAt(i);
  }
  return {
    x: ((h1 >>> 0) % 1000) / 1000 - 0.5,
    y: ((h2 >>> 0) % 1000) / 1000 - 0.5,
  };
}

// Hash auxiliar (mesma família FNV/DJB2 de seededPosition) só pra derivar o jitter
// dentro do cluster — precisa de 2 valores independentes do id (ângulo + raio) além
// dos 2 já usados por seededPosition, então usa um "salt" fixo no hash pra não
// colidir com o par (x,y) do seed antigo.
function jitterHash(id: string): { angle: number; u: number } {
  let h1 = 2166136261;
  let h2 = 5381;
  const salted = `jitter:${id}`;
  for (let i = 0; i < salted.length; i++) {
    h1 = Math.imul(h1 ^ salted.charCodeAt(i), 16777619);
    h2 = ((h2 << 5) + h2) ^ salted.charCodeAt(i);
  }
  return {
    angle: ((h1 >>> 0) % 10000) / 10000 * 2 * Math.PI,
    u: ((h2 >>> 0) % 10000) / 10000,
  };
}

// Seed clusterizado por cluster (kind da entidade), O(n) e determinístico. Nós do
// mesmo cluster nascem próximos (mesmo centro distribuído num círculo), com jitter
// individual derivado do hash do id — sem FA2, sem O(n²), sem dependência de ordem
// de iteração (clusters ordenados lexicograficamente). Porta de clusteredSeed do Brain.
export function clusteredSeed(nodes: LayoutNode[]): LaidOutNode[] {
  const n = nodes.length;
  if (n === 0) return [];

  // 1. Clusters distintos, ordenados (determinismo independente da ordem de chegada
  // das entidades no D1). Fallback 'other' quando cluster ausente.
  const byCluster = new Map<string, LayoutNode[]>();
  for (const node of nodes) {
    const c = node.cluster?.trim() || 'other';
    const list = byCluster.get(c);
    if (list) list.push(node); else byCluster.set(c, [node]);
  }
  const clusters = Array.from(byCluster.keys()).sort();
  const C = clusters.length;

  // 2. Centro de cada cluster num círculo.
  const R = 40 * Math.sqrt(n);
  const centers = new Map<string, { cx: number; cy: number }>();
  clusters.forEach((c, i) => {
    const angle = (i / C) * 2 * Math.PI;
    centers.set(c, { cx: R * Math.cos(angle), cy: R * Math.sin(angle) });
  });

  // 3. Cada nó = centro do seu cluster + jitter determinístico. Raio máximo do
  // jitter escala com o tamanho do cluster (cluster grande ocupa mais área).
  // Distribuição radial r = rMax * sqrt(u) pra densidade uniforme no disco.
  const out: LaidOutNode[] = [];
  for (const c of clusters) {
    const list = byCluster.get(c)!;
    const rMax = 12 * Math.sqrt(list.length);
    for (const node of list) {
      const { cx, cy } = centers.get(c)!;
      const { angle, u } = jitterHash(node.id);
      const r = rMax * Math.sqrt(u);
      out.push({ id: node.id, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
  }
  return out;
}

// Layout "escalado" pra grafos GRANDES (milhares de nós, maioria isolada):
// roda forceAtlas2 SÓ no núcleo conectado (poucos nós) e ESPALHA os isolados num
// halo determinístico (anel por hash) ao redor. O(n) nos isolados. O núcleo passa
// pelo computeLayout — que já tem o guard de escala, protegendo também este modo.
export function computeLayoutScaled(nodes: LayoutNode[], edges: LayoutEdge[]): LaidOutNode[] {
  const connected = new Set<string>();
  for (const e of edges) { connected.add(e.source); connected.add(e.target); }
  const coreNodes = nodes.filter((n) => connected.has(n.id));
  const laidCore = coreNodes.length ? computeLayout(coreNodes, edges) : [];
  const pos = new Map(laidCore.map((n) => [n.id, { x: n.x, y: n.y }]));
  const out: LaidOutNode[] = [];
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (p) { out.push({ id: n.id, x: p.x, y: p.y }); continue; }
    const s = seededPosition(n.id); // ~[-0.5, 0.5]
    const ang = (s.x + 0.5) * Math.PI * 2;
    const rad = 4 + (s.y + 0.5) * 4; // halo a partir do raio ~4 (fora do núcleo)
    out.push({ id: n.id, x: Math.cos(ang) * rad, y: Math.sin(ang) * rad });
  }
  return out;
}

export function computeLayout(nodes: LayoutNode[], edges: LayoutEdge[]): LaidOutNode[] {
  // GUARD DE ESCALA (fix Error 1102 — Worker exceeded resource limits). Acima do teto
  // o forceAtlas2 server-side (150 iter) estourava o CPU do Worker a cada invalidação
  // de cache (o sourceHash muda em qualquer save_person/connect). O layout server é SÓ
  // um SEED — o client refina. Então acima do teto pulamos o FA2 e devolvemos direto o
  // seed clusterizado por cluster (O(n), custo trivial).
  if (nodes.length > FA2_MAX_NODES) {
    return clusteredSeed(nodes);
  }

  const g = new Graph({ type: 'undirected', multi: false });
  const seeds = new Map(clusteredSeed(nodes).map((n) => [n.id, n]));
  for (const n of nodes) {
    const seed = seeds.get(n.id) ?? seededPosition(n.id);
    g.addNode(n.id, { x: seed.x, y: seed.y });
  }
  for (const e of edges) {
    if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
    if (e.source === e.target) continue;
    if (g.hasEdge(e.source, e.target)) continue;
    g.addEdge(e.source, e.target);
  }

  const settings = forceAtlas2.inferSettings(g);
  forceAtlas2.assign(g, {
    // Server-side só gera SEED inicial — o refino de verdade fica pro client.
    // 150 iterações dá um seed razoável (não amontoado no centro) sem queimar CPU.
    iterations: 150,
    settings: {
      ...settings,
      barnesHutOptimize: true,
      scalingRatio: 18,
      gravity: 0.5,
      slowDown: 5,
    },
  });

  return nodes.map((n) => {
    const attrs = g.getNodeAttributes(n.id);
    const x = Number.isFinite(attrs.x) ? attrs.x : 0;
    const y = Number.isFinite(attrs.y) ? attrs.y : 0;
    return { id: n.id, x, y };
  });
}
