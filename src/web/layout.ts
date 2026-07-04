import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

// `domain` é opcional (aditivo) pra não quebrar chamadores existentes que só
// passam `{ id }`. Quando ausente, o nó cai no cluster 'misc' (ver clusteredSeed).
export interface LayoutNode { id: string; domain?: string; }
export interface LayoutEdge { source: string; target: string; }
export interface LaidOutNode { id: string; x: number; y: number; }

// GUARD DE ESCALA (fix Error 1102 — Worker exceeded resource limits). Exportado
// pra virar assert explícito em teste de regressão (test/layout.test.ts) — nada
// impede um refactor futuro de reativar o FA2 acima do teto sem esse assert.
export const FA2_MAX_NODES = 900;

// Seed random positions deterministically by hashing the node id, so that
// identical input graphs produce identical output. forceAtlas2 refines these
// initial positions but the starting point decides the final orientation.
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

// Hash auxiliar (mesma família FNV/DJB2 de seededPosition) só pra derivar o
// jitter dentro do cluster — precisa de 2 valores independentes do id (ângulo +
// raio) além dos 2 já usados por seededPosition, então usa um "salt" fixo no
// hash pra não colidir com o par (x,y) do seed antigo.
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

// Seed clusterizado por domínio, O(n) e determinístico. Nós do mesmo domínio
// nascem próximos (mesmo centro de cluster distribuído num círculo), com
// jitter individual derivado do hash do id — sem FA2, sem O(n²), sem
// dependência de ordem de iteração (domínios ordenados lexicograficamente).
export function clusteredSeed(nodes: LayoutNode[]): LaidOutNode[] {
  const n = nodes.length;
  if (n === 0) return [];

  // 1. Domínios distintos, ordenados (determinismo independente da ordem de
  // chegada das notas no D1). Fallback 'misc' quando domain ausente.
  const byDomain = new Map<string, LayoutNode[]>();
  for (const node of nodes) {
    const d = node.domain?.trim() || 'misc';
    const list = byDomain.get(d);
    if (list) list.push(node); else byDomain.set(d, [node]);
  }
  const domains = Array.from(byDomain.keys()).sort();
  const D = domains.length;

  // 2. Centro de cada cluster num círculo — mesma escala do spread antigo.
  const R = 40 * Math.sqrt(n);
  const centers = new Map<string, { cx: number; cy: number }>();
  domains.forEach((d, i) => {
    const angle = (i / D) * 2 * Math.PI;
    centers.set(d, { cx: R * Math.cos(angle), cy: R * Math.sin(angle) });
  });

  // 3. Cada nó = centro do seu domínio + jitter determinístico. Raio máximo do
  // jitter escala com o tamanho do cluster (cluster grande ocupa mais área).
  // Distribuição radial r = rMax * sqrt(u) pra densidade uniforme no disco
  // (evita amontoar no centro do cluster).
  const out: LaidOutNode[] = [];
  for (const d of domains) {
    const list = byDomain.get(d)!;
    const rMax = 12 * Math.sqrt(list.length);
    for (const node of list) {
      const { cx, cy } = centers.get(d)!;
      const { angle, u } = jitterHash(node.id);
      const r = rMax * Math.sqrt(u);
      out.push({ id: node.id, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
  }
  return out;
}

export function computeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  existing?: ReadonlyMap<string, { x: number; y: number }>,
): LaidOutNode[] {
  // Layout persistente: nó com posição já gravada em `existing` mantém-se
  // parado — não passa pelo FA2 (nem pelo seed). Se `existing` cobre pelo menos
  // 1 nó, o FA2 é pulado por completo pra esse rebuild inteiro (o refinamento
  // fica 100% a cargo do d3-force client-side, que já existe e já é suave o
  // bastante pra não reamontoar nós estáveis). Só nós NOVOS (sem posição em
  // `existing`) são semeados — perto do cluster do domínio deles, calculado
  // sobre o conjunto TOTAL de nós pra reusar os mesmos centros.
  if (existing && existing.size > 0) {
    const seeds = new Map(clusteredSeed(nodes).map((n) => [n.id, n]));
    return nodes.map((n) => {
      const prev = existing.get(n.id);
      if (prev && Number.isFinite(prev.x) && Number.isFinite(prev.y)) {
        return { id: n.id, x: prev.x, y: prev.y };
      }
      const s = seeds.get(n.id) ?? { x: 0, y: 0 };
      return { id: n.id, x: s.x, y: s.y };
    });
  }

  // GUARD DE ESCALA (fix Error 1102 — Worker exceeded resource limits). O vault
  // cresceu (backfill) pra ~1800+ nos + ~10k arestas similares, e o forceAtlas2
  // server-side (150 iter) passou a estourar o CPU do Worker toda vez que o cache
  // do grafo invalidava (o que acontece a cada escrita de nota/edge). O layout
  // server e SO um SEED inicial — o d3-force client-side (Web Worker) refina o
  // layout de verdade. Entao acima do teto pulamos o FA2 e devolvemos direto um
  // seed clusterizado por domínio (O(n), custo trivial): nós do mesmo domínio
  // nascem próximos (em vez de espalhados ao acaso) e o cliente refina.
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
    // Server-side só gera SEED inicial — o D3-force client-side em Web Worker
    // (A.24+) refina o layout de verdade. Reduzimos de 800 → 150 iterações
    // pra cortar ~80% do CPU do Worker server e acelerar /app/graph/data.
    // 150 ainda dá um seed razoável (não amontoado no centro).
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
