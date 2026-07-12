import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
} from 'three';

// ──────────────────────────────────────────────────────────────────────────────
// Cenografia do palco 3D (spec 104 "cosmos"): gaiola esférica aramada + sprite
// do ano. Funções PURAS separadas do graph3d.ts pra serem testáveis em jsdom
// (test/client) sem subir WebGL — a matemática (percentis do núcleo, vértices
// da gaiola) é o que quebra silencioso; os builders three são wiring fino.
// ──────────────────────────────────────────────────────────────────────────────

export interface CorePoint { x: number; y: number; z: number; }
export interface CoreSphere {
  cx: number; cy: number; cz: number;
  /** Raio no percentil 88 das distâncias ao centróide (o "núcleo" do frameCore). */
  r88: number;
  /** Raio no percentil 98 — quase-tudo, ainda ignorando o rabo extremo de órfãs. */
  r98: number;
}

// Centróide + percentis de raio da nuvem. Mesma matemática que o frameCore do
// graph3d.ts usava inline (centróide de TODOS os pontos; percentil ignora o
// halo de órfãs distantes) — extraída pra gaiola e moldura compartilharem.
// null com menos de 8 pontos (nuvem pequena demais pra percentil fazer sentido;
// o chamador cai no zoomToFit clássico e esconde a cenografia).
export function computeCore(pts: CorePoint[]): CoreSphere | null {
  if (pts.length < 8) return null;
  let cx = 0, cy = 0, cz = 0;
  for (const p of pts) { cx += p.x; cy += p.y; cz += p.z; }
  cx /= pts.length; cy /= pts.length; cz /= pts.length;
  const dists = pts
    .map((p) => Math.hypot(p.x - cx, p.y - cy, p.z - cz))
    .sort((a, b) => a - b);
  const at = (pct: number) =>
    dists[Math.min(dists.length - 1, Math.floor(dists.length * pct))] || 1;
  return { cx, cy, cz, r88: at(0.88), r98: at(0.98) };
}

// Raio da gaiola: envolve QUASE tudo (r98 + 5% de folga), mas nunca mais que
// 1.4x o núcleo — uma única órfã em fuga não pode inflar a esfera até virar
// cenário invisível de tão longe.
export function cageRadius(core: CoreSphere): number {
  return Math.min(core.r98 * 1.05, core.r88 * 1.4);
}

// Vértices da esfera aramada em raio UNITÁRIO (o chamador escala/posiciona o
// LineSegments): `meridians` círculos máximos passando pelos polos ±y +
// `parallels` latitudes uniformes (sem os polos), cada círculo quebrado em
// `segments` segmentos de reta. Retorna pares de endpoints (formato
// LineSegments): (meridians + parallels) · segments · 2 vértices · xyz.
export function cagePositions(meridians = 12, parallels = 7, segments = 64): Float32Array {
  const out = new Float32Array((meridians + parallels) * segments * 6);
  let o = 0;
  const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    out[o++] = ax; out[o++] = ay; out[o++] = az;
    out[o++] = bx; out[o++] = by; out[o++] = bz;
  };
  const TAU = 2 * Math.PI;
  // Meridianos: círculo completo no plano de azimute phi (theta 0..2π cobre as
  // duas metades — phi só precisa varrer meia volta pra não duplicar círculos).
  for (let m = 0; m < meridians; m++) {
    const phi = (m * Math.PI) / meridians;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    for (let s = 0; s < segments; s++) {
      const t0 = (s / segments) * TAU;
      const t1 = ((s + 1) / segments) * TAU;
      seg(
        Math.sin(t0) * cp, Math.cos(t0), Math.sin(t0) * sp,
        Math.sin(t1) * cp, Math.cos(t1), Math.sin(t1) * sp,
      );
    }
  }
  // Paralelos: latitudes uniformes entre os polos (polos excluídos — viram ponto).
  for (let p = 0; p < parallels; p++) {
    const lat = -Math.PI / 2 + ((p + 1) * Math.PI) / (parallels + 1);
    const y = Math.sin(lat), r = Math.cos(lat);
    for (let s = 0; s < segments; s++) {
      const t0 = (s / segments) * TAU;
      const t1 = ((s + 1) / segments) * TAU;
      seg(r * Math.cos(t0), y, r * Math.sin(t0), r * Math.cos(t1), y, r * Math.sin(t1));
    }
  }
  return out;
}

// Gaiola pronta pra cena, raio unitário: 1 draw call (uma BufferGeometry só).
// depthWrite:false — as linhas não podem ocluir esferas/bloom atrás delas.
export function buildCage(color: string, opacity: number): LineSegments {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(cagePositions(), 3));
  const mat = new LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  return new LineSegments(geo, mat);
}

// Texto do ano com respiro entre dígitos (o letter-spacing do canvas 2d não é
// universal; espaço literal é) — "2026" → "2 0 2 6".
export function yearText(year: number): string {
  return String(year).split('').join(' ');
}

// Dimensões do canvas do sprite — exportadas pro chamador escalar o sprite no
// MESMO aspecto (senão o texto estica).
export const YEAR_CANVAS_W = 512;
export const YEAR_CANVAS_H = 160;

// Sprite do ano (CanvasTexture — sempre de frente pra câmera). null quando o
// contexto 2d não existe (jsdom/headless): o palco segue sem o ano, sem erro.
export function buildYearSprite(year: number, fontFamily: string, color: string): Sprite | null {
  const canvas = document.createElement('canvas');
  canvas.width = YEAR_CANVAS_W;
  canvas.height = YEAR_CANVAS_H;
  let c2d: CanvasRenderingContext2D | null = null;
  try { c2d = canvas.getContext('2d'); } catch { c2d = null; }
  if (!c2d) return null;
  c2d.clearRect(0, 0, YEAR_CANVAS_W, YEAR_CANVAS_H);
  c2d.font = `600 104px ${fontFamily || 'system-ui'}`;
  c2d.textAlign = 'center';
  c2d.textBaseline = 'middle';
  // SEM shadowBlur no canvas: com bloom ligado o blur duplo (canvas + bloom)
  // derretia os dígitos num blob ilegível (validação 12/07) — o glow do ano é
  // 100% do bloom; sem bloom o texto fica limpo e discreto, também ok.
  c2d.fillStyle = color;
  c2d.fillText(yearText(year), YEAR_CANVAS_W / 2, YEAR_CANVAS_H / 2 + 4);
  const tex = new CanvasTexture(canvas);
  const mat = new SpriteMaterial({ map: tex, transparent: true, opacity: 0.8, depthWrite: false });
  return new Sprite(mat);
}

// Descarte explícito — o _destructor da lib não conhece objetos que NÓS
// adicionamos à cena; sem isso geometria/material/textura vazam na troca 2D↔3D.
export function disposeScenery(cage: LineSegments | null, year: Sprite | null): void {
  if (cage) {
    cage.parent?.remove(cage);
    cage.geometry.dispose();
    cage.material.dispose();
  }
  if (year) {
    year.parent?.remove(year);
    year.material.map?.dispose();
    year.material.dispose();
  }
}
