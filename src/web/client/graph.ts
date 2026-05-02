import Graph from 'graphology';
import Sigma from 'sigma';
import { EdgeRectangleProgram } from 'sigma/rendering';
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
    setStatus('Falha ao carregar grafo');
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
        // A.29 — base size + cor pré-multiplicada fixa (alpha 25%).
        // Slider Line thickness é multiplier puro sobre `size` (igual Obsidian).
        size: 1.5,
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
  setStatus(`${payload.nodes.length} notas · ${explicitCount} ligações explícitas · ${similarCount} semânticas`);

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
    defaultEdgeColor: 'rgba(204, 204, 204, 0.8)',
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
    // A.35 — modo de coloração: 'neutral' | 'domain' | 'kind' | 'degree'.
    // Substituiu o checkbox showColors antigo (removido).
    colorMode: 'neutral' as 'neutral' | 'domain' | 'kind' | 'degree',
    nodeSizeMult: 1,
    lineSizeMult: 1,
    textFadeMult: 0,
    hideOrphans: false,
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
    gctx.strokeStyle = state.colorMode === 'domain'
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

  // A.35 — unificado: um único listener afterRender pra todas as camadas
  // 2D que sobrepõem a WebGL canvas (similar dashed, hover ring, suggested
  // links). Reduz overhead de event dispatch e mantém ordem determinística.
  renderer.on('afterRender', () => {
    drawSimilarEdges();
    drawHoverRing();
    drawSuggestedEdges();
  });
  renderer.on('resize', sizeOverlay);

  // ────────────────────────────────────────────────────────────────────────
  // Reducers: apply filter + ego highlight + dynamic labels
  // ────────────────────────────────────────────────────────────────────────
  // A.33 — paleta de cores por kind (alinhada a domain-colors mas distinta).
  const KIND_COLORS: Record<string, string> = {
    concept:    '#7dd3fc', // cyan-300
    decision:   '#fbbf24', // amber-400
    insight:    '#f472b6', // pink-400
    fact:       '#94a3b8', // slate-400
    pattern:    '#a78bfa', // violet-400
    principle:  '#fb923c', // orange-400
    question:   '#86efac', // green-300
  };
  // Gradiente de degree: 0 conexões = cinza, +20 = vermelho saturado.
  function degreeColor(deg: number): string {
    const t = Math.min(1, deg / 20);
    const r = Math.round(120 + (240 - 120) * t);
    const g = Math.round(120 + (80 - 120) * t);
    const b = Math.round(140 + (80 - 140) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
  function pickNodeColor(id: string, attrs: any): string {
    const NEUTRAL = (attrs.color as string) || '#b8b8c8';
    switch (state.colorMode) {
      case 'domain': return (attrs.domainColor as string) || NEUTRAL;
      case 'kind': {
        const k = (attrs.kind as string) || '';
        return KIND_COLORS[k] || NEUTRAL;
      }
      case 'degree': return degreeColor(degreeById.get(id) ?? 0);
      case 'neutral':
      default: return NEUTRAL;
    }
  }

  function isNodeActive(id: string): boolean {
    if (state.domainFilter && state.domainFilter.size > 0) {
      const d = graph.getNodeAttribute(id, 'domain') as string;
      if (!state.domainFilter.has(d)) return false;
    }
    if (state.kindFilter && state.kindFilter.size > 0) {
      const k = graph.getNodeAttribute(id, 'kind') as string;
      if (!state.kindFilter.has(k)) return false;
    }
    // A.22 — hide orphans: nó sem nenhuma edge explícita é considerado órfão.
    if (state.hideOrphans) {
      const deg = degreeById.get(id) ?? 0;
      if (deg === 0) return false;
    }
    return true;
  }

  renderer.setSetting('nodeReducer', (n, attrs) => {
    const camRatio = renderer.getCamera().ratio;
    const degree = degreeById.get(n) ?? 0;
    const active = isNodeActive(n);

    // A.33 — coloração baseada no modo selecionado.
    const baseColor = pickNodeColor(n, attrs);

    // A.22 — multiplicador global de tamanho (slider Display > Node size).
    const baseSize = (attrs.size as number) * state.nodeSizeMult;

    // Filter out: heavy dim, no label
    if (!active) {
      return { ...attrs, color: 'rgba(70, 70, 90, 0.12)', label: '', size: baseSize * 0.6 };
    }

    // Search hit: bright + enlarged
    if (state.searchMatches.size > 0 && state.searchMatches.has(n)) {
      return { ...attrs, color: baseColor, size: baseSize * 1.6, zIndex: 10 };
    }

    // A.6 — hovered node: NÃO faz scale (Obsidian não escala). Ring fino
    // desenhado no overlay 2D acima dá o destaque visual. Apenas força label.
    if (state.hoveredNode === n) {
      return { ...attrs, color: baseColor, size: baseSize, label: baseLabel.get(n) ?? '', zIndex: 20 };
    }

    // Ego dim: hovered node's neighborhood stays bright, rest fade to ghosts
    if (state.hoveredNeighbors && !state.hoveredNeighbors.has(n)) {
      return { ...attrs, color: 'rgba(70, 70, 90, 0.25)', size: baseSize, label: '' };
    }

    // Degree fade on zoom-out: leaf nodes become quiet at far camera
    if (camRatio > 2.8 && degree <= 1 && state.hoveredNeighbors == null) {
      return { ...attrs, color: hexWithAlpha(baseColor, 0.45), size: baseSize };
    }

    // A.22 — Dynamic labels com textFadeMult ajustável.
    // mult > 0 → labels aparecem em zoom mais distante (mais labels)
    // mult < 0 → labels só em zoom muito perto (menos labels)
    // Threshold base 0.6 (in) e 1.3 (mid). Mult de -3..3 desloca essas bordas.
    const labelInThreshold = 0.6 * Math.pow(2, -state.textFadeMult * 0.5);
    const labelMidThreshold = 1.3 * Math.pow(2, -state.textFadeMult * 0.5);
    const base = baseLabel.get(n) ?? '';
    let label: string | null = attrs.label as string;
    if (camRatio < labelInThreshold) label = base;
    else if (camRatio < labelMidThreshold && degree >= 3) label = base;
    else label = null;
    return { ...attrs, color: baseColor, size: baseSize, label: label ?? '' };
  });

  renderer.setSetting('edgeReducer', (edge, attrs) => {
    // A.29 — Line thickness é multiplier puro (igual Obsidian). Cor base fica
    // fixa (rgba pré-multiplicado 25%); só size escala com slider.
    const [s, t] = graph.extremities(edge);
    const baseSize = (attrs.size as number) * state.lineSizeMult;
    if (!isNodeActive(s) || !isNodeActive(t)) {
      return { ...attrs, color: 'rgba(5, 5, 5, 0.02)', size: baseSize, hidden: true };
    }
    if (state.hoveredNeighbors) {
      const keep = state.hoveredNeighbors.has(s) && state.hoveredNeighbors.has(t);
      return keep
        ? { ...attrs, color: 'rgba(191, 191, 191, 0.75)', size: baseSize * 1.6 }
        : { ...attrs, color: 'rgba(5, 5, 5, 0.02)', size: baseSize };
    }
    return { ...attrs, size: baseSize };
  });

  // ────────────────────────────────────────────────────────────────────────
  // A.24 — Physics: D3-force em Web Worker dedicado
  // A.29 — defaults e ranges alinhados com Obsidian:
  //   center: 0..1   default 0.1  (forceCenter strength sutil)
  //   repel:  0..20  default 10   (forceManyBody strength magnitude)
  //   link:   0..1   default 1    (forceLink strength)
  //   distance: 30..500 default 250 (forceLink distance)
  // ────────────────────────────────────────────────────────────────────────
  const FORCE_DEFAULTS = { center: 0.1, repel: 10, link: 1, distance: 250 };
  function mapForces(o: { center: number; repel: number; link: number; distance: number }) {
    return {
      // Slider Obsidian-like → parâmetros que o worker D3-force consome.
      center: o.center * 0.5,         // 0.1 → 0.05 forceCenter strength
      repel: o.repel * 50,            // 10 → 500 forceManyBody magnitude
      link: o.link,                   // direto
      distance: o.distance,           // direto
    };
  }
  let currentForces = { ...FORCE_DEFAULTS };

  // Snapshot inicial pra Reset + raio pra collide proporcional
  const initialPositions: Array<{ id: string; x: number; y: number; r: number }> = payload.nodes.map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    r: n.size,  // A.25 — passa raio pro worker
  }));

  const worker = new Worker('/app/graph/sim-worker.bundle.js?v=' + Date.now());

  // A.26 — recentralizar a câmera periodicamente durante o reveal.
  // Sem isso, a câmera fica fixa e os nós (que voam de range com D3-force)
  // saem da viewport — edges parecem invisíveis. Recentro a cada 30 ticks
  // até a simulação esfriar; depois disso fica fixa pro usuário pan/zoom.
  let tickCount = 0;
  let cameraSettled = false;
  worker.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === 'tick') {
      const positions: Record<string, [number, number]> = msg.positions;
      let nanCount = 0;
      let firstId = '';
      for (const id in positions) {
        const [x, y] = positions[id];
        if (!isFinite(x) || !isFinite(y)) {
          nanCount++;
          continue;
        }
        if (!firstId) firstId = id;
        if (graph.hasNode(id)) {
          graph.setNodeAttribute(id, 'x', x);
          graph.setNodeAttribute(id, 'y', y);
        }
      }
      // A.27 — log uma vez pra Eric checar console
      if (tickCount === 0) {
        const sample = positions[firstId];
        console.log('[graph] tick #1', { sampleId: firstId, samplePos: sample, nanCount });
      }
      renderer.refresh();
      tickCount++;
      // Recentro nos primeiros frames pra acompanhar o reveal explosivo
      if (!cameraSettled && (tickCount === 1 || tickCount % 30 === 0)) {
        void renderer.getCamera().animatedReset({ duration: 300 });
      }
    } else if (msg.type === 'end') {
      cameraSettled = true;
      void renderer.getCamera().animatedReset({ duration: 400 });
    }
  });

  const workerLinks = [];
  for (const e of payload.edges) {
    if (e.type !== 'explicit') continue;
    workerLinks.push({ source: e.source, target: e.target });
  }
  worker.postMessage({
    type: 'init',
    nodes: initialPositions,
    links: workerLinks,
    forces: mapForces(currentForces),
  });

  function setForces(o: { center?: number; repel?: number; link?: number; distance?: number }) {
    currentForces = { ...currentForces, ...o };
    worker.postMessage({
      type: 'forces',
      forces: mapForces(currentForces),
      alpha: 0.3,
    });
  }

  function pinNode(id: string, x: number, y: number) {
    worker.postMessage({ type: 'pin', id, x, y });
  }
  function unpinNode(id: string) {
    worker.postMessage({ type: 'unpin', id });
  }

  function resetGraphLayout() {
    worker.postMessage({ type: 'reset', nodes: initialPositions });
    void renderer.getCamera().animate(
      { x: 0.5, y: 0.5, ratio: 1.05, angle: 0 },
      { duration: 400 },
    );
  }

  // Compat: alguns callers ainda chamam runPhysics() — vira reheat no worker.
  function runPhysics(_ms?: number) {
    worker.postMessage({ type: 'reheat', alpha: 0.5 });
  }
  // Inicial reveal já roda automático com alpha=1 do init. Não precisa burst extra.
  void runPhysics;

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
    dragOrigin = { x: event.x, y: event.y };
    container.style.cursor = 'grabbing';
    renderer.getCamera().disable();
  });

  renderer.getMouseCaptor().on('mousemovebody', (e) => {
    if (!drag) return;
    if (!didDrag && dragOrigin) {
      const dx = e.x - dragOrigin.x;
      const dy = e.y - dragOrigin.y;
      if (dx * dx + dy * dy <= DRAG_THRESHOLD_SQ) return;
      didDrag = true;
    }
    // A.24 — drag via pin no worker (D3-force segura o nó em fx/fy e
    // recalcula vizinhos suave em torno).
    const pos = renderer.viewportToGraph(e);
    drag.pointer = pos;
    pinNode(drag.node, pos.x, pos.y);
    e.preventSigmaDefault();
    e.original.preventDefault();
    e.original.stopPropagation();
  });

  const release = () => {
    if (drag) {
      const wasDragging = didDrag;
      const draggedId = drag.node;
      drag = null;
      dragOrigin = null;
      container.style.cursor = '';
      if (wasDragging) {
        // A.24 — libera pin → worker volta a esfriar naturalmente
        unpinNode(draggedId);
      }
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
      <button class="panel-close" aria-label="Fechar painel">×</button>
      <div class="panel-meta">${kindBadge}<span class="panel-degree">${neighbors.size} ${neighbors.size === 1 ? 'conexão' : 'conexões'}</span></div>
      <h2 class="panel-title">${esc(title)}</h2>
      <div class="panel-chips">${domainChips}</div>
      ${tldrBlock}
      <a class="panel-open" href="/app/notes/${encodeURIComponent(nodeId)}">Abrir nota completa →</a>
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
      (window as any).__updateActiveFilters?.();
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
      (window as any).__updateActiveFilters?.();
      renderer.refresh();
    },
    onKindToggle: (kind, active) => {
      if (!state.kindFilter) state.kindFilter = new Set();
      if (active) state.kindFilter.add(kind);
      else state.kindFilter.delete(kind);
      if (state.kindFilter.size === 0) state.kindFilter = null;
      (window as any).__updateActiveFilters?.();
      renderer.refresh();
    },
    onSimilarOpacity: (v) => { state.similarOpacity = v; renderer.refresh(); },
    onSimilarHide: (hide) => { state.hideSimilar = hide; (window as any).__updateActiveFilters?.(); renderer.refresh(); },
    // A.33/A.35 — color mode (substitui onShowColors removido).
    onColorMode: (mode) => {
      state.colorMode = (['neutral','domain','kind','degree'].includes(mode) ? mode : 'neutral') as any;
      renderer.refresh();
    },
    onZoomIn: () => renderer.getCamera().animatedZoom({ duration: 280 }),
    onZoomOut: () => renderer.getCamera().animatedUnzoom({ duration: 280 }),
    onFit: () => {
      renderer.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1.05 }, { duration: 400 });
    },
    // A.22 + A.29 — Display
    onNodeSizeMult: (v) => { state.nodeSizeMult = v; renderer.refresh(); },
    onLineSizeMult: (v) => { state.lineSizeMult = v; renderer.refresh(); },
    onTextFadeMult: (v) => { state.textFadeMult = v; renderer.refresh(); },
    onHideOrphans: (hide) => { state.hideOrphans = hide; (window as any).__updateActiveFilters?.(); renderer.refresh(); },
    // A.29 — Forces (live, ranges Obsidian-like)
    onForceCenter: (v) => setForces({ center: v }),
    onForceRepel: (v) => setForces({ repel: v }),
    onForceLink: (v) => setForces({ link: v }),
    onForceDistance: (v) => setForces({ distance: v }),
    // A.29 — único Reset que reseta TUDO: filters, display, forces, layout.
    onResetAll: () => {
      // 1. Filters
      state.domainFilter = null;
      state.kindFilter = null;
      state.searchQuery = '';
      state.searchMatches = new Set();
      state.hideOrphans = false;
      state.hideSimilar = false;
      state.similarOpacity = 0.18;
      state.colorMode = 'neutral';
      // 2. Display
      state.nodeSizeMult = 1;
      state.lineSizeMult = 1;
      state.textFadeMult = 0;
      // 3. Forces (volta pros defaults Obsidian-like)
      currentForces = { ...FORCE_DEFAULTS };
      worker.postMessage({
        type: 'forces',
        forces: mapForces(currentForces),
        alpha: 0.5,
      });
      // 4. Layout (snapshot inicial)
      resetGraphLayout();
      // 5. Sync HTML inputs/checkboxes
      const setVal = (id: string, v: number | string) => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) el.value = String(v);
      };
      const setCheck = (id: string, c: boolean) => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) el.checked = c;
      };
      setVal('graph-search-input', '');
      setVal('similar-opacity', 18);
      setCheck('similar-hide', false);
      setCheck('hide-orphans', false);
      setVal('node-size-mult', 1);
      setVal('line-size-mult', 1);
      setVal('text-fade-mult', 0);
      setVal('force-center', FORCE_DEFAULTS.center);
      setVal('force-repel', FORCE_DEFAULTS.repel);
      setVal('force-link', FORCE_DEFAULTS.link);
      setVal('force-distance', FORCE_DEFAULTS.distance);
      // A.35 — chips de coloração: remove active, ativa o "neutral"
      document.querySelectorAll('.graph-color-chip').forEach((el) => {
        el.classList.toggle('active', (el as HTMLElement).dataset.colorMode === 'neutral');
      });
      document.querySelectorAll('.graph-chip.active').forEach((el) => el.classList.remove('active'));
      (window as any).__updateActiveFilters?.();
      renderer.refresh();
    },
  }, payload.nodes);

  // Keyboard: Esc closes panel; / focuses search; Cmd/Ctrl+K opens palette.
  window.addEventListener('keydown', (e) => {
    // A.31 — Cmd+K (Mac) / Ctrl+K (Windows) abre palette
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
      return;
    }
    if (e.key === 'Escape') {
      const palette = document.getElementById('graph-palette-backdrop');
      if (palette?.classList.contains('open')) { closePalette(); return; }
      const suggest = document.getElementById('graph-suggest-modal-backdrop');
      if (suggest?.classList.contains('open')) { closeSuggestModal(); return; }
      closePanel();
    }
    if (e.key === '/' && !isTypingInInput()) {
      const input = document.getElementById('graph-search-input') as HTMLInputElement | null;
      if (input) { e.preventDefault(); input.focus(); }
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // A.31 — Cmd+K command palette
  // ────────────────────────────────────────────────────────────────────────
  let paletteIdx = 0;
  let paletteResults: Array<{ id: string; label: string; domain: string; tldr?: string }> = [];

  function openPalette() {
    const bd = document.getElementById('graph-palette-backdrop');
    const inp = document.getElementById('graph-palette-input') as HTMLInputElement | null;
    if (!bd || !inp) return;
    bd.classList.add('open');
    inp.value = '';
    renderPaletteResults('');
    setTimeout(() => inp.focus(), 0);
  }
  function closePalette() {
    const bd = document.getElementById('graph-palette-backdrop');
    if (bd) bd.classList.remove('open');
  }
  function renderPaletteResults(query: string) {
    const list = document.getElementById('graph-palette-list');
    if (!list) return;
    if (!query.trim()) {
      // Top 12 notas por degree (hubs principais) quando vazio
      const hubs = [...payload.nodes]
        .map((n) => ({ ...n, deg: degreeById.get(n.id) ?? 0 }))
        .sort((a, b) => b.deg - a.deg)
        .slice(0, 12);
      paletteResults = hubs.map((n) => ({ id: n.id, label: n.label, domain: n.domain, tldr: meta.get(n.id)?.tldr }));
    } else {
      const hits = fuse.search(query, { limit: 30 });
      paletteResults = hits.map((h) => ({ id: h.item.id, label: h.item.label, domain: h.item.domain, tldr: meta.get(h.item.id)?.tldr }));
    }
    paletteIdx = 0;
    if (paletteResults.length === 0) {
      list.innerHTML = '<li class="graph-palette-empty">Nenhuma nota encontrada</li>';
      return;
    }
    list.innerHTML = paletteResults
      .map((r, i) => `
        <li class="graph-palette-item${i === 0 ? ' active' : ''}" data-idx="${i}" data-id="${esc(r.id)}">
          <span class="graph-palette-item-title">${esc(r.label)}</span>
          <span class="graph-palette-item-meta">${esc(r.domain)}${r.tldr ? ' · ' + esc(r.tldr.slice(0, 80)) : ''}</span>
        </li>
      `)
      .join('');
  }
  function paletteSelect(idx: number) {
    if (idx < 0 || idx >= paletteResults.length) return;
    const r = paletteResults[idx];
    closePalette();
    focusNode(r.id);
  }
  function paletteMove(delta: number) {
    if (paletteResults.length === 0) return;
    paletteIdx = (paletteIdx + delta + paletteResults.length) % paletteResults.length;
    const items = document.querySelectorAll('.graph-palette-item');
    items.forEach((el, i) => {
      el.classList.toggle('active', i === paletteIdx);
      if (i === paletteIdx) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    });
  }
  const paletteInp = document.getElementById('graph-palette-input') as HTMLInputElement | null;
  if (paletteInp) {
    paletteInp.addEventListener('input', () => renderPaletteResults(paletteInp.value));
    paletteInp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); paletteMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); paletteMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); paletteSelect(paletteIdx); }
    });
  }
  document.getElementById('graph-palette-list')?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.graph-palette-item') as HTMLElement | null;
    if (!item) return;
    paletteSelect(Number(item.dataset.idx));
  });
  document.getElementById('graph-palette-backdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closePalette();
  });

  // ────────────────────────────────────────────────────────────────────────
  // A.32 — Suggested links layer + create modal
  // ────────────────────────────────────────────────────────────────────────
  let suggestedActive = false;
  let suggestedPairs: Array<{ source: string; target: string; score: number }> = [];
  let suggestModalState: { source: string; target: string } | null = null;

  // Pré-computa pares: pega edges 'similar' do payload, filtra os que NÃO têm
  // edge 'explicit' já existente, e ordena por score desc.
  const explicitPairs = new Set<string>();
  for (const e of payload.edges) {
    if (e.type !== 'explicit') continue;
    const k = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
    explicitPairs.add(k);
  }
  function computeSuggestedPairs(threshold = 0.78) {
    const out: Array<{ source: string; target: string; score: number }> = [];
    for (const e of payload.edges) {
      if (e.type !== 'similar') continue;
      const score = e.score ?? 0;
      if (score < threshold) continue;
      const k = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
      if (explicitPairs.has(k)) continue;
      out.push({ source: e.source, target: e.target, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 60);
  }
  suggestedPairs = computeSuggestedPairs();

  function drawSuggestedEdges() {
    if (!suggestedActive) return;
    octx.save();
    octx.lineWidth = 1.4;
    octx.setLineDash([4, 4]);
    octx.lineCap = 'round';
    octx.strokeStyle = 'rgba(255, 200, 100, 0.55)';
    for (const p of suggestedPairs) {
      if (!graph.hasNode(p.source) || !graph.hasNode(p.target)) continue;
      if (!isNodeActive(p.source) || !isNodeActive(p.target)) continue;
      const a = renderer.graphToViewport({
        x: graph.getNodeAttribute(p.source, 'x') as number,
        y: graph.getNodeAttribute(p.source, 'y') as number,
      });
      const b = renderer.graphToViewport({
        x: graph.getNodeAttribute(p.target, 'x') as number,
        y: graph.getNodeAttribute(p.target, 'y') as number,
      });
      octx.beginPath();
      octx.moveTo(a.x, a.y);
      octx.lineTo(b.x, b.y);
      octx.stroke();
    }
    octx.restore();
  }
  // afterRender unificado em um único listener (ver acima).

  function toggleSuggestedLinks() {
    suggestedActive = !suggestedActive;
    const btn = document.getElementById('suggested-toggle');
    if (btn) {
      btn.classList.toggle('active', suggestedActive);
      btn.textContent = suggestedActive ? 'Esconder conexões sugeridas' : 'Mostrar conexões sugeridas';
    }
    renderer.refresh();
  }

  // Click em edge sugerida (canvas overlay): detecta proximidade do mouse com cada par
  overlay.addEventListener('click', (e) => {
    if (!suggestedActive) return;
    const rect = overlay.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: { p: typeof suggestedPairs[0]; d: number } | null = null;
    for (const p of suggestedPairs) {
      if (!graph.hasNode(p.source) || !graph.hasNode(p.target)) continue;
      const a = renderer.graphToViewport({
        x: graph.getNodeAttribute(p.source, 'x') as number,
        y: graph.getNodeAttribute(p.source, 'y') as number,
      });
      const b = renderer.graphToViewport({
        x: graph.getNodeAttribute(p.target, 'x') as number,
        y: graph.getNodeAttribute(p.target, 'y') as number,
      });
      const d = pointToSegmentDistance(mx, my, a.x, a.y, b.x, b.y);
      if (!best || d < best.d) best = { p, d };
    }
    if (best && best.d < 8) {
      openSuggestModal(best.p.source, best.p.target);
    }
  });
  // Pra que o overlay receba pointer events ao clicar (default é none pra não bloquear hover do Sigma).
  // Solução: só ativa pointer-events quando suggestedActive E mouse não está em hover de nó.
  // Implementação simples: overlay só vira clicável quando suggested está ON.
  function syncOverlayPointer() {
    overlay.style.pointerEvents = suggestedActive ? 'auto' : 'none';
  }

  function pointToSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const A = px - x1, B = py - y1, C = x2 - x1, D = y2 - y1;
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = lenSq !== 0 ? dot / lenSq : -1;
    param = Math.max(0, Math.min(1, param));
    const xx = x1 + param * C, yy = y1 + param * D;
    return Math.hypot(px - xx, py - yy);
  }

  function openSuggestModal(sourceId: string, targetId: string) {
    const bd = document.getElementById('graph-suggest-modal-backdrop');
    const fromEl = document.getElementById('suggest-from');
    const toEl = document.getElementById('suggest-to');
    const ta = document.getElementById('suggest-why') as HTMLTextAreaElement | null;
    if (!bd || !fromEl || !toEl || !ta) return;
    fromEl.textContent = graph.getNodeAttribute(sourceId, 'label') as string;
    toEl.textContent = graph.getNodeAttribute(targetId, 'label') as string;
    ta.value = '';
    suggestModalState = { source: sourceId, target: targetId };
    bd.classList.add('open');
    setTimeout(() => ta.focus(), 0);
  }
  function closeSuggestModal() {
    const bd = document.getElementById('graph-suggest-modal-backdrop');
    if (bd) bd.classList.remove('open');
    suggestModalState = null;
  }
  async function createSuggestedLink() {
    if (!suggestModalState) return;
    const ta = document.getElementById('suggest-why') as HTMLTextAreaElement | null;
    const why = (ta?.value || '').trim();
    if (!why) {
      alert('Escreva uma justificativa pra ligação (POR QUÊ se conectam) — princípio Latticework.');
      ta?.focus();
      return;
    }
    const btn = document.getElementById('suggest-create-btn') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Criando...'; }
    try {
      const res = await fetch('/app/graph/link', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: suggestModalState.source,
          target: suggestModalState.target,
          why,
        }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      // Adiciona edge no graph local sem precisar reload
      const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      try {
        graph.addEdgeWithKey(id, suggestModalState.source, suggestModalState.target, {
          size: 1.5,
          color: 'rgba(64, 64, 64, 0.25)',
        });
      } catch { /* duplicate */ }
      // Remove o par da lista de sugeridos
      const k = suggestModalState.source < suggestModalState.target
        ? `${suggestModalState.source}|${suggestModalState.target}`
        : `${suggestModalState.target}|${suggestModalState.source}`;
      explicitPairs.add(k);
      suggestedPairs = suggestedPairs.filter((p) => {
        const pk = p.source < p.target ? `${p.source}|${p.target}` : `${p.target}|${p.source}`;
        return pk !== k;
      });
      closeSuggestModal();
      renderer.refresh();
    } catch (err) {
      console.error('createSuggestedLink failed', err);
      alert('Erro ao criar ligação. Veja console.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Criar ligação'; }
    }
  }

  document.getElementById('graph-suggest-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSuggestModal();
  });
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('[data-graph-action]') as HTMLElement | null;
    if (!btn) return;
    const action = btn.dataset.graphAction;
    if (action === 'toggle-suggested') { toggleSuggestedLinks(); syncOverlayPointer(); }
    if (action === 'suggest-cancel') closeSuggestModal();
    if (action === 'suggest-create') void createSuggestedLink();
  });

  // A.30/A.34 — Indicador de filtros ativos. Em A.30 eu fazia monkey-patch
  // de renderer.refresh, e o worker D3-force chama refresh 60x/s → 60 DOM ops/s.
  // A.34: chamada EXPLÍCITA nos handlers que mudam state de filtro. Zero
  // overhead no hot path do worker.
  function updateActiveFiltersIndicator() {
    const el = document.getElementById('graph-active-filters');
    const text = document.getElementById('graph-active-filters-text');
    if (!el || !text) return;
    const parts: string[] = [];
    if (state.searchQuery) parts.push(`busca "${state.searchQuery}"`);
    if (state.domainFilter && state.domainFilter.size > 0) {
      parts.push(`${state.domainFilter.size} ${state.domainFilter.size === 1 ? 'área' : 'áreas'}`);
    }
    if (state.kindFilter && state.kindFilter.size > 0) {
      parts.push(`${state.kindFilter.size} ${state.kindFilter.size === 1 ? 'tipo' : 'tipos'}`);
    }
    if (state.hideOrphans) parts.push('isoladas escondidas');
    if (state.hideSimilar) parts.push('semânticas escondidas');
    if (parts.length === 0) {
      el.classList.remove('show');
    } else {
      text.textContent = `Filtrando: ${parts.join(', ')}`;
      el.classList.add('show');
    }
  }
  // Expõe globalmente pra que callbacks de filtro possam chamar.
  (window as any).__updateActiveFilters = updateActiveFiltersIndicator;
  updateActiveFiltersIndicator();
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
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  // A.22 + A.29 — Display + Forces
  onNodeSizeMult: (v: number) => void;
  onLineSizeMult: (v: number) => void;
  onTextFadeMult: (v: number) => void;
  onHideOrphans: (hide: boolean) => void;
  onForceCenter: (v: number) => void;
  onForceRepel: (v: number) => void;
  onForceLink: (v: number) => void;
  onForceDistance: (v: number) => void;
  // A.29 — único Restore default que reseta TUDO (filters, display, forces, layout).
  onResetAll: () => void;
  // A.33 — modo de coloração
  onColorMode: (mode: string) => void;
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
      if (action === 'reset-all') cb.onResetAll();
      // A.30 — botão "Limpar" do indicador de filtros ativos
      if (action === 'clear-filters') cb.onResetAll();
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
  // A.35 — chips de Coloração das bolinhas (substituiu select)
  const colorChips = document.querySelectorAll('.graph-color-chip');
  colorChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const mode = (chip as HTMLElement).dataset.colorMode;
      if (!mode) return;
      colorChips.forEach((c) => c.classList.toggle('active', c === chip));
      cb.onColorMode(mode);
    });
  });

  // A.22 — Display sliders + Forces sliders + hide orphans
  const wireSlider = (id: string, fn: (v: number) => void) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.addEventListener('input', () => fn(Number(el.value)));
  };
  wireSlider('node-size-mult', cb.onNodeSizeMult);
  wireSlider('line-size-mult', cb.onLineSizeMult);
  wireSlider('text-fade-mult', cb.onTextFadeMult);
  wireSlider('force-center', cb.onForceCenter);
  wireSlider('force-repel', cb.onForceRepel);
  wireSlider('force-link', cb.onForceLink);
  wireSlider('force-distance', cb.onForceDistance);

  const hideOrphans = document.getElementById('hide-orphans') as HTMLInputElement | null;
  if (hideOrphans) {
    hideOrphans.addEventListener('change', () => cb.onHideOrphans(hideOrphans.checked));
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
  setStatus('Erro ao carregar grafo');
});
