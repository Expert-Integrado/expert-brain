// Mini graph for the note detail page. Renders a 1-hop ego network around the
// note being viewed: the focal node in the center, explicit + similar edges
// reaching its direct neighbors, nothing else. Click a neighbor to navigate.

import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { domainColor } from '../domain-colors.js';

interface PayloadNode {
  id: string;
  label: string;
  domain: string;
  size: number;
  x: number;
  y: number;
}
interface PayloadEdge {
  id: string;
  source: string;
  target: string;
  type: 'explicit' | 'similar';
  why?: string;
  relation_type?: string;
  score?: number;
}
interface Payload { nodes: PayloadNode[]; edges: PayloadEdge[]; }

async function main() {
  const container = document.getElementById('local-graph');
  if (!container) return;
  const focusId = container.dataset.noteId;
  if (!focusId) return;

  let payload: Payload;
  try {
    const res = await fetch('/app/graph/data', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`data ${res.status}`);
    payload = (await res.json()) as Payload;
  } catch (err) {
    console.warn('local-graph: load failed', err);
    container.innerHTML = '<p class="local-graph-empty">Local graph unavailable.</p>';
    return;
  }

  // Find focal + 1-hop neighbors
  const neighbors = new Set<string>([focusId]);
  for (const e of payload.edges) {
    if (e.source === focusId) neighbors.add(e.target);
    else if (e.target === focusId) neighbors.add(e.source);
  }

  if (neighbors.size <= 1) {
    container.innerHTML = '<p class="local-graph-empty">No connections yet for this note.</p>';
    return;
  }

  const graph = new Graph({ type: 'undirected', multi: true });
  for (const n of payload.nodes) {
    if (!neighbors.has(n.id)) continue;
    const isFocus = n.id === focusId;
    graph.addNode(n.id, {
      label: n.label,
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      size: isFocus ? 16 : 9,
      color: domainColor(n.domain),
      isFocus,
    });
  }

  for (const e of payload.edges) {
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
    if (!neighbors.has(e.source) || !neighbors.has(e.target)) continue;
    // Only include edges that touch the focal node (clean star shape).
    if (e.source !== focusId && e.target !== focusId) continue;
    const color = e.type === 'explicit' ? 'rgba(186, 140, 255, 0.78)' : 'rgba(140, 200, 255, 0.4)';
    try {
      graph.addEdgeWithKey(e.id, e.source, e.target, {
        size: e.type === 'explicit' ? 2 : 1,
        color,
      });
    } catch {
      /* duplicate edge id — ignore */
    }
  }

  // Quick layout pass — few nodes, single shot is fine
  const settings = forceAtlas2.inferSettings(graph);
  forceAtlas2.assign(graph, { iterations: 80, settings: { ...settings, scalingRatio: 12 } });

  const renderer = new Sigma(graph, container as HTMLElement, {
    labelColor: { color: '#f4ecff' },
    labelSize: 12,
    labelWeight: '600',
    labelFont: 'Manrope, system-ui, sans-serif',
    labelDensity: 1,
    labelGridCellSize: 80,
    labelRenderedSizeThreshold: 5,
    defaultEdgeColor: 'rgba(180, 140, 255, 0.5)',
    renderEdgeLabels: false,
    minCameraRatio: 0.2,
    maxCameraRatio: 4,
  });

  renderer.setSetting('nodeReducer', (n, attrs) => {
    if (attrs.isFocus) {
      return {
        ...attrs,
        color: '#a78bfa',
        highlighted: true,
      };
    }
    return attrs;
  });

  renderer.on('clickNode', ({ node }) => {
    if (node === focusId) return;
    window.location.href = `/app/notes/${encodeURIComponent(node)}`;
  });

  (container as HTMLElement).style.cursor = 'grab';
  renderer.on('enterNode', ({ node }) => {
    (container as HTMLElement).style.cursor = node === focusId ? 'default' : 'pointer';
  });
  renderer.on('leaveNode', () => {
    (container as HTMLElement).style.cursor = 'grab';
  });
}

main().catch((err) => console.error('local-graph: fatal', err));
