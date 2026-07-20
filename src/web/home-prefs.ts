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
export const HOME_BOX_KEYS = ['today', 'inbox', 'digest', 'insights', 'activity'] as const;
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
  // 680: o dashboard COMPLETO mora neste card desde a fusão do /app/insights
  // (19/07) — os 420px do card-resumo antigo espremiam tudo em scroll interno.
  insights: 680,
  activity: 560,
};

// Alturas por caixa (chave ausente = default do CSS).
export type HomePrefs = Partial<Record<HomeBoxKey, number>>;

// Largura por caixa (revisão 19/07): 'normal' = 1 coluna do grid; 'wide' = linha
// inteira (grid-column: 1 / -1). Chave AUSENTE = default da caixa — pref antiga
// sem o campo `sizes` rende todos os defaults (retrocompatível por construção).
export type HomeBoxSize = 'normal' | 'wide';
export type HomeSizes = Partial<Record<HomeBoxKey, HomeBoxSize>>;

// Defaults de largura. O card de Estatísticas nasce expandido (o dashboard mensal
// completo mora nele desde a fusão do /app/insights na home — revisão 19/07); a
// Atividade sempre ocupa a linha inteira por CSS e fica FORA do toggle.
export const HOME_BOX_WIDE_DEFAULTS: Record<HomeBoxKey, boolean> = {
  today: false,
  inbox: false,
  digest: false,
  insights: true,
  activity: true,
};

// Estado completo persistido: alturas + larguras + ordem das caixas (null =
// ordem default) + dismiss do card "Comece aqui" (spec 91/92 — o card de ativação
// some manual mesmo com passos pendentes; concluir os 4 passos também o esconde).
export interface HomePrefsState {
  heights: HomePrefs;
  sizes: HomeSizes;
  order: HomeBoxKey[] | null;
  startDismissed: boolean;
}

// A caixa está expandida? (pref salva vence; ausente = default da caixa)
export const isBoxWide = (box: HomeBoxKey, sizes: HomeSizes): boolean =>
  (sizes[box] ?? (HOME_BOX_WIDE_DEFAULTS[box] ? 'wide' : 'normal')) === 'wide';

// ── Helpers de SSR das caixas (compartilhados entre home.ts e insights.ts — o
// card de Estatísticas é renderizado em insights.ts e importar de home.ts
// criaria ciclo; este módulo é folha, os dois importam daqui). ──────────────

// Atributos do ALVO DE ALTURA (o elemento que recebe --home-card-h): identidade
// da caixa + default + limites (o client lê daqui — número único dos dois lados)
// + style inline quando há altura salva (ausente = fallback do var() no CSS).
export function homeBoxAttrs(box: HomeBoxKey, heights: HomePrefs): string {
  const h = heights[box];
  return ` data-home-box="${box}" data-home-default="${HOME_BOX_DEFAULTS[box]}" data-home-min="${HOME_BOX_MIN}" data-home-max="${HOME_BOX_MAX}"${h ? ` style="--home-card-h:${h}px"` : ''}`;
}

// Atributo do ITEM REORDENÁVEL (filho direto da .home-grid).
export const homeItemAttr = (box: HomeBoxKey): string => ` data-home-item="${box}"`;

// Classe extra do card expandido (linha inteira). Vazia quando normal.
export const homeWideClass = (box: HomeBoxKey, sizes: HomeSizes): string =>
  isBoxWide(box, sizes) ? ' home-card-wide' : '';

// Alça de redimensionamento de ALTURA (borda de baixo). aria-hidden: interação
// de ponteiro; o teclado tem o fallback natural (o conteúdo rola de qualquer jeito).
export const HOME_RESIZE_HANDLE = '<div class="home-resize" aria-hidden="true"></div>';

// Botão de LARGURA no header do card (revisão 19/07): alterna normal ↔ linha
// inteira. Os DOIS ícones vão no markup e o CSS mostra um por estado (a classe
// .home-card-wide do card decide) — o client só troca classe + aria-label/title.
// data-home-wide-default informa o client qual estado é o default da caixa
// (só diferença do default é persistida, mesma semântica das alturas).
export function homeSizeToggleHtml(box: HomeBoxKey, sizes: HomeSizes): string {
  const label = isBoxWide(box, sizes) ? 'Reduzir card' : 'Expandir card';
  return `<button type="button" class="home-size-toggle" data-home-wide-default="${HOME_BOX_WIDE_DEFAULTS[box] ? '1' : '0'}" aria-label="${label}" title="${label}">
    <svg class="home-size-icon-expand" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
    <svg class="home-size-icon-reduce" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
  </button>`;
}

const clampBox = (v: unknown): number | null => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN;
  if (Number.isNaN(n)) return null;
  return Math.min(HOME_BOX_MAX, Math.max(HOME_BOX_MIN, n));
};

// Sanitiza o POST do cliente (ou o blob salvo no meta) pro shape canônico:
// { heights: {...}, sizes: {...}, order: [...] }. Altura/largura inválida é
// DROPADA (cai no default); ordem só aceita chaves conhecidas, sem duplicata, e
// chaves faltantes são COMPLETADAS na ordem default (uma pref antiga nunca
// esconde caixa nova). null só quando o body não traz NADA utilizável (→ 400).
export function sanitizeHomePrefs(raw: unknown): HomePrefsState | null {
  if (!raw || typeof raw !== 'object') return null;
  const heightsRaw = (raw as Record<string, unknown>).heights;
  const sizesRaw = (raw as Record<string, unknown>).sizes;
  const orderRaw = (raw as Record<string, unknown>).order;
  const startDismissed = (raw as Record<string, unknown>).startDismissed === true;
  const hasHeights = !!heightsRaw && typeof heightsRaw === 'object';
  const hasSizes = !!sizesRaw && typeof sizesRaw === 'object';
  const hasOrder = Array.isArray(orderRaw);
  if (!hasHeights && !hasSizes && !hasOrder && !startDismissed) return null;

  const heights: HomePrefs = {};
  if (hasHeights) {
    for (const key of HOME_BOX_KEYS) {
      const v = clampBox((heightsRaw as Record<string, unknown>)[key]);
      if (v !== null) heights[key] = v;
    }
  }

  // Larguras: só 'wide'/'normal' em chave conhecida — o resto é dropado (default).
  const sizes: HomeSizes = {};
  if (hasSizes) {
    for (const key of HOME_BOX_KEYS) {
      const v = (sizesRaw as Record<string, unknown>)[key];
      if (v === 'wide' || v === 'normal') sizes[key] = v;
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

  return { heights, sizes, order, startDismissed };
}

// Lê as prefs salvas; estado vazio (defaults) se nada salvo/ilegível.
export async function getHomePrefs(env: Env): Promise<HomePrefsState> {
  const empty: HomePrefsState = { heights: {}, sizes: {}, order: null, startDismissed: false };
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(HOME_PREFS_META_KEY).first<{ value: string }>();
  if (!row?.value) return empty;
  try { return sanitizeHomePrefs(JSON.parse(row.value)) ?? empty; } catch { return empty; }
}

// POST /app/home/prefs — salva o layout como padrão do dono. Body:
// { heights: { today?: px, ... }, sizes: { today?: 'wide'|'normal', ... },
//   order: ['inbox','today',...] }.
// Altura/largura omitida = default; order omitido/igual ao default = ordem padrão.
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
  // O client de layout só manda heights/sizes/order — preserva o dismiss do
  // "Comece aqui" já salvo (spec 92), senão arrastar uma caixa ressuscitava o
  // card. Mesmo racional pro `sizes` ausente (cliente antigo/cacheado não pode
  // zerar as larguras salvas ao arrastar).
  const b = body as Record<string, unknown>;
  if (b.startDismissed === undefined || b.sizes === undefined) {
    const saved = await getHomePrefs(env);
    if (b.startDismissed === undefined) state.startDismissed = saved.startDismissed;
    if (b.sizes === undefined) state.sizes = saved.sizes;
  }
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(HOME_PREFS_META_KEY, JSON.stringify(state)).run();
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
}

// POST /app/home/start-dismiss — form nativo (CSP-safe) do card "Comece aqui"
// (spec 91/92): marca o dismiss no MESMO blob do layout e volta pra home.
export async function handleStartDismissPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const state = await getHomePrefs(env);
  state.startDismissed = true;
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(HOME_PREFS_META_KEY, JSON.stringify(state)).run();
  return new Response(null, { status: 302, headers: { location: '/app' } });
}
