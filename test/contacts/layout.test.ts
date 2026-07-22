import { describe, it, expect } from 'vitest';
import { computeLayout, clusteredSeed, FA2_MAX_NODES, type LayoutNode } from '../../src/contacts/web/layout';

// Spec 10-backend/21 Parte 2 — guard de escala (fix 1102) + seed clusterizado.

const mkNodes = (count: number): LayoutNode[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    cluster: i % 3 === 0 ? 'person' : i % 3 === 1 ? 'company' : 'other',
  }));

describe('computeLayout — guard FA2_MAX_NODES (fix Error 1102)', () => {
  it('> 900 nós NÃO executa forceAtlas2 (retorna exatamente o seed clusterizado)', () => {
    const nodes = mkNodes(FA2_MAX_NODES + 1);
    const out = computeLayout(nodes, []);
    // acima do teto o guard retorna clusteredSeed(nodes) direto — deep-equal prova
    // que o forceAtlas2 (que MOVE as posições) não rodou.
    expect(out).toEqual(clusteredSeed(nodes));
    expect(out.length).toBe(nodes.length);
    expect(out.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it('≤ 900 nós executa o caminho FA2 (posições finitas, ids preservados)', () => {
    const nodes = mkNodes(50);
    const edges = [{ source: 'n0', target: 'n1' }, { source: 'n1', target: 'n2' }];
    const out = computeLayout(nodes, edges);
    expect(out.length).toBe(50);
    expect(out.map((n) => n.id).sort()).toEqual(nodes.map((n) => n.id).sort());
    expect(out.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it('determinístico — mesmo input → mesmo output (≤ 900)', () => {
    const nodes = mkNodes(40);
    const edges = [{ source: 'n0', target: 'n5' }, { source: 'n2', target: 'n7' }];
    expect(computeLayout(nodes, edges)).toEqual(computeLayout(nodes, edges));
  });

  it('determinístico acima do teto também', () => {
    const nodes = mkNodes(FA2_MAX_NODES + 200);
    expect(computeLayout(nodes, [])).toEqual(computeLayout(nodes, []));
  });
});

describe('clusteredSeed — âncora por cluster + jitter determinístico', () => {
  it('vazio → []', () => {
    expect(clusteredSeed([])).toEqual([]);
  });

  it('determinístico e cobre todos os nós', () => {
    const nodes = mkNodes(30);
    const a = clusteredSeed(nodes);
    const b = clusteredSeed(nodes);
    expect(a).toEqual(b);
    expect(a.map((n) => n.id).sort()).toEqual(nodes.map((n) => n.id).sort());
  });

  it('nós do mesmo cluster ficam mais perto do centro comum do que de outro cluster', () => {
    // 2 clusters bem povoados; a distância média intra-cluster < distância entre centros.
    const nodes: LayoutNode[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, cluster: 'person' })),
      ...Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, cluster: 'company' })),
    ];
    const pos = new Map(clusteredSeed(nodes).map((n) => [n.id, n]));
    const centroid = (prefix: string) => {
      const pts = nodes.filter((n) => n.id.startsWith(prefix)).map((n) => pos.get(n.id)!);
      return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
    };
    const cp = centroid('p'), cc = centroid('c');
    const dCenters = Math.hypot(cp.x - cc.x, cp.y - cc.y);
    // espalhamento médio dentro do cluster 'person'
    const spread = nodes.filter((n) => n.id.startsWith('p'))
      .map((n) => Math.hypot(pos.get(n.id)!.x - cp.x, pos.get(n.id)!.y - cp.y))
      .reduce((s, d) => s + d, 0) / 20;
    expect(dCenters).toBeGreaterThan(spread);
  });

  it("cluster ausente cai em 'other' (sem quebrar)", () => {
    const out = clusteredSeed([{ id: 'x' }, { id: 'y' }]);
    expect(out.length).toBe(2);
    expect(out.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });
});
