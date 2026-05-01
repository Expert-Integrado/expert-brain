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
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
}
interface Forces {
  center: number;     // gravity-ish (0..1)
  repel: number;      // forceManyBody strength (negative magnitude, 0..2000)
  link: number;       // forceLink strength (0..2)
  distance: number;   // forceLink distance (default 80)
}

const DEFAULTS: Forces = { center: 0.05, repel: 250, link: 0.4, distance: 80 };

let nodes: SimNode[] = [];
let links: SimLink[] = [];
let sim: Simulation<SimNode, SimLink> | null = null;
let forces: Forces = { ...DEFAULTS };
const pinned = new Map<string, { x: number; y: number }>();

function rebuildSimulation() {
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
    .force('charge', forceManyBody<SimNode>().strength(-forces.repel))
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => (d as SimNode).id)
        .strength(forces.link)
        .distance(forces.distance),
    )
    .force('center', forceCenter<SimNode>(0, 0).strength(forces.center))
    .force('collide', forceCollide<SimNode>().radius(8).strength(0.6))
    .alphaDecay(1 - Math.pow(0.001, 1 / 300)) // ~0.0228, default D3 (~300 ticks pra esfriar)
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
      nodes = msg.nodes.map((n: any) => ({ id: n.id, x: n.x, y: n.y }));
      // Resolve string IDs em referências
      links = msg.links.map((l: any) => ({ source: l.source, target: l.target }));
      if (msg.forces) forces = { ...forces, ...msg.forces };
      pinned.clear();
      rebuildSimulation();
      break;
    }
    case 'forces': {
      forces = { ...forces, ...msg.forces };
      if (sim) {
        (sim.force('charge') as any)?.strength(-forces.repel);
        (sim.force('link') as any)?.strength(forces.link).distance(forces.distance);
        (sim.force('center') as any)?.strength(forces.center);
        sim.alpha(msg.alpha ?? 0.3).restart();
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
