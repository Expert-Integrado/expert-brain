import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

export interface LayoutNode { id: string; }
export interface LayoutEdge { source: string; target: string; }
export interface LaidOutNode { id: string; x: number; y: number; }

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

export function computeLayout(nodes: LayoutNode[], edges: LayoutEdge[]): LaidOutNode[] {
  // GUARD DE ESCALA (fix Error 1102 — Worker exceeded resource limits). O vault
  // cresceu (backfill) pra ~1800+ nos + ~10k arestas similares, e o forceAtlas2
  // server-side (150 iter) passou a estourar o CPU do Worker toda vez que o cache
  // do grafo invalidava (o que acontece a cada escrita de nota/edge). O layout
  // server e SO um SEED inicial — o d3-force client-side (Web Worker) refina o
  // layout de verdade. Entao acima do teto pulamos o FA2 e devolvemos direto um
  // seed deterministico ESPALHADO (O(n), custo trivial): a bolinha nao nasce
  // amontoada e o cliente refina. Abaixo do teto, FA2 da um seed mais bonito.
  const FA2_MAX_NODES = 900;
  if (nodes.length > FA2_MAX_NODES) {
    const spread = 40 * Math.sqrt(nodes.length);
    return nodes.map((n) => {
      const s = seededPosition(n.id);
      return { id: n.id, x: s.x * spread, y: s.y * spread };
    });
  }

  const g = new Graph({ type: 'undirected', multi: false });
  for (const n of nodes) {
    const seed = seededPosition(n.id);
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
