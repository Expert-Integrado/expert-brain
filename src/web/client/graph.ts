import Graph from 'graphology';
import Sigma from 'sigma';
import { EdgeRectangleProgram } from 'sigma/rendering';
import Fuse from 'fuse.js';
import { DOMAIN_COLORS, DOMAIN_FALLBACK, domainColor, domainColorMuted, resolveDomainMeta, resolveKindMeta, EMPTY_TAXONOMY_CONFIG, type TaxonomyConfig } from '../domain-colors.js';
import { loadMeta } from './meta-cache.js';
import { loadTaxonomy } from './taxonomy-cache.js';

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
  // Mobile overlay toggle — abre/fecha o painel de controles pra liberar o
  // canvas em telas pequenas. Em desktop o botão fica escondido via CSS e
  // o overlay continua sempre visível.
  wireOverlayToggle();
  wirePanelToggle();

  // Fonte de dados parametrizável: o /app/graph usa /app/graph/{data,meta} (Brain);
  // o /app/contacts (mesmo renderer embutido no shell do Brain) usa /app/contacts/*,
  // que proxia o vault de contatos. Lido do data-graph-src no #graph-canvas.
  const graphSrc = (document.getElementById('graph-canvas') as HTMLElement | null)?.dataset.graphSrc || '/app/graph';

  // Parallel load: graph topology + note metadata. Meta endpoint is additive —
  // if it fails we degrade to id-only panel content rather than aborting.
  // O meta do Brain (graphSrc === '/app/graph') vai pelo loadMeta() memoizado/
  // cacheável (spec 23) — compartilha o fetch com a palette e revalida via ETag.
  // O grafo de CONTATOS usa outra fonte (/app/contacts/meta), que loadMeta() não
  // cobre; nesse caso mantém o fetch parametrizado direto. ATENÇÃO: o meta de
  // vault estrangeiro NÃO é array — o proxy de contatos devolve o objeto
  // {ok, counts, legend, list: [{id,label}]} do Expert Console. Normaliza pra
  // array aqui; iterar o objeto direto mata o main() inteiro (TypeError) e
  // deixa a aba presa em "Carregando grafo..." (regressão da onda G, 03/07).
  const isBrainGraph = graphSrc === '/app/graph';
  const metaListP: Promise<NoteMeta[]> = isBrainGraph
    ? loadMeta().catch((err) => { console.warn('graph: meta load failed', err); return []; })
    : fetch(`${graphSrc}/meta`, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : []))
        .then((x: any): NoteMeta[] => (Array.isArray(x) ? x : Array.isArray(x?.list) ? x.list : []))
        .catch((err) => { console.warn('graph: meta load failed', err); return []; });
  // Taxonomia configurável (spec 54): só faz sentido pro vault de NOTAS do Brain
  // — contatos tem paleta própria (fora de escopo, ver spec 54 "Fora de escopo").
  // Aditivo: falha vira config vazia (fallback = paleta compilada), nunca trava o boot.
  const taxonomyP: Promise<TaxonomyConfig> = isBrainGraph ? loadTaxonomy() : Promise.resolve(EMPTY_TAXONOMY_CONFIG);
  const [graphRes, metaList, taxonomy] = await Promise.all([
    fetch(`${graphSrc}/data`, { credentials: 'same-origin' }),
    metaListP,
    taxonomyP,
  ]);
  if (!graphRes.ok) {
    setStatus('Falha ao carregar grafo');
    const loading = document.getElementById('graph-center-loading');
    if (loading) loading.textContent = 'Falha ao carregar grafo';
    return;
  }
  const payload = (await graphRes.json()) as Payload;
  const meta: Map<string, NoteMeta> = new Map();
  // Guarda de shape: meta é camada ADITIVA — nunca pode derrubar o boot do grafo.
  if (Array.isArray(metaList)) for (const m of metaList) meta.set(m.id, m);
  for (const n of payload.nodes) {
    const m = meta.get(n.id);
    if (m) { n.kind = m.kind; n.tldr = m.tldr; }
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
      // Renderiza JÁ no layout pré-computado pelo servidor (ForceAtlas2) em vez
      // de posição aleatória — o grafo aparece organizado no 1º frame, sem o
      // "explode e reorganiza por 5s" a cada load. A simulação D3 só refina.
      x: n.x,
      y: n.y,
      // A.9 — n.size já é o valor final do Obsidian (range 8-30). Usar direto.
      size: n.size,
      color: NEUTRAL_NODE_COLOR,
      domainColor: resolveDomainMeta(n.domain, taxonomy).color, // guardado pra toggle Cores
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
        // A.36 — fio fino discreto (Obsidian): base size 0.8 + cinza-escuro
        // com alpha baixa. Slider "Espessura das linhas" é multiplier puro
        // sobre `size`; o edgeReducer engorda no hover/search.
        size: 0.8,
        color: 'rgba(63, 63, 70, 0.35)',
      });
    } else {
      similarCount++;
      similarEdges.push({ source: e.source, target: e.target, score: e.score });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Status + legend
  // ────────────────────────────────────────────────────────────────────────
  const isContacts = (document.getElementById('graph-canvas') as HTMLElement | null)?.dataset.vault === 'contacts';
  const noun = isContacts ? 'contatos' : 'notas';
  // Rótulos pt-BR dos tipos de entidade do vault de contatos (chips do dropdown
  // e do painel). As CORES vêm de CONTACT_KIND_COLORS via domainColor().
  const CONTACT_TYPE_LABELS: Record<string, string> = {
    person: 'Pessoa', company: 'Empresa', place: 'Lugar', event: 'Evento', other: 'Outro',
  };
  // Contatos não têm arestas semânticas (são puladas) — não mostra "X semânticas".
  setStatus(isContacts
    ? `${payload.nodes.length} ${noun} · ${explicitCount} ligações`
    : `${payload.nodes.length} ${noun} · ${explicitCount} ligações explícitas · ${similarCount} semânticas`);

  renderLegend(payload.nodes, taxonomy);

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
    // A.36 — fio discreto estilo Obsidian: cinza-escuro (#3f3f46) com alpha
    // baixa, quase invisível parado, só ganha corpo no hover/search (edgeReducer).
    // Antes era rgba(204,204,204,0.8) — cinza-claro forte que competia com os nós.
    defaultEdgeColor: 'rgba(63, 63, 70, 0.35)',
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
    // Passo de zoom da RODA do mouse bem mais fino que o default (~1.5).
    // (Os botões +/− usam factor próprio em onZoomIn/onZoomOut.)
    zoomingRatio: 1.12,
    defaultDrawNodeHover: drawDarkHover as any,
  });

  // Expõe renderer pro listener de viewport-change (mobile scale) refresh-ar
  // os reducers quando a tela vira/redimensiona.
  (globalThis as any).__graphRenderer = renderer;

  // Esconde o loading central assim que o primeiro frame for renderizado.
  let _loadingHidden = false;
  renderer.on('afterRender', () => {
    if (_loadingHidden) return;
    const loading = document.getElementById('graph-center-loading');
    if (loading) loading.classList.add('hidden');
    _loadingHidden = true;
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
  // Declarado cedo (antes do afterRender) pra evitar TDZ — usado por P2 (pular
  // camadas 2D durante o reveal) e pelo recentro da câmera no settle.
  let cameraSettled = false;
  // Deep-link ?focus=<id> (spec 50-console-v2/56, "Abrir no grafo" na página do
  // contato): foca o nó DEPOIS do settle inicial da simulação — se disparado
  // antes, o applyCoreBBox()+animatedReset() do settle desfaz o enquadramento.
  let pendingFocusId: string | null = new URLSearchParams(window.location.search).get('focus') || null;
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
    // nodeSizeMult/lineSizeMult/textFadeMult NÃO ficam aqui — viraram perfis
    // visual2d/visual3d POR MODO (mesmo padrão de forces2d/forces3d abaixo),
    // pra mexer no slider "Tamanho das bolinhas" no 3D não afetar o 2D. Ver
    // getVisual()/setVisual()/syncVisualSliders() e a declaração de
    // visual2d/visual3d perto de forces2d/forces3d.
    hideOrphans: false,
    noOverlap: false,                   // modo "não sobrepor as bolinhas" (collide forte)
    // Escala extra aplicada por cima dos multiplicadores acima.
    // Em mobile (<768px) reduz nodes/edges proporcionalmente pra manter
    // a mesma "leitura" visual do desktop sem ficar gigante na tela pequena.
    mobileNodeScale: 1,
    mobileEdgeScale: 1,
  };

  // Perfis VISUAL por modo (mesma dor real do forces2d/forces3d mais abaixo:
  // mexer no slider "Tamanho das bolinhas" ou "Espessura das linhas" no 3D
  // destruía a config do 2D, porque nodeSizeMult/lineSizeMult/textFadeMult eram
  // estado global único no `state`). `visual2d` alimenta o nodeReducer/edgeReducer
  // do Sigma (2D); `visual3d` alimenta só o palco 3D via ctx3D().getVisual().
  // textFadeMult NÃO existe no perfil 3D — rótulo só aparece no hover lá (sem
  // equivalente); o slider de rótulos fica desabilitado/sem efeito no 3D, igual
  // hoje. Defaults idênticos aos valores globais atuais — comportamento do 2D não
  // muda. Os MESMOS sliders do painel VISUAL editam o perfil do modo ATIVO — ao
  // alternar, syncVisualSliders() reposiciona os inputs pro perfil novo.
  //
  // DECLARADO AQUI (junto do `state`), ANTES do renderer.setSetting('nodeReducer'
  // /'edgeReducer') mais abaixo, de PROPÓSITO: o Sigma invoca os reducers de forma
  // SÍNCRONA no próprio setSetting (varre forEachNode na hora). Como visual2d é um
  // `let` block-scoped, se ele fosse declarado depois dos reducers (era o caso no
  // R3), essa 1ª varredura leria visual2d na Temporal Dead Zone → "ReferenceError:
  // Cannot access 'visual2d' before initialization", o main() inteiro estourava no
  // catch ("Erro ao carregar grafo") e a simulação NUNCA rodava (nós ficavam nas
  // posições-semente cruas). Manter esta declaração ACIMA dos reducers.
  const VISUAL_DEFAULTS = { nodeSizeMult: 1, lineSizeMult: 1, textFadeMult: 0 };
  const VISUAL3D_DEFAULTS = { nodeSizeMult: 1, lineSizeMult: 1 };
  let visual2d = { ...VISUAL_DEFAULTS };
  let visual3d = { ...VISUAL3D_DEFAULTS };

  // Leitor DEFENSIVO do multiplicador visual 2D: se o campo faltar ou vier NaN
  // (prefs antigas, refactor futuro, objeto parcial), cai no default em vez de
  // propagar undefined/NaN pro tamanho renderizado — que apagaria os nós/linhas.
  // O boot do 2D NUNCA pode morrer nem sumir por um campo visual ausente.
  const v2 = (k: keyof typeof VISUAL_DEFAULTS): number => {
    const raw = (visual2d as Record<string, unknown>)[k];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : VISUAL_DEFAULTS[k];
  };

  // Aplica escala mobile e reage a mudanças de viewport (rotação, redimensiona).
  const applyMobileScale = () => {
    const mobile = window.matchMedia('(max-width: 767px)').matches;
    state.mobileNodeScale = mobile ? 0.5 : 1;
    state.mobileEdgeScale = mobile ? 0.7 : 1;
  };
  applyMobileScale();
  // O listener abaixo refresh-a o renderer só depois dele existir; antes,
  // o estado já ficou correto pelo applyMobileScale acima e o primeiro
  // render vai usar os valores certos.
  window.matchMedia('(max-width: 767px)').addEventListener('change', () => {
    applyMobileScale();
    if (typeof (globalThis as any).__graphRenderer?.refresh === 'function') {
      (globalThis as any).__graphRenderer.refresh();
    }
  });

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

  // Spec 20-frontend/25 (perf): cache de conversão graph→viewport POR FRAME.
  // graphToViewport roda no máximo 1x por nó por frame (não 2x por linha) — as
  // duas camadas de linha (semânticas + sugeridas) compartilham o cache; o
  // afterRender limpa antes de desenhar.
  const viewportCache = new Map<string, { x: number; y: number }>();
  function nodeViewport(id: string): { x: number; y: number } {
    let v = viewportCache.get(id);
    if (!v) {
      v = renderer.graphToViewport({
        x: graph.getNodeAttribute(id, 'x') as number,
        y: graph.getNodeAttribute(id, 'y') as number,
      });
      viewportCache.set(id, v);
    }
    return v;
  }
  // Culling: pula a linha quando AMBOS os endpoints estão fora da viewport
  // expandida por 100px. Linha que cruza a tela com os dois endpoints fora da
  // margem some — aceitável pro caso de uso (o fallback seria interseção
  // segmento×retângulo, mais caro; documentado na spec 25).
  const CULL_MARGIN = 100;
  function outOfView(v: { x: number; y: number }, w: number, h: number): boolean {
    return v.x < -CULL_MARGIN || v.x > w + CULL_MARGIN || v.y < -CULL_MARGIN || v.y > h + CULL_MARGIN;
  }

  function drawSimilarEdges() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (state.hideSimilar || state.similarOpacity <= 0 || similarEdges.length === 0) return;

    const w = overlay.width / dpr;
    const h = overlay.height / dpr;
    // Batching por alpha: os alphas possíveis num frame são poucos (base, boost
    // de search/hover, dim) — acumula segmentos por bucket e faz 1 stroke por
    // bucket em vez de beginPath/stroke por linha.
    const buckets = new Map<number, Array<{ ax: number; ay: number; bx: number; by: number }>>();
    for (const e of similarEdges) {
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      if (!isNodeActive(e.source) || !isNodeActive(e.target)) continue;

      const a = nodeViewport(e.source);
      const b = nodeViewport(e.target);
      if (outOfView(a, w, h) && outOfView(b, w, h)) continue;

      // When hovering a node, boost similar edges touching its ego network
      // and dim the rest so the local structure reads without hiding context.
      let alpha = state.similarOpacity;
      if (state.searchMatches.size > 0) {
        // Search ativo: só realça a semântica entre dois matches; o resto apaga.
        const both = state.searchMatches.has(e.source) && state.searchMatches.has(e.target);
        alpha = both ? Math.max(0.6, state.similarOpacity) : state.similarOpacity * 0.1;
      } else if (state.hoveredNeighbors) {
        const inEgo = state.hoveredNeighbors.has(e.source) && state.hoveredNeighbors.has(e.target);
        alpha = inEgo ? Math.max(0.55, state.similarOpacity) : state.similarOpacity * 0.25;
      }

      let bucket = buckets.get(alpha);
      if (!bucket) { bucket = []; buckets.set(alpha, bucket); }
      bucket.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
    if (buckets.size === 0) return;

    octx.save();
    octx.lineWidth = 1.1;
    octx.setLineDash([6, 5]);
    octx.lineCap = 'round';
    for (const [alpha, lines] of buckets) {
      octx.strokeStyle = `rgba(140, 200, 255, ${alpha})`;
      octx.beginPath();
      for (const l of lines) {
        octx.moveTo(l.ax, l.ay);
        octx.lineTo(l.bx, l.by);
      }
      octx.stroke();
    }
    octx.restore();
  }

  // A.35 — unificado: um único listener afterRender pra todas as camadas
  // 2D que sobrepõem a WebGL canvas (similar dashed, hover ring, suggested
  // links). Reduz overhead de event dispatch e mantém ordem determinística.
  renderer.on('afterRender', () => {
    // P2 (perf) — durante o reveal da simulação (cameraSettled=false) as linhas
    // semânticas/sugeridas são caras (loop em todas + conversões de coordenada)
    // e seriam redesenhadas a cada frame do settle. Só desenha depois
    // que assenta. O hover ring é barato e não acontece durante o load.
    viewportCache.clear(); // posições/câmera mudaram — cache vale só neste frame
    if (cameraSettled) {
      drawSimilarEdges();
      drawSuggestedEdges();
    }
    drawHoverRing();
  });
  renderer.on('resize', sizeOverlay);

  // ────────────────────────────────────────────────────────────────────────
  // Reducers: apply filter + ego highlight + dynamic labels
  // ────────────────────────────────────────────────────────────────────────
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
        return k ? resolveKindMeta(k, taxonomy).color : NEUTRAL;
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

    // A.22 — multiplicador de tamanho do perfil VISUAL 2D (slider Display > Node
    // size) — o nodeReducer do Sigma só renderiza o palco 2D, então lê SEMPRE
    // visual2d (nunca visual3d), igual o sim-worker sempre usa forces2d.
    // mobileNodeScale aplica escala extra em viewports <768px sem mexer no slider.
    const baseSize = (attrs.size as number) * v2('nodeSizeMult') * state.mobileNodeScale;

    // Filter out: heavy dim, no label
    if (!active) {
      return { ...attrs, color: 'rgba(70, 70, 90, 0.12)', label: '', size: baseSize * 0.6 };
    }

    // Search ativo: foco igual ao hover. Match = aceso + maior + rótulo;
    // o resto escurece (vira fantasma), pra os relevantes "pularem" na tela.
    if (state.searchMatches.size > 0) {
      if (state.searchMatches.has(n)) {
        return { ...attrs, color: baseColor, size: baseSize * 1.6, label: baseLabel.get(n) ?? '', zIndex: 10 };
      }
      return { ...attrs, color: 'rgba(70, 70, 90, 0.22)', size: baseSize, label: '' };
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

    // A.22 — Dynamic labels com textFadeMult ajustável (perfil visual2d — sem
    // equivalente 3D, ver comentário na declaração de visual2d/visual3d).
    // mult > 0 → labels aparecem em zoom mais distante (mais labels)
    // mult < 0 → labels só em zoom muito perto (menos labels)
    // Threshold base 0.6 (in) e 1.3 (mid). Mult de -3..3 desloca essas bordas.
    const labelInThreshold = 0.6 * Math.pow(2, -v2('textFadeMult') * 0.5);
    const labelMidThreshold = 1.3 * Math.pow(2, -v2('textFadeMult') * 0.5);
    const base = baseLabel.get(n) ?? '';
    let label: string | null = attrs.label as string;
    if (camRatio < labelInThreshold) label = base;
    else if (camRatio < labelMidThreshold && degree >= 3) label = base;
    else label = null;
    return { ...attrs, color: baseColor, size: baseSize, label: label ?? '' };
  });

  renderer.setSetting('edgeReducer', (edge, attrs) => {
    // A.29 — Line thickness é multiplier puro (igual Obsidian). Cor base fica
    // fixa (rgba pré-multiplicado 25%); só size escala com slider. edgeReducer
    // do Sigma só renderiza o palco 2D → lê SEMPRE visual2d (nunca visual3d).
    const [s, t] = graph.extremities(edge);
    const baseSize = (attrs.size as number) * v2('lineSizeMult') * state.mobileEdgeScale;
    if (!isNodeActive(s) || !isNodeActive(t)) {
      return { ...attrs, color: 'rgba(5, 5, 5, 0.02)', size: baseSize, hidden: true };
    }
    // Search ativo: igual ao hover — só destaca ligações entre dois matches,
    // o resto some.
    if (state.searchMatches.size > 0) {
      const keep = state.searchMatches.has(s) && state.searchMatches.has(t);
      return keep
        ? { ...attrs, color: 'rgba(191, 191, 191, 0.75)', size: baseSize * 1.6 }
        : { ...attrs, color: 'rgba(5, 5, 5, 0.02)', size: baseSize };
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
  // A.37 — MAPEAMENTO DE SLIDER 1:1 COM O OBSIDIAN (reversa-engenheirado do
  // obsidian.asar). Defaults e fórmulas abaixo são os do Obsidian, não aproximações:
  //   center   slider 0..1    default 0.1 → efetivo = slider          (identity; strength forceX/Y)
  //   repel    slider 0..20   default 10  → efetivo = slider³ = 1000   (Obsidian: e*e*e)
  //   link     slider 0..1    default 1   → efetivo = slider           (worker escala por grau)
  //   distance slider 30..500 default 250 → efetivo = slider           (identity)
  //
  // É o mapping e*e*e do repel + a AUSÊNCIA de distanceMax no worker (v9 capava em
  // 250) que faz o slider de repulsão finalmente "pegar": slider 10→1000, 20→8000.
  // ────────────────────────────────────────────────────────────────────────
  const FORCE_DEFAULTS = { center: 0.1, repel: 10, link: 1, distance: 250 };
  // Perfil 3D com DEFAULTS PRÓPRIOS (calibrados no repro visual 2026-07): o mundo
  // 3D do 3d-force-graph tem escala própria (ver o /8 do repel em graph3d.ts) —
  // center mais alto segura a nuvem coesa, repel mais baixo e distance moderada
  // evitam a "poeira" espalhada. MANTER EM SINCRONIA com FORCE3D_DEFAULTS do
  // server (src/web/graph-prefs.ts) — é o mesmo número dos dois lados.
  const FORCE3D_DEFAULTS = { center: 0.2, repel: 8, link: 1, distance: 150 };
  function mapForces(o: { center: number; repel: number; link: number; distance: number }) {
    return {
      // Slider Obsidian → parâmetros que o worker D3-force consome (fiel ao asar).
      center: o.center,                     // identity → centerStrength (forceX/Y strength)
      repel: o.repel * o.repel * o.repel,   // e*e*e (Obsidian): slider 10 → repelStrength 1000
      link: o.link,                         // identity (worker escala por grau, = E*J do Obsidian)
      distance: o.distance,                 // identity → linkDistance (default 250, ligações longas)
    };
  }
  // Perfis de força POR MODO (dor real: mexer nos sliders no 3D destruía a config
  // do 2D). `forces2d` alimenta o sim-worker (Sigma); `forces3d` alimenta só o
  // palco 3D via ctx3D().getForces(). Os MESMOS 4 sliders editam o perfil do modo
  // ATIVO — ao alternar, syncForceSliders() reposiciona os inputs pro perfil novo.
  let forces2d = { ...FORCE_DEFAULTS };
  let forces3d = { ...FORCE3D_DEFAULTS };

  // visual2d/visual3d (perfis VISUAL por modo) são declarados lá em cima, junto
  // do `state` — TÊM que existir ANTES do renderer.setSetting('nodeReducer') que
  // os lê de forma síncrona no boot (senão TDZ mata o main inteiro). Ver o bloco
  // de comentário na declaração pra o porquê. Aqui embaixo eles já estão prontos.

  // Aplica a config salva (data-graph-prefs no #graph-canvas, injetada pelo server
  // a partir do meta) ANTES de inicializar a simulação: seta state + forces2d/3d e
  // sincroniza os inputs/checkboxes/chips do painel. Sem nada salvo, mantém os
  // defaults dos próprios inputs HTML. CSP-safe: lê de data-attribute, não inline JS.
  function applySavedPrefs() {
    const canvas = document.getElementById('graph-canvas');
    const raw = canvas?.dataset.graphPrefs;
    if (!raw) return;
    let p: any;
    try { p = JSON.parse(raw); } catch { return; }
    if (!p || typeof p !== 'object') return;
    const clamp = (v: any, lo: number, hi: number, d: number) =>
      (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : d;
    if (p.forces && typeof p.forces === 'object') {
      forces2d = {
        center: clamp(p.forces.center, 0, 1, forces2d.center),
        repel: clamp(p.forces.repel, 0, 20, forces2d.repel),
        link: clamp(p.forces.link, 0, 1, forces2d.link),
        distance: clamp(p.forces.distance, 30, 500, forces2d.distance),
      };
    }
    // Aditivo: perfil 3D salvo (prefs antigas sem o campo mantêm os defaults 3D).
    if (p.forces3d && typeof p.forces3d === 'object') {
      forces3d = {
        center: clamp(p.forces3d.center, 0, 1, forces3d.center),
        repel: clamp(p.forces3d.repel, 0, 20, forces3d.repel),
        link: clamp(p.forces3d.link, 0, 1, forces3d.link),
        distance: clamp(p.forces3d.distance, 30, 500, forces3d.distance),
      };
    }
    if (['neutral', 'domain', 'kind', 'degree'].includes(p.colorMode)) state.colorMode = p.colorMode;
    state.similarOpacity = clamp(p.similarOpacity, 0, 1, state.similarOpacity);
    if (typeof p.hideSimilar === 'boolean') state.hideSimilar = p.hideSimilar;
    // Perfil visual 2D — nomes legados (nodeSizeMult/lineSizeMult/textFadeMult
    // no root do JSON) continuam sendo o perfil 2D, igual `forces` acima.
    visual2d = {
      nodeSizeMult: clamp(p.nodeSizeMult, 0.3, 3, visual2d.nodeSizeMult),
      lineSizeMult: clamp(p.lineSizeMult, 0, 3, visual2d.lineSizeMult),
      textFadeMult: clamp(p.textFadeMult, -3, 3, visual2d.textFadeMult),
    };
    // Aditivo: perfil visual 3D salvo (prefs antigas sem o campo mantêm os
    // defaults visuais 3D).
    if (p.visual3d && typeof p.visual3d === 'object') {
      visual3d = {
        nodeSizeMult: clamp(p.visual3d.nodeSizeMult, 0.3, 3, visual3d.nodeSizeMult),
        lineSizeMult: clamp(p.visual3d.lineSizeMult, 0, 3, visual3d.lineSizeMult),
      };
    }
    if (typeof p.hideOrphans === 'boolean') state.hideOrphans = p.hideOrphans;
    if (typeof p.noOverlap === 'boolean') state.noOverlap = p.noOverlap;
    // Sincroniza o painel HTML com os valores carregados.
    const setVal = (id: string, v: number) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.value = String(v); };
    const setCheck = (id: string, c: boolean) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.checked = c; };
    // Sliders de força e visual NÃO são setados aqui: quem posiciona é
    // syncForceSliders()/syncVisualSliders() (chamados no updateModeUI do boot e
    // a cada toggle 2D↔3D), que refletem o perfil do MODO ATIVO — aqui o modo
    // inicial ainda nem foi resolvido.
    setVal('similar-opacity', Math.round(state.similarOpacity * 100));
    setCheck('similar-hide', state.hideSimilar);
    setCheck('hide-orphans', state.hideOrphans);
    setCheck('no-overlap', state.noOverlap);
    document.querySelectorAll('.graph-color-chip').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.colorMode === state.colorMode);
    });
  }
  applySavedPrefs();

  // Contatos: cor por TIPO (Pessoa/Empresa/...) é o default certo — grafo todo
  // cinza esconde a informação mais básica do vault (o print do "damásio" era
  // uma nuvem monocromática). Só sobrepõe o default 'neutral'; se o dono salvar
  // outra coloração nas prefs, ela vence na próxima carga igual pra notas.
  if (isContacts && state.colorMode === 'neutral') {
    state.colorMode = 'domain';
    document.querySelectorAll('.graph-color-chip').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.colorMode === 'domain');
    });
  }

  // Snapshot inicial pra Reset + raio pra collide proporcional + domínio pra
  // gravidade por domínio (A.37).
  const initialPositions: Array<{ id: string; x: number; y: number; r: number; domain: string }> = payload.nodes.map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    r: n.size,     // A.25 — passa raio pro worker
    domain: n.domain, // A.37 — passa domínio pro worker (gravidade por domínio)
  }));

  // Versão estável injetada pelo server (data-sw-ver no #graph-canvas) — cacheia
  // entre loads em vez de rebaixar o worker a cada page load (era Date.now()).
  const swVer = (document.getElementById('graph-canvas') as HTMLElement | null)?.dataset.swVer || '0';
  const worker = new Worker('/app/graph/sim-worker.bundle.js?v=' + swVer);

  // A.26 — recentralizar a câmera periodicamente durante o reveal.
  // Sem isso, a câmera fica fixa e os nós (que voam de range com D3-force)
  // saem da viewport — edges parecem invisíveis. Recentro a cada 30 ticks
  // até a simulação esfriar; depois disso fica fixa pro usuário pan/zoom.
  let tickCount = 0;
  // P1 (perf) — coalescer por requestAnimationFrame: o worker emite ~300 ticks
  // no reveal; em vez de aplicar posições + refresh a CADA tick, guardo a última
  // e dou UM refresh por frame de tela. Corta refreshes (e redesenhos 2D)
  // redundantes que travavam o load.
  let pendingPositions: Record<string, [number, number]> | null = null;
  let rafId = 0;
  function flushPositions() {
    rafId = 0;
    const positions = pendingPositions;
    pendingPositions = null;
    if (!positions) return;
    for (const id in positions) {
      const [x, y] = positions[id];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (graph.hasNode(id)) {
        graph.setNodeAttribute(id, 'x', x);
        graph.setNodeAttribute(id, 'y', y);
      }
    }
    renderer.refresh();
  }
  worker.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === 'tick') {
      pendingPositions = msg.positions as Record<string, [number, number]>;
      if (!rafId) rafId = requestAnimationFrame(flushPositions);
      tickCount++;
      // Recentro nos primeiros frames pra acompanhar o reveal explosivo
      if (!cameraSettled && (tickCount === 1 || tickCount % 30 === 0)) {
        void renderer.getCamera().animatedReset({ duration: 300 });
      }
    } else if (msg.type === 'end') {
      // Aplica as últimas posições pendentes (rAF pode não ter rodado ainda).
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      flushPositions();
      cameraSettled = true;
      // Centraliza no cluster principal: alguns órfãos/outliers distantes
      // esticam a bounding box e jogam o miolo do grafo pra um canto. Em vez
      // de enquadrar tudo, enquadro a bbox robusta (percentil) do núcleo.
      applyCoreBBox();
      void renderer.getCamera().animatedReset({ duration: 400 });
      // Redesenha as camadas 2D (semânticas/sugeridas) agora que assentou — P2.
      renderer.refresh();
      // Deep-link ?focus=<id>: DEPOIS do reset padrão acima, senão o
      // applyCoreBBox sempre desfaz o foco. Um frame de folga garante que o
      // Sigma já computou displayData pro nó antes do focusNode centralizar.
      if (pendingFocusId && graph.hasNode(pendingFocusId)) {
        const idToFocus = pendingFocusId;
        pendingFocusId = null;
        requestAnimationFrame(() => focusNode(idToFocus));
      }
    }
  });

  // Bounding box robusta do núcleo: ignora ~2% de outliers em cada extremo de
  // cada eixo, pra os poucos nós isolados/distantes não desenquadrarem o miolo.
  function applyCoreBBox() {
    const xs: number[] = [];
    const ys: number[] = [];
    graph.forEachNode((_id, attr) => {
      if (isFinite(attr.x) && isFinite(attr.y)) { xs.push(attr.x); ys.push(attr.y); }
    });
    if (xs.length < 8) { renderer.setCustomBBox(null); return; }
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    const p = 0.02;
    const lo = (arr: number[]) => arr[Math.floor(arr.length * p)];
    const hi = (arr: number[]) => arr[Math.min(arr.length - 1, Math.ceil(arr.length * (1 - p)))];
    let minX = lo(xs), maxX = hi(xs), minY = lo(ys), maxY = hi(ys);
    // Margem de 8% pra não colar os nós da borda na moldura da viewport.
    const mx = (maxX - minX) * 0.08 || 1;
    const my = (maxY - minY) * 0.08 || 1;
    renderer.setCustomBBox({ x: [minX - mx, maxX + mx], y: [minY - my, maxY + my] });
  }

  // A.36 — SÓ ligações explícitas entram na física. As arestas 'similar'
  // (semânticas) são overlay VISUAL, nunca estrutura: se entrassem no forceLink,
  // puxariam nós de ilhas diferentes pra perto e as ilhas se fundiriam — o
  // oposto do dente-de-leão do Obsidian, onde a estrutura vem só dos links reais.
  // Elas continuam renderizáveis (drawSimilarEdges), mas fora da simulação SEMPRE.
  const workerLinks = [];
  for (const e of payload.edges) {
    if (e.type !== 'explicit') continue;
    workerLinks.push({ source: e.source, target: e.target });
  }
  worker.postMessage({
    type: 'init',
    nodes: initialPositions,
    links: workerLinks,
    forces: mapForces(forces2d), // o sim-worker 2D SEMPRE usa o perfil 2D
    noOverlap: state.noOverlap,   // respeita o modo "não sobrepor" salvo já no 1º layout
    // Começa com alpha baixo: como já renderizamos no layout pré-computado do
    // servidor, a simulação só precisa de um ajuste fino suave — não do reveal
    // explosivo do alpha=1 (que reorganizava tudo do zero por ~5s).
    alpha: 0.25,
  });

  // Roteia o ajuste de slider pro perfil do MODO ATIVO. No 3D, NÃO toca no
  // sim-worker 2D (era isso que destruía a config do 2D ao mexer no 3D) — o
  // handler do slider já faz push3D(applyForces) pra reaquecer o palco 3D.
  function setForces(o: { center?: number; repel?: number; link?: number; distance?: number }) {
    if (mode === '3d') {
      forces3d = { ...forces3d, ...o };
      return;
    }
    forces2d = { ...forces2d, ...o };
    worker.postMessage({
      type: 'forces',
      forces: mapForces(forces2d),
      alpha: 0.3,
    });
  }

  // Roteia o ajuste de slider VISUAL (Tamanho das bolinhas / Espessura das
  // linhas / Aparição dos rótulos) pro perfil do MODO ATIVO — mesmo mecanismo
  // de setForces acima. textFadeMult é ignorado no 3D (sem equivalente lá; o
  // slider de rótulos já fica desabilitado/sem efeito no 3D, ver onTextFadeMult).
  function setVisual(o: { nodeSizeMult?: number; lineSizeMult?: number; textFadeMult?: number }) {
    if (mode === '3d') {
      const { nodeSizeMult, lineSizeMult } = o;
      visual3d = { ...visual3d, ...(nodeSizeMult !== undefined ? { nodeSizeMult } : {}), ...(lineSizeMult !== undefined ? { lineSizeMult } : {}) };
      return;
    }
    visual2d = { ...visual2d, ...o };
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
  renderer.on('clickStage', ({ event }: { event: { x: number; y: number } }) => {
    // Spec 20-frontend/25: com sugeridas ativas, o hit-test das linhas roda AQUI
    // (a overlay 2D fica pointer-events:none SEMPRE — deixá-la 'auto' sequestrava
    // hover/drag/zoom/pan do Sigma). O clickStage já resolve nó-vs-stage e ignora
    // cliques que foram drag.
    if (suggestedActive) {
      const hit = hitTestSuggested(event.x, event.y);
      if (hit) { openSuggestModal(hit.source, hit.target); return; }
    }
    closePanel();
  });

  // Allow opening a note from external code (eg. search enter, command palette)
  function focusNode(id: string) {
    if (!graph.hasNode(id)) return;
    // Em 3D, a câmera do globo voa até o nó (equivalente do animate 2D abaixo).
    if (mode === '3d' && g3d) { g3d.flyTo(id); openPanel(id); return; }
    // A câmera do Sigma vive no espaço ENQUADRADO (bbox ativo → ~[0..1]; repouso
    // = {0.5, 0.5, ratio 1}). Coordenadas CRUAS do graph (milhares de unidades
    // pós-simulação) jogavam a câmera pro vazio — spec 29. getNodeDisplayData
    // devolve x/y já nesse espaço.
    const dd = renderer.getNodeDisplayData(id);
    if (dd) {
      searchCameraMoved = true;
      renderer.getCamera().animate({ x: dd.x, y: dd.y, ratio: 0.35 }, { duration: 500 });
    }
    openPanel(id);
  }

  // Enquadra a câmera no bounding box dos matches da busca ativa — em 7,6k nós
  // o highlight sozinho é invisível em zoom-out; a câmera precisa IR até os
  // achados. Tudo em coordenadas DISPLAY (getNodeDisplayData — espaço enquadrado
  // onde repouso = {0.5, 0.5, ratio 1}), NUNCA nas cruas do graph: a v1 (93cdc10)
  // usava graph coords + piso 0.08 e mandava a câmera pro vazio com nós inflados
  // 12,5× (px renderizado = size/ratio) — spec 29. Guardas: só 2D, só pós-settle
  // (não briga com o animatedReset do reveal) e só até 200 matches.
  //
  // searchCameraMoved: marca que busca/foco mexeu na câmera — limpar a busca
  // dispara animatedReset e o usuário SEMPRE volta pro enquadramento padrão.
  let searchCameraMoved = false;
  function fitToMatches() {
    if (mode === '3d' || !cameraSettled) return;
    if (state.searchMatches.size === 0 || state.searchMatches.size > 200) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, count = 0;
    for (const id of state.searchMatches) {
      if (!graph.hasNode(id)) continue;
      const dd = renderer.getNodeDisplayData(id);
      if (!dd) continue;
      count++;
      if (dd.x < minX) minX = dd.x; if (dd.x > maxX) maxX = dd.x;
      if (dd.y < minY) minY = dd.y; if (dd.y > maxY) maxY = dd.y;
    }
    if (count === 0) return;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    // No espaço enquadrado ratio 1 ≈ moldura do bbox ativo, então o span dos
    // matches JÁ é a fração da moldura — sem denominador externo. Folga 1.4 pra
    // respiro; piso 0.25 (longe do minCameraRatio 0.08, que infla os nós).
    const ratio = Math.min(1.15, Math.max(0.25, Math.max(maxX - minX, maxY - minY) * 1.4 || 0.3));
    searchCameraMoved = true;
    renderer.getCamera().animate({ x: cx, y: cy, ratio }, { duration: 400 });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Slide panel (Obsidian-style) — visual state, no navigation
  // ────────────────────────────────────────────────────────────────────────
  const panel = ensurePanel();
  function openPanel(nodeId: string) {
    state.selectedNodeId = nodeId;
    const node = graph.getNodeAttributes(nodeId);
    // Contato tem painel próprio: telefone/empresa/conexões/eventos via proxy —
    // o template de NOTA (kind/tldr/"Abrir nota completa") não se aplica.
    if (isContacts) {
      openContactPanel(nodeId, (node.label as string) ?? nodeId, (node.domain as string) ?? 'other');
      return;
    }
    const m = meta.get(nodeId);
    const title = (node.label as string) ?? nodeId;
    const domainChips = m?.domains?.length
      ? m.domains.map((d) => {
          const meta2 = resolveDomainMeta(d, taxonomy);
          return `<span class="panel-chip" style="--chip:${meta2.color}">${esc(meta2.label)}</span>`;
        }).join('')
      : (() => {
          const meta2 = resolveDomainMeta(node.domain as string, taxonomy);
          return `<span class="panel-chip" style="--chip:${meta2.color}">${esc(meta2.label)}</span>`;
        })();
    const kindBadge = m?.kind
      ? (() => {
          const km = resolveKindMeta(m.kind, taxonomy);
          return `<span class="panel-kind" style="--chip:${km.color}">${esc(km.label)}</span>`;
        })()
      : '';
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

  // Painel de CONTATO: esqueleto imediato (nome/tipo/grau) + hidratação com o
  // detalhe do proxy /app/contacts/entity (telefone, empresa, conexões com
  // porquê, eventos, avatar). Camada ADITIVA: se o fetch falhar, o esqueleto
  // fica de pé — o painel nunca quebra o grafo. Seq guard evita que um detalhe
  // lento sobrescreva o painel de outro contato clicado depois.
  let contactPanelSeq = 0;
  function openContactPanel(nodeId: string, title: string, kind: string) {
    const neighbors = new Set<string>();
    graph.forEachNeighbor(nodeId, (n) => neighbors.add(n));
    const chip = `<span class="panel-chip" style="--chip:${domainColor(kind)}">${esc(CONTACT_TYPE_LABELS[kind] ?? kind)}</span>`;
    panel.innerHTML = `
      <button class="panel-close" aria-label="Fechar painel">×</button>
      <div class="panel-meta"><span class="panel-degree">${neighbors.size} ${neighbors.size === 1 ? 'conexão' : 'conexões'}</span></div>
      <h2 class="panel-title">${esc(title)}</h2>
      <div class="panel-chips">${chip}</div>
      <a class="panel-open" href="/app/contacts/${encodeURIComponent(nodeId)}">Abrir contato completo →</a>
      <div class="panel-contact-body"><p class="panel-tldr">Carregando detalhes...</p></div>
    `;
    panel.classList.add('open');
    panel.querySelector('.panel-close')?.addEventListener('click', closePanel, { once: true });

    const mySeq = ++contactPanelSeq;
    void fetch(`/app/contacts/entity?id=${encodeURIComponent(nodeId)}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: any) => {
        if (mySeq !== contactPanelSeq) return;
        const body = panel.querySelector('.panel-contact-body');
        if (!body) return;
        if (!d || d.ok === false) { body.innerHTML = ''; return; }
        const avatar = typeof d.img === 'string' && d.img.startsWith('/media/')
          ? `<img class="panel-avatar" src="/app/contacts${esc(d.img)}" alt="" loading="lazy">`
          : '';
        const fields = Array.isArray(d.fields) && d.fields.length
          ? `<dl class="panel-fields">${d.fields.map((f: any) => `
              <div class="panel-field"><dt>${esc(String(f.label ?? ''))}</dt><dd>${
                f.href
                  ? `<a href="${esc(String(f.href))}" target="_blank" rel="noopener">${esc(String(f.value ?? ''))}</a>`
                  : esc(String(f.value ?? ''))
              }</dd></div>`).join('')}</dl>`
          : '';
        const conns = Array.isArray(d.connections) && d.connections.length
          ? `<div class="panel-section-title">Conexões</div><div class="panel-conns">${d.connections.slice(0, 12).map((c: any) => `
              <button type="button" class="panel-conn" data-focus="${esc(String(c.otherId ?? ''))}">
                <span class="panel-conn-label">${esc(String(c.otherLabel ?? ''))}</span><span class="panel-conn-rel">${esc(String(c.rel ?? ''))}</span>
                ${c.why ? `<span class="panel-conn-why">${esc(String(c.why))}</span>` : ''}
              </button>`).join('')}</div>`
          : '';
        // Timeline (spec 50-console-v2/57): substitui a lista estática dos 8
        // eventos do payload por um bloco vivo, paginado (endpoint dedicado
        // /app/contacts/entity/events) + form "Registrar interação". Montado à
        // parte porque é assíncrono/interativo — não entra no innerHTML acima.
        body.innerHTML = `${avatar}${fields}${conns}`;
        const timelineWrap = document.createElement('div');
        timelineWrap.className = 'panel-timeline-wrap';
        body.appendChild(timelineWrap);
        body.querySelectorAll('.panel-conn').forEach((el) => {
          el.addEventListener('click', () => {
            const id = (el as HTMLElement).dataset.focus;
            if (id && graph.hasNode(id)) focusNode(id);
          });
        });
        initContactTimeline(nodeId, timelineWrap, () => mySeq === contactPanelSeq);
      })
      .catch(() => { /* aditivo: o esqueleto do painel já está de pé */ });
  }

  // Timeline PAGINADA de interações + form "Registrar interação" (spec
  // 50-console-v2/57). Proxy do Brain: GET /app/contacts/entity/events (leitura,
  // CONTACTS_PROXY_TOKEN read-only do lado do contacts) e POST
  // /app/contacts/entity/event (escrita, CONTACTS_WRITE_TOKEN escopado). `stillActive`
  // evita atualizar um painel que já foi trocado por outro contato (mesmo guard de
  // seq do hidrata acima).
  function initContactTimeline(entityId: string, container: HTMLElement, stillActive: () => boolean): void {
    const state = { offset: 0, total: 0, loading: false };

    container.innerHTML = `
      <div class="panel-section-title">Interações</div>
      <ul class="panel-events" data-timeline-list></ul>
      <button type="button" class="panel-timeline-more" data-timeline-more style="display:none">Carregar mais</button>
      <details class="panel-addconn">
        <summary class="panel-addconn-summary">Registrar interação</summary>
        <form class="panel-form" data-timeline-form>
          <div class="panel-form-field">
            <label class="panel-form-label">Tipo</label>
            <select class="panel-form-input" data-timeline-kind>
              ${MANUAL_EVENT_KINDS.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}
            </select>
          </div>
          <div class="panel-form-field">
            <label class="panel-form-label">Contexto (opcional)</label>
            <textarea class="panel-form-textarea" rows="3" maxlength="2000" data-timeline-context placeholder="Sobre o que foi..."></textarea>
          </div>
          <div class="panel-form-field">
            <label class="panel-form-label">Quando (opcional, padrão agora)</label>
            <input type="datetime-local" class="panel-form-input" data-timeline-when />
          </div>
          <div class="panel-form-feedback" role="status" data-timeline-feedback></div>
          <button type="submit" class="panel-form-submit" data-timeline-submit>Registrar</button>
        </form>
      </details>
    `;

    const list = container.querySelector('[data-timeline-list]') as HTMLUListElement;
    const moreBtn = container.querySelector('[data-timeline-more]') as HTMLButtonElement;
    const form = container.querySelector('[data-timeline-form]') as HTMLFormElement;
    const kindSel = container.querySelector('[data-timeline-kind]') as HTMLSelectElement;
    const ctxArea = container.querySelector('[data-timeline-context]') as HTMLTextAreaElement;
    const whenInput = container.querySelector('[data-timeline-when]') as HTMLInputElement;
    const feedback = container.querySelector('[data-timeline-feedback]') as HTMLElement;
    const submitBtn = container.querySelector('[data-timeline-submit]') as HTMLButtonElement;

    function renderItem(ev: { kind: string; ts: string; context?: string | null }): string {
      return `<li>
        <span class="panel-event-kind">${esc(EVENT_KIND_LABELS[ev.kind] ?? ev.kind)}</span>
        <span class="panel-event-ts">${esc(formatContactEventTs(ev.ts))}</span>
        ${ev.context ? `<div class="panel-event-ctx">${esc(ev.context)}</div>` : ''}
      </li>`;
    }

    async function loadPage(): Promise<void> {
      if (state.loading || !stillActive()) return;
      state.loading = true;
      moreBtn.disabled = true;
      moreBtn.textContent = 'Carregando...';
      try {
        const res = await fetch(
          `/app/contacts/entity/events?id=${encodeURIComponent(entityId)}&offset=${state.offset}&limit=${CONTACT_EVENTS_PAGE_SIZE}`,
          { credentials: 'same-origin' },
        );
        if (!stillActive()) return;
        const d: any = res.ok ? await res.json() : null;
        if (!d || d.ok === false) {
          moreBtn.style.display = 'none';
          if (state.offset === 0) list.innerHTML = '<li class="panel-empty">Erro ao carregar interações.</li>';
          return;
        }
        state.total = d.total ?? 0;
        const events = Array.isArray(d.events) ? d.events : [];
        if (state.offset === 0 && events.length === 0) {
          list.innerHTML = '<li class="panel-empty">Nenhuma interação registrada ainda.</li>';
        } else {
          list.insertAdjacentHTML('beforeend', events.map(renderItem).join(''));
        }
        state.offset += events.length;
        moreBtn.style.display = state.offset < state.total ? '' : 'none';
        moreBtn.textContent = 'Carregar mais';
      } catch {
        moreBtn.style.display = 'none';
      } finally {
        moreBtn.disabled = false;
        state.loading = false;
      }
    }

    moreBtn.addEventListener('click', () => void loadPage());
    void loadPage();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      feedback.textContent = '';
      feedback.classList.remove('error', 'ok');
      const ctxVal = ctxArea.value.trim();
      const body: { entity_id: string; kind: string; context?: string; ts?: string } = {
        entity_id: entityId,
        kind: kindSel.value,
      };
      if (ctxVal) body.context = ctxVal;
      if (whenInput.value) {
        const dt = new Date(whenInput.value);
        if (!Number.isNaN(dt.getTime())) body.ts = contactEventToSqliteUtc(dt);
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Registrando...';
      void fetch('/app/contacts/entity/event', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const data: any = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) throw new Error(data.error || `falha ${res.status}`);
          const emptyMsg = list.querySelector('.panel-empty');
          if (emptyMsg) emptyMsg.remove();
          list.insertAdjacentHTML('afterbegin', renderItem({
            kind: kindSel.value,
            ts: body.ts || contactEventToSqliteUtc(new Date()),
            context: ctxVal || null,
          }));
          state.total += 1;
          state.offset += 1;
          ctxArea.value = '';
          whenInput.value = '';
          feedback.classList.add('ok');
          feedback.textContent = 'Registrado.';
        })
        .catch((err) => {
          feedback.classList.add('error');
          feedback.textContent = `Erro: ${String(err?.message || err)}`;
        })
        .finally(() => {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Registrar';
        });
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Controls: search + domain/kind filters + opacity slider + zoom buttons
  // ────────────────────────────────────────────────────────────────────────
  // Fuse fica como fallback instantâneo (label + tldr) se a busca server-side
  // falhar. Caminho normal: /app/search (FTS5 em título + resumo + CORPO).
  const fuse = new Fuse(payload.nodes, {
    keys: [
      { name: 'label', weight: 0.7 },
      { name: 'tldr', weight: 0.3 },
    ],
    threshold: 0.35,
    minMatchCharLength: 2,
    ignoreLocation: true,
  });

  // Acento não pode separar "damásio" de "Damasio": dobra query e labels pra
  // minúsculo sem diacríticos antes de comparar (dropdown e highlight).
  const foldAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const searchIndex = payload.nodes.map((n) => ({ id: n.id, folded: foldAccents(n.label ?? '') }));

  // Busca local RANQUEADA por nome — prefixo > início de palavra > substring;
  // Fuse entra por último só pra tolerância a typo. Instantânea (memória).
  function localRankedIds(q: string, limit: number): string[] {
    const fq = foldAccents(q.trim());
    if (!fq) return [];
    const pref: string[] = [];
    const word: string[] = [];
    const sub: string[] = [];
    for (const e of searchIndex) {
      const i = e.folded.indexOf(fq);
      if (i === -1) continue;
      if (i === 0) pref.push(e.id);
      else if (e.folded[i - 1] === ' ') word.push(e.id);
      else sub.push(e.id);
    }
    const out = [...pref, ...word, ...sub];
    if (out.length < limit) {
      const seen = new Set(out);
      for (const h of fuse.search(q, { limit })) {
        if (seen.has(h.item.id)) continue;
        out.push(h.item.id);
        seen.add(h.item.id);
        if (out.length >= limit) break;
      }
    }
    return out.slice(0, limit);
  }

  // Busca server-side por vault. Notas: /app/search (FTS5 em título+resumo+
  // CORPO). Contatos: o proxy /app/contacts/data?q= cai no fetchByQuery do
  // Expert Console (semântico via embedding + LIKE em nome/empresa/cargo/setor/
  // notas) — usamos só os ids do subgrafo retornado. AbortController mata a
  // request anterior (padrão do Console standalone) e o seq guard em quem chama
  // descarta eco atrasado.
  let searchSeq = 0;
  let searchAbort: AbortController | null = null;
  async function serverSearchIds(q: string, limit: number): Promise<string[]> {
    searchAbort?.abort();
    const ac = new AbortController();
    searchAbort = ac;
    try {
      if (isContacts) {
        const res = await fetch(
          `${graphSrc}/data?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 30)}`,
          { credentials: 'same-origin', signal: ac.signal },
        );
        if (!res.ok) throw new Error('search ' + res.status);
        const sub = (await res.json()) as Payload;
        return (sub.nodes ?? []).map((n) => n.id).filter((id) => graph.hasNode(id)).slice(0, limit);
      }
      const res = await fetch('/app/search?q=' + encodeURIComponent(q), {
        credentials: 'same-origin',
        signal: ac.signal,
      });
      if (!res.ok) throw new Error('search ' + res.status);
      const ids = (await res.json()) as string[];
      return ids.filter((id) => graph.hasNode(id)).slice(0, limit);
    } catch (err) {
      if (ac.signal.aborted) return [];
      console.warn('graph: busca server-side falhou, usando Fuse', err);
      return fuse.search(q, { limit }).map((h) => h.item.id);
    }
  }

  // ── Dropdown typeahead da busca ──────────────────────────────────────────
  // Em grafo grande a resposta da busca é uma LISTA; o palco vai atrás da
  // escolha. Locais entram na hora; extras do servidor chegam com badge ≈
  // (match semântico/campos não visíveis). ↑↓ navega, Enter abre, Esc fecha.
  const searchResultsEl = document.getElementById('graph-search-results');
  type SearchItem = { id: string; label: string; domain: string; semantic: boolean };
  let searchItems: SearchItem[] = [];
  let searchActiveIdx = -1;

  function hideSearchResults() {
    searchItems = [];
    searchActiveIdx = -1;
    if (searchResultsEl) {
      searchResultsEl.hidden = true;
      searchResultsEl.innerHTML = '';
    }
  }

  function renderSearchResults(total: number) {
    if (!searchResultsEl) return;
    if (searchItems.length === 0) {
      searchResultsEl.innerHTML = `<div class="graph-search-empty">Nenhum resultado</div>`;
      searchResultsEl.hidden = false;
      return;
    }
    const hasSemantic = searchItems.some((it) => it.semantic);
    const rows = searchItems.map((it, i) => {
      const domainMeta = resolveDomainMeta(it.domain, taxonomy);
      const chipLabel = isContacts ? (CONTACT_TYPE_LABELS[it.domain] ?? it.domain) : domainMeta.label;
      const dotColor = isContacts ? domainColor(it.domain) : domainMeta.color;
      const sem = it.semantic
        ? `<span class="graph-search-sem" title="Match semântico (empresa, cargo, notas ou similaridade)">≈</span>`
        : '';
      const tldr = !isContacts ? (meta.get(it.id)?.tldr ?? '') : '';
      return `<button type="button" class="graph-search-item${i === searchActiveIdx ? ' active' : ''}" role="option" aria-selected="${i === searchActiveIdx}" data-idx="${i}">
        <span class="dot" style="background:${dotColor}"></span>
        <span class="graph-search-item-main"><span class="graph-search-item-label">${esc(it.label)}</span>${tldr ? `<span class="graph-search-item-tldr">${esc(tldr)}</span>` : ''}</span>
        ${sem}<span class="graph-search-item-chip">${esc(chipLabel)}</span>
      </button>`;
    }).join('');
    const counter = `<div class="graph-search-counter">${total} resultado${total === 1 ? '' : 's'}${hasSemantic ? ' · ≈ semântico' : ''}</div>`;
    searchResultsEl.innerHTML = counter + rows;
    searchResultsEl.hidden = false;
  }

  function selectSearchItem(idx: number) {
    const it = searchItems[idx];
    if (!it) return;
    focusNode(it.id);
    hideSearchResults();
  }

  // mousedown (não click): dispara ANTES do blur do input — senão o fechamento
  // por blur engole a seleção. preventDefault mantém o foco na caixa.
  searchResultsEl?.addEventListener('mousedown', (e) => {
    const item = (e.target as HTMLElement).closest('.graph-search-item') as HTMLElement | null;
    if (!item) return;
    e.preventDefault();
    selectSearchItem(Number(item.dataset.idx));
  });

  // ────────────────────────────────────────────────────────────────────────
  // Modo 2D / 3D — o 3D é um PALCO alternativo na MESMA tela: o painel esquerdo
  // (busca, chips, forças, visual, salvar/restaurar) comanda os DOIS. O bundle 3D
  // (three, 1.35MB) é lazy-loaded só quando liga. O estado `state` é compartilhado;
  // forças têm perfil POR MODO (forces2d/forces3d — ver setForces/syncForceSliders).
  // são compartilhados por referência; cada handler de controle, além de mexer no
  // Sigma 2D, empurra a mudança pro controlador 3D quando ele está ativo.
  // ────────────────────────────────────────────────────────────────────────
  interface Graph3DController {
    applyFilters: () => void; applyColors: () => void; applySimilar: () => void;
    applyNodeSize: () => void; applyForces: () => void; applyNoOverlap: () => void;
    applySearch: () => void; // busca acende/apaga nós no 3D (paridade com o 2D)
    flyTo: (id: string) => void; resize: () => void; dispose: () => void;
  }
  const wrap = container.closest('.graph-wrap') as HTMLElement | null;
  const can3D = !!document.getElementById('graph3d-stage');
  let mode: '2d' | '3d' = (wrap?.dataset.graphInitialMode === '3d' && can3D) ? '3d' : '2d';
  let g3d: Graph3DController | null = null;
  let bundle3DPromise: Promise<void> | null = null;

  // Injeta o bundle 3D uma única vez (CSP script-src 'self': <script src> local,
  // sem eval/inline). Resolve quando window.__initGraph3D existir.
  function loadBundle3D(): Promise<void> {
    if (bundle3DPromise) return bundle3DPromise;
    bundle3DPromise = new Promise<void>((resolve, reject) => {
      if ((window as any).__initGraph3D) { resolve(); return; }
      const btn = document.querySelector('[data-graph-action="toggle-3d"]') as HTMLElement | null;
      const src = btn?.dataset.graph3dSrc;
      if (!src) { reject(new Error('sem data-graph3d-src')); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('falha ao carregar bundle 3D'));
      document.head.appendChild(s);
    });
    return bundle3DPromise;
  }

  // Contexto passado ao 3D: reusa isNodeActive/pickNodeColor do 2D pra o filtro e
  // a coloração baterem exatamente. pickNodeColor do 3D recebe o GraphNode; aqui
  // adaptamos pra assinatura (id, attrs) do 2D montando um attrs a partir do nó.
  function ctx3D() {
    return {
      payload,
      state,
      getForces: () => forces3d, // o palco 3D SEMPRE lê o perfil 3D (nunca o 2D)
      getVisual: () => visual3d, // idem, pro perfil visual (node/line size)
      isNodeActive: (id: string) => isNodeActive(id),
      pickNodeColor: (id: string, node: GraphNode) =>
        pickNodeColor(id, { color: '#b8b8c8', domainColor: resolveDomainMeta(node.domain, taxonomy).color, kind: node.kind ?? '' }),
      // Abre o mesmo painel de nota do clique 2D (visual, sem navegar pra fora).
      onNodeOpen: (id: string) => openPanel(id),
    };
  }

  async function enter3D() {
    if (!can3D) return;
    wrap?.classList.add('mode-3d', 'mode-3d-loading');
    try {
      await loadBundle3D();
      const stage = document.getElementById('graph3d-stage') as HTMLElement | null;
      const init = (window as any).__initGraph3D as ((el: HTMLElement, c: any) => Graph3DController) | undefined;
      if (stage && init && !g3d) g3d = init(stage, ctx3D());
      else if (g3d) g3d.resize();
    } catch (err) {
      console.error('graph: 3D falhou', err);
      wrap?.classList.remove('mode-3d');
      mode = '2d';
    } finally {
      wrap?.classList.remove('mode-3d-loading');
    }
    updateModeUI();
  }

  function exit3D() {
    wrap?.classList.remove('mode-3d', 'mode-3d-loading');
    updateModeUI();
    // Sigma pode ter perdido dimensão enquanto escondido — reajusta o enquadre.
    applyCoreBBox();
    renderer.refresh();
  }

  // Reposiciona os 4 sliders de força pro perfil do MODO ATIVO. Chamado no boot
  // (updateModeUI inicial) e a cada toggle 2D↔3D — os sliders são compartilhados
  // entre os palcos, mas cada palco tem seu perfil; sem isso, o input mostraria o
  // valor do modo anterior e o 1º arrasto "pularia".
  function syncForceSliders() {
    const f = mode === '3d' ? forces3d : forces2d;
    const setVal = (id: string, v: number) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.value = String(v); };
    setVal('force-center', f.center);
    setVal('force-repel', f.repel);
    setVal('force-link', f.link);
    setVal('force-distance', f.distance);
  }

  // Reposiciona os sliders VISUAL (Tamanho das bolinhas / Espessura das linhas /
  // Aparição dos rótulos) pro perfil do MODO ATIVO — mesma mecânica de
  // syncForceSliders acima. "Aparição dos rótulos" não tem perfil 3D (sem
  // equivalente lá — rótulo só aparece no hover): o input sempre reflete
  // visual2d.textFadeMult, e continua SEM EFEITO no palco 3D quando arrastado
  // lá (mesmo comportamento de hoje — onTextFadeMult só dá renderer.refresh()
  // do Sigma 2D, nunca é empurrado pro 3D via push3D). Nenhum disabled/tooltip
  // novo foi adicionado aqui pra não mudar UX além do escopo do fix.
  function syncVisualSliders() {
    const v = mode === '3d' ? visual3d : visual2d;
    const setVal = (id: string, val: number) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.value = String(val); };
    setVal('node-size-mult', v.nodeSizeMult);
    setVal('line-size-mult', v.lineSizeMult);
    setVal('text-fade-mult', visual2d.textFadeMult);
  }

  // Sincroniza rótulo/estado do botão + o botão de "conexões sugeridas" (que só
  // faz sentido no 2D — em 3D fica desabilitado com tooltip, ver task item 2).
  function updateModeUI() {
    syncForceSliders(); // sliders refletem o perfil do modo ativo
    syncVisualSliders(); // idem, pros sliders de VISUAL
    const btn = document.querySelector('[data-graph-action="toggle-3d"]') as HTMLElement | null;
    if (btn) {
      btn.textContent = mode === '3d' ? '2D' : '3D';
      btn.setAttribute('aria-pressed', mode === '3d' ? 'true' : 'false');
    }
    const sug = document.getElementById('suggested-toggle') as HTMLButtonElement | null;
    if (sug) {
      const disable = mode === '3d';
      sug.disabled = disable;
      sug.style.opacity = disable ? '0.5' : '';
      sug.style.cursor = disable ? 'not-allowed' : '';
      sug.title = disable ? 'Disponível no 2D' : '';
    }
    // Spec 29: o modo NÃO vai mais pra URL no toggle — recarregar a página abre
    // SEMPRE em 2D (o ?mode=3d que sobrevivia ao F5 prendia o boot no 3D, igual
    // a pref persistida fazia). Deep-link ?mode=3d digitado à mão segue valendo;
    // aqui só LIMPAMOS um eventual ?mode residual da URL.
    try {
      const u = new URL(location.href);
      if (u.searchParams.has('mode')) {
        u.searchParams.delete('mode');
        history.replaceState(null, '', u.toString());
      }
    } catch { /* noop */ }
  }

  async function toggleMode() {
    if (mode === '3d') { mode = '2d'; exit3D(); }
    else {
      mode = '3d';
      // Sliders/botão refletem o modo NOVO imediatamente (síncrono com o clique).
      // enter3D é async (lazy-load do bundle na 1ª vez) e só chama updateModeUI
      // no fim — sem esta chamada, os sliders ficariam mostrando o perfil 2D
      // durante o load, e uma leitura/arrasto nesse intervalo agiria no perfil
      // errado visualmente (o setForces já roteia certo, mas o input mentiria).
      updateModeUI();
      await enter3D();
    }
  }
  // Espelha uma mutação de controle pro 3D quando ativo (no-op no 2D puro).
  const push3D = (fn: (c: Graph3DController) => void) => { if (mode === '3d' && g3d) fn(g3d); };

  // Se o server já mandou abrir em 3D (?mode=3d ou pref), liga após o boot.
  if (mode === '3d') { void enter3D(); }
  updateModeUI();

  // Limpeza COMPLETA do estado de busca (o input em si é de quem chama): zera
  // matches, fecha o dropdown, cancela request em voo e — se o foco/fit moveu a
  // câmera — devolve o enquadramento padrão (spec 29: "voltar da pesquisa" é
  // literal). Rota ÚNICA usada por: digitar vazio, Esc, o ✕ da caixa, o
  // "Limpar" de filtros e o "Restaurar padrão".
  function clearSearchState() {
    state.searchQuery = '';
    state.searchMatches = new Set();
    hideSearchResults();
    searchAbort?.abort();
    searchSeq++; // invalida eco server em voo
    (window as any).__updateActiveFilters?.();
    renderer.refresh();
    push3D((c) => c.applySearch());
    if (searchCameraMoved && mode === '2d') {
      searchCameraMoved = false;
      void renderer.getCamera().animatedReset({ duration: 400 });
    }
  }

  wireControls({
    onSearch: (q) => {
      state.searchQuery = q;
      if (!q) {
        clearSearchState();
        return;
      }
      // Instantâneo: ranking local por nome (prefixo > palavra > substring >
      // fuzzy), acento-insensível. Alimenta o highlight E o dropdown.
      const localIds = localRankedIds(q, 50);
      state.searchMatches = new Set(localIds);
      searchItems = localIds.slice(0, 8).map((id) => ({
        id,
        label: baseLabel.get(id) ?? id,
        domain: (graph.getNodeAttribute(id, 'domain') as string) ?? '',
        semantic: false,
      }));
      searchActiveIdx = searchItems.length ? 0 : -1;
      renderSearchResults(localIds.length);
      (window as any).__updateActiveFilters?.();
      renderer.refresh();
      push3D((c) => c.applySearch());
      fitToMatches();
      // Background: server amplia (FTS no corpo pra notas; semântico + empresa/
      // cargo/notas pra contatos). Extras entram no fim do dropdown com ≈.
      const mySeq = ++searchSeq;
      void serverSearchIds(q, 30).then((ids) => {
        if (mySeq !== searchSeq) return;
        const extra = ids.filter((id) => !state.searchMatches.has(id));
        if (extra.length === 0) return;
        state.searchMatches = new Set([...state.searchMatches, ...extra]);
        const room = Math.max(0, 10 - searchItems.length);
        for (const id of extra.slice(0, room)) {
          searchItems.push({
            id,
            label: baseLabel.get(id) ?? id,
            domain: (graph.getNodeAttribute(id, 'domain') as string) ?? '',
            semantic: true,
          });
        }
        if (searchActiveIdx === -1 && searchItems.length) searchActiveIdx = 0;
        renderSearchResults(state.searchMatches.size);
        (window as any).__updateActiveFilters?.();
        renderer.refresh();
        push3D((c) => c.applySearch());
        fitToMatches();
      });
    },
    onSearchSubmit: (q) => {
      if (!q) return;
      // Enter abre o item ativo do dropdown; sem dropdown, cai no 1º match
      // ranqueado local; sem local, tenta o servidor.
      if (searchActiveIdx >= 0 && searchItems[searchActiveIdx]) {
        selectSearchItem(searchActiveIdx);
        return;
      }
      const local = localRankedIds(q, 1);
      if (local[0]) { focusNode(local[0]); hideSearchResults(); return; }
      void serverSearchIds(q, 1).then((ids) => {
        if (ids[0]) { focusNode(ids[0]); hideSearchResults(); }
      });
    },
    onSearchNav: (delta) => {
      if (!searchItems.length) return;
      searchActiveIdx = (searchActiveIdx + delta + searchItems.length) % searchItems.length;
      renderSearchResults(state.searchMatches.size);
      searchResultsEl?.querySelector('.graph-search-item.active')?.scrollIntoView({ block: 'nearest' });
    },
    onSearchClose: () => hideSearchResults(),
    onDomainToggle: (domain, active) => {
      if (!state.domainFilter) state.domainFilter = new Set();
      if (active) state.domainFilter.add(domain);
      else state.domainFilter.delete(domain);
      if (state.domainFilter.size === 0) state.domainFilter = null;
      (window as any).__updateActiveFilters?.();
      renderer.refresh();
      push3D((c) => c.applyFilters());
    },
    onKindToggle: (kind, active) => {
      if (!state.kindFilter) state.kindFilter = new Set();
      if (active) state.kindFilter.add(kind);
      else state.kindFilter.delete(kind);
      if (state.kindFilter.size === 0) state.kindFilter = null;
      (window as any).__updateActiveFilters?.();
      renderer.refresh();
      push3D((c) => c.applyFilters());
    },
    onSimilarOpacity: (v) => { state.similarOpacity = v; renderer.refresh(); push3D((c) => c.applySimilar()); },
    onSimilarHide: (hide) => { state.hideSimilar = hide; (window as any).__updateActiveFilters?.(); renderer.refresh(); push3D((c) => c.applySimilar()); },
    // A.33/A.35 — color mode (substitui onShowColors removido).
    onColorMode: (m) => {
      state.colorMode = (['neutral','domain','kind','degree'].includes(m) ? m : 'neutral') as any;
      renderer.refresh();
      push3D((c) => c.applyColors());
    },
    // factor explícito pequeno (1.12 = ~12% por clique). Sem isso o Sigma usa
    // DEFAULT_ZOOMING_RATIO (1.5), que pulava demais — o zoomingRatio das
    // settings só vale pra roda do mouse, não pros botões.
    onZoomIn: () => renderer.getCamera().animatedZoom({ duration: 200, factor: 1.12 }),
    onZoomOut: () => renderer.getCamera().animatedUnzoom({ duration: 200, factor: 1.12 }),
    onFit: () => {
      // Reaplica a bbox do núcleo antes de enquadrar — "ajustar à tela" sempre
      // centraliza o miolo, mesmo depois de pan/zoom ou mudança de filtro.
      applyCoreBBox();
      renderer.getCamera().animatedReset({ duration: 400 });
    },
    // A.22 + A.29 — Display. Roteia pro perfil visual do MODO ATIVO (setVisual) —
    // mexer no slider no 3D não pode mais destruir a config do 2D, e vice-versa.
    onNodeSizeMult: (v) => { setVisual({ nodeSizeMult: v }); renderer.refresh(); push3D((c) => c.applyNodeSize()); },
    onLineSizeMult: (v) => { setVisual({ lineSizeMult: v }); renderer.refresh(); push3D((c) => c.applyNodeSize()); },
    // textFadeMult é 2D-only (sem equivalente no 3D) — setVisual já ignora esse
    // campo quando mode==='3d' (visual3d não tem essa chave); no 3D o slider
    // segue visível e arrastável mas sem efeito nenhum (mesmo comportamento de
    // hoje: nunca foi empurrado pro palco 3D via push3D).
    onTextFadeMult: (v) => { setVisual({ textFadeMult: v }); renderer.refresh(); },
    onHideOrphans: (hide) => { state.hideOrphans = hide; (window as any).__updateActiveFilters?.(); renderer.refresh(); push3D((c) => c.applyFilters()); },
    // A.29 — Forces (live, ranges Obsidian-like)
    onForceCenter: (v) => { setForces({ center: v }); push3D((c) => c.applyForces()); },
    onForceRepel: (v) => { setForces({ repel: v }); push3D((c) => c.applyForces()); },
    onForceLink: (v) => { setForces({ link: v }); push3D((c) => c.applyForces()); },
    onForceDistance: (v) => { setForces({ distance: v }); push3D((c) => c.applyForces()); },
    // Liga/desliga "não sobrepor": manda pro worker reforçar a colisão e reaquecer.
    onNoOverlap: (on) => {
      state.noOverlap = on;
      worker.postMessage({ type: 'collide', noOverlap: on });
      push3D((c) => c.applyNoOverlap());
    },
    // Salva a configuração atual como padrão do dono (persiste no meta, sincroniza
    // entre máquinas). Filtros/busca NÃO entram — são exploração, não preferência.
    onSavePrefs: () => {
      const prefs = {
        // Persiste os DOIS perfis de força (2D e 3D) — salvar no 3D não apaga a
        // calibração do 2D e vice-versa. Server sanitiza ambos (graph-prefs.ts).
        forces: { ...forces2d },
        forces3d: { ...forces3d },
        colorMode: state.colorMode,
        similarOpacity: state.similarOpacity,
        hideSimilar: state.hideSimilar,
        // Idem pros perfis visuais: nodeSizeMult/lineSizeMult/textFadeMult no
        // root seguem sendo o perfil 2D (nome legado); visual3d é o aditivo —
        // salvar no 3D não apaga a calibração visual do 2D e vice-versa.
        nodeSizeMult: visual2d.nodeSizeMult,
        lineSizeMult: visual2d.lineSizeMult,
        textFadeMult: visual2d.textFadeMult,
        visual3d: { ...visual3d },
        hideOrphans: state.hideOrphans,
        noOverlap: state.noOverlap,
      };
      const btn = document.getElementById('graph-save-prefs');
      const restore = () => { if (btn) setTimeout(() => { btn.textContent = 'Salvar como padrão'; }, 1600); };
      fetch('/app/graph/prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Spec 29: cada superfície salva na SUA chave (contatos ≠ notas) — o
        // server roteia pelo campo surface. `mode` não vai no payload: boot é
        // SEMPRE 2D; 3D só por escolha explícita na sessão (?mode=3d/toggle).
        body: JSON.stringify({ ...prefs, surface: isContacts ? 'contacts' : 'notes' }),
      }).then((r) => {
        if (r.ok) {
          // O dataset é a FONTE do "Restaurar padrão" (applySavedPrefs relê) —
          // sem atualizar aqui, restaurar logo após salvar voltaria pro padrão
          // ANTERIOR ao salve, não pro recém-salvo.
          const canvas = document.getElementById('graph-canvas');
          if (canvas) canvas.dataset.graphPrefs = JSON.stringify(prefs);
        }
        if (btn) btn.textContent = r.ok ? 'Salvo! ✓' : 'Erro ao salvar';
        restore();
      }).catch(() => {
        if (btn) btn.textContent = 'Erro ao salvar';
        restore();
      });
    },
    // "Restaurar padrão" — volta pro PADRÃO SALVO do dono, não pra fábrica: quem
    // salvou um padrão espera que o botão volte PRA ELE (fábrica é só o fallback
    // de quem nunca salvou). Equivale a recarregar a página: fábrica nos dois
    // palcos → blob salvo por cima (a MESMA applySavedPrefs do boot, relendo o
    // dataset que o Salvar atualiza) → exploração zerada → layout inicial.
    onResetAll: () => {
      // 1. Exploração (busca + filtros de categoria) zera — não faz parte do
      // padrão salvo; clearSearchState devolve a câmera se a busca a moveu.
      const searchInput = document.getElementById('graph-search-input') as HTMLInputElement | null;
      if (searchInput) searchInput.value = '';
      clearSearchState();
      state.domainFilter = null;
      state.kindFilter = null;
      // 2. Fábrica como BASELINE nos dois perfis de cada palco + toggles: o blob
      // salvo entra por cima; campo ausente no blob fica exatamente na fábrica
      // (applySavedPrefs usa o valor corrente como fallback dos clamps).
      forces2d = { ...FORCE_DEFAULTS };
      forces3d = { ...FORCE3D_DEFAULTS };
      visual2d = { ...VISUAL_DEFAULTS };
      visual3d = { ...VISUAL3D_DEFAULTS };
      state.colorMode = 'neutral';
      state.similarOpacity = 0.18;
      state.hideSimilar = false;
      state.hideOrphans = false;
      state.noOverlap = false;
      applySavedPrefs();
      // Contatos: default de coloração por TIPO (pessoa/empresa) — mesmo
      // override do boot; restaurar não pode devolver a nuvem cinza.
      if (isContacts && state.colorMode === 'neutral') state.colorMode = 'domain';
      // 3. Reaplica nos palcos: física 2D com o perfil FINAL (salvo ou fábrica),
      // collide conforme o padrão, e posições de volta ao snapshot inicial.
      worker.postMessage({ type: 'forces', forces: mapForces(forces2d), alpha: 0.5 });
      worker.postMessage({ type: 'collide', noOverlap: state.noOverlap });
      resetGraphLayout();
      // 4. Sync HTML — sempre daqui (applySavedPrefs só sincroniza quando HÁ
      // blob salvo; sem blob, os inputs têm que refletir a fábrica).
      const setVal = (id: string, v: number | string) => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) el.value = String(v);
      };
      const setCheck = (id: string, c: boolean) => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) el.checked = c;
      };
      setVal('similar-opacity', Math.round(state.similarOpacity * 100));
      setCheck('similar-hide', state.hideSimilar);
      setCheck('hide-orphans', state.hideOrphans);
      setCheck('no-overlap', state.noOverlap);
      // Sliders de força e visual refletem o perfil do modo ativo (recém-restaurado).
      syncForceSliders();
      syncVisualSliders();
      // A.35 — chips de coloração seguem o modo final (salvo ou default do vault)
      document.querySelectorAll('.graph-color-chip').forEach((el) => {
        el.classList.toggle('active', (el as HTMLElement).dataset.colorMode === state.colorMode);
      });
      document.querySelectorAll('.graph-chip.active').forEach((el) => el.classList.remove('active'));
      (window as any).__updateActiveFilters?.();
      renderer.refresh();
      // Espelha a restauração completa no palco 3D quando ativo.
      push3D((c) => { c.applyFilters(); c.applyColors(); c.applySearch(); c.applySimilar(); c.applyNodeSize(); c.applyForces(); c.applyNoOverlap(); });
    },
    // "Limpar" (indicador de filtros ativos) — SÓ exploração: busca + chips de
    // categoria/tipo. Visual, forças, cores, toggles e posições são CONFIGURAÇÃO
    // e ficam intactos (era o bug: Limpar chamava o reset nuclear e destruía o
    // visual que o dono tinha acabado de ajustar).
    onClearFilters: () => {
      const searchInput = document.getElementById('graph-search-input') as HTMLInputElement | null;
      if (searchInput) searchInput.value = '';
      clearSearchState();
      state.domainFilter = null;
      state.kindFilter = null;
      document.querySelectorAll('.graph-chip.active').forEach((el) => el.classList.remove('active'));
      (window as any).__updateActiveFilters?.();
      renderer.refresh();
      push3D((c) => c.applyFilters());
    },
    // Toggle 2D/3D — troca o palco sem recarregar; lazy-load do bundle 3D na 1ª vez.
    onToggle3D: () => { void toggleMode(); },
  }, payload.nodes, taxonomy);

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
      hideSearchResults();
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
    // Cor única → um path só (spec 25); mesmo cache/culling das semânticas.
    const w = overlay.width / dpr;
    const h = overlay.height / dpr;
    octx.save();
    octx.lineWidth = 1.4;
    octx.setLineDash([4, 4]);
    octx.lineCap = 'round';
    octx.strokeStyle = 'rgba(255, 200, 100, 0.55)';
    octx.beginPath();
    for (const p of suggestedPairs) {
      if (!graph.hasNode(p.source) || !graph.hasNode(p.target)) continue;
      if (!isNodeActive(p.source) || !isNodeActive(p.target)) continue;
      const a = nodeViewport(p.source);
      const b = nodeViewport(p.target);
      if (outOfView(a, w, h) && outOfView(b, w, h)) continue;
      octx.moveTo(a.x, a.y);
      octx.lineTo(b.x, b.y);
    }
    octx.stroke();
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

  // Hit-test das linhas sugeridas em coordenadas de viewport — chamado pelo
  // clickStage do Sigma (spec 25), NUNCA por listener na overlay (que permanece
  // pointer-events:none em todos os estados).
  function hitTestSuggested(mx: number, my: number): { source: string; target: string } | null {
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
    return best && best.d < 8 ? { source: best.p.source, target: best.p.target } : null;
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

  // Regra canônica do MCP (link.ts): why nomeia o mecanismo, mínimo 20 chars.
  const WHY_MIN = 20;
  function suggestErrorEl(): HTMLElement | null { return document.getElementById('suggest-error'); }
  function showSuggestError(msg: string) {
    const el = suggestErrorEl();
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }
  function clearSuggestError() {
    const el = suggestErrorEl();
    if (el) { el.textContent = ''; el.style.display = 'none'; }
  }
  function syncWhyCounter() {
    const ta = document.getElementById('suggest-why') as HTMLTextAreaElement | null;
    const count = document.getElementById('suggest-why-count');
    const btn = document.getElementById('suggest-create-btn') as HTMLButtonElement | null;
    const len = (ta?.value || '').trim().length;
    if (count) count.textContent = `${len}/${WHY_MIN} mín`;
    if (btn) btn.disabled = len < WHY_MIN;
  }
  document.getElementById('suggest-why')?.addEventListener('input', () => { clearSuggestError(); syncWhyCounter(); });

  function openSuggestModal(sourceId: string, targetId: string) {
    const bd = document.getElementById('graph-suggest-modal-backdrop');
    const fromEl = document.getElementById('suggest-from');
    const toEl = document.getElementById('suggest-to');
    const ta = document.getElementById('suggest-why') as HTMLTextAreaElement | null;
    if (!bd || !fromEl || !toEl || !ta) return;
    fromEl.textContent = graph.getNodeAttribute(sourceId, 'label') as string;
    toEl.textContent = graph.getNodeAttribute(targetId, 'label') as string;
    ta.value = '';
    const rel = document.getElementById('suggest-relation') as HTMLSelectElement | null;
    if (rel) rel.value = 'analogous_to';
    clearSuggestError();
    syncWhyCounter();
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
    if (why.length < WHY_MIN) {
      showSuggestError(`Justificativa com no mínimo ${WHY_MIN} caracteres — nomeie o mecanismo compartilhado (princípio Latticework).`);
      ta?.focus();
      return;
    }
    const relSel = document.getElementById('suggest-relation') as HTMLSelectElement | null;
    const relationType = relSel?.value === 'same_mechanism_as' ? 'same_mechanism_as' : 'analogous_to';
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
          relation_type: relationType,
        }),
      });
      if (!res.ok) {
        // Mostra o erro REAL do server inline (mantém o modal aberto pra corrigir).
        let serverMsg = `Erro ao criar ligação (HTTP ${res.status}).`;
        try {
          const body = await res.json() as { error?: string };
          if (body?.error) serverMsg = body.error;
        } catch { /* corpo não-JSON: fica a mensagem genérica */ }
        showSuggestError(serverMsg);
        return;
      }
      // Adiciona edge no graph local sem precisar reload
      const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      try {
        graph.addEdgeWithKey(id, suggestModalState.source, suggestModalState.target, {
          // A.36 — mesmo fio discreto das demais explícitas (ver bloco de load).
          size: 0.8,
          color: 'rgba(63, 63, 70, 0.35)',
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
      showSuggestError('Erro de rede ao criar ligação — tente de novo.');
    } finally {
      if (btn) { btn.textContent = 'Criar ligação'; syncWhyCounter(); }
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
    if (action === 'toggle-suggested') toggleSuggestedLinks();
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

// Timeline de interações do contato (spec 50-console-v2/57) — labels PT-BR,
// cópia inline porque este bundle não importa o TS do worker de contatos (mesmo
// padrão de CONTACT_TYPE_LABELS acima, pro tipo de ENTIDADE).
const EVENT_KIND_LABELS: Record<string, string> = {
  met: 'Encontro', talked: 'Conversa', meeting: 'Reunião', email: 'E-mail', message: 'Mensagem',
  note: 'Nota', saw_post: 'Vi post', recommended: 'Indicação', birthday_reminder: 'Aniversário',
  mentioned_in_brain: 'Citado no Brain',
};
// Kinds MANUAIS oferecidos no form "Registrar interação" (spec 57 §4).
const MANUAL_EVENT_KINDS: Array<{ value: string; label: string }> = [
  { value: 'met', label: 'Encontro' },
  { value: 'talked', label: 'Conversa' },
  { value: 'meeting', label: 'Reunião' },
  { value: 'email', label: 'E-mail' },
  { value: 'message', label: 'Mensagem' },
  { value: 'note', label: 'Nota' },
];
const CONTACT_EVENTS_PAGE_SIZE = 20;

// Timestamp de evento → data/hora BRT curta. A coluna events.ts do contacts é UTC
// "YYYY-MM-DD HH:MM:SS" (datetime('now') do SQLite); normaliza pra ISO antes do
// Date() pra não depender de parsing ambíguo entre browsers.
function formatContactEventTs(ts: string): string {
  if (!ts) return '';
  const iso = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 16);
  try {
    return d.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return ts.slice(0, 16);
  }
}

// Converte um Date (valor de <input type="datetime-local">, já em hora LOCAL do
// browser) pro MESMO formato UTC "YYYY-MM-DD HH:MM:SS" que datetime('now') grava —
// mistura de formatos quebraria a ordenação lexicográfica ORDER BY ts DESC.
function contactEventToSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
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
function renderLegend(nodes: GraphNode[], taxonomy: TaxonomyConfig) {
  const el = document.getElementById('graph-legend');
  if (!el) return;

  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.domain, (counts.get(n.domain) ?? 0) + 1);
  // spec 54 — áreas pré-criadas na taxonomia (0 notas ainda) aparecem na
  // legenda/filtro assim que salvas, mesmo sem nenhum nó usando o slug.
  for (const slug of Object.keys(taxonomy.domains)) {
    if (!counts.has(slug)) counts.set(slug, 0);
  }

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
    .map((d) => {
      const meta = resolveDomainMeta(d, taxonomy);
      return `
      <button class="graph-chip" data-filter="domain" data-value="${esc(d)}">
        <span class="dot" style="background:${meta.color}"></span>
        <span class="label">${esc(meta.label)}</span>
        <span class="count">${counts.get(d)}</span>
      </button>`;
    })
    .join('');
}

// ──────────────────────────────────────────────────────────────────────────────
// Wire up all interactive controls in the overlay
// ──────────────────────────────────────────────────────────────────────────────
interface ControlCallbacks {
  onSearch: (q: string) => void;
  onSearchSubmit: (q: string) => void;
  // Dropdown typeahead: ↑↓ navega itens (delta ±1); close fecha (blur/Esc).
  onSearchNav: (delta: number) => void;
  onSearchClose: () => void;
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
  // "Restaurar padrão" — volta pro padrão SALVO (fábrica só se nunca salvou) e
  // zera exploração + layout. "Limpar" — SÓ exploração (busca + categorias),
  // sem tocar visual/forças (dois botões, dois handlers; eram o mesmo, e era o bug).
  onResetAll: () => void;
  onClearFilters: () => void;
  // A.33 — modo de coloração
  onColorMode: (mode: string) => void;
  // Não-sobrepor as bolinhas (collide forte) + salvar config como padrão do dono.
  onNoOverlap: (on: boolean) => void;
  onSavePrefs: () => void;
  // Alterna o palco 2D/3D na mesma tela (lazy-load do bundle 3D na 1ª vez).
  onToggle3D: () => void;
}

function wireControls(cb: ControlCallbacks, nodes: GraphNode[], taxonomy: TaxonomyConfig) {
  const search = document.getElementById('graph-search-input') as HTMLInputElement | null;
  if (search) {
    let t: number | null = null;
    search.addEventListener('input', () => {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => cb.onSearch(search.value.trim()), 90);
    });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        cb.onSearchSubmit(search.value.trim());
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        cb.onSearchNav(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cb.onSearchNav(-1);
      } else if (e.key === 'Escape') {
        if (search.value) { search.value = ''; cb.onSearch(''); }
        cb.onSearchClose();
      }
    });
    // Fecha o dropdown ao sair da caixa — com atraso pra seleção por mousedown
    // (que roda antes do blur e usa preventDefault) não ser engolida.
    search.addEventListener('blur', () => { window.setTimeout(() => cb.onSearchClose(), 150); });
  }
  // ✕ da caixa de busca — limpa SÓ a busca (não os filtros nem o visual) e
  // devolve o foco pra caixa. Visibilidade é CSS puro (:has no graph.ts server).
  const searchClear = document.getElementById('graph-search-clear');
  searchClear?.addEventListener('click', () => {
    if (search) { search.value = ''; search.focus(); }
    cb.onSearch('');
  });

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
      if (action === 'save-prefs') cb.onSavePrefs();
      if (action === 'toggle-3d') cb.onToggle3D();
      // A.30 — botão "Limpar" do indicador de filtros ativos (handler PRÓPRIO:
      // só exploração; não confundir com o reset-all acima)
      if (action === 'clear-filters') cb.onClearFilters();
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
  const noOverlap = document.getElementById('no-overlap') as HTMLInputElement | null;
  if (noOverlap) {
    noOverlap.addEventListener('change', () => cb.onNoOverlap(noOverlap.checked));
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
      .map((k) => {
        const label = resolveKindMeta(k, taxonomy).label;
        return `
        <button class="graph-chip graph-chip-kind" data-filter="kind" data-value="${esc(k)}">
          <span class="label">${esc(label)}</span>
          <span class="count">${counts.get(k)}</span>
        </button>`;
      })
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

// Recolher o painel de controles (desktop): esconde filtros/forças/visual e
// deixa só a barra de busca. Estado persiste em cookie (server renderiza já
// recolhido, sem flash).
function wirePanelToggle() {
  const btn = document.getElementById('graph-panel-toggle') as HTMLButtonElement | null;
  const overlay = document.getElementById('graph-overlay');
  if (!btn || !overlay) return;
  btn.addEventListener('click', () => {
    const collapsed = overlay.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', collapsed ? 'Expandir filtros' : 'Recolher filtros');
    document.cookie = `eb_graphpanel=${collapsed ? 'collapsed' : 'expanded'}; path=/; max-age=31536000; samesite=lax`;
  });
}

function wireOverlayToggle() {
  const toggle = document.getElementById('graph-overlay-toggle') as HTMLButtonElement | null;
  const overlay = document.getElementById('graph-overlay');
  if (!toggle || !overlay) return;

  const setOpen = (open: boolean) => {
    overlay.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };

  toggle.addEventListener('click', () => {
    const open = !overlay.classList.contains('open');
    setOpen(open);
  });

  // Em desktop, força aberto (CSS deixa visível por padrão de qualquer jeito).
  // Em mobile, começa fechado.
  const mq = window.matchMedia('(min-width: 768px)');
  const applyMq = (e: MediaQueryList | MediaQueryListEvent) => {
    if (e.matches) setOpen(true);
    else setOpen(false);
  };
  applyMq(mq);
  mq.addEventListener('change', applyMq);
}

main().catch((err) => {
  console.error(err);
  setStatus('Erro ao carregar grafo');
});
