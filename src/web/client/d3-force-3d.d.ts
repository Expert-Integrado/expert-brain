// Declaração ambiente pro pacote d3-force-3d (não publica tipos próprios). Só o
// subconjunto que o palco 3D usa (forceManyBody/forceCenter/forceLink/forceCollide).
// As forças são objetos encadeáveis; tipamos como `any` — o 3d-force-graph as
// consome via d3Force() sem exigir shape estrito, e o uso aqui é chainable puro.
declare module 'd3-force-3d' {
  export function forceManyBody(): any;
  export function forceCenter(x?: number, y?: number, z?: number): any;
  export function forceLink(links?: any[]): any;
  export function forceCollide(radius?: number | ((d: any) => number)): any;
  export function forceX(x?: number | ((d: any) => number)): any;
  export function forceY(y?: number | ((d: any) => number)): any;
  export function forceZ(z?: number | ((d: any) => number)): any;
  export function forceRadial(radius?: number, x?: number, y?: number, z?: number): any;
  export function forceSimulation(nodes?: any[], numDimensions?: number): any;
}
