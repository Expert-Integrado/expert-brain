import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';

interface GraphNode { id: string; label: string; domain: string; size: number; x: number; y: number; }
interface ExplicitEdge { id: string; source: string; target: string; type: 'explicit'; why: string; relation_type: string; }
interface SimilarEdge { id: string; source: string; target: string; type: 'similar'; score: number; }
type Edge = ExplicitEdge | SimilarEdge;
interface Payload { nodes: GraphNode[]; edges: Edge[]; }

// Stable pastel color per domain via FNV-1a hash → HSL hue, converted to hex
// because Sigma's WebGL program expects hex/rgb, not hsl() strings.
function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const c = lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(c * 255);
  };
  const r = f(0), g = f(8), b = f(4);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function domainColor(domain: string): string {
  let h = 2166136261;
  for (let i = 0; i < domain.length; i++) h = Math.imul(h ^ domain.charCodeAt(i), 16777619);
  const hue = (h >>> 0) % 360;
  return hslToHex(hue, 70, 72);
}

async function main() {
  const res = await fetch('/app/graph/data', { credentials: 'same-origin' });
  if (!res.ok) {
    document.getElementById('graph-count')!.textContent = 'Failed to load graph';
    return;
  }
  const payload = (await res.json()) as Payload;

  const container = document.getElementById('graph-canvas') as HTMLElement;
  const graph = new Graph({ type: 'undirected', multi: true });

  // Nodes start clustered near origin with small random jitter so force-atlas2
  // has a non-degenerate starting point and can "explode" them outward. This
  // is what gives the Obsidian-style reveal — the physics converges from a
  // collapsed ball into the final layout over ~2 seconds.
  for (const n of payload.nodes) {
    graph.addNode(n.id, {
      label: n.label,
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      size: 7 + n.size * 3.5,
      color: domainColor(n.domain),
    });
  }

  // Only explicit edges go into the graphology graph (Sigma draws them solid).
  // Similar edges are kept out and drawn on a Canvas 2D overlay with setLineDash
  // — Sigma v3's WebGL edge programs can't render dashed lines natively.
  const similarEdges: Array<{ source: string; target: string }> = [];
  for (const e of payload.edges) {
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
    if (e.type === 'explicit') {
      graph.addEdgeWithKey(e.id, e.source, e.target, {
        type: 'line',
        size: 2.2,
        color: 'rgba(180, 140, 255, 0.75)',
      });
    } else {
      similarEdges.push({ source: e.source, target: e.target });
    }
  }

  // Custom hover renderer: Sigma v3's default draws a WHITE rounded rectangle
  // behind the label (legacy light-theme style). We replace it with a dark
  // Midnight Nebula pill so the label is readable on hover.
  function drawDarkHover(
    ctx: CanvasRenderingContext2D,
    data: { x: number; y: number; size: number; label?: string | null },
    settings: { labelSize: number; labelWeight: string; labelFont: string }
  ) {
    const label = data.label ?? '';
    if (!label) return;
    const size = settings.labelSize;
    ctx.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    const textWidth = ctx.measureText(label).width;

    const padX = 10;
    const padY = 6;
    const offsetX = data.size + 8;
    const boxX = data.x + offsetX;
    const boxY = data.y - size / 2 - padY;
    const boxW = textWidth + padX * 2;
    const boxH = size + padY * 2;
    const radius = 8;

    // Pill background
    ctx.fillStyle = 'rgba(20, 12, 51, 0.94)';
    ctx.strokeStyle = 'rgba(180, 140, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const rr = (ctx as unknown as { roundRect?: Function }).roundRect;
    if (typeof rr === 'function') {
      (ctx as unknown as { roundRect: (x: number, y: number, w: number, h: number, r: number) => void })
        .roundRect(boxX, boxY, boxW, boxH, radius);
    } else {
      ctx.rect(boxX, boxY, boxW, boxH);
    }
    ctx.fill();
    ctx.stroke();

    // Text
    ctx.fillStyle = '#ecdfff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, boxX + padX, data.y);
  }

  const renderer = new Sigma(graph, container, {
    labelColor: { color: '#ecdfff' },
    labelSize: 13,
    labelWeight: '600',
    labelFont: 'Manrope, system-ui, sans-serif',
    labelDensity: 1,
    labelGridCellSize: 80,
    labelRenderedSizeThreshold: 18,
    defaultNodeColor: '#b48cff',
    defaultEdgeColor: 'rgba(180, 140, 255, 0.5)',
    renderEdgeLabels: false,
    minCameraRatio: 0.1,
    maxCameraRatio: 10,
    defaultDrawNodeHover: drawDarkHover as any,
  });

  const explicitCount = payload.edges.filter((e) => e.type === 'explicit').length;
  const similarCount = payload.edges.length - explicitCount;
  document.getElementById('graph-count')!.textContent =
    `${payload.nodes.length} notes · ${explicitCount} explicit · ${similarCount} similar`;

  // Hover state is referenced by both the dashed-edge overlay (below) and the
  // nodeReducer (further down), so declare it up front to avoid TDZ.
  let hoveredNeighbors: Set<string> | null = null;

  // -----------------------------------------------------------------------
  // Dashed similar-edge overlay: 2D canvas positioned on top of Sigma's WebGL
  // canvas. Repainted after every Sigma render via the 'afterRender' event, so
  // it stays in sync with pan/zoom/drag.
  // -----------------------------------------------------------------------
  const overlay = document.createElement('canvas');
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '2';
  container.appendChild(overlay);
  const octx = overlay.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;

  function sizeOverlay() {
    const { width, height } = container.getBoundingClientRect();
    overlay.width = Math.round(width * dpr);
    overlay.height = Math.round(height * dpr);
    overlay.style.width = width + 'px';
    overlay.style.height = height + 'px';
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeOverlay();
  window.addEventListener('resize', sizeOverlay);

  function drawSimilarEdges() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (similarEdges.length === 0) return;
    octx.save();
    octx.lineWidth = 1.2;
    octx.setLineDash([6, 5]);
    octx.lineCap = 'round';

    const highlight = 'rgba(140, 200, 255, 0.6)';
    const dim = 'rgba(140, 200, 255, 0.12)';

    for (const e of similarEdges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      // Dim (don't hide) similar edges outside the hovered neighborhood.
      const isActive = !hoveredNeighbors || (hoveredNeighbors.has(e.source) && hoveredNeighbors.has(e.target));
      octx.strokeStyle = isActive ? highlight : dim;
      const a = renderer.graphToViewport({
        x: graph.getNodeAttribute(e.source, 'x') as number,
        y: graph.getNodeAttribute(e.source, 'y') as number,
      });
      const b = renderer.graphToViewport({
        x: graph.getNodeAttribute(e.target, 'x') as number,
        y: graph.getNodeAttribute(e.target, 'y') as number,
      });
      octx.beginPath();
      octx.moveTo(a.x, a.y);
      octx.lineTo(b.x, b.y);
      octx.stroke();
    }
    octx.restore();
  }

  renderer.on('afterRender', drawSimilarEdges);
  renderer.on('resize', sizeOverlay);

  // -----------------------------------------------------------------------
  // Live physics loop (Obsidian-style force-directed reveal + drag feedback)
  // -----------------------------------------------------------------------
  // Each animation frame we run a single force-atlas2 iteration. With
  // Barnes-Hut this is O(n log n) and stays well under 16ms at 1000+ nodes.
  // Sigma re-renders automatically whenever node attributes change.
  //
  // The loop runs for ~3 seconds on load (initial reveal), then stops. During
  // drag we restart the loop so other nodes react physically to the grabbed
  // node — the dragged node's x/y is overwritten from the pointer on every
  // frame, which "pins" it while physics still processes its neighbors.
  const fa2Settings = forceAtlas2.inferSettings(graph);
  const physicsSettings = {
    ...fa2Settings,
    barnesHutOptimize: true,
    // Trust inferSettings for gravity/scaling (tuned to graph order). Only
    // halve slowDown so ~240 RAF frames × REVEAL_LERP=0.06 actually converge
    // to a round-ish cluster inside 4s — otherwise strongGravityMode keeps
    // collapsing the layout along the weaker axis and we get a vertical strip.
    slowDown: Math.max(2, (fa2Settings.slowDown ?? 1) / 2),
  };

  // Instead of applying force-atlas2 steps at full speed (which snaps small
  // graphs into place in ~5 frames), we compute where physics WANTS each node
  // to be, then lerp toward that target. REVEAL_LERP controls reveal tempo —
  // 0.06 gives ~2 seconds to settle on small graphs, which reads as a smooth
  // "cascade" instead of a flash.
  const REVEAL_LERP = 0.06;
  const DRAG_LERP = 0.18; // snappier during drag so neighbors chase in real time

  let physicsUntil = 0;
  let rafHandle = 0;

  // Sigma normalizes coords into [0,1]² using max(dx,dy) — preserving aspect —
  // then applies a correctionRatio so the cluster touches the short viewport
  // axis. Camera at {x:0.5,y:0.5,ratio:1} is therefore the canonical fit.
  // refresh() recomputes normalization against the live node bbox (which
  // expands as FA2 runs); ratio:1.05 adds a tiny breathing margin without
  // re-introducing the hardcoded zoom that caused the clipping bug.
  function refitCamera() {
    renderer.refresh();
    renderer.getCamera().setState({ x: 0.5, y: 0.5, angle: 0, ratio: 1.05 });
  }

  function runPhysics(durationMs: number) {
    physicsUntil = Math.max(physicsUntil, Date.now() + durationMs);
    if (rafHandle) return;

    const loop = () => {
      // Snapshot current positions.
      const prev = new Map<string, { x: number; y: number }>();
      graph.forEachNode((id, attrs) => {
        prev.set(id, { x: attrs.x as number, y: attrs.y as number });
      });

      // Run one physics iteration — this overwrites x/y with target positions.
      forceAtlas2.assign(graph, { iterations: 1, settings: physicsSettings });

      // Lerp every node from its previous position toward the physics target.
      const lerp = drag ? DRAG_LERP : REVEAL_LERP;
      graph.forEachNode((id, attrs) => {
        const p = prev.get(id)!;
        const targetX = attrs.x as number;
        const targetY = attrs.y as number;
        graph.setNodeAttribute(id, 'x', p.x + (targetX - p.x) * lerp);
        graph.setNodeAttribute(id, 'y', p.y + (targetY - p.y) * lerp);
      });

      // While dragging, pin the grabbed node directly to the pointer (no lerp).
      if (drag) {
        graph.setNodeAttribute(drag.node, 'x', drag.pointer.x);
        graph.setNodeAttribute(drag.node, 'y', drag.pointer.y);
      }

      // Keep the camera fitting the expanding bbox during reveal — otherwise
      // nodes fly outside the initial viewport as they explode outward.
      if (!drag) refitCamera();

      if (Date.now() < physicsUntil || drag) {
        rafHandle = requestAnimationFrame(loop);
      } else {
        rafHandle = 0;
        renderer.refresh();
        void renderer.getCamera().animatedReset({ duration: 400 });
      }
    };
    rafHandle = requestAnimationFrame(loop);
  }

  // Initial reveal: run physics for 4 seconds on load.
  runPhysics(4000);

  // -----------------------------------------------------------------------
  // Hover highlight (dim non-neighbors via reducer)
  // -----------------------------------------------------------------------
  renderer.setSetting('nodeReducer', (n, attrs) => {
    if (!hoveredNeighbors) return attrs;
    if (hoveredNeighbors.has(n)) return attrs;
    return { ...attrs, color: 'rgba(60, 50, 90, 0.35)', label: '' };
  });
  renderer.setSetting('edgeReducer', (edge, attrs) => {
    if (!hoveredNeighbors) return attrs;
    const [s, t] = graph.extremities(edge);
    return hoveredNeighbors.has(s) && hoveredNeighbors.has(t)
      ? attrs
      : { ...attrs, color: 'rgba(180, 140, 255, 0.04)' };
  });

  // -----------------------------------------------------------------------
  // Drag: pin node to pointer, physics reacts around it
  // -----------------------------------------------------------------------
  let drag: { node: string; pointer: { x: number; y: number } } | null = null;
  let didDrag = false;

  renderer.on('enterNode', ({ node }) => {
    container.style.cursor = drag ? 'grabbing' : 'grab';
    const neighbors = new Set<string>([node]);
    graph.forEachNeighbor(node, (n) => neighbors.add(n));
    hoveredNeighbors = neighbors;
    renderer.refresh();
  });
  renderer.on('leaveNode', () => {
    if (!drag) container.style.cursor = '';
    hoveredNeighbors = null;
    renderer.refresh();
  });

  renderer.on('downNode', ({ node }) => {
    drag = {
      node,
      pointer: {
        x: graph.getNodeAttribute(node, 'x') as number,
        y: graph.getNodeAttribute(node, 'y') as number,
      },
    };
    didDrag = false;
    container.style.cursor = 'grabbing';
    renderer.getCamera().disable();
    // Restart physics so neighbors react live.
    runPhysics(4000);
  });

  renderer.getMouseCaptor().on('mousemovebody', (e) => {
    if (!drag) return;
    drag.pointer = renderer.viewportToGraph(e);
    didDrag = true;
    e.preventSigmaDefault();
    e.original.preventDefault();
    e.original.stopPropagation();
  });

  const release = () => {
    if (drag) {
      drag = null;
      container.style.cursor = '';
      // Let physics run a bit more so everything resettles smoothly.
      runPhysics(1500);
    }
    renderer.getCamera().enable();
  };
  renderer.getMouseCaptor().on('mouseup', release);
  renderer.getMouseCaptor().on('mouseleave', release);

  renderer.on('clickNode', ({ node }) => {
    if (didDrag) { didDrag = false; return; }
    window.location.href = `/app/notes/${encodeURIComponent(node)}`;
  });
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('graph-count');
  if (el) el.textContent = 'Error loading graph';
});
