// Mini graph for the note detail page. Renders an N-hop ego network around the
// note being viewed. Slider on top lets the reader adjust depth (1-3 hops).
// Click a neighbor to navigate.

import Graph from 'graphology';
import Sigma from 'sigma';
import { EdgeRectangleProgram } from 'sigma/rendering';
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

function expandNeighborhood(
  focusId: string,
  edges: PayloadEdge[],
  hops: number,
): Map<string, number> {
  // Build adjacency from EXPLICIT edges only — semantic similar edges geram
  // ruído quando expande pra 2-3 hops.
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.type !== 'explicit') continue;
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }

  // BFS retornando map<id, hopDistance>
  const distance = new Map<string, number>();
  distance.set(focusId, 0);
  let frontier = new Set<string>([focusId]);
  for (let h = 0; h < hops; h++) {
    const next = new Set<string>();
    for (const id of frontier) {
      const nbrs = adj.get(id);
      if (!nbrs) continue;
      for (const nb of nbrs) {
        if (!distance.has(nb)) {
          distance.set(nb, h + 1);
          next.add(nb);
        }
      }
    }
    if (next.size === 0) break;
    frontier = next;
  }
  return distance;
}

let currentRenderer: Sigma | null = null;

function render(
  container: HTMLElement,
  focusId: string,
  payload: Payload,
  hops: number,
) {
  if (currentRenderer) {
    currentRenderer.kill();
    currentRenderer = null;
  }

  const distance = expandNeighborhood(focusId, payload.edges, hops);

  if (distance.size <= 1) {
    container.innerHTML = '<p class="local-graph-empty">No connections yet for this note.</p>';
    return;
  }

  const graph = new Graph({ type: 'undirected', multi: true });
  for (const n of payload.nodes) {
    if (!distance.has(n.id)) continue;
    const hop = distance.get(n.id)!;
    const isFocus = hop === 0;
    graph.addNode(n.id, {
      label: n.label,
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      // Tamanho decai com hop: 16 (focus), 10 (1-hop), 7 (2-hop), 5 (3-hop)
      size: isFocus ? 16 : Math.max(5, 11 - hop * 2),
      color: domainColor(n.domain),
      isFocus,
      hop,
    });
  }

  for (const e of payload.edges) {
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
    if (!distance.has(e.source) || !distance.has(e.target)) continue;
    if (e.type !== 'explicit') continue;
    try {
      graph.addEdgeWithKey(e.id, e.source, e.target, {
        size: 0.8,
        color: 'rgba(120, 120, 120, 0.45)',
      });
    } catch {
      /* duplicate edge id — ignore */
    }
  }

  const settings = forceAtlas2.inferSettings(graph);
  forceAtlas2.assign(graph, {
    iterations: 120,
    settings: { ...settings, scalingRatio: 12, gravity: 1.0 },
  });

  const renderer = new Sigma(graph, container, {
    labelColor: { color: '#f4ecff' },
    labelSize: 12,
    labelWeight: '600',
    labelFont: 'Manrope, system-ui, sans-serif',
    labelDensity: 1,
    labelGridCellSize: 80,
    labelRenderedSizeThreshold: 5,
    defaultEdgeColor: 'rgba(120, 120, 120, 0.45)',
    defaultEdgeType: 'rectangle',
    edgeProgramClasses: { rectangle: EdgeRectangleProgram },
    renderEdgeLabels: false,
    minCameraRatio: 0.2,
    maxCameraRatio: 4,
  });

  // Esconde o loading central após primeiro render.
  let _localLoadingHidden = false;
  renderer.on('afterRender', () => {
    if (_localLoadingHidden) return;
    const loading = document.getElementById('local-graph-loading');
    if (loading) loading.classList.add('hidden');
    _localLoadingHidden = true;
  });

  renderer.setSetting('nodeReducer', (n, attrs) => {
    if (attrs.isFocus) {
      return { ...attrs, color: '#a78bfa', highlighted: true };
    }
    return attrs;
  });

  renderer.on('clickNode', ({ node }) => {
    if (node === focusId) return;
    window.location.href = `/app/notes/${encodeURIComponent(node)}`;
  });

  container.style.cursor = 'grab';
  renderer.on('enterNode', ({ node }) => {
    container.style.cursor = node === focusId ? 'default' : 'pointer';
  });
  renderer.on('leaveNode', () => {
    container.style.cursor = 'grab';
  });

  currentRenderer = renderer;
}

async function main() {
  const container = document.getElementById('local-graph') as HTMLElement | null;
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

  let hops = 1;
  render(container, focusId, payload, hops);

  const slider = document.getElementById('local-graph-hops') as HTMLInputElement | null;
  const valueLabel = document.getElementById('local-graph-hops-value');
  if (slider) {
    slider.addEventListener('input', () => {
      hops = Number(slider.value);
      if (valueLabel) valueLabel.textContent = `${hops} salto${hops > 1 ? 's' : ''}`;
      render(container, focusId, payload, hops);
    });
  }
}

main().catch((err) => console.error('local-graph: fatal', err));
