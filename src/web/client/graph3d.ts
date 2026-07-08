import ForceGraph3D from '3d-force-graph';
import { forceManyBody, forceCenter, forceCollide } from 'd3-force-3d';
import { domainColor } from '../domain-colors.js';

// ──────────────────────────────────────────────────────────────────────────────
// Grafo 3D — o "globo que gira", agora como um MODO do /app/graph (não mais uma
// página standalone). Este bundle é lazy-loaded pelo client 2D (graph.ts) só
// quando o dono liga o 3D — os 1.35MB (three + 3d-force-graph) não pesam o load
// padrão. Registra um inicializador global window.__initGraph3D que o 2D chama
// passando o MESMO payload/estado/callbacks dos controles do painel esquerdo, pra
// os controles (busca, chips de área/tipo, coloração, forças, semânticas, etc.)
// comandarem os DOIS palcos sem duplicar UI. CSP do app é script-src 'self': o
// bundle (three incluso) é self-hosted, ZERO CDN. Ver src/web/render.ts (CSP).
// ──────────────────────────────────────────────────────────────────────────────

// Shapes espelham o payload de src/web/graph-data.ts + o estado vivo do client 2D.
interface GraphNode {
  id: string;
  label: string;
  domain: string;
  size: number;
  x: number;
  y: number;
  kind?: string;
  tldr?: string;
}
interface ExplicitEdge { id: string; source: string; target: string; type: 'explicit'; why: string; relation_type: string; }
interface SimilarEdge { id: string; source: string; target: string; type: 'similar'; score: number; }
type Edge = ExplicitEdge | SimilarEdge;
interface Payload { nodes: GraphNode[]; edges: Edge[]; }

// Estado vivo compartilhado com o client 2D (mesmo objeto por referência). O 3D
// LÊ daqui; nunca escreve. Só os campos que o 3D consome estão tipados.
// nodeSizeMult/lineSizeMult NÃO ficam mais aqui (eram estado global até
// 2026-07, compartilhado com o 2D) — viraram perfil PRÓPRIO do 3D, lido via
// ctx.getVisual() (mesmo padrão do ctx.getForces() abaixo). Ver visual2d/
// visual3d no client 2D (graph.ts).
interface SharedState {
  similarOpacity: number;   // 0..1
  hideSimilar: boolean;
  noOverlap: boolean;
  colorMode: 'neutral' | 'domain' | 'kind' | 'degree';
  // Busca ativa (mesmo Set do 2D, por referência) — spec 29: o 3D acende só os
  // matches e apaga o resto, paridade com o nodeReducer do 2D.
  searchMatches: Set<string>;
}
interface Forces { center: number; repel: number; link: number; distance: number; }
// Perfil visual do palco 3D — sem textFadeMult (sem equivalente no 3D: rótulo
// só aparece no hover).
interface Visual3D { nodeSizeMult: number; lineSizeMult: number; }

// Contexto injetado pelo client 2D. Reusa as MESMAS funções de filtro/cor do 2D
// (isNodeActive / pickNodeColor) pra o comportamento bater exatamente entre palcos.
interface Ctx {
  payload: Payload;
  state: SharedState;
  getForces: () => Forces;
  getVisual: () => Visual3D; // o palco 3D SEMPRE lê o perfil visual 3D (nunca o 2D)
  isNodeActive: (id: string) => boolean;    // mesma lógica de chips + esconder isoladas do 2D
  pickNodeColor: (id: string, node: GraphNode) => string; // mesma coloração (neutra/área/tipo/grau) do 2D
  onNodeOpen: (id: string) => void;         // abre o painel de nota (mesmo do clique 2D)
}

// Controlador devolvido ao 2D pra ele empurrar mudanças de estado por evento
// (sem polling): cada handler do painel chama o método correspondente.
export interface Graph3DController {
  applyFilters: () => void;   // chips área/tipo + esconder isoladas
  applyColors: () => void;    // modo de coloração
  applySimilar: () => void;   // intensidade/esconder das linhas semânticas
  applyNodeSize: () => void;  // multiplicador de tamanho + espessura
  applyForces: () => void;    // 4 sliders de força → d3-force-3d + reheat
  applyNoOverlap: () => void; // colisão forte
  applySearch: () => void;    // busca: acende matches, apaga o resto (spec 29)
  flyTo: (id: string) => void;// busca/focar nota → câmera voa até o nó
  resize: () => void;
  dispose: () => void;
}

const BG_COLOR = '#0c0c10'; // espelho JS do token --surface-canvas (styles.ts) — WebGL não lê CSS var

// Baseline de colisão espelhado do sim-worker.ts do 2D (raio flat 60 desligado,
// 66 ligado). No mundo 3D usamos nodeRelSize 6 e o `val` é n.size/3, então os
// raios efetivos são menores que os do 2D; mantemos a MESMA razão 60↔66 pra o
// "não sobrepor" ter o mesmo salto perceptual. Escala /6 alinha ao mundo 3D.
const COLLIDE_BASE = 60 / 6;   // 10
const COLLIDE_STRONG = 66 / 6; // 11

// ── Gravidade por domínio no 3D — espelha o DOMAIN_GRAVITY=0.03 do sim-worker
// 2D (A.37), com REFORÇO pra órfãs: nó de grau 0 não tem forceLink segurando,
// então o charge o empurrava pro "infinito" (halo de poeira que dominava o
// enquadramento). Órfã recebe 4x a gravidade → assenta num anel próximo ao
// cluster do seu domínio, não some. Conectados ficam no 0.03 (mesma sensação
// de agrupamento temático do 2D).
const DOMAIN_GRAVITY_3D = 0.03;
const ORPHAN_GRAVITY_3D = DOMAIN_GRAVITY_3D * 4; // 0.12 — anel próximo, sem fuga

// ──────────────────────────────────────────────────────────────────────────────
// Mapeamento dos 4 sliders (mesmos ranges do painel 2D) → forças d3-force-3d.
// A lib usa d3-force-3d (mesma API .strength/.distance do d3-force 2D). NÃO
// tocamos no sim-worker.ts do 2D — aqui é a simulação PRÓPRIA do 3d-force-graph.
//   center   0..1    → forceCenter().strength (puxa pro centro do mundo 3D)
//   repel    0..20   → forceManyBody().strength = -(repel³) (mesmo e*e*e do 2D)
//   link     0..1    → forceLink().strength (identity; a lib escala por grau)
//   distance 30..500 → forceLink().distance (identity)
// ──────────────────────────────────────────────────────────────────────────────

// Só arestas explícitas entram na FÍSICA (igual 2D: as semânticas são overlay
// visual, nunca estrutura — senão fundiriam ilhas). As semânticas viram links
// 'similar' invisíveis à física mas desenháveis como linhas translúcidas.

function initGraph3D(container: HTMLElement, ctx: Ctx): Graph3DController {
  const { payload, state } = ctx;

  // Nós no formato do 3d-force-graph. Guardamos o GraphNode original em `_n` pra
  // os accessors de cor reusarem pickNodeColor do 2D (mesma coloração exata).
  const validIds = new Set(payload.nodes.map((n) => n.id));
  const nodes = payload.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    val: n.size / 3, // volume relativo (raio = cbrt(val)·nodeRelSize) — proporcional ao 2D
    _n: n,
  }));

  // Links explícitos (estrutura + física) e similares (só visual). O flag `_sim`
  // separa os dois no linkVisibility/linkColor/linkWidth e na física (só explícitos
  // recebem força — os similares entram como links mas com strength 0).
  const explicitLinks: Array<{ source: string; target: string; _sim: false }> = [];
  const similarLinks: Array<{ source: string; target: string; _sim: true; score: number }> = [];
  for (const e of payload.edges) {
    if (!validIds.has(e.source) || !validIds.has(e.target)) continue;
    if (e.type === 'explicit') explicitLinks.push({ source: e.source, target: e.target, _sim: false });
    else similarLinks.push({ source: e.source, target: e.target, _sim: true, score: e.score });
  }
  const links: Array<any> = [...explicitLinks, ...similarLinks];

  // Grau EXPLÍCITO por nó (semânticas não contam — são overlay). Calculado aqui,
  // enquanto source/target ainda são strings (a engine depois os troca por
  // referências de nó). Grau 0 = órfã → gravidade de domínio reforçada (4x).
  const degreeById = new Map<string, number>();
  for (const l of explicitLinks) {
    degreeById.set(l.source, (degreeById.get(l.source) ?? 0) + 1);
    degreeById.set(l.target, (degreeById.get(l.target) ?? 0) + 1);
  }

  // Força CUSTOM d3-force-3d: puxa cada nó pro centróide do SEU domínio,
  // recalculado a cada tick das posições ATUAIS (não dá pra pré-computar: o
  // layout 3D nasce da phyllotaxis da engine, não do layout 2D do servidor).
  // Centróide considera SÓ nós conectados (grau>0) — senão o halo de órfãs
  // puxaria o próprio alvo pra fora. Domínio sem nó conectado: sem alvo (a
  // força 'center' global segura essas órfãs perto da origem).
  function domainGravityForce() {
    let simNodes: any[] = [];
    const force = (alpha: number) => {
      const acc = new Map<string, { x: number; y: number; z: number; n: number }>();
      for (const nd of simNodes) {
        if ((degreeById.get(nd.id) ?? 0) === 0) continue; // órfã não define centróide
        const dom = nd._n?.domain || '_';
        const a = acc.get(dom) ?? { x: 0, y: 0, z: 0, n: 0 };
        a.x += nd.x; a.y += nd.y; a.z += nd.z; a.n += 1;
        acc.set(dom, a);
      }
      for (const nd of simNodes) {
        const c = acc.get(nd._n?.domain || '_');
        if (!c || !c.n) continue;
        const orphan = (degreeById.get(nd.id) ?? 0) === 0;
        const k = (orphan ? ORPHAN_GRAVITY_3D : DOMAIN_GRAVITY_3D) * alpha;
        nd.vx += (c.x / c.n - nd.x) * k;
        nd.vy += (c.y / c.n - nd.y) * k;
        nd.vz += (c.z / c.n - nd.z) * k;
      }
    };
    // Assinatura d3-force: a simulação injeta os nós materializados aqui.
    force.initialize = (nds: any[]) => { simNodes = nds; };
    return force;
  }

  const { clientWidth, clientHeight } = container;

  const graph = new (ForceGraph3D as any)(container)
    .graphData({ nodes, links })
    .backgroundColor(BG_COLOR)
    .width(clientWidth || window.innerWidth)
    .height(clientHeight || window.innerHeight)
    .showNavInfo(false)
    // Cor: reusa a MESMA função pickNodeColor do 2D (neutra/área/tipo/grau),
    // com dim de busca por cima (nodeColorFn — spec 29).
    .nodeColor((n: any) => nodeColorFn(n))
    .nodeVal((n: any) => nodeVal(n))
    // Esferas MAIORES que o default (4): raio = cbrt(val)·nodeRelSize, então 4→6
    // é +50% de raio em toda bolinha — na visão inicial enquadrada pelo núcleo,
    // as bolinhas devem ser claramente visíveis, não poeira.
    .nodeRelSize(6)
    // Esferas REDONDAS: 16 segmentos (default 8 deixava facetas visíveis de
    // perto). Tradeoff APROVADO pelo dono: ~4x mais triângulos por esfera (os
    // segmentos dobram em latitude E longitude) — ~1.8k nós seguem leves na GPU.
    .nodeResolution(16)
    // Opacidade de linha na lib = linkOpacity · alpha(rgba do linkColor). O
    // default 0.2 esmagava TUDO (explícita 0.4 → 0.08 efetivo: "a linha nem
    // aparece"; semântica 0.18 → 0.036). Com 1, o alfa do rgba dos accessors
    // abaixo vira a única fonte de verdade — o que se escreve é o que se vê.
    .linkOpacity(1)
    // Nós filtrados (chips/isoladas) somem de vez — mesma lógica isNodeActive do 2D.
    .nodeVisibility((n: any) => ctx.isNodeActive(n.id))
    .nodeLabel((n: any) => String(n.label ?? n.id))
    // Semânticas: escondidas por default (igual 2D); intensidade pelo slider.
    .linkVisibility((l: any) => linkVisible(l))
    .linkColor((l: any) => linkColor(l))
    .linkWidth((l: any) => linkWidth(l))
    // Clique abre o MESMO painel de nota do 2D (não navega pra fora).
    .onNodeClick((n: any) => { const id = String(n.id ?? ''); if (id) ctx.onNodeOpen(id); });

  // Multiplicador de tamanho do painel (slider "Tamanho das bolinhas") aplicado
  // sobre o val base. Recalculado via graph.nodeVal(...) no applyNodeSize.
  // Lê SEMPRE o perfil visual 3D (ctx.getVisual) — nunca o 2D.
  // Busca ativa: match cresce ×1.6 (espelho do nodeReducer 2D) — COMPÕE com o
  // multiplicador do slider, não substitui.
  function nodeVal(n: any): number {
    const base = typeof n.val === 'number' ? n.val : 1;
    const searchBoost =
      state.searchMatches.size > 0 && state.searchMatches.has(String(n.id)) ? 1.6 : 1;
    return base * (ctx.getVisual().nodeSizeMult || 1) * searchBoost;
  }

  // Cor com dim de busca (spec 29): não-match vira o MESMO fantasma do 2D
  // (rgba com alpha baixa embutida na cor — nodeOpacity da lib é GLOBAL, não
  // serve pra dim individual; mesmo truque do linkColor abaixo).
  function nodeColorFn(n: any): string {
    if (state.searchMatches.size > 0 && !state.searchMatches.has(String(n.id))) {
      return 'rgba(70, 70, 90, 0.22)';
    }
    return ctx.pickNodeColor(n.id, n._n);
  }

  // Visibilidade de link: explícito só se as duas pontas estão ativas; semântico
  // só se não está escondido, intensidade > 0 e ambas pontas ativas (igual 2D).
  function linkVisible(l: any): boolean {
    const s = idOf(l.source), t = idOf(l.target);
    if (!ctx.isNodeActive(s) || !ctx.isNodeActive(t)) return false;
    if (l._sim) return !state.hideSimilar && state.similarOpacity > 0;
    return true;
  }
  function linkColor(l: any): string {
    if (l._sim) {
      // Linhas semânticas translúcidas — mesma cor-base azulada do overlay 2D,
      // opacidade dirigida pelo slider "Intensidade".
      const a = Math.max(0, Math.min(1, state.similarOpacity));
      return `rgba(140, 200, 255, ${a})`;
    }
    // Explícita um degrau acima do discreto ("a linha nem aparece" — feedback do
    // dono): alfa 0.55 + tom um pouco mais claro. Com linkOpacity(1), esse alfa
    // vale literalmente (antes era multiplicado pelo 0.2 default da lib).
    return 'rgba(150, 150, 172, 0.55)';
  }
  function linkWidth(l: any): number {
    if (l._sim) return 0.4; // fio fino pras semânticas
    // Explícita mais grossa por default no 3D (0.6 sumia entre as esferas
    // maiores); o slider "Espessura das linhas" segue multiplicando por cima.
    // Lê SEMPRE o perfil visual 3D (ctx.getVisual) — nunca o 2D.
    return 1.0 * (ctx.getVisual().lineSizeMult || 1);
  }

  // ── Física: só explícitos puxam. Configura d3-force-3d com os 4 sliders. ──
  // forceLink recebe SÓ os links explícitos (os semânticos não entram na física).
  //
  // `withReheat` separa CONFIGURAR as forças (seguro a qualquer momento) de
  // REAQUECER a simulação (perigoso antes da engine inicializar). Detalhe crítico:
  // three-forcegraph inicializa a engine (e só então preenche `state.layout`) num
  // digest DEBOUNCED de 1ms disparado por .graphData() — é assíncrono. Já o loop
  // de render (requestAnimationFrame → tickFrame) pode disparar ANTES desse 1ms.
  // d3ReheatSimulation() chama resetCountdown() que seta engineRunning=true de
  // forma SÍNCRONA; se um frame roda antes do digest, tickFrame faz
  // state.layout['tick']() com layout ainda undefined → "Cannot read properties of
  // undefined (reading 'tick')" e a tela fica PRETA no 1º frame. Por isso o reheat
  // inicial é ADIADO pro primeiro onEngineTick (quando state.layout já existe —
  // ver bloco de init lá embaixo). Ajustes vindos dos sliders (pós-init) podem
  // reaquecer normalmente.
  function applyForces(withReheat = true) {
    const f = ctx.getForces();
    // e*e*e/8, NÃO o e*e*e cru do 2D: o mundo 3D do 3d-force-graph tem escala
    // própria (charge default da lib é ~-120; o cru do 2D em repel=10 dava -1000,
    // 8x mais forte que o default) — isso empurrava a nuvem de nós pra fora do
    // frustum da câmera (que nunca reenquadra sozinha) e a tela ficava PRETA.
    // /8 recalibra pro default=10 → -125 (mesma ordem de grandeza do default da
    // lib), preservando a curva cúbica do slider (sensação de "força" idêntica).
    const repel = (f.repel * f.repel * f.repel) / 8;
    graph
      .d3Force('charge', forceManyBody().strength(-repel).theta(0.9).distanceMin(30))
      .d3Force('center', forceCenter().strength(f.center));
    // NÃO criar forceLink próprio: no init a engine ainda não materializou os nós,
    // e um forceLink(explicitLinks) novo falha a resolução de id do d3 ("node not
    // found"). Em vez disso, pegamos a força de link já existente da lib (que ela
    // materializa a partir do graphData) e só ajustamos strength/distance nela.
    // Semânticas (_sim:true) ficam com strength 0 (fora da física, overlay visual);
    // explícitas usam o slider — mesmo comportamento de antes, sem recriar a força.
    const link = graph.d3Force('link');
    if (link) link.strength((l: any) => (l._sim ? 0 : f.link)).distance(f.distance);
    applyCollide();
    if (withReheat) graph.d3ReheatSimulation(); // reheat (a lib expõe d3ReheatSimulation)
  }

  // Gravidade por domínio + reforço de órfãs (constante, fora dos sliders):
  // registrada UMA vez — o setter só grava no d3ForceLayout; a engine chama
  // initialize() quando materializa os nós no digest.
  graph.d3Force('domainGravity', domainGravityForce());

  // Colisão: baseline sempre ligado (evita encavalamento visual); "não sobrepor"
  // sobe raio + strength, espelhando o 60↔66 do sim-worker do 2D.
  function applyCollide() {
    const on = state.noOverlap;
    graph.d3Force(
      'collide',
      forceCollide()
        .radius((n: any) => nodeVal(n) * graph.nodeRelSize() + (on ? COLLIDE_STRONG : COLLIDE_BASE))
        .strength(on ? 1 : 0.5)
        .iterations(on ? 4 : 1),
    );
  }

  // Câmera voa até o nó (busca/focar). Posiciona a câmera a uma distância fixa
  // na direção do nó, mirando nele — equivalente 3D do focusNode do 2D.
  function flyTo(id: string) {
    const node = nodes.find((n) => n.id === id) as any;
    if (!node || typeof node.x !== 'number') return;
    const dist = 120;
    const hyp = Math.hypot(node.x, node.y, node.z) || 1;
    const ratio = 1 + dist / hyp;
    graph.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: node.z * ratio }, // nova posição
      node,                                                        // mira no nó
      1000,                                                        // ms
    );
  }

  // ── Auto-rotate "globo que gira": pausa na interação, retoma após ~10s. ──
  const controls = graph.controls() as any;
  const AUTOROTATE_SPEED = 0.6;
  const RESUME_AFTER_MS = 10_000;
  let resumeTimer = 0;
  const pauseAutoRotate = () => {
    if (!controls) return;
    controls.autoRotate = false;
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = window.setTimeout(() => { controls.autoRotate = true; }, RESUME_AFTER_MS);
  };
  if (controls) {
    controls.autoRotate = true;
    controls.autoRotateSpeed = AUTOROTATE_SPEED;
    container.addEventListener('pointerdown', pauseAutoRotate, { passive: true });
    container.addEventListener('wheel', pauseAutoRotate, { passive: true });
    if (typeof controls.addEventListener === 'function') controls.addEventListener('start', pauseAutoRotate);
  }

  // ── Enquadramento pelo NÚCLEO (não pelo bounding box total): o zoomToFit da
  // lib enquadra TODOS os nós, e o halo de órfãs/isoladas distantes dominava o
  // frame — o miolo virava poeira no centro. Aqui: centróide da nuvem + raio no
  // percentil ~88 das distâncias ao centróide (ignora os ~12% mais distantes) e
  // câmera posicionada NA MÃO (cameraPosition) pra caber ESSE raio no fov
  // vertical, preservando a direção atual câmera→centróide (não "pula" o
  // auto-rotate). Fallback: zoomToFit clássico se a nuvem for pequena demais.
  const CORE_PCT = 0.88;   // percentil do raio do núcleo (85-90 por espec do dono)
  const CORE_MARGIN = 1.15; // folga de 15% pra borda do núcleo não colar na moldura
  function frameCore(ms: number) {
    const pts = (nodes as any[]).filter((n) => typeof n.x === 'number' && isFinite(n.x)
      && typeof n.y === 'number' && isFinite(n.y) && typeof n.z === 'number' && isFinite(n.z));
    if (pts.length < 8) { graph.zoomToFit(ms, 60); return; }
    let cx = 0, cy = 0, cz = 0;
    for (const p of pts) { cx += p.x; cy += p.y; cz += p.z; }
    cx /= pts.length; cy /= pts.length; cz /= pts.length;
    const dists = pts.map((p) => Math.hypot(p.x - cx, p.y - cy, p.z - cz)).sort((a, b) => a - b);
    const r = dists[Math.min(dists.length - 1, Math.floor(dists.length * CORE_PCT))] || 1;
    // Distância pra uma esfera de raio r caber no fov VERTICAL (aspect > 1 no
    // desktop → o eixo vertical é o limitante; em telas retrato sobra margem).
    const cam = graph.camera() as any;
    const fovRad = ((cam?.fov ?? 50) * Math.PI) / 180;
    const dist = (r * CORE_MARGIN) / Math.tan(fovRad / 2);
    // Mantém a direção atual da câmera em relação ao centróide (fallback +z).
    const cur = cam?.position ?? { x: 0, y: 0, z: 1 };
    let dx = cur.x - cx, dy = cur.y - cy, dz = cur.z - cz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) { dx = 0; dy = 0; dz = 1; } else { dx /= len; dy /= len; dz /= len; }
    graph.cameraPosition(
      { x: cx + dx * dist, y: cy + dy * dist, z: cz + dz * dist }, // posição
      { x: cx, y: cy, z: cz },                                     // mira no centróide do núcleo
      ms,
    );
  }

  // Dois disparos, ambos "só uma vez" (mesma coreografia de antes, agora com
  // frameCore em vez de zoomToFit):
  //   1) frameCore(0) ~1.5s após o init — rede de segurança; sem isso a câmera
  //      fica parada na posição default da lib e a tela fica preta/poeira
  //      durante o assentamento da física (vários segundos com 1.8k+ nós).
  //   2) frameCore(600) na PRIMEIRA estabilização da engine (onEngineStop) —
  //      reenquadra suave já com a nuvem assentada.
  // `autoFitDone` bloqueia ambos após a 1ª interação do usuário (reusa o mesmo
  // pointerdown do auto-rotate) pra nunca mais roubar a câmera dele depois.
  let autoFitDone = false;
  let engineStoppedOnce = false;
  const cancelAutoFit = () => { autoFitDone = true; };
  container.addEventListener('pointerdown', cancelAutoFit, { passive: true });
  window.setTimeout(() => {
    if (!autoFitDone) frameCore(0);
  }, 1500);
  graph.onEngineStop(() => {
    if (engineStoppedOnce) return;
    engineStoppedOnce = true;
    if (!autoFitDone) frameCore(600);
  });

  // Reaquecimento inicial ADIADO pro 1º tick da engine: nesse ponto o digest
  // debounced já rodou e state.layout existe, então o reheat é seguro (não crasha
  // o tickFrame). Só uma vez — depois os sliders reaquecem sob demanda.
  // No MESMO handler: reenquadra pelo núcleo a cada 30 ticks DURANTE o
  // assentamento (espelha o "recentro a cada 30 ticks" do 2D) — sem isso a nuvem
  // expande pra além da câmera entre o frame de segurança de 1.5s e o
  // onEngineStop (~15s de cooldown da lib) e o dono assiste "de dentro" da nuvem.
  let firstTickReheated = false;
  let settleTicks = 0;
  graph.onEngineTick(() => {
    if (!firstTickReheated) {
      firstTickReheated = true;
      graph.d3ReheatSimulation();
      return;
    }
    settleTicks++;
    if (!autoFitDone && !engineStoppedOnce && settleTicks % 30 === 0) frameCore(200);
  });

  // Configura a física inicial já com os valores atuais dos sliders, MAS sem
  // reaquecer aqui (síncrono, antes da engine existir) — o reheat vem no 1º tick.
  applyForces(false);

  const resize = () => {
    graph.width(container.clientWidth || window.innerWidth);
    graph.height(container.clientHeight || window.innerHeight);
  };
  window.addEventListener('resize', resize);

  return {
    // Filtros mudam visibilidade de nós E links (link de/pra nó filtrado some).
    applyFilters: () => { graph.nodeVisibility((n: any) => ctx.isNodeActive(n.id)); graph.linkVisibility((l: any) => linkVisible(l)); },
    // Cor sempre via nodeColorFn — inclui o dim de busca por cima do colorMode.
    applyColors: () => graph.nodeColor((n: any) => nodeColorFn(n)),
    applySimilar: () => { graph.linkVisibility((l: any) => linkVisible(l)); graph.linkColor((l: any) => linkColor(l)); },
    applyNodeSize: () => { graph.nodeVal((n: any) => nodeVal(n)); graph.linkWidth((l: any) => linkWidth(l)); applyCollide(); graph.d3ReheatSimulation(); },
    applyForces,
    applyNoOverlap: () => { applyCollide(); graph.d3ReheatSimulation(); },
    // Busca (spec 29): rechama os accessors de cor e tamanho — a lib reavalia
    // todos os nós (mesmo mecanismo dos outros applyX; sem refresh manual).
    applySearch: () => { graph.nodeColor((n: any) => nodeColorFn(n)); graph.nodeVal((n: any) => nodeVal(n)); },
    flyTo,
    resize,
    dispose: () => {
      window.removeEventListener('resize', resize);
      if (resumeTimer) clearTimeout(resumeTimer);
      try { graph._destructor?.(); } catch { /* best-effort */ }
    },
  };
}

function idOf(v: any): string {
  return typeof v === 'object' && v ? String(v.id ?? '') : String(v ?? '');
}

// Registra o inicializador global pro client 2D chamar após o lazy-load do bundle.
(window as any).__initGraph3D = initGraph3D;
