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
  forceCenter,
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
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
}
interface Forces {
  center: number;     // forceCenter strength (0..0.2 sutil)
  repel: number;      // forceManyBody strength magnitude (200..2000)
  link: number;       // forceLink strength (0..2)
  distance: number;   // forceLink distance (30..400)
}

// A.36 — Paridade visual com o graph view do Obsidian (dentes-de-leão): folhas
// orbitam grudadas nos hubs, ilhas afastadas por espaço vazio. A receita:
//   center  MUITO fraco (0.02) → não puxa tudo pro miolo, deixa as ilhas se
//           afastarem em vez de virar uma bola única;
//   repel   MODERADO (450) com distanceMax curto (250) → empurra vizinhos pra
//           não encavalar, mas NÃO repele entre clusters distantes (o que
//           colapsaria as ilhas num disco só e custa O(n²));
//   link    FORTE (1) e distância CURTA (40) → a folha gruda no hub; o strength
//           por-link ainda é escalado por grau (ver chargeStrength/linkStrength
//           abaixo) pra folha (grau 1) colar mais que hub<->hub.
const DEFAULTS: Forces = { center: 0.02, repel: 450, link: 1, distance: 40 };

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

// A.36 — closures ÚNICAS de força, referenciadas TANTO no rebuild quanto no
// case 'forces'. Antes o 'forces' reaplicava strength flat (-forces.repel) e
// trocava silenciosamente o modelo físico (hub repelia 2,5x menos ao mexer em
// qualquer slider). Extraídas pra manter o scaling por raio/grau consistente.
const chargeStrength = (d: SimNode) => -forces.repel * ((d.r ?? 10) / 12);
const linkStrength = (l: SimLink) => {
  const s = typeof l.source === 'string' ? l.source : (l.source as SimNode).id;
  const t = typeof l.target === 'string' ? l.target : (l.target as SimNode).id;
  // 1 / min(grau) escala com o slider `link`: folha (grau 1) gruda no hub com
  // strength cheio; ligação hub<->hub afrouxa proporcional ao grau — igual d3.
  const minDeg = Math.min(degreeById.get(s) ?? 1, degreeById.get(t) ?? 1) || 1;
  return forces.link / minDeg;
};

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
    // A.25 — manyBody com strength escalado pelo tamanho do nó (nós grandes
    // empurram mais que pequenos), igual ao Obsidian. A.36 — distanceMax CURTO
    // (250): repulsão morre além de ~250px, então clusters distantes NÃO se
    // empurram — as ilhas ficam separadas por espaço vazio (dentes-de-leão) em
    // vez de colapsar num disco só. Também corta o O(n²) global (perf).
    .force(
      'charge',
      forceManyBody<SimNode>()
        .strength(chargeStrength)
        .distanceMax(250),
    )
    // A.36 — link forte + curto + strength por grau (folha gruda no hub).
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => (d as SimNode).id)
        .strength(linkStrength)
        .distance(forces.distance),
    )
    .force('center', forceCenter<SimNode>(0, 0).strength(forces.center))
    // A.25 — collide com raio = size + padding. Garante que nó grande não fica em
    // cima de pequeno. Intensidade/iterações sobem no modo "não sobrepor".
    .force('collide', forceCollide<SimNode>().radius(collideRadius).strength(collideStrength()).iterations(collideIterations()))
    .alphaDecay(1 - Math.pow(0.001, 1 / 300)) // ~0.0228, default D3 (~300 ticks pra esfriar)
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
      // A.25 — recebe r (raio) por nó pra collide + repel proporcionais
      nodes = msg.nodes.map((n: any) => ({ id: n.id, x: n.x, y: n.y, r: n.r ?? 10 }));
      links = msg.links.map((l: any) => ({ source: l.source, target: l.target }));
      recomputeDegrees(); // A.36 — grau por nó pro linkStrength escalar por grau
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
        (sim.force('center') as any)?.strength(forces.center);
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
