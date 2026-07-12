// Declaração ambiente pro three@0.185 (não publica .d.ts) e pros addons jsm de
// pós-processamento — mesmo padrão do d3-force-3d.d.ts: só o SUBCONJUNTO que o
// palco 3D usa (spec 104: bloom + gaiola + ano). O runtime vem do MESMO three
// que o 3d-force-graph já embute no bundle (esbuild dedupe) — o shim é só tipo.
declare module 'three' {
  export class Vector2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
  }
  export class BufferGeometry {
    setAttribute(name: string, attribute: unknown): this;
    getAttribute(name: string): { count: number; array: ArrayLike<number> };
    dispose(): void;
  }
  export class Float32BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number);
  }
  export class LineBasicMaterial {
    constructor(params?: Record<string, unknown>);
    transparent: boolean;
    opacity: number;
    depthWrite: boolean;
    dispose(): void;
  }
  export class LineSegments {
    constructor(geometry?: unknown, material?: unknown);
    geometry: BufferGeometry;
    material: LineBasicMaterial;
    position: { set(x: number, y: number, z: number): void };
    scale: { setScalar(s: number): void };
    visible: boolean;
    renderOrder: number;
    parent: { remove(obj: unknown): void } | null;
  }
  export class CanvasTexture {
    constructor(canvas: unknown);
    dispose(): void;
  }
  export class SpriteMaterial {
    constructor(params?: Record<string, unknown>);
    map: CanvasTexture | null;
    dispose(): void;
  }
  export class Sprite {
    constructor(material?: unknown);
    material: SpriteMaterial;
    position: { set(x: number, y: number, z: number): void };
    scale: { set(x: number, y: number, z: number): void };
    visible: boolean;
    renderOrder: number;
    parent: { remove(obj: unknown): void } | null;
  }
}

declare module 'three/examples/jsm/postprocessing/UnrealBloomPass.js' {
  import { Vector2 } from 'three';
  export class UnrealBloomPass {
    constructor(resolution: Vector2, strength?: number, radius?: number, threshold?: number);
    enabled: boolean;
    strength: number;
    radius: number;
    threshold: number;
    dispose(): void;
  }
}

declare module 'three/examples/jsm/postprocessing/OutputPass.js' {
  export class OutputPass {
    enabled: boolean;
    dispose(): void;
  }
}
