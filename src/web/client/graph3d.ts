import ForceGraph3D from '3d-force-graph';
import { forceManyBody, forceCenter, forceCollide } from 'd3-force-3d';
import { Vector2 } from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { domainColor } from '../domain-colors.js';
import { computeCore, cageRadius, buildCage, buildRing, disposeScenery } from './graph3d-scenery.js';

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
// só aparece no hover). `glow` (spec 104) é o DESEJO do dono; o efetivo ainda
// passa pelos guards tema escuro + desktop (ver glowEffective no init).
interface Visual3D { nodeSizeMult: number; lineSizeMult: number; glow: boolean; }

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
  applyGlow: () => void;      // switch Brilho (spec 104): liga/desliga bloom + alfa das arestas
  flyTo: (id: string) => void;// busca/focar nota → câmera voa até o nó
  resize: () => void;
  // Pausa/retoma o loop de render (spec 104): SEM isso o 3D continua queimando
  // GPU escondido quando o dono volta pro 2D (o container só ganha display:none).
  pause: () => void;
  resume: () => void;
  dispose: () => void;
}

// WebGL não lê CSS var — resolve --surface-canvas no runtime (tema claro, spec 96);
// fallback = o valor dark histórico se o token não existir.
const BG_COLOR = (typeof document !== 'undefined'
  && getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim()) || '#0c0c10';

// Baseline de colisão espelhado do sim-worker.ts do 2D (raio flat 60 desligado,
// 66 ligado). No mundo 3D usamos nodeRelSize 6 e o `val` é n.size/3, então os
// raios efetivos são menores que os do 2D; mantemos a MESMA razão 60↔66 pra o
// "não sobrepor" ter o mesmo salto perceptual. Escala /6 alinha ao mundo 3D.
const COLLIDE_BASE = 60 / 6;   // 10
const COLLIDE_STRONG = 66 / 6; // 11

// ── Gravidade de agrupamento no 3D — v3 por COMUNIDADE (13/07/2026). História:
// v1 puxava pro centróide dinâmico do domínio (não separava nada — numa bola
// misturada todos os centróides ficam no meio); v2 deu âncora FIXA por
// DOMÍNIO (separou, mas virou "agrupamento por categoria" — o dono rejeitou:
// os grupos devem nascer da CONEXÃO real, não da etiqueta). v3 ancora por
// comunidade detectada do próprio grafo (label propagation) — um fio de
// assunto que cruza áreas vira UM grupo, órfãs viram poeira espalhada. Órfã
// recebe gravidade reforçada (sem forceLink segurando, o charge a empurrava
// pro "infinito").
const DOMAIN_GRAVITY_3D = 0.03;
const ORPHAN_GRAVITY_3D = 0.10; // órfã assenta perto da própria âncora, sem fuga
// Membro de gânglio ANCORADO puxa mais forte que poeira conectada: com a
// colisão forte ligada (pref comum) 0.03 não vencia o inchaço — o grupo
// existia na matemática mas não no olho (vault real do dono, 13/07/2026).
const GANGLIO_GRAVITY_3D = 0.05;

// Direção i de k na esfera de fibonacci — distribui as âncoras uniformemente
// em volta da origem (determinístico: mesma ordem = mesmo layout).
function fibDir(i: number, k: number): [number, number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = k <= 1 ? 0 : 1 - (2 * (i + 0.5)) / k;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = golden * i;
  return [Math.cos(th) * r, y, Math.sin(th) * r];
}

// ──────────────────────────────────────────────────────────────────────────────
// Mapeamento dos 4 sliders (mesmos ranges do painel 2D) → forças d3-force-3d.
// A lib usa d3-force-3d (mesma API .strength/.distance do d3-force 2D). NÃO
// tocamos no sim-worker.ts do 2D — aqui é a simulação PRÓPRIA do 3d-force-graph.
//   center   0..1    → forceCenter().strength (puxa pro centro do mundo 3D)
//   repel    0..20   → forceManyBody().strength = -(repel³) (mesmo e*e*e do 2D)
//   link     0..1    → forceLink().strength (identity; a lib escala por grau)
//   distance 30..500 → forceLink().distance (identity)
// ──────────────────────────────────────────────────────────────────────────────

// Física dos links (revisões 12-13/07/2026, feedback do dono): três regimes.
// - Semânticas: puxam pesado pelo score (similaridade é o que condensa os
//   gânglios — antes tinham strength 0 e o 3D virava bola uniforme).
// - Explícitas INTRA-comunidade: força cheia do slider (estrutura do gânglio).
// - Explícitas CROSS-comunidade: força bem menor + distância maior — viram as
//   PONTES longas entre gânglios da referência, em vez de molas que fundem
//   tudo numa bola só.
// Fatores recalibrados na rodada da referência (13/07/2026): 0.5/dist 0.5x
// colapsava cada grupo numa bola densa onde NENHUMA linha aparecia — o
// "fogo de artifício" da referência precisa das folhas AFASTADAS do hub com
// os raios visíveis. Sim mais fraco + distâncias cheias = dandelion aberto.
const SIM_LINK_FACTOR = 0.25;
const CROSS_DOMAIN_LINK_FACTOR = 0.22;

function initGraph3D(container: HTMLElement, ctx: Ctx): Graph3DController {
  const { payload, state } = ctx;

  // Guards do glow/perf (spec 104), lidos UMA vez no init — tema sem reação viva
  // (mesma limitação do BG_COLOR acima: trocar o tema com o 3D aberto mantém as
  // cores antigas até recarregar; registrado na spec, commit opcional separado).
  const isMobile = window.matchMedia('(max-width: 767px)').matches;
  const isDark = (document.documentElement.getAttribute('data-theme') || 'dark') !== 'light';

  // Nós no formato do 3d-force-graph. Guardamos o GraphNode original em `_n` pra
  // os accessors de cor reusarem pickNodeColor do 2D (mesma coloração exata).
  const validIds = new Set(payload.nodes.map((n) => n.id));
  const nodes = payload.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    // Volume relativo (raio = cbrt(val)·nodeRelSize). Expoente 1.5 sobre a
    // base do 2D: amplia a hierarquia hub vs folha (raio ~2.4x em vez de
    // ~1.7x) — os hubs dominam a cena como na referência de "neurônios".
    val: Math.pow(n.size / 3, 1.5),
    _n: n,
  }));

  // Links explícitos e similares. O flag `_sim` separa os dois no
  // linkVisibility/linkColor/linkWidth e na física (similares puxam fraco,
  // pesado pelo score — ver SIM_LINK_FACTOR).
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
  // referências de nó). Grau 0 = órfã → gravidade de domínio reforçada.
  const degreeById = new Map<string, number>();
  for (const l of explicitLinks) {
    degreeById.set(l.source, (degreeById.get(l.source) ?? 0) + 1);
    degreeById.set(l.target, (degreeById.get(l.target) ?? 0) + 1);
  }

  // Sinapses (pedido do dono 13/07): as partículas da lib viajam source →
  // target. Orienta o link visual com o HUB como fonte, pro pulso sair do
  // centro do "fogo de artifício" rumo às pontas — e o raio herda a cor do
  // hub de quebra (linkColor usa a fonte). Só visual: a física não tem
  // direção, e a seta semântica do edge não é exibida no 3D.
  for (const l of explicitLinks) {
    if ((degreeById.get(l.target) ?? 0) > (degreeById.get(l.source) ?? 0)) {
      const s = l.source;
      (l as any).source = l.target;
      (l as any).target = s;
    }
  }

  // Nó por id — pro linkColor achar o nó fonte enquanto source ainda é string.
  const nodeById = new Map<string, any>(nodes.map((n) => [n.id, n]));

  // ── Comunidades por propagação de rótulos (13/07/2026, feedback do dono:
  // "não quero agrupamento por tema/categoria — quero outro tipo"). Os grupos
  // nascem de QUEM SE CONECTA COM QUEM (explícitas peso 1, semânticas peso
  // 0.5·score), não da etiqueta de área. Determinístico (ordem estável +
  // desempate lexicográfico), ~10 varreduras bastam pra alguns milhares de
  // nós. Nota órfã fica como comunidade própria — vira poeira espalhada, como
  // na referência.
  function computeCommunities(): Map<string, string> {
    const label = new Map<string, string>();
    const adj = new Map<string, Array<{ id: string; w: number }>>();
    const push = (a: string, b: string, w: number) => {
      let arr = adj.get(a);
      if (!arr) { arr = []; adj.set(a, arr); }
      arr.push({ id: b, w });
    };
    for (const n of nodes) label.set(String(n.id), String(n.id));
    for (const l of explicitLinks) { push(l.source, l.target, 1); push(l.target, l.source, 1); }
    for (const l of similarLinks) {
      const w = 0.5 * (l.score ?? 0.5);
      push(l.source, l.target, w); push(l.target, l.source, w);
    }
    const ids = nodes.map((n) => String(n.id)).sort();
    for (let it = 0; it < 10; it++) {
      let changed = 0;
      for (const id of ids) {
        const neigh = adj.get(id);
        if (!neigh || !neigh.length) continue;
        const votes = new Map<string, number>();
        for (const nb of neigh) {
          const lb = label.get(nb.id) ?? nb.id;
          votes.set(lb, (votes.get(lb) ?? 0) + nb.w);
        }
        let best = label.get(id) ?? id;
        let bw = -1;
        for (const [lb, w] of votes) {
          if (w > bw || (w === bw && lb < best)) { bw = w; best = lb; }
        }
        if (best !== label.get(id)) { label.set(id, best); changed++; }
      }
      if (!changed) break;
    }
    return label;
  }
  const communityById = computeCommunities();
  const comOfEnd = (v: any): string => {
    const id = typeof v === 'object' && v ? String(v.id ?? '') : String(v ?? '');
    return communityById.get(id) ?? id;
  };

  // Força CUSTOM d3-force-3d v3: puxa cada nó pra ÂNCORA FIXA da sua
  // COMUNIDADE (detectada da conexão real — não da categoria; feedback do dono
  // 13/07). Direção de fibonacci × profundidade própria (razão áurea,
  // 0.55..1.1 do raio médio atual): comunidades grandes ganham os primeiros
  // endereços, as pequenas/poeira se espalham pela esfera inteira. Âncora
  // fixa SEPARA; centróide dinâmico (v1) não separava a bola misturada.
  function communityGravityForce() {
    let simNodes: any[] = [];
    // Comunidades ordenadas por tamanho desc — determinístico entre sessões.
    const comCount = new Map<string, number>();
    for (const n of nodes) {
      const c = communityById.get(String(n.id)) ?? String(n.id);
      comCount.set(c, (comCount.get(c) ?? 0) + 1);
    }
    const coms = [...comCount.keys()].sort((a, b) => (comCount.get(b)! - comCount.get(a)!) || a.localeCompare(b));
    // BUG corrigido (13/07, print do dono): fibDir(i, TOTAL) com centenas de
    // comunidades-poeira jogava TODAS as grandes no polo norte (i pequenos de
    // um k gigante → y≈1) — o conteúdo espremia num quadrante. Agora as
    // GRANDES (≥5 notas) espalham pela esfera inteira (fib sobre só elas) e a
    // poeira ganha direção determinística por hash — fica espalhada por toda
    // parte, como o fundo estrelado da referência.
    // Raios COMPACTOS (feedback do dono 13/07: "grupos longe demais, tem que
    // virar quase um globo"): grandes assentam em 0.30..0.72 do raio médio
    // (encostando umas nas outras), poeira em 0.55..0.90 (casca de estrelas
    // em volta) — menos vazio no miolo, um globo cheio.
    // CAP de âncoras (13/07/2026, vault real do dono): o grafo real produz
    // CENTENAS de comunidades ≥5 (447 medidas offline, cobrindo 80% das notas)
    // — uma âncora pra cada punha os centros a ~9° um do outro e os blobs se
    // encostavam: a nuvem voltava a ler como bola uniforme ("as minhas não
    // criam os gânglios"). A referência tem POUCOS dandelions + starfield:
    // só as GANGLIA_MAX maiores comunidades ganham âncora de gânglio; todas
    // as outras caem no regime de poeira (hashDir) — comunidades pequenas
    // ainda se aglutinam no seu ponto próprio da casca (textura de "galáxias
    // distantes"), órfãs viram estrelas soltas.
    const BIG_COM_MIN = 5;
    const GANGLIA_MAX = 14;
    const bigComs = coms.filter((c) => (comCount.get(c) ?? 0) >= BIG_COM_MIN).slice(0, GANGLIA_MAX);
    const hashDir = (s: string): { dir: [number, number, number]; rf: number } => {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      const y = 1 - 2 * ((h % 1024) / 1023);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = 2 * Math.PI * (((h >>> 10) % 1024) / 1024);
      return { dir: [Math.cos(th) * r, y, Math.sin(th) * r], rf: 0.55 + 0.35 * (((h >>> 20) % 1024) / 1024) };
    };
    const anchorByCom = new Map<string, { dir: [number, number, number]; rf: number }>();
    bigComs.forEach((c, i) => anchorByCom.set(c, {
      dir: fibDir(i, bigComs.length),
      rf: 0.30 + 0.42 * ((i * 0.6180339887) % 1),
    }));
    for (const c of coms) if (!anchorByCom.has(c)) anchorByCom.set(c, hashDir(c));
    const gangliaSet = new Set(bigComs);
    const force = (alpha: number) => {
      if (!simNodes.length) return;
      // Escala base = distância média atual ao centro (auto-acompanha o charge).
      let sum = 0;
      for (const nd of simNodes) sum += Math.hypot(nd.x, nd.y, nd.z) || 0;
      const R = Math.max(150, sum / simNodes.length);
      for (const nd of simNodes) {
        const com = communityById.get(String(nd.id)) ?? String(nd.id);
        const a = anchorByCom.get(com);
        if (!a) continue;
        const orphan = (degreeById.get(nd.id) ?? 0) === 0;
        const k = (orphan ? ORPHAN_GRAVITY_3D
          : gangliaSet.has(com) ? GANGLIO_GRAVITY_3D
          : DOMAIN_GRAVITY_3D) * alpha;
        const r = R * a.rf;
        nd.vx += (a.dir[0] * r - nd.x) * k;
        nd.vy += (a.dir[1] * r - nd.y) * k;
        nd.vz += (a.dir[2] * r - nd.z) * k;
      }
    };
    // Assinatura d3-force: a simulação injeta os nós materializados aqui.
    force.initialize = (nds: any[]) => { simNodes = nds; };
    return force;
  }

  const { clientWidth, clientHeight } = container;

  const graph = new (ForceGraph3D as any)(container)
    .graphData({ nodes, links })
    // Tema escuro: preto PURO obrigatório. O OutputPass do pipeline de glow
    // converte linear→sRGB no final e AMPLIFICA canal baixo: '#000004' rendia
    // RGB(0,0,34) na tela — fundo azul-marinho (medido em 13/07/2026, pixel do
    // screenshot). Só 0 sobrevive a gamma. Claro segue o token do tema.
    .backgroundColor(isDark ? '#000000' : BG_COLOR)
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
    // Mobile (spec 104): 8 segmentos — GPU de celular não paga as facetas.
    .nodeResolution(isMobile ? 8 : 16)
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
    // Sinapses: SEM partículas cíclicas (pedido do dono 13/07: "não é pra
    // ficar piscando sem parar") — os pulsos são emitidos avulsos pelo
    // scheduler de sinapses lá embaixo (emitParticle, um disparo a cada 3-7s).
    // Speed/width valem pros pulsos emitidos.
    .linkDirectionalParticleSpeed(0.006)
    .linkDirectionalParticleWidth(1.9)
    // Clique abre o MESMO painel de nota do 2D (não navega pra fora).
    .onNodeClick((n: any) => { const id = String(n.id ?? ''); if (id) ctx.onNodeOpen(id); });

  // ── Perf mobile (spec 104): pixelRatio ≤1.5 no renderer E no composer — o
  // clamp default da lib (2) ainda é caro em tela retina de celular; e o bloom
  // renderiza em N render targets do MESMO tamanho, então o composer precisa do
  // mesmo teto ou a economia some.
  if (isMobile) {
    const pr = Math.min(window.devicePixelRatio || 1, 1.5);
    try {
      graph.renderer()?.setPixelRatio?.(pr);
      graph.postProcessingComposer()?.setPixelRatio?.(pr);
    } catch { /* renderer ainda não pronto — segue com o default da lib */ }
  }

  // ── Bloom (spec 104): UnrealBloomPass + OutputPass no composer QUE A LIB JÁ
  // USA (three-render-objects renderiza via EffectComposer+RenderPass — plugar é
  // 1 addPass). OutputPass é OBRIGATÓRIO junto: os passes de bloom não convertem
  // pra sRGB, sem ele a cena inteira escurece. Com ambos enabled=false o
  // pipeline volta byte-idêntico ao original — toggle limpo.
  // Knobs (rodada 5, 13/07/2026): strength 0.35 / radius 0.18 / threshold 0.30.
  // Regra destilada das 5 rodadas com o dono: RADIUS curto controla o véu
  // (halo local, fundo preto), THRESHOLD baixo acende todo nó, STRENGTH é o
  // que lava a cena pra cinza quando passa de ~0.4 com milhares de nós claros
  // (modo neutro) — 0.5 ainda acinzentava, 0.35 dá brasa sem véu. Fantasma
  // de busca (rgba escuro 0.22) continua abaixo do threshold — busca legível.
  let bloomPass: UnrealBloomPass | null = null;
  let outputPass: OutputPass | null = null;
  try {
    const composer = graph.postProcessingComposer?.();
    if (composer?.addPass) {
      bloomPass = new UnrealBloomPass(
        new Vector2(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight),
        0.35, 0.18, 0.30,
      );
      outputPass = new OutputPass();
      bloomPass.enabled = false;
      outputPass.enabled = false;
      composer.addPass(bloomPass);
      composer.addPass(outputPass);
    }
  } catch { /* sem composer (lib mudou?) — palco segue sem glow */ }

  // Efetivo = desejo do dono (pref) E tema escuro E desktop. Em fundo claro o
  // bloom lava a imagem; mobile v1 força off (GPU).
  const glowEffective = () => !!ctx.getVisual().glow && isDark && !isMobile && !!bloomPass;
  let glowOn = false;
  function applyGlow() {
    glowOn = glowEffective();
    if (bloomPass) bloomPass.enabled = glowOn;
    if (outputPass) outputPass.enabled = glowOn;
    // Rechamar o accessor faz a lib reavaliar o alfa das linhas (muda com o
    // bloom). As sinapses seguem o glowOn direto no scheduler (fireSynapse).
    graph.linkColor((l: any) => linkColor(l));
  }

  // ── Sinapses com FREQUÊNCIA (pedido do dono, 13/07/2026): nada de fluxo
  // contínuo piscando sem parar — UM disparo por vez, com pausa ALEATÓRIA de
  // 3 a 7 segundos entre um raio e o próximo. Cada disparo sorteia um hub
  // (sorteio por link ⇒ ponderado pelo nº de raios do hub: dandelions grandes
  // disparam mais) e emite um pulso avulso em cada raio visível dele — a
  // sinapse sai do centro e corre até as pontas. emitParticle é não-cíclico:
  // a lib anima e descarta sozinha. Amarrado ao "Brilho" (glowOn) e pausado
  // junto com o palco (paused) — 3D escondido não acumula pulso congelado. ──
  const spokesByHub = new Map<string, any[]>();
  for (const l of explicitLinks) {
    let arr = spokesByHub.get(l.source as string);
    if (!arr) { arr = []; spokesByHub.set(l.source as string, arr); }
    arr.push(l);
  }
  let paused = false;
  let synapseTimer = 0;
  function fireSynapse() {
    if (!explicitLinks.length) return;
    const pick = explicitLinks[Math.floor(Math.random() * explicitLinks.length)] as any;
    const spokes = spokesByHub.get(idOf(pick.source)) ?? [pick];
    for (const l of spokes) {
      if (!linkVisible(l)) continue; // nó filtrado não "pisca" invisível
      try { graph.emitParticle(l); } catch { /* engine ainda assentando */ }
    }
  }
  function scheduleSynapse() {
    synapseTimer = window.setTimeout(() => {
      // !document.hidden: setTimeout segue rodando em aba oculta (só o rAF
      // para) e cada emitParticle acumularia photons pra "explodir" todos de
      // uma vez na volta — sinapse só dispara com a aba visível (spec 105).
      if (glowOn && !paused && !document.hidden) fireSynapse();
      scheduleSynapse();
    }, 3000 + Math.random() * 4000);
  }
  scheduleSynapse();

  // Aba em background: pausa o loop da lib por inteiro (o browser já pausa o
  // rAF sozinho; isto só torna o estado explícito e barato). Na volta, só
  // retoma se o palco 3D está ATIVO (`paused` é do exit3D — o dono pode ter
  // escondido o 3D antes de trocar de aba; resume aqui não pode ressuscitá-lo).
  const onVisibility = () => {
    try {
      if (document.hidden) graph.pauseAnimation?.();
      else if (!paused) graph.resumeAnimation?.();
    } catch { /* best-effort */ }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ── Cenografia "cosmos" (spec 104): gaiola esférica adicionada à cena da
  // lib — a cena NUNCA é recriada (filtros/busca/reheat só mexem em graphData),
  // então o objeto persiste. Posição/raio seguem o computeCore nos MESMOS
  // momentos do frameCore (30 ticks + engineStop); nasce invisível até a
  // primeira medida.
  let cage: ReturnType<typeof buildCage> | null = null;
  let ring: ReturnType<typeof buildRing> | null = null;
  try {
    const scene = graph.scene?.();
    if (scene?.add) {
      const cageColor = isDark ? '#93a1c8' : '#3c4262';
      // 0.12 no escuro: na referência a malha é bem presente (a 0.07 sumia; a
      // 0.15 sob o bloom antigo gritava — com o bloom seco atual 0.12 assenta).
      cage = buildCage(cageColor, isDark ? 0.12 : 0.15);
      cage.visible = false;
      cage.renderOrder = -1; // atrás dos nós — arame é cenário, não conteúdo
      scene.add(cage);
      // Anel equatorial (o "disco de Saturno" da referência) — mais aceso que
      // a malha, transborda a gaiola (escala 1.12x no updateScenery).
      ring = buildRing(cageColor, isDark ? 0.30 : 0.25);
      ring.visible = false;
      ring.renderOrder = -1;
      scene.add(ring);
    }
  } catch { /* cena indisponível — palco segue sem cenografia */ }

  // Pontos vivos da nuvem (a engine muta x/y/z nos objetos de `nodes`).
  const livePts = () => (nodes as any[]).filter((n) => typeof n.x === 'number' && isFinite(n.x)
    && typeof n.y === 'number' && isFinite(n.y) && typeof n.z === 'number' && isFinite(n.z));

  function updateScenery() {
    if (!cage) return;
    const core = computeCore(livePts());
    if (!core) {
      cage.visible = false;
      if (ring) ring.visible = false;
      return;
    }
    const r = cageRadius(core);
    cage.visible = true;
    cage.position.set(core.cx, core.cy, core.cz);
    cage.scale.setScalar(r);
    if (ring) {
      ring.visible = true;
      ring.position.set(core.cx, core.cy, core.cz);
      ring.scale.setScalar(r * 1.12);
    }
  }

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
  // Cor do nó (#rrggbb do pickNodeColor) → rgba de linha com o alfa dado.
  function hexAlpha(c: string, a: number): string {
    if (/^#[0-9a-fA-F]{6}$/.test(c)) {
      const r = parseInt(c.slice(1, 3), 16);
      const g = parseInt(c.slice(3, 5), 16);
      const b = parseInt(c.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
    return `rgba(150, 150, 172, ${a})`; // cor não-hex (modo neutro etc): cinza histórico
  }
  function linkColor(l: any): string {
    if (l._sim) {
      // Linhas semânticas translúcidas — mesma cor-base azulada do overlay 2D,
      // opacidade dirigida pelo slider "Intensidade".
      const a = Math.max(0, Math.min(1, state.similarOpacity));
      return `rgba(140, 200, 255, ${a})`;
    }
    // Raios coloridos (rodada da referência, 13/07/2026): a explícita HERDA a
    // cor do nó FONTE (área/tipo/grau — o modo de coloração vigente). É o que
    // faz cada hub virar um "fogo de artifício" com raios da cor do grupo,
    // como no vídeo de referência — linha cinza uniforme lia como teia morta.
    // Busca ativa: fonte fantasma (nodeColorFn devolve rgba escuro) → a linha
    // apaga junto (alfa 0.08), matches seguem acesos.
    const src = typeof l.source === 'object' && l.source ? l.source : nodeById.get(String(l.source));
    const base = src ? nodeColorFn(src) : '';
    if (base.startsWith('rgba')) return 'rgba(70, 70, 90, 0.08)';
    return hexAlpha(base, glowOn ? 0.5 : 0.55);
  }
  function linkWidth(l: any): number {
    // Semânticas: width 0 → a lib usa THREE.Line (1px, LineBasicMaterial SEM
    // iluminação) em vez de cilindro Lambert — corta a geometria de ~15k
    // cilindros no vault real (spec 105). Em opacity ≤0.2 o visual é quase
    // idêntico. NÃO trocar este accessor em runtime: mudança de linkWidth faz
    // linkDataMapper.clear() na lib e recria TODOS os ~19k objetos de link —
    // os tiers de qualidade mexem só em linkVisibility (diff barato).
    if (l._sim) return 0;
    // Explícita mais grossa por default no 3D (0.6 sumia entre as esferas
    // maiores; 1.0 ainda sumia com a câmera enquadrando a esfera inteira —
    // os raios do "fogo de artifício" precisam aparecer de longe). O slider
    // "Espessura das linhas" multiplica por cima; lê SEMPRE o perfil 3D.
    return 1.3 * (ctx.getVisual().lineSizeMult || 1);
  }

  // ── Física: explícitos puxam com o slider; semânticos puxam fraco pelo
  // score (SIM_LINK_FACTOR — é o que condensa os "gânglios"). ──
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
    // e*e*e/4, NÃO o e*e*e cru do 2D: o mundo 3D do 3d-force-graph tem escala
    // própria (o cru do 2D em repel=10 dava -1000 e empurrava a nuvem pra fora
    // do frustum — tela preta). Era /8 (default 8 → -64, metade do default da
    // lib); subiu pra /4 na rodada dos gânglios (12/07/2026): repulsão mais
    // forte abre os VAZIOS entre os grupos — e o frameCore reenquadra a câmera
    // durante o assentamento, então nuvem maior não some da tela.
    const repel = (f.repel * f.repel * f.repel) / 4;
    graph
      .d3Force('charge', forceManyBody().strength(-repel).theta(0.9).distanceMin(30))
      .d3Force('center', forceCenter().strength(f.center));
    // NÃO criar forceLink próprio: no init a engine ainda não materializou os nós,
    // e um forceLink(explicitLinks) novo falha a resolução de id do d3 ("node not
    // found"). Em vez disso, pegamos a força de link já existente da lib (que ela
    // materializa a partir do graphData) e só ajustamos strength/distance nela.
    // Três regimes (ver SIM_LINK_FACTOR/CROSS_DOMAIN_LINK_FACTOR): semântica
    // condensa o gânglio, intra-domínio estrutura, cross-domínio vira ponte
    // longa e frouxa. Tudo escala pelo slider "Força das ligações" (f.link).
    const link = graph.d3Force('link');
    if (link) {
      link
        .strength((l: any) => {
          if (l._sim) return f.link * SIM_LINK_FACTOR * (l.score ?? 0.5);
          return comOfEnd(l.source) === comOfEnd(l.target) ? f.link : f.link * CROSS_DOMAIN_LINK_FACTOR;
        })
        .distance((l: any) => {
          if (l._sim) return f.distance * 0.8;
          // Ponte cross-comunidade curta (1.8 → 1.2, feedback 13/07): grupos
          // ligados ficam VIZINHOS — o globo fecha, sem ilhas distantes.
          return comOfEnd(l.source) === comOfEnd(l.target) ? f.distance : f.distance * 1.2;
        });
    }
    applyCollide();
    if (withReheat) graph.d3ReheatSimulation(); // reheat (a lib expõe d3ReheatSimulation)
  }

  // Gravidade por domínio + reforço de órfãs (constante, fora dos sliders):
  // registrada UMA vez — o setter só grava no d3ForceLayout; a engine chama
  // initialize() quando materializa os nós no digest.
  graph.d3Force('communityGravity', communityGravityForce());

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
  // Percentil do núcleo (0.88) agora vive no computeCore (graph3d-scenery) —
  // gaiola e moldura medem a MESMA esfera. Margem 1.30 (era 1.15): a gaiola
  // fica ENTRE o núcleo e a moldura, e não pode colar na borda da tela.
  const CORE_MARGIN = 1.30;
  function frameCore(ms: number) {
    const core = computeCore(livePts());
    if (!core) { graph.zoomToFit(ms, 60); return; }
    const { cx, cy, cz, r88: r } = core;
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
    // Cenografia acompanha TODO assentamento (reheat de slider também) — só o
    // enquadramento é one-shot.
    updateScenery();
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
    if (settleTicks % 30 === 0) {
      // Gaiola/ano seguem a nuvem durante o assentamento SEMPRE (barato: um
      // percentil sobre ~2k pontos); a moldura continua bloqueável pelo usuário.
      updateScenery();
      if (!autoFitDone && !engineStoppedOnce) frameCore(200);
    }
  });

  // Configura a física inicial já com os valores atuais dos sliders, MAS sem
  // reaquecer aqui (síncrono, antes da engine existir) — o reheat vem no 1º tick.
  applyForces(false);
  // Glow inicial conforme pref + guards (tema/mobile) — antes do 1º frame.
  applyGlow();

  const resize = () => {
    graph.width(container.clientWidth || window.innerWidth);
    graph.height(container.clientHeight || window.innerHeight);
  };
  window.addEventListener('resize', resize);

  return {
    // Filtros mudam visibilidade de nós E links (link de/pra nó filtrado some).
    applyFilters: () => { graph.nodeVisibility((n: any) => ctx.isNodeActive(n.id)); graph.linkVisibility((l: any) => linkVisible(l)); },
    // Cor sempre via nodeColorFn — inclui o dim de busca por cima do colorMode.
    // linkColor junto: as linhas herdam a cor do nó fonte (seguem o modo).
    applyColors: () => { graph.nodeColor((n: any) => nodeColorFn(n)); graph.linkColor((l: any) => linkColor(l)); },
    applySimilar: () => { graph.linkVisibility((l: any) => linkVisible(l)); graph.linkColor((l: any) => linkColor(l)); },
    applyNodeSize: () => { graph.nodeVal((n: any) => nodeVal(n)); graph.linkWidth((l: any) => linkWidth(l)); applyCollide(); graph.d3ReheatSimulation(); },
    applyForces,
    applyNoOverlap: () => { applyCollide(); graph.d3ReheatSimulation(); },
    // Busca (spec 29): rechama os accessors de cor e tamanho — a lib reavalia
    // todos os nós (mesmo mecanismo dos outros applyX; sem refresh manual).
    applySearch: () => { graph.nodeColor((n: any) => nodeColorFn(n)); graph.nodeVal((n: any) => nodeVal(n)); graph.linkColor((l: any) => linkColor(l)); },
    applyGlow,
    flyTo,
    resize,
    // pauseAnimation congela o loop rAF da lib (render + tick); resumeAnimation
    // retoma. O 2D chama no exit3D/enter3D — 3D escondido não queima GPU.
    pause: () => { paused = true; try { graph.pauseAnimation?.(); } catch { /* best-effort */ } },
    resume: () => { paused = false; try { graph.resumeAnimation?.(); } catch { /* best-effort */ } },
    dispose: () => {
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (resumeTimer) clearTimeout(resumeTimer);
      if (synapseTimer) clearTimeout(synapseTimer);
      // O EffectComposer NÃO descarta passes adicionados (vazariam ~8 render
      // targets por sessão 3D); cenografia idem (geometria/material/textura).
      try { bloomPass?.dispose?.(); outputPass?.dispose?.(); } catch { /* best-effort */ }
      try { disposeScenery(cage, ring); } catch { /* best-effort */ }
      try { graph._destructor?.(); } catch { /* best-effort */ }
    },
  };
}

function idOf(v: any): string {
  return typeof v === 'object' && v ? String(v.id ?? '') : String(v ?? '');
}

// Registra o inicializador global pro client 2D chamar após o lazy-load do bundle.
(window as any).__initGraph3D = initGraph3D;
