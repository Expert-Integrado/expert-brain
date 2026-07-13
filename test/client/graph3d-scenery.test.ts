// Testes da cenografia do palco 3D (spec 104 "cosmos") — a matemática pura de
// src/web/client/graph3d-scenery.ts: percentis do núcleo, vértices da gaiola.
// Roda em jsdom (sem WebGL).
import { describe, it, expect } from 'vitest';
import {
  computeCore,
  cageRadius,
  cagePositions,
  buildCage,
  ringPositions,
} from '../../src/web/client/graph3d-scenery.js';

describe('computeCore', () => {
  it('nuvem pequena (<8 pontos) → null (chamador cai no zoomToFit)', () => {
    const pts = Array.from({ length: 7 }, (_, i) => ({ x: i, y: 0, z: 0 }));
    expect(computeCore(pts)).toBeNull();
  });

  it('centróide correto e r88 ignora outliers; r98 os enxerga', () => {
    // 96 pontos num casulo de raio ~1 em volta de (10, 20, 30) + 4 outliers
    // SIMÉTRICOS a 500 (não deslocam o centróide).
    const pts: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * 2 * Math.PI;
      pts.push({ x: 10 + Math.cos(a), y: 20 + Math.sin(a), z: 30 });
    }
    pts.push({ x: 10 + 500, y: 20, z: 30 }, { x: 10 - 500, y: 20, z: 30 });
    pts.push({ x: 10, y: 20 + 500, z: 30 }, { x: 10, y: 20 - 500, z: 30 });

    const core = computeCore(pts)!;
    expect(core.cx).toBeCloseTo(10, 6);
    expect(core.cy).toBeCloseTo(20, 6);
    expect(core.cz).toBeCloseTo(30, 6);
    expect(core.r88).toBeLessThan(2);     // percentil 88 fica no casulo
    expect(core.r98).toBeGreaterThan(400); // percentil 98 já pega outlier
  });
});

describe('cageRadius', () => {
  it('sem outliers acompanha o r98 com 5% de folga', () => {
    const r = cageRadius({ cx: 0, cy: 0, cz: 0, r88: 100, r98: 110 });
    expect(r).toBeCloseTo(110 * 1.05, 6);
  });

  it('com outlier em fuga clampa em 1.4x o núcleo (gaiola não infla)', () => {
    const r = cageRadius({ cx: 0, cy: 0, cz: 0, r88: 1, r98: 500 });
    expect(r).toBeCloseTo(1.4, 6);
  });
});

describe('cagePositions', () => {
  it('conta exata de floats: (meridianos+paralelos) · segmentos · 2 pontas · xyz', () => {
    expect(cagePositions().length).toBe((12 + 7) * 64 * 2 * 3);
    expect(cagePositions(2, 1, 8).length).toBe((2 + 1) * 8 * 2 * 3);
  });

  it('todo vértice está na esfera unitária (norma 1, tolerância float32)', () => {
    const pos = cagePositions(4, 3, 16);
    for (let i = 0; i < pos.length; i += 3) {
      const norm = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
      expect(norm).toBeCloseTo(1, 6);
    }
  });

  it('paralelos em latitudes uniformes sem os polos (|y| < 1)', () => {
    const parallels = 3;
    const pos = cagePositions(0, parallels, 8);
    const ys = new Set<string>();
    for (let i = 1; i < pos.length; i += 3) ys.add(pos[i].toFixed(9));
    expect(ys.size).toBe(parallels);
    for (const y of ys) expect(Math.abs(Number(y))).toBeLessThan(1);
  });
});

describe('ringPositions', () => {
  it('círculo unitário no plano XZ: contagem exata, y=0, norma 1', () => {
    const pos = ringPositions(16);
    expect(pos.length).toBe(16 * 2 * 3);
    for (let i = 0; i < pos.length; i += 3) {
      expect(pos[i + 1]).toBe(0);
      expect(Math.hypot(pos[i], pos[i + 2])).toBeCloseTo(1, 6);
    }
  });
});

describe('buildCage', () => {
  it('LineSegments com a geometria completa e material que não oclui (depthWrite off)', () => {
    const cage = buildCage('#93a1c8', 0.15);
    expect(cage.geometry.getAttribute('position').count).toBe((12 + 7) * 64 * 2);
    expect(cage.material.transparent).toBe(true);
    expect(cage.material.opacity).toBeCloseTo(0.15, 6);
    expect(cage.material.depthWrite).toBe(false);
  });
});
