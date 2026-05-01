import Graph from 'graphology';
import Sigma from 'sigma';
import { EdgeRectangleProgram } from 'sigma/rendering';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import Fuse from 'fuse.js';
import { DOMAIN_COLORS, DOMAIN_FALLBACK, domainColor, domainColorMuted } from '../domain-colors.js';

// ──────────────────────────────────────────────────────────────────────────────
// Payload shape (matches src/web/graph-data.ts server-side)
// ──────────────────────────────────────────────────────────────────────────────

interface GraphNode {
  id: string;
  label: string;
  domain: string;
  size: number;
  x: number;
  y: number;
  // Added client-side after load:
  kind?: string;
  tldr?: string;
}
interface ExplicitEdge {
  id: string;
  source: string;
  target: string;
  type: 'explicit';
  why: string;
  relation_type: string;
}
interface SimilarEdge {
  id: string;
  source: string;
  target: string;
  type: 'similar';
  score: number;
}
type Edge = ExplicitEdge | SimilarEdge;
interface Payload { nodes: GraphNode[]; edges: Edge[]; }

// Node metadata fetched from /app/graph/meta (title, kind, tldr, domains array).
// Kept separate from the graph payload so GRAPH_CACHE stays small and the
// slide panel can render without an extra round trip per click.
interface NoteMeta {
  id: string;
  title: string;
  kind: string;
  tldr: string;
  domains: string[];
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

async function main() {
  // Parallel load: graph topology + note metadata. Meta endpoint is additive —
  // if it fails we degrade to id-only panel content rather than aborting.
  const [graphRes, metaRes] = await Promise.all([
    fetch('/app/graph/data', { credentials: 'same-origin' }),
    fetch('/app/graph/meta', { credentials: 'same-origin' }),
  ]);
  if (!graphRes.ok) {
    setStatus('Failed to load graph');
    return;
  }
  const payload = (await graphRes.json()) as Payload;
  const meta: Map<string, NoteMeta> = new Map();
  if (metaRes.ok) {
    try {
      const list = (await metaRes.json()) as NoteMeta[];
      for (const m of list) meta.set(m.id, m);
      for (const n of payload.nodes) {
        const m = meta.get(n.id);
        if (m) { n.kind = m.kind; n.tldr = m.tldr; }
      }
    } catch (err) {
      console.warn('graph: meta parse failed', err);
    }
  }

  const container = document.getElementById('graph-canvas') as HTMLElement;
  const graph = new Graph({ type: 'undirected', multi: true });

  // Compute degree up front — used for node fade on zoom-out, label priority.
  const degreeById = new Map<string, number>();
  const bumpDegree = (id: string) => degreeById.set(id, (degreeById.get(id) ?? 0) + 1);

  // Phase A.6 — Obsidian-faithful: nodes default cinza-claro neutro
  // (equivalente a --text-muted do Obsidian dark theme). Cor por domínio
  // continua armazenada como `domainColor` em attrs, ativada via toggle.
  const NEUTRAL_NODE_COLOR = '#b8b8c8';
  for (const n of payload.nodes) {
    graph.addNode(n.id, {
      label: n.label,
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      // A.9 — n.size já é o valor final do Obsidian (range 8-30). Usar direto.
      size: n.size,
      color: NEUTRAL_NODE_COLOR,
      domainColor: domainColor(n.domain), // guardado pra toggle Cores
      domain: n.domain,
      kind: n.kind ?? '',
    });
  }

  const similarEdges: Array<{ source: string; target: string; score: number }> = [];
  let explicitCount = 0;
  let similarCount = 0;
  for (const e of payload.edges) {
    if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
    bumpDegree(e.source); bumpDegree(e.target);
    if (e.type === 'explicit') {
      explicitCount++;
      graph.addEdgeWithKey(e.id, e.source, e.target, {
        // A.19 — linha base 25% (255*0.25=64). Pré-multiplicado, ver A.17.
        size: 0.7,
        color: 'rgba(64, 64, 64, 0.25)',
      });
    } else {
      similarCount++;
      similarEdges.push({ source: e.source, target: e.target, score: e.score });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Status + legend
  // ────────────────────────────────────────────────────────────────────────
  setStatus(`${payload.nodes.length} notes · ${explicitCount} explicit · ${similarCount} similar`);

  renderLegend(payload.nodes);

  // ────────────────────────────────────────────────────────────────────────
  // Sigma renderer — label thresholds deliberately conservative so labels
  // ONLY appear on hover or when the camera zooms deep into a cluster. The
  // previous config (labelDensity=1, labelRenderedSizeThreshold=18) rendered
  // every label every frame, turning the viewport into text soup at small
  // zoom. labelRenderedSizeThreshold is in *rendered pixels*, not graph
  // units — at camera.ratio≈1 a node of graph-size 10 renders at ~10px;
  // setting the threshold to 10 plus a dynamic bump in the reducer below
  // means only zoomed-in nodes get labels by default.
  // ────────────────────────────────────────────────────────────────────────
  const renderer = new Sigma(graph, container, {
    labelColor: { color: '#e5e5ea' },
    labelSize: 12,
    labelWeight: '500',
    labelFont: 'Manrope, system-ui, sans-serif',
    labelDensity: 0.07,
    labelGridCellSize: 160,
    // Phase A.2 — Obsidian-style: raise threshold to 18px rendered. Labels só
    // aparecem em zoom alto (ou hover). Reducer dinâmico abaixo continua
    // forçando label em zoom <0.6 / hubs em zoom <1.3 / hover.
    labelRenderedSizeThreshold: 18,
    defaultNodeColor: DOMAIN_FALLBACK,
    // A.13 — alinhado: 6% (linha quase invisível, só destaca no hover).
    defaultEdgeColor: 'rgba(64, 64, 64, 0.25)',
    // A.16 — Sigma 3 só registra EdgeLineProgram por default. Pra usar
    // 'rectangle' (triangle strips com blending de alpha de verdade) precisa
    // registrar o programa via edgeProgramClasses E setar defaultEdgeType.
    // A.15 só setava o type sem registrar → Sigma crashava silencioso e
    // graph ficava em branco.
    defaultEdgeType: 'rectangle',
    edgeProgramClasses: {
      rectangle: EdgeRectangleProgram,
    },
    renderEdgeLabels: false,
    minCameraRatio: 0.08,
    maxCameraRatio: 12,
    defaultDrawNodeHover: drawDarkHover as any,
  });

  // Dynamic label threshold: when zoomed in (ratio < 0.5) show more labels;
  // when far out (ratio > 2) only show labels for high-degree hubs.
  // Implemented as a nodeReducer side-effect on `label` rather than changing
  // the sigma setting — cheaper and preserves Sigma's grid culling.
  const baseLabel = new Map<string, string>();
  graph.forEachNode((id, attrs) => { baseLabel.set(id, attrs.label as string); });

  // ────────────────────────────────────────────────────────────────────────
  // UI state
  // ────────────────────────────────────────────────────────────────────────
  const state = {
    hoveredNode: null as string | null,
    hoveredNeighbors: null as Set<string> | null,
    similarOpacity: 0.18,               // slider 0..1
    hideSimilar: false,
    domainFilter: null as Set<string> | null,  // null = all visible
    kindFilter: null as Set<string> | null,
    searchQuery: '',
    searchMatches: new Set<string>(),
    selectedNodeId: null as string | null,
    showColors: false, // A.6 — toggle Obsidian-faithful default OFF
  };

  // ────────────────────────────────────────────────────────────────────────
  // Glow overlay (Phase A.3) — sits ABOVE the Sigma WebGL canvases with
  // mix-blend-mode 'screen' so the halo lightens nodes without occluding
  // them. zIndex: 1 keeps it under the similar-edge overlay (zIndex: 2).
  // ────────────────────────────────────────────────────────────────────────
  const glowCanvas = document.createElement('canvas');
  glowCanvas.style.position = 'absolute';
  glowCanvas.style.inset = '0';
  glowCanvas.style.pointerEvents = 'none';
  glowCanvas.style.mixBlendMode = 'screen';
  glowCanvas.style.zIndex = '1';
  container.appendChild(glowCanvas);
  const gctx = glowCanvas.getContext('2d')!;

  // ────────────────────────────────────────────────────────────────────────
  // Similar edge overlay (2D canvas on top of Sigma WebGL). Repainted every
  // 'afterRender' so pan/zoom stay in sync. Respects slider + filter state.
  // ────────────────────────────────────────────────────────────────────────
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
    glowCanvas.width = Math.round(width * dpr);
    glowCanvas.height = Math.round(height * dpr);
    glowCanvas.style.width = width + 'px';
    glowCanvas.style.height = height + 'px';
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeOverlay();
  window.addEventListener('resize', sizeOverlay);

  // ────────────────────────────────────────────────────────────────────────
  // Phase A.6 — Obsidian-faithful hover ring. Substituto do glow per-node:
  // único anel fino (1px de tela) ao redor do nó hovered. Igual à
  // implementação do app.js do Obsidian: o.lineStyle(E,M.rgb,1) onde
  // E = max(1, 1/scale).
  // ────────────────────────────────────────────────────────────────────────
  function drawHoverRing() {
    gctx.clearRect(0, 0, glowCanvas.width, glowCanvas.height);
    if (!state.hoveredNode) return;
    if (!graph.hasNode(state.hoveredNode)) return;
    const id = state.hoveredNode;
    const attrs = graph.getNodeAttributes(id);
    const v = renderer.graphToViewport({ x: attrs.x as number, y: attrs.y as number });
    const camRatio = renderer.getCamera().ratio;
    const renderedRadius = (attrs.size as number) / camRatio;
    const ringRadius = renderedRadius + 4;

    gctx.save();
    gctx.lineWidth = 1.2;
    gctx.strokeStyle = state.showColors
      ? (attrs.domainColor as string) || '#ffffff'
      : 'rgba(255, 255, 255, 0.85)';
    gctx.beginPath();
    gctx.arc(v.x, v.y, ringRadius, 0, Math.PI * 2);
    gctx.stroke();
    gctx.restore();
  }

  function hexToRgba(hex: string, alpha: number): string {
    if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function drawSimilarEdges() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (state.hideSimilar || state.similarOpacity <= 0 || similarEdges.length === 0) return;

    octx.save();
    octx.lineWidth = 1.1;
    octx.setLineDash([6, 5]);
    octx.lineCap = 'round';

    for (const e of similarEdges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      if (!isNodeActive(e.source) || !isNodeActive(e.target)) continue;

      // When hovering a node, boost similar edges touching its ego network
      // and dim the rest so the local structure reads without hiding context.
      let alpha = state.similarOpacity;
      if (state.hoveredNeighbors) {
        const inEgo = state.hoveredNeighbors.has(e.source) && state.hoveredNeighbors.has(e.target);
        alpha = inEgo ? Math.max(0.55, state.similarOpacity) : state.similarOpacity * 0.25;
      }

      octx.strokeStyle = `rgba(140, 200, 255, ${alpha})`;
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

  renderer.on('afterRender', () => {
    drawSimilarEdges();
    drawHoverRing();
  });
  renderer.on('resize', sizeOverlay);

  // ────────────────────────────────────────────────────────────────────────
  // Reducers: apply filter + ego highlight + dynamic labels
  // ────────────────────────────────────────────────────────────────────────
  function isNodeActive(id: string): boolean {
    if (state.domainFilter && state.domainFilter.size > 0) {
      const d = graph.getNodeAttribute(id, 'domain') as string;
      if (!state.domainFilter.has(d)) return false;
    }
    if (state.kindFilter && state.kindFilter.size > 0) {
      const k = graph.getNodeAttribute(id, 'kind') as string;
      if (!state.kindFilter.has(k)) return false;
    }
    return true;
  }

  renderer.setSetting('nodeReducer', (n, attrs) => {
    const camRatio = renderer.getCamera().ratio;
    const degree = degreeById.get(n) ?? 0;
    const active = isNodeActive(n);

    // A.6 — cor base: saturada se toggle Cores está ON, cinza neutro se OFF
    const baseColor = state.showColors
      ? (attrs.domainColor as string) || (attrs.color as string)
      : (attrs.color as string);

    // Filter out: heavy dim, no label
    if (!active) {
      return { ...attrs, color: 'rgba(70, 70, 90, 0.12)', label: '', size: (attrs.size as number) * 0.6 };
    }

    // Search hit: bright + enlarged
    if (state.searchMatches.size > 0 && state.searchMatches.has(n)) {
      return { ...attrs, color: baseColor, size: (attrs.size as number) * 1.6, zIndex: 10 };
    }

    // A.6 — hovered node: NÃO faz scale (Obsidian não escala). Ring fino
    // desenhado no overlay 2D acima dá o destaque visual. Apenas força label.
    if (state.hoveredNode === n) {
      return { ...attrs, color: baseColor, label: baseLabel.get(n) ?? '', zIndex: 20 };
    }

    // Ego dim: hovered node's neighborhood stays bright, rest fade to ghosts
    if (state.hoveredNeighbors && !state.hoveredNeighbors.has(n)) {
      return { ...attrs, color: 'rgba(70, 70, 90, 0.25)', label: '' };
    }

    // Degree fade on zoom-out: leaf nodes become quiet at far camera
    if (camRatio > 2.8 && degree <= 1 && state.hoveredNeighbors == null) {
      return { ...attrs, color: hexWithAlpha(baseColor, 0.45) };
    }

    // Dynamic labels:
    // - zoomed in (<0.6) → always show
    // - mid (<1.3) → show if degree ≥ 3 (hubs)
    // - zoomed out → only in hover (handled by reducer above)
    const base = baseLabel.get(n) ?? '';
    let label: string | null = attrs.label as string;
    if (camRatio < 0.6) label = base;
    else if (camRatio < 1.3 && degree >= 3) label = base;
    else label = null;
    return { ...attrs, color: baseColor, label: label ?? '' };
  });

  renderer.setSetting('edgeReducer', (edge, attrs) => {
    // A.19 — base 25%, hover ego 75% (255*0.75≈191), inactive 2% (255*0.02≈5).
    // Pré-multiplicação manual: ver A.17.
    const [s, t] = graph.extremities(edge);
    if (!isNodeActive(s) || !isNodeActive(t)) {
      return { ...attrs, color: 'rgba(5, 5, 5, 0.02)', hidden: true };
    }
    if (state.hoveredNeighbors) {
      const keep = state.hoveredNeighbors.has(s) && state.hoveredNeighbors.has(t);
      return keep
        ? { ...attrs, color: 'rgba(191, 191, 191, 0.75)', size: (attrs.size as number) * 1.6 }
        : { ...attrs, color: 'rgba(5, 5, 5, 0.02)' };
    }
    return attrs;
  });

  // ────────────────────────────────────────────────────────────────────────
  // Physics: ForceAtlas2 reveal with early-stop on convergence
  // ────────────────────────────────────────────────────────────────────────
  const fa2Settings = forceAtlas2.inferSettings(graph);
  const physicsSettings = {
    ...fa2Settings,
    barnesHutOptimize: true,
    slowDown: Math.max(2, (fa2Settings.slowDown ?? 1) / 2),
  };
  const REVEAL_LERP = 0.06;
  const DRAG_LERP = 0.18;
  const CONVERGENCE_EPSILON = 0.35;   // max-delta below this counts as "settled"
  const CONVERGENCE_WINDOW = 30;      // consecutive frames under ε before stopping

  let physicsUntil = 0;
  let rafHandle = 0;
  let convergenceStreak = 0;

  // A.20 — snapshot do layout em equilíbrio. Capturado UMA vez na primeira
  // convergência do reveal physics. Reset restaura sempre essa posição,
  // independente de quantos drags o usuário tenha feito depois.
  let restSnapshot: Map<string, { x: number; y: number }> | null = null;

  function refitCamera() {
    renderer.refresh();
    renderer.getCamera().setState({ x: 0.5, y: 0.5, angle: 0, ratio: 1.05 });
  }

  function runPhysics(durationMs: number) {
    physicsUntil = Math.max(physicsUntil, Date.now() + durationMs);
    convergenceStreak = 0;
    if (rafHandle) return;

    const loop = () => {
      const prev = new Map<string, { x: number; y: number }>();
      graph.forEachNode((id, attrs) => {
        prev.set(id, { x: attrs.x as number, y: attrs.y as number });
      });

      forceAtlas2.assign(graph, { iterations: 1, settings: physicsSettings });

      const lerp = drag ? DRAG_LERP : REVEAL_LERP;
      let maxDelta = 0;
      graph.forEachNode((id, attrs) => {
        const p = prev.get(id)!;
        const targetX = attrs.x as number;
        const targetY = attrs.y as number;
        const dx = (targetX - p.x) * lerp;
        const dy = (targetY - p.y) * lerp;
        const newX = p.x + dx;
        const newY = p.y + dy;
        graph.setNodeAttribute(id, 'x', newX);
        graph.setNodeAttribute(id, 'y', newY);
        const magnitude = Math.hypot(dx, dy);
        if (magnitude > maxDelta) maxDelta = magnitude;
      });

      if (drag) {
        graph.setNodeAttribute(drag.node, 'x', drag.pointer.x);
        graph.setNodeAttribute(drag.node, 'y', drag.pointer.y);
      }

      if (!drag) refitCamera();

      // Convergence detection — only active after the initial 4s reveal has
      // had a chance to spread nodes. Prevents early-stop during the first
      // collapse-to-cluster phase.
      const elapsedFromStart = Date.now() - initialStart;
      if (!drag && elapsedFromStart > 2500) {
        if (maxDelta < CONVERGENCE_EPSILON) convergenceStreak++;
        else convergenceStreak = 0;
      }

      const shouldStop =
        !drag &&
        (Date.now() >= physicsUntil || convergenceStreak >= CONVERGENCE_WINDOW);

      if (!shouldStop) {
        rafHandle = requestAnimationFrame(loop);
      } else {
        rafHandle = 0;
        renderer.refresh();
        void renderer.getCamera().animatedReset({ duration: 400 });
        // A.20 — captura snapshot UMA vez, na primeira convergência sem drag.
        // Drags subsequentes não atualizam → Reset volta ao layout original.
        if (!restSnapshot && !drag) {
          restSnapshot = new Map();
          graph.forEachNode((id, attrs) => {
            restSnapshot!.set(id, { x: attrs.x as number, y: attrs.y as number });
          });
        }
      }
    };
    rafHandle = requestAnimationFrame(loop);
  }

  // A.20 — restaura snapshot do layout original. Usado pelo botão Reset.
  function resetGraphLayout() {
    if (!restSnapshot) return;
    // Para physics em curso pra evitar lerp lutando contra o snapshot.
    physicsUntil = 0;
    convergenceStreak = CONVERGENCE_WINDOW;
    restSnapshot.forEach((pos, id) => {
      if (graph.hasNode(id)) {
        graph.setNodeAttribute(id, 'x', pos.x);
        graph.setNodeAttribute(id, 'y', pos.y);
      }
    });
    renderer.refresh();
    void renderer.getCamera().animate(
      { x: 0.5, y: 0.5, ratio: 1.05, angle: 0 },
      { duration: 400 },
    );
  }

  const initialStart = Date.now();
  runPhysics(4000);

  // ────────────────────────────────────────────────────────────────────────
  // Hover highlight
  // ────────────────────────────────────────────────────────────────────────
  renderer.on('enterNode', ({ node }) => {
    container.style.cursor = drag ? 'grabbing' : 'grab';
    const neighbors = new Set<string>([node]);
    graph.forEachNeighbor(node, (n) => neighbors.add(n));
    state.hoveredNode = node;
    state.hoveredNeighbors = neighbors;
    renderer.refresh();
  });
  renderer.on('leaveNode', () => {
    if (!drag) container.style.cursor = '';
    state.hoveredNode = null;
    state.hoveredNeighbors = null;
    renderer.refresh();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Drag — pin node to pointer, physics reacts live
  // ────────────────────────────────────────────────────────────────────────
  let drag: { node: string; pointer: { x: number; y: number } } | null = null;
  let didDrag = false;
  // A.21 — igual Obsidian: drag só é confirmado depois de 5px de movimento.
  // Movimento menor é tratado como click puro (sem disparar physics).
  let dragOrigin: { x: number; y: number } | null = null;
  const DRAG_THRESHOLD_SQ = 25; // 5px²

  renderer.on('downNode', ({ node, event }) => {
    drag = {
      node,
      pointer: {
        x: graph.getNodeAttribute(node, 'x') as number,
        y: graph.getNodeAttribute(node, 'y') as number,
      },
    };
    didDrag = false;
    // A.21 — captura ponto inicial em viewport (px) pra threshold de 5px.
    dragOrigin = { x: event.x, y: event.y };
    container.style.cursor = 'grabbing';
    renderer.getCamera().disable();
  });

  renderer.getMouseCaptor().on('mousemovebody', (e) => {
    if (!drag) return;
    if (!didDrag && dragOrigin) {
      // A.21 — só confirma drag depois de 5px de movimento (igual Obsidian).
      // Movimento menor é tratado como click — não atualiza pointer nem dispara
      // physics, então o layout fica intacto.
      const dx = e.x - dragOrigin.x;
      const dy = e.y - dragOrigin.y;
      if (dx * dx + dy * dy <= DRAG_THRESHOLD_SQ) return;
      didDrag = true;
      runPhysics(4000);
    }
    drag.pointer = renderer.viewportToGraph(e);
    e.preventSigmaDefault();
    e.original.preventDefault();
    e.original.stopPropagation();
  });

  const release = () => {
    if (drag) {
      const wasDragging = didDrag;
      drag = null;
      dragOrigin = null;
      container.style.cursor = '';
      if (wasDragging) runPhysics(1500);
    }
    renderer.getCamera().enable();
  };
  renderer.getMouseCaptor().on('mouseup', release);
  renderer.getMouseCaptor().on('mouseleave', release);

  // ────────────────────────────────────────────────────────────────────────
  // Click → open side panel instead of navigating away
  // ────────────────────────────────────────────────────────────────────────
  renderer.on('clickNode', ({ node }) => {
    if (didDrag) { didDrag = false; return; }
    openPanel(node);
  });
  renderer.on('clickStage', () => {
    closePanel();
  });

  // Allow opening a note from external code (eg. search enter, command palette)
  function focusNode(id: string) {
    if (!graph.hasNode(id)) return;
    const x = graph.getNodeAttribute(id, 'x') as number;
    const y = graph.getNodeAttribute(id, 'y') as number;
    const cam = renderer.getCamera();
    cam.animate({ x, y, ratio: 0.35 }, { duration: 500 });
    openPanel(id);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Slide panel (Obsidian-style) — visual state, no navigation
  // ────────────────────────────────────────────────────────────────────────
  const panel = ensurePanel();
  function openPanel(nodeId: string) {
    state.selectedNodeId = nodeId;
    const node = graph.getNodeAttributes(nodeId);
    const m = meta.get(nodeId);
    const title = (node.label as string) ?? nodeId;
    const domainChips = m?.domains?.length
      ? m.domains.map((d) => `<span class="panel-chip" style="--chip:${domainColor(d)}">${esc(d)}</span>`).join('')
      : `<span class="panel-chip" style="--chip:${domainColor(node.domain as string)}">${esc(node.domain as string)}</span>`;
    const kindBadge = m?.kind ? `<span class="panel-kind">${esc(m.kind)}</span>` : '';
    const tldrBlock = m?.tldr ? `<p class="panel-tldr">${esc(m.tldr)}</p>` : '';

    const neighbors = new Set<string>();
    graph.forEachNeighbor(nodeId, (n) => neighbors.add(n));

    panel.innerHTML = `
      <button class="panel-close" aria-label="Close panel">×</button>
      <div class="panel-meta">${kindBadge}<span class="panel-degree">${neighbors.size} connections</span></div>
      <h2 class="panel-title">${esc(title)}</h2>
      <div class="panel-chips">${domainChips}</div>
      ${tldrBlock}
      <a class="panel-open" href="/app/notes/${encodeURIComponent(nodeId)}">Open full note →</a>
    `;
    panel.classList.add('open');
    panel.querySelector('.panel-close')?.addEventListener('click', closePanel, { once: true });
  }
  function closePanel() {
    state.selectedNodeId = null;
    panel.classList.remove('open');
  }

  // ────────────────────────────────────────────────────────────────────────
  // Controls: search + domain/kind filters + opacity slider + zoom buttons
  // ────────────────────────────────────────────────────────────────────────
  const fuse = new Fuse(payload.nodes, {
    keys: [
      { name: 'label', weight: 0.7 },
      { name: 'tldr', weight: 0.3 },
    ],
    threshold: 0.35,
    minMatchCharLength: 2,
    ignoreLocation: true,
  });

  wireControls({
    onSearch: (q) => {
      state.searchQuery = q;
      if (!q) {
        state.searchMatches = new Set();
      } else {
        const hits = fuse.search(q, { limit: 20 });
        state.searchMatches = new Set(hits.map((h) => h.item.id));
      }
      renderer.refresh();
    },
    onSearchSubmit: (q) => {
      if (!q) return;
      const hits = fuse.search(q, { limit: 1 });
      if (hits[0]) focusNode(hits[0].item.id);
    },
    onDomainToggle: (domain, active) => {
      if (!state.domainFilter) state.domainFilter = new Set();
      if (active) state.domainFilter.add(domain);
      else state.domainFilter.delete(domain);
      if (state.domainFilter.size === 0) state.domainFilter = null;
      renderer.refresh();
    },
    onKindToggle: (kind, active) => {
      if (!state.kindFilter) state.kindFilter = new Set();
      if (active) state.kindFilter.add(kind);
      else state.kindFilter.delete(kind);
      if (state.kindFilter.size === 0) state.kindFilter = null;
      renderer.refresh();
    },
    onSimilarOpacity: (v) => { state.similarOpacity = v; renderer.refresh(); },
    onSimilarHide: (hide) => { state.hideSimilar = hide; renderer.refresh(); },
    onShowColors: (show) => { state.showColors = show; renderer.refresh(); },
    onZoomIn: () => renderer.getCamera().animatedZoom({ duration: 280 }),
    onZoomOut: () => renderer.getCamera().animatedUnzoom({ duration: 280 }),
    onFit: () => {
      renderer.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1.05 }, { duration: 400 });
    },
    onResetFilters: () => {
      state.domainFilter = null;
      state.kindFilter = null;
      state.searchQuery = '';
      state.searchMatches = new Set();
      const input = document.getElementById('graph-search-input') as HTMLInputElement | null;
      if (input) input.value = '';
      document.querySelectorAll('.graph-chip.active').forEach((el) => el.classList.remove('active'));
      // A.20 — Reset agora também restaura o layout original (snapshot).
      resetGraphLayout();
      renderer.refresh();
    },
  }, payload.nodes);

  // Keyboard: Esc closes panel; / focuses search
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
    if (e.key === '/' && !isTypingInInput()) {
      const input = document.getElementById('graph-search-input') as HTMLInputElement | null;
      if (input) { e.preventDefault(); input.focus(); }
    }
  });
}

function isTypingInInput(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
    }
    return c;
  });
}

function setStatus(text: string) {
  const el = document.getElementById('graph-count');
  if (el) el.textContent = text;
}

function hexWithAlpha(color: string, alpha: number): string {
  // Accepts '#rrggbb' or 'rgb(a)(...)'
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  // rgb(a) — rewrite alpha
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return color;
  const parts = m[1].split(',').map((s) => s.trim());
  const r = parts[0], g = parts[1], b = parts[2];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sigma custom hover renderer: dark pill (overrides the default white box)
// ──────────────────────────────────────────────────────────────────────────────
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

  ctx.fillStyle = '#ecdfff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, boxX + padX, data.y);
}

// ──────────────────────────────────────────────────────────────────────────────
// Legend — colors per domain with counts, clickable to toggle filter
// ──────────────────────────────────────────────────────────────────────────────
function renderLegend(nodes: GraphNode[]) {
  const el = document.getElementById('graph-legend');
  if (!el) return;

  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.domain, (counts.get(n.domain) ?? 0) + 1);

  // Sort known domains first (in palette order), then unknowns alpha
  const known = Object.keys(DOMAIN_COLORS);
  const sorted = [...counts.keys()].sort((a, b) => {
    const ai = known.indexOf(a), bi = known.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  el.innerHTML = sorted
    .map(
      (d) => `
      <button class="graph-chip" data-filter="domain" data-value="${esc(d)}">
        <span class="dot" style="background:${domainColor(d)}"></span>
        <span class="label">${esc(d)}</span>
        <span class="count">${counts.get(d)}</span>
      </button>`
    )
    .join('');
}

// ──────────────────────────────────────────────────────────────────────────────
// Wire up all interactive controls in the overlay
// ──────────────────────────────────────────────────────────────────────────────
interface ControlCallbacks {
  onSearch: (q: string) => void;
  onSearchSubmit: (q: string) => void;
  onDomainToggle: (domain: string, active: boolean) => void;
  onKindToggle: (kind: string, active: boolean) => void;
  onSimilarOpacity: (v: number) => void;
  onSimilarHide: (hide: boolean) => void;
  onShowColors: (show: boolean) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onResetFilters: () => void;
}

function wireControls(cb: ControlCallbacks, nodes: GraphNode[]) {
  const search = document.getElementById('graph-search-input') as HTMLInputElement | null;
  if (search) {
    let t: number | null = null;
    search.addEventListener('input', () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => cb.onSearch(search.value.trim()), 90);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') cb.onSearchSubmit(search.value.trim());
    });
  }

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const chip = target.closest('.graph-chip') as HTMLElement | null;
    if (chip) {
      const filter = chip.dataset.filter;
      const value = chip.dataset.value;
      if (!filter || !value) return;
      chip.classList.toggle('active');
      const active = chip.classList.contains('active');
      if (filter === 'domain') cb.onDomainToggle(value, active);
      if (filter === 'kind') cb.onKindToggle(value, active);
      return;
    }
    const btn = target.closest('[data-graph-action]') as HTMLElement | null;
    if (btn) {
      const action = btn.dataset.graphAction;
      if (action === 'zoom-in') cb.onZoomIn();
      if (action === 'zoom-out') cb.onZoomOut();
      if (action === 'fit') cb.onFit();
      if (action === 'reset-filters') cb.onResetFilters();
    }
  });

  const slider = document.getElementById('similar-opacity') as HTMLInputElement | null;
  if (slider) {
    slider.addEventListener('input', () => cb.onSimilarOpacity(Number(slider.value) / 100));
  }
  const hide = document.getElementById('similar-hide') as HTMLInputElement | null;
  if (hide) {
    hide.addEventListener('change', () => cb.onSimilarHide(hide.checked));
  }
  const colorsToggle = document.getElementById('show-colors') as HTMLInputElement | null;
  if (colorsToggle) {
    colorsToggle.addEventListener('change', () => cb.onShowColors(colorsToggle.checked));
  }

  // Populate kind chips from nodes that carry `kind`
  const kindsEl = document.getElementById('graph-kinds');
  if (kindsEl) {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      if (n.kind) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    }
    const order = ['concept', 'decision', 'insight', 'fact', 'pattern', 'principle', 'question'];
    const sorted = [...counts.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    kindsEl.innerHTML = sorted
      .map(
        (k) => `
        <button class="graph-chip graph-chip-kind" data-filter="kind" data-value="${esc(k)}">
          <span class="label">${esc(k)}</span>
          <span class="count">${counts.get(k)}</span>
        </button>`
      )
      .join('');
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Slide panel DOM (lazy init)
// ──────────────────────────────────────────────────────────────────────────────
function ensurePanel(): HTMLElement {
  let el = document.getElementById('graph-panel');
  if (el) return el;
  el = document.createElement('aside');
  el.id = 'graph-panel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Note preview');
  document.body.appendChild(el);
  return el;
}

main().catch((err) => {
  console.error(err);
  setStatus('Error loading graph');
});
