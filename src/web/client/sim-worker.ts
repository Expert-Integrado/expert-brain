// A.24 — Web Worker dedicado pra simulação D3-force.
// Igual ao sim.js do Obsidian: roda contínuo enquanto alpha > alphaMin,
// esfria sozinho via alphaDecay (~0.0228 default), aceita comandos do main
// thread via postMessage. Posições são mandadas de volta a cada tick.
//
// Mensagens IN (main → worker):
//   {type:'init', nodes:[{id,x,y}], links:[{source,target}], forces?:Forces}
//   {type:'forces', forces:Partial<Forces>, alpha?:number}     // ajusta forces (gravity etc)
//   {type:'pin', id:string, x:number, y:number}                // drag start ou move
//   {type:'unpin', id:string}                                  // drag end (libera fx/fy)
//   {type:'reheat', alpha:number}                              // reaquece simulação
//   {type:'reset', nodes:[{id,x,y}]}                            // restaura snapshot e reaquece
//   {type:'stop'}                                              // pausa simulação
//
// Mensagens OUT (worker → main):
//   {type:'tick', positions:Record<id, [x,y]>, alpha:number}
//   {type:'end'}                                               // alpha caiu abaixo de alphaMin

import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceX,
  forceY,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

interface SimNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  // A.25 — raio do nó (do server-side: max(8, min(3*sqrt(d+1), 30))).
  // Usado pra forceCollide proporcional + repel scaled by size.
  r: number;
  // A.37 — domínio do nó, usado pela gravidade fraca por domínio (forceX/Y
  // puxando cada nó pro centróide do seu cluster de domínio).
  domain?: string;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
}
interface Forces {
  center: number;     // A.37 — forceX(0)/forceY(0) strength = centerStrength (Obsidian default 0.1)
  repel: number;      // forceManyBody strength magnitude (200..2000)
  link: number;       // forceLink strength (0..2)
  distance: number;   // forceLink distance (30..400)
}

// A.37 — Física reversa-engenheirada 1:1 do graph view do Obsidian (extraída do
// obsidian.asar, engine WASM + fallback d3 idêntico). O modelo REAL do Obsidian:
//   - center: forceX(0)+forceY(0) com strength = centerStrength (default 0.1);
//   - repel:  forceManyBody strength = -repelStrength; SEM distanceMax (=Infinity!),
//             distanceMin=30, theta=0.9. O default do Obsidian é BRUTAL: slider 10
//             → repelStrength = 10³ = 1000 (mapping e*e*e). É esse repel forte +
//             sem-cap que "explode" o grafo e dá o espaçamento característico;
//   - link:   forceLink strength = linkStrength · (1/deg) (default 1), distance =
//             linkDistance (default 250, NÃO 40 — as ligações do Obsidian são longas);
//   - velocityDecay 0.4 (vx*=0.6/tick), alphaDecay 0.0228, alphaMin 0.001.
//
// Nossos DEFAULTS ficam alinhados ao Obsidian: center 0.1, repel 1000 (=slider 10³),
// link 1, distance 250. O cap de distanceMax=250 do modelo antigo (v9) era o que
// castrava o slider de repulsão — removido (ver rebuildSimulation).
const DEFAULTS: Forces = { center: 0.1, repel: 1000, link: 1, distance: 250 };

// ── A.37 — GRAVIDADE FRACA POR DOMÍNIO (adição nossa, fora do modelo Obsidian) ──
// O vault do dono é DENSO (sem notas-folha soltas como vaults típicos), então o
// dente-de-leão puro do Obsidian não separa os clusters temáticos. Puxamos cada
// nó de leve pro CENTRÓIDE do seu domínio (calculado das posições iniciais), o que
// agrupa por área sem precisar de UI nova. forceX/forceY com strength baixa.
//
// CALIBRAR AQUI: subir aproxima mais os nós do mesmo domínio (clusters mais
// apertados/separados); baixar deixa a topologia dos links mandar. 0 = desliga.
// Se conflitar com o modelo Obsidian (grafo "quadrado" demais), baixar pra 0.02.
const DOMAIN_GRAVITY = 0.03;

let nodes: SimNode[] = [];
let links: SimLink[] = [];
let sim: Simulation<SimNode, SimLink> | null = null;
let forces: Forces = { ...DEFAULTS };
// Modo "não sobrepor": collide forte (strength 1 + 4 iterações + padding maior)
// que resolve a sobreposição de verdade. Default off = collide suave (0.8/1 iter)
// que só evita encavalamento grosseiro sem custar perf no caso comum.
let noOverlap = false;
const collideRadius = (d: SimNode) => (d.r ?? 10) + (noOverlap ? 6 : 4);
const collideStrength = () => (noOverlap ? 1 : 0.8);
const collideIterations = () => (noOverlap ? 4 : 1);
const pinned = new Map<string, { x: number; y: number }>();

// A.36 — grau (nº de links explícitos) por nó. Usado pra escalar o strength do
// forceLink como o d3 faz por default (1 / min(grau_a, grau_b)): a ponta de
// menor grau (a folha) "manda" e gruda mais forte no hub. Recalculado sempre
// que os links mudam (init).
const degreeById = new Map<string, number>();
function recomputeDegrees() {
  degreeById.clear();
  for (const l of links) {
    const s = typeof l.source === 'string' ? l.source : (l.source as SimNode).id;
    const t = typeof l.target === 'string' ? l.target : (l.target as SimNode).id;
    degreeById.set(s, (degreeById.get(s) ?? 0) + 1);
    degreeById.set(t, (degreeById.get(t) ?? 0) + 1);
  }
}

// A.36/A.37 — closures ÚNICAS de força, referenciadas TANTO no rebuild quanto no
// case 'forces'. Antes o 'forces' reaplicava strength flat (-forces.repel) e
// trocava silenciosamente o modelo físico. Extraídas pra manter o scaling
// consistente entre init e ajuste de slider.
//
// A.37 — O Obsidian usa strength BRUTA (-repelStrength) igual pra todo nó. Nós
// mantemos um leve scaling por raio (nó maior/hub empurra um pouco mais) como
// EXTRA que não conflita — mas centrado em 1.0 pra o default bater com o Obsidian:
// nó de raio médio (~12) → fator ~1.0 → -forces.repel puro, igual ao Obsidian.
const chargeStrength = (d: SimNode) => -forces.repel * ((d.r ?? 12) / 12);
const linkStrength = (l: SimLink) => {
  const s = typeof l.source === 'string' ? l.source : (l.source as SimNode).id;
  const t = typeof l.target === 'string' ? l.target : (l.target as SimNode).id;
  // 1 / min(grau) escala com o slider `link`: folha (grau 1) gruda no hub com
  // strength cheio; ligação hub<->hub afrouxa proporcional ao grau — igual d3
  // (e igual ao E*J(...) do fallback d3 do Obsidian, onde J é o 1/deg default).
  const minDeg = Math.min(degreeById.get(s) ?? 1, degreeById.get(t) ?? 1) || 1;
  return forces.link / minDeg;
};

// A.37 — centróide por domínio, recalculado no init a partir das posições
// iniciais (o layout pré-computado do servidor). A gravidade por domínio puxa
// cada nó pra { x, y } do seu domínio. Constante DOMAIN_GRAVITY controla a força.
const domainCentroid = new Map<string, { x: number; y: number }>();
function recomputeDomainCentroids() {
  domainCentroid.clear();
  const acc = new Map<string, { x: number; y: number; n: number }>();
  for (const nd of nodes) {
    const dom = nd.domain || '_';
    const a = acc.get(dom) ?? { x: 0, y: 0, n: 0 };
    a.x += nd.x ?? 0;
    a.y += nd.y ?? 0;
    a.n += 1;
    acc.set(dom, a);
  }
  for (const [dom, a] of acc) {
    domainCentroid.set(dom, { x: a.x / a.n, y: a.y / a.n });
  }
}
// Alvo X/Y da gravidade de domínio pra cada nó (fallback 0 = centro global).
const domainTargetX = (d: SimNode) => domainCentroid.get(d.domain || '_')?.x ?? 0;
const domainTargetY = (d: SimNode) => domainCentroid.get(d.domain || '_')?.y ?? 0;

function rebuildSimulation(initialAlpha = 1) {
  if (sim) sim.stop();

  // Re-aplica pins ao reconstruir
  for (const n of nodes) {
    const p = pinned.get(n.id);
    if (p) {
      n.fx = p.x;
      n.fy = p.y;
    } else {
      n.fx = null;
      n.fy = null;
    }
  }

  sim = forceSimulation<SimNode, SimLink>(nodes)
    // A.37 — manyBody FIEL ao Obsidian: SEM distanceMax cap (Obsidian usa h=1/0,
    // i.e. Infinity — a repulsão age em TODO o grafo, é isso que dá o espaçamento
    // amplo característico). theta=0.9 (Obsidian usa f=.81=theta², logo θ=√.81=0.9)
    // mantém o Barnes-Hut barato o suficiente pra ~1800 nós. distanceMin=30 evita
    // singularidade quando dois nós coincidem. O cap de 250 do modelo antigo (v9)
    // era EXATAMENTE o que castrava o slider de repulsão — removido de propósito.
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength(chargeStrength)
        .theta(0.9)
        .distanceMin(30),
    )
    // A.37 — link com strength por grau (folha gruda no hub) e distância =
    // linkDistance (default 250, igual Obsidian — ligações LONGAS, não curtas).
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => (d as SimNode).id)
        .strength(linkStrength)
        .distance(forces.distance),
    )
    // A.37 — center FIEL ao Obsidian: forceX(0)+forceY(0) com strength =
    // centerStrength (o Obsidian NÃO usa forceCenter; usa forceX/forceY separados,
    // conforme o array [_,N,q,R,k] extraído do worker). Puxa cada nó pro (0,0).
    .force('centerX', forceX<SimNode>(0).strength(forces.center))
    .force('centerY', forceY<SimNode>(0).strength(forces.center))
    // A.37 — GRAVIDADE POR DOMÍNIO (nossa, fora do Obsidian): forceX/forceY
    // fracos puxando cada nó pro centróide do seu domínio. Agrupa os clusters
    // temáticos num vault denso. DOMAIN_GRAVITY calibra (0 desliga).
    .force('domainX', forceX<SimNode>(domainTargetX).strength(DOMAIN_GRAVITY))
    .force('domainY', forceY<SimNode>(domainTargetY).strength(DOMAIN_GRAVITY))
    // A.25 — collide com raio = size + padding. Garante que nó grande não fica em
    // cima de pequeno. Intensidade/iterações sobem no modo "não sobrepor".
    .force('collide', forceCollide<SimNode>().radius(collideRadius).strength(collideStrength()).iterations(collideIterations()))
    .velocityDecay(0.4)                       // A.37 — Obsidian: vx*=0.6/tick (=1-0.4)
    .alphaDecay(1 - Math.pow(0.001, 1 / 300)) // ~0.0228, default D3 = Obsidian (~300 ticks pra esfriar)
    .alphaMin(0.001)                          // A.37 — Obsidian alphaMin .001 explícito
    .alpha(initialAlpha)
    .on('tick', emitTick)
    .on('end', () => {
      (self as DedicatedWorkerGlobalScope).postMessage({ type: 'end' });
    });
}

function emitTick() {
  const positions: Record<string, [number, number]> = {};
  for (const n of nodes) {
    positions[n.id] = [n.x ?? 0, n.y ?? 0];
  }
  (self as DedicatedWorkerGlobalScope).postMessage({
    type: 'tick',
    positions,
    alpha: sim?.alpha() ?? 0,
  });
}

self.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      // A.25 — recebe r (raio) por nó pra collide + repel proporcionais.
      // A.37 — recebe domain por nó pra gravidade por domínio.
      nodes = msg.nodes.map((n: any) => ({ id: n.id, x: n.x, y: n.y, r: n.r ?? 10, domain: n.domain }));
      links = msg.links.map((l: any) => ({ source: l.source, target: l.target }));
      recomputeDegrees(); // A.36 — grau por nó pro linkStrength escalar por grau
      recomputeDomainCentroids(); // A.37 — centróide por domínio (posições iniciais)
      if (msg.forces) forces = { ...forces, ...msg.forces };
      if (typeof msg.noOverlap === 'boolean') noOverlap = msg.noOverlap;
      pinned.clear();
      // alpha do init (default 1): o client manda baixo (~0.25) quando já
      // renderizou no layout pré-computado, pra um ajuste fino suave em vez do
      // reveal explosivo. forceSimulation começa em alpha=1; baixamos aqui.
      rebuildSimulation(typeof msg.alpha === 'number' ? msg.alpha : 1);
      break;
    }
    case 'forces': {
      forces = { ...forces, ...msg.forces };
      if (sim) {
        // A.36 — reaplica as MESMAS closures (charge scaled por raio, link
        // scaled por grau) em vez de strength flat. Antes, mexer em qualquer
        // slider trocava o modelo físico e o layout ajustado divergia do que o
        // reload reproduzia. As closures leem `forces` (já atualizado acima).
        (sim.force('charge') as any)?.strength(chargeStrength);
        (sim.force('link') as any)?.strength(linkStrength).distance(forces.distance);
        // A.37 — center é forceX/forceY (não forceCenter). Reaplica strength nos dois.
        (sim.force('centerX') as any)?.strength(forces.center);
        (sim.force('centerY') as any)?.strength(forces.center);
        sim.alpha(msg.alpha ?? 0.3).restart();
      }
      break;
    }
    case 'collide': {
      // Liga/desliga o modo "não sobrepor" ao vivo e reaquece pra re-resolver as
      // posições sem encavalar (alpha 0.5 dá um empurrão suficiente).
      noOverlap = !!msg.noOverlap;
      if (sim) {
        (sim.force('collide') as any)
          ?.radius(collideRadius)
          .strength(collideStrength())
          .iterations(collideIterations());
        sim.alpha(0.5).restart();
      }
      break;
    }
    case 'pin': {
      pinned.set(msg.id, { x: msg.x, y: msg.y });
      const node = nodes.find((n) => n.id === msg.id);
      if (node) {
        node.fx = msg.x;
        node.fy = msg.y;
      }
      if (sim) sim.alphaTarget(0.3).restart();
      break;
    }
    case 'unpin': {
      pinned.delete(msg.id);
      const node = nodes.find((n) => n.id === msg.id);
      if (node) {
        node.fx = null;
        node.fy = null;
      }
      if (sim) sim.alphaTarget(0);
      break;
    }
    case 'reheat': {
      if (sim) sim.alpha(msg.alpha ?? 0.5).restart();
      break;
    }
    case 'reset': {
      // Restaura posições do snapshot e reaquece
      for (const n of nodes) {
        const target = msg.nodes.find((s: any) => s.id === n.id);
        if (target) {
          n.x = target.x;
          n.y = target.y;
          n.vx = 0;
          n.vy = 0;
        }
      }
      pinned.clear();
      rebuildSimulation();
      break;
    }
    case 'stop': {
      if (sim) sim.stop();
      break;
    }
  }
});
