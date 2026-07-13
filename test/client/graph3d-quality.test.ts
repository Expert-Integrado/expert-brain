// Testes do motor de qualidade do 3D (spec 105) — a matemática pura de
// src/web/client/graph3d-quality.ts. Roda em jsdom (sem WebGL).
import { describe, it, expect } from 'vitest';
import {
  TIER_SETTINGS,
  medianOf,
  resolveTier,
} from '../../src/web/client/graph3d-quality.js';

describe('TIER_SETTINGS', () => {
  it('extra preserva o estado calibrado da spec 104 (nada muda no tier máximo)', () => {
    expect(TIER_SETTINGS.extra).toEqual({
      simsVisible: true, glowAllowed: true, nodeResolution: 16,
      pixelRatioCap: 2, collideStrongIterations: 4, cooldownTime: 15000,
    });
  });

  it('cada degrau só APERTA os knobs (nunca afrouxa): extra ≥ balanced ≥ low', () => {
    const [e, b, l] = [TIER_SETTINGS.extra, TIER_SETTINGS.balanced, TIER_SETTINGS.low];
    for (const [hi, lo] of [[e, b], [b, l]] as const) {
      expect(hi.nodeResolution).toBeGreaterThanOrEqual(lo.nodeResolution);
      expect(hi.pixelRatioCap).toBeGreaterThanOrEqual(lo.pixelRatioCap);
      expect(hi.collideStrongIterations).toBeGreaterThanOrEqual(lo.collideStrongIterations);
      expect(hi.cooldownTime).toBeGreaterThanOrEqual(lo.cooldownTime);
      expect(Number(hi.simsVisible)).toBeGreaterThanOrEqual(Number(lo.simsVisible));
      expect(Number(hi.glowAllowed)).toBeGreaterThanOrEqual(Number(lo.glowAllowed));
    }
  });

  it('low desliga glow e sims (os dois maiores custos)', () => {
    expect(TIER_SETTINGS.low.glowAllowed).toBe(false);
    expect(TIER_SETTINGS.low.simsVisible).toBe(false);
  });
});

describe('medianOf', () => {
  it('ímpar → elemento central; par → média dos dois centrais', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });

  it('robusta a outliers (hitch de GC não arrasta a decisão)', () => {
    // 9 frames de 10ms + 1 hitch de 500ms: média seria 59ms; mediana fica 10.
    expect(medianOf([10, 10, 10, 10, 500, 10, 10, 10, 10, 10])).toBe(10);
  });

  it('vazio → NaN (não decide sem amostras) e não muta a entrada', () => {
    expect(medianOf([])).toBeNaN();
    const input = [5, 1, 3];
    medianOf(input);
    expect(input).toEqual([5, 1, 3]);
  });
});

describe('resolveTier', () => {
  it('máquina folgada (≤18.2ms ≈ 55fps+) → extra', () => {
    expect(resolveTier(10)).toBe('extra');
    expect(resolveTier(18.2)).toBe('extra');
  });

  it('meio-termo (≤33.3ms ≈ 30fps) → balanced', () => {
    expect(resolveTier(18.3)).toBe('balanced');
    expect(resolveTier(33.3)).toBe('balanced');
  });

  it('sofrendo (>33.3ms) → low', () => {
    expect(resolveTier(33.4)).toBe('low');
    expect(resolveTier(200)).toBe('low');
  });

  it('sem amostras (NaN/Infinity) → balanced, sem promover nem punir', () => {
    expect(resolveTier(NaN)).toBe('balanced');
    expect(resolveTier(Infinity)).toBe('balanced');
  });
});
