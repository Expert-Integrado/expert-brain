import type { Env } from '../env.js';
import { requireSession } from './session.js';

// Preferências das caixas da home (Onda 9, specs/60-ux-reforma/71): altura de cada
// caixa salva POR DONO na tabela meta — mesmo padrão do graph-prefs (sincroniza
// entre máquinas sem binding novo). Caixa sem valor salvo usa o default do CSS.
export const HOME_PREFS_META_KEY = 'home_prefs';

// Chaves canônicas das caixas ajustáveis. Se a home ganhar caixa nova, entra aqui
// e no modal de ajuste no MESMO commit.
export const HOME_BOX_KEYS = ['today', 'inbox', 'digest', 'activity'] as const;
export type HomeBoxKey = (typeof HOME_BOX_KEYS)[number];

// Limites do slider (px). O mínimo mantém título+captura visíveis; o máximo evita
// caixa maior que a viewport comum. MANTER EM SINCRONIA com min/max dos ranges
// SSR em home.ts — é o mesmo número dos dois lados.
export const HOME_BOX_MIN = 220;
export const HOME_BOX_MAX = 960;

// Defaults quando não há pref salva — também são o valor inicial dos sliders.
// MANTER EM SINCRONIA com os fallbacks var(--home-card-h, ...) no HOME_CSS.
export const HOME_BOX_DEFAULTS: Record<HomeBoxKey, number> = {
  today: 420,
  inbox: 420,
  digest: 420,
  activity: 560,
};

export type HomePrefs = Partial<Record<HomeBoxKey, number>>;

const clampBox = (v: unknown): number | null => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN;
  if (Number.isNaN(n)) return null;
  return Math.min(HOME_BOX_MAX, Math.max(HOME_BOX_MIN, n));
};

// Sanitiza o POST do cliente (ou o blob salvo no meta) pro shape canônico: só as
// chaves conhecidas, cada altura clampada; valor inválido é DROPADO (cai no
// default), nunca 400 — o pior caso é a caixa voltar pro tamanho padrão.
export function sanitizeHomePrefs(raw: unknown): HomePrefs | null {
  if (!raw || typeof raw !== 'object') return null;
  const heights = (raw as Record<string, unknown>).heights;
  if (!heights || typeof heights !== 'object') return null;
  const out: HomePrefs = {};
  for (const key of HOME_BOX_KEYS) {
    const v = clampBox((heights as Record<string, unknown>)[key]);
    if (v !== null) out[key] = v;
  }
  return out;
}

// Lê as prefs salvas; {} se nada salvo (todas as caixas no default).
export async function getHomePrefs(env: Env): Promise<HomePrefs> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(HOME_PREFS_META_KEY).first<{ value: string }>();
  if (!row?.value) return {};
  try { return sanitizeHomePrefs(JSON.parse(row.value)) ?? {}; } catch { return {}; }
}

// POST /app/home/prefs — salva as alturas como padrão do dono. Body:
// { heights: { today?: px, inbox?: px, digest?: px, activity?: px } }.
// Chave OMITIDA = usa o default (é assim que o "Restaurar padrão" limpa tudo).
export async function handleHomePrefsPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  let body: unknown;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const prefs = sanitizeHomePrefs(body);
  if (prefs === null) {
    return new Response(JSON.stringify({ error: 'invalid prefs' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(HOME_PREFS_META_KEY, JSON.stringify({ heights: prefs })).run();
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
}
