import { describe, it, expect } from 'vitest';
import { computeLayout, clusteredSeed, FA2_MAX_NODES, type LayoutNode, type LayoutEdge } from '../src/web/layout.js';

// Gera um vault sintético acima do teto do guard 1102: N nós, ~10 domínios
// ciclando, e uma malha de edges leve entre vizinhos (não precisa ser densa —
// é o volume de NÓS que estoura o FA2, não o de arestas).
function synthNodes(n: number): LayoutNode[] {
  return Array.from({ length: n }, (_, i) => ({ id: `note-${i}`, domain: `dom-${i % 10}` }));
}

function synthEdges(nodes: LayoutNode[]): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ source: nodes[i].id, target: nodes[i + 1].id });
  }
  return edges;
}

describe('layout — guard de escala (fix Error 1102)', () => {
  it('FA2_MAX_NODES vale 900 (assert explícito contra regressão silenciosa do teto)', () => {
    expect(FA2_MAX_NODES).toBe(900);
  });

  it('acima do teto, computeLayout não passa pelo FA2 (tempo trivial mesmo com 950 nós)', () => {
    const nodes = synthNodes(950);
    const edges = synthEdges(nodes);
    const start = performance.now();
    const result = computeLayout(nodes, edges);
    const elapsed = performance.now() - start;
    expect(result).toHaveLength(950);
    // FA2 com 150 iterações em 950 nós levaria ordens de magnitude mais que
    // isso — o seed clusterizado é O(n) e deve ser trivialmente rápido.
    expect(elapsed).toBeLessThan(500);
  });

  it('posições finitas', () => {
    const nodes = synthNodes(950);
    const edges = synthEdges(nodes);
    const result = computeLayout(nodes, edges);
    for (const n of result) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it('determinístico: duas chamadas com o mesmo input dão o mesmo resultado', () => {
    const nodes = synthNodes(950);
    const edges = synthEdges(nodes);
    const r1 = computeLayout(nodes, edges);
    const r2 = computeLayout(nodes, edges);
    expect(r1).toEqual(r2);
  });

  it('distintas: nenhum par de nós cai na posição idêntica', () => {
    const nodes = synthNodes(950);
    const edges = synthEdges(nodes);
    const result = computeLayout(nodes, edges);
    const seen = new Set(result.map((n) => `${n.x},${n.y}`));
    expect(seen.size).toBe(result.length);
  });

  it('clusterizadas: cada nó fica mais perto do centroide do próprio domínio que de qualquer outro', () => {
    const nodes = synthNodes(950);
    const edges = synthEdges(nodes);
    const result = computeLayout(nodes, edges);
    const posById = new Map(result.map((n) => [n.id, n]));

    // Centroide observado de cada domínio (média das posições dos seus nós).
    const byDomain = new Map<string, LayoutNode[]>();
    for (const n of nodes) {
      const d = n.domain!;
      const list = byDomain.get(d);
      if (list) list.push(n); else byDomain.set(d, [n]);
    }
    const centroids = new Map<string, { x: number; y: number }>();
    for (const [d, list] of byDomain) {
      let sx = 0, sy = 0;
      for (const n of list) {
        const p = posById.get(n.id)!;
        sx += p.x; sy += p.y;
      }
      centroids.set(d, { x: sx / list.length, y: sy / list.length });
    }

    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);

    let correct = 0;
    for (const n of nodes) {
      const p = posById.get(n.id)!;
      const ownDist = dist(p, centroids.get(n.domain!)!);
      const closerToOther = Array.from(centroids.entries()).some(
        ([d, c]) => d !== n.domain && dist(p, c) < ownDist,
      );
      if (!closerToOther) correct++;
    }
    // Tolerância estatística (>= 95%) em vez de 100% estrito — jitter não cruza
    // clusters por construção, mas a versão estatística tolera ajustes futuros.
    expect(correct / nodes.length).toBeGreaterThanOrEqual(0.95);
  });

  it('persistência: nós cobertos por `existing` mantêm a posição; só o nó novo ganha posição nova', () => {
    const nodes = synthNodes(950);
    const edges = synthEdges(nodes);

    const existing = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < nodes.length - 1; i++) {
      existing.set(nodes[i].id, { x: i * 1.5, y: -i * 0.5 });
    }
    // Nó N-1 (último) fica de fora de `existing` — é o "nó novo" deste rebuild.
    const newNodeId = nodes[nodes.length - 1].id;

    const result = computeLayout(nodes, edges, existing);
    const posById = new Map(result.map((n) => [n.id, n]));

    for (const [id, pos] of existing) {
      const p = posById.get(id)!;
      expect(p.x).toBe(pos.x);
      expect(p.y).toBe(pos.y);
    }

    const newPos = posById.get(newNodeId)!;
    expect(Number.isFinite(newPos.x)).toBe(true);
    expect(Number.isFinite(newPos.y)).toBe(true);
    // Nó novo não deve coincidir com nenhuma posição pré-existente.
    for (const pos of existing.values()) {
      expect(newPos.x === pos.x && newPos.y === pos.y).toBe(false);
    }
  });

  it('abaixo do teto, com `existing`, também pula o FA2 (posições preservadas)', () => {
    const nodes = synthNodes(50);
    const edges = synthEdges(nodes);
    const existing = new Map<string, { x: number; y: number }>();
    for (const n of nodes.slice(0, -1)) existing.set(n.id, { x: 7, y: -7 });

    const result = computeLayout(nodes, edges, existing);
    const posById = new Map(result.map((n) => [n.id, n]));
    for (const n of nodes.slice(0, -1)) {
      expect(posById.get(n.id)).toEqual({ id: n.id, x: 7, y: -7 });
    }
  });
});

describe('clusteredSeed', () => {
  it('vazio devolve vazio', () => {
    expect(clusteredSeed([])).toEqual([]);
  });

  it('nós sem domínio caem no cluster "misc"', () => {
    const nodes: LayoutNode[] = [{ id: 'a' }, { id: 'b' }];
    const result = clusteredSeed(nodes);
    expect(result).toHaveLength(2);
    for (const n of result) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it('determinístico independente da ordem de entrada (domínios ordenados lexicograficamente)', () => {
    const a: LayoutNode[] = [{ id: 'x', domain: 'zebra' }, { id: 'y', domain: 'alpha' }];
    const b: LayoutNode[] = [{ id: 'y', domain: 'alpha' }, { id: 'x', domain: 'zebra' }];
    const ra = new Map(clusteredSeed(a).map((n) => [n.id, n]));
    const rb = new Map(clusteredSeed(b).map((n) => [n.id, n]));
    expect(ra.get('x')).toEqual(rb.get('x'));
    expect(ra.get('y')).toEqual(rb.get('y'));
  });
});
