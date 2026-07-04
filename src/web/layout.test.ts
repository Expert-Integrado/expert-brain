import { describe, it, expect } from 'vitest';
import { computeLayout, type LayoutNode, type LayoutEdge } from './layout.js';

describe('computeLayout', () => {
  it('returns finite x/y for every node of a small graph', () => {
    const nodes: LayoutNode[] = [
      { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
    ];
    const edges: LayoutEdge[] = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'd' },
      { source: 'd', target: 'a' },
    ];
    const result = computeLayout(nodes, edges);
    expect(result).toHaveLength(4);
    for (const n of result) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it('handles an isolated node (no edges) without NaN', () => {
    const result = computeLayout([{ id: 'solo' }], []);
    expect(Number.isFinite(result[0].x)).toBe(true);
    expect(Number.isFinite(result[0].y)).toBe(true);
  });

  it('is deterministic for the same input', () => {
    const nodes: LayoutNode[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const edges: LayoutEdge[] = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
    const r1 = computeLayout(nodes, edges);
    const r2 = computeLayout(nodes, edges);
    expect(r1).toEqual(r2);
  });
});
