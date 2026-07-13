// ──────────────────────────────────────────────────────────────────────────────
// Tiers de qualidade do palco 3D (spec 105) — a parte PURA, testável em jsdom
// sem WebGL (mesmo padrão do graph3d-scenery.ts). O graph3d.ts aplica os knobs;
// aqui vivem só os números e a decisão do modo auto.
//
// Enum espelhado do server (graph-prefs.ts Quality3D) — o server valida, o
// client aplica. 'auto' não é um tier aplicável: resolve pra um dos três.
// ──────────────────────────────────────────────────────────────────────────────

export type QualityPref = 'auto' | 'extra' | 'balanced' | 'low';
export type QualityTier = 'extra' | 'balanced' | 'low';

export interface TierSettings {
  /** Linhas semânticas visíveis no 3D (o gate é LOCAL do palco; o 2D não muda). */
  simsVisible: boolean;
  /** Bloom/sinapses permitidos (compõe com os guards de tema/mobile existentes). */
  glowAllowed: boolean;
  /** Segmentos das esferas — compõe com o guard mobile via min(). */
  nodeResolution: number;
  /** Teto de pixelRatio — compõe com o guard mobile (1.5) e o dpr via min(). */
  pixelRatioCap: number;
  /** Iterações do forceCollide com "não sobrepor" LIGADO (desligado é sempre 1). */
  collideStrongIterations: number;
  /** Tempo de física após cada reheat (ms) — default da lib é 15000. */
  cooldownTime: number;
}

// extra = estado calibrado da spec 104 (nada muda); balanced corta os ~15k
// objetos das sims e clampa o fill do bloom; low apaga o glow (o maior custo
// de GPU) e reduz geometria/física pro mínimo digno.
export const TIER_SETTINGS: Record<QualityTier, TierSettings> = {
  extra: { simsVisible: true, glowAllowed: true, nodeResolution: 16, pixelRatioCap: 2, collideStrongIterations: 4, cooldownTime: 15000 },
  balanced: { simsVisible: false, glowAllowed: true, nodeResolution: 16, pixelRatioCap: 1.5, collideStrongIterations: 4, cooldownTime: 15000 },
  low: { simsVisible: false, glowAllowed: false, nodeResolution: 8, pixelRatioCap: 1, collideStrongIterations: 2, cooldownTime: 8000 },
};

// Mediana simples — robusta aos hitches de GC que uma média não aguenta.
// Array vazio → NaN (o chamador não decide sem amostras).
export function medianOf(samples: number[]): number {
  if (!samples.length) return NaN;
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Decisão do modo auto a partir da MEDIANA do frame time medida em 'balanced'
// (o palco boota em balanced de propósito — medir em extra imporia o jank que
// o dono já reclama). Thresholds:
//   ≤ 18.2ms (~55fps, folga sob o vsync de 60) → aguenta mais → extra
//   ≤ 33.3ms (~30fps)                          → fica onde está → balanced
//   acima                                       → sofrendo      → low
// NaN (sem amostras) → balanced (não piora nem promove sem evidência).
export function resolveTier(medianFrameMs: number): QualityTier {
  if (!Number.isFinite(medianFrameMs)) return 'balanced';
  if (medianFrameMs <= 18.2) return 'extra';
  if (medianFrameMs <= 33.3) return 'balanced';
  return 'low';
}
