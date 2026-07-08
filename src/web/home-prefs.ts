import type { Env } from '../env.js';
import { requireSession } from './session.js';

// Preferências das caixas da home (Onda 9/9b, specs/60-ux-reforma/71 e 72): altura
// E ORDEM das caixas salvas POR DONO na tabela meta — mesmo padrão do graph-prefs
// (sincroniza entre máquinas sem binding novo). Caixa sem valor salvo usa o default.
// A edição é por manipulação direta (arrastar pra reordenar, puxar a borda pra
// redimensionar — feedback do dono: "igual ao ClickUp"), sem modal.
export const HOME_PREFS_META_KEY = 'home_prefs';

// Chaves canônicas das caixas ajustáveis. Se a home ganhar caixa nova, entra aqui
// e no SSR dos handles no MESMO commit.
export const HOME_BOX_KEYS = ['today', 'inbox', 'digest', 'activity'] as const;
export type HomeBoxKey = (typeof HOME_BOX_KEYS)[number];

// Limites do resize (px). O mínimo mantém título+captura visíveis; o máximo evita
// caixa maior que a viewport comum. O client recebe estes números via data-attrs
// do SSR — número único dos dois lados.
export const HOME_BOX_MIN = 220;
export const HOME_BOX_MAX = 960;

// Defaults quando não há pref salva.
// MANTER EM SINCRONIA com os fallbacks var(--home-card-h, ...) no HOME_CSS.
export const HOME_BOX_DEFAULTS: Record<HomeBoxKey, number> = {
  today: 420,
  inbox: 420,
  digest: 420,
  activity: 560,
};

// Alturas por caixa (chave ausente = default do CSS).
export type HomePrefs = Partial<Record<HomeBoxKey, number>>;

// Estado completo persistido: alturas + ordem das caixas (null = ordem default).
export interface HomePrefsState {
  heights: HomePrefs;
  order: HomeBoxKey[] | null;
}

const clampBox = (v: unknown): number | null => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN;
  if (Number.isNaN(n)) return null;
  return Math.min(HOME_BOX_MAX, Math.max(HOME_BOX_MIN, n));
};

// Sanitiza o POST do cliente (ou o blob salvo no meta) pro shape canônico:
// { heights: {...}, order: [...] }. Altura inválida é DROPADA (cai no default);
// ordem só aceita chaves conhecidas, sem duplicata, e chaves faltantes são
// COMPLETADAS na ordem default (uma pref antiga nunca esconde caixa nova).
// null só quando o body não traz NEM heights NEM order utilizáveis (→ 400).
export function sanitizeHomePrefs(raw: unknown): HomePrefsState | null {
  if (!raw || typeof raw !== 'object') return null;
  const heightsRaw = (raw as Record<string, unknown>).heights;
  const orderRaw = (raw as Record<string, unknown>).order;
  const hasHeights = !!heightsRaw && typeof heightsRaw === 'object';
  const hasOrder = Array.isArray(orderRaw);
  if (!hasHeights && !hasOrder) return null;

  const heights: HomePrefs = {};
  if (hasHeights) {
    for (const key of HOME_BOX_KEYS) {
      const v = clampBox((heightsRaw as Record<string, unknown>)[key]);
      if (v !== null) heights[key] = v;
    }
  }

  let order: HomeBoxKey[] | null = null;
  if (hasOrder) {
    const seen = new Set<string>();
    const o: HomeBoxKey[] = [];
    for (const k of orderRaw as unknown[]) {
      if (typeof k === 'string' && (HOME_BOX_KEYS as readonly string[]).includes(k) && !seen.has(k)) {
        seen.add(k);
        o.push(k as HomeBoxKey);
      }
    }
    for (const k of HOME_BOX_KEYS) if (!seen.has(k)) o.push(k);
    order = o;
  }

  return { heights, order };
}

// Lê as prefs salvas; estado vazio (defaults) se nada salvo/ilegível.
export async function getHomePrefs(env: Env): Promise<HomePrefsState> {
  const empty: HomePrefsState = { heights: {}, order: null };
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(HOME_PREFS_META_KEY).first<{ value: string }>();
  if (!row?.value) return empty;
  try { return sanitizeHomePrefs(JSON.parse(row.value)) ?? empty; } catch { return empty; }
}

// POST /app/home/prefs — salva o layout como padrão do dono. Body:
// { heights: { today?: px, ... }, order: ['inbox','today',...] }.
// Altura omitida = default; order omitido/igual ao default = ordem padrão.
export async function handleHomePrefsPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  let body: unknown;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const state = sanitizeHomePrefs(body);
  if (state === null) {
    return new Response(JSON.stringify({ error: 'invalid prefs' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(HOME_PREFS_META_KEY, JSON.stringify(state)).run();
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
}
