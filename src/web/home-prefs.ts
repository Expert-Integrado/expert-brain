import type { Env } from '../env.js';
import { requireSession } from './session.js';

// Preferências das caixas da home (Onda 9/9b, specs/60-ux-reforma/71 e 72): altura
// E ORDEM das caixas salvas POR DONO na tabela meta — mesmo padrão do graph-prefs
// (sincroniza entre máquinas sem binding novo). Caixa sem valor salvo usa o default.
// A edição é por manipulação direta (arrastar pra reordenar, puxar a borda pra
// redimensionar — feedback do dono: "igual ao ClickUp"), sem modal.
export const HOME_PREFS_META_KEY = 'home_prefs';

// Chaves canônicas das caixas ajustáveis. Se a home ganhar caixa nova, entra aqui
// e no SSR dos handles no MESMO commit. A ordem AQUI é a ordem default do grid —
// 'pending' (Pendências com você, rodada 6) nasce PRIMEIRO: é o que espera o dono.
export const HOME_BOX_KEYS = ['pending', 'today', 'inbox', 'digest', 'insights', 'activity'] as const;
export type HomeBoxKey = (typeof HOME_BOX_KEYS)[number];

// Limites do resize (px). O mínimo mantém título+captura visíveis; o máximo evita
// caixa maior que a viewport comum. O client recebe estes números via data-attrs
// do SSR — número único dos dois lados.
export const HOME_BOX_MIN = 220;
export const HOME_BOX_MAX = 960;

// Defaults quando não há pref salva.
// MANTER EM SINCRONIA com os fallbacks var(--home-card-h, ...) no HOME_CSS.
export const HOME_BOX_DEFAULTS: Record<HomeBoxKey, number> = {
  // 320: fila curta por natureza (5 visíveis + "Ver mais") — não precisa da
  // altura dos cards de conteúdo.
  pending: 320,
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
  // Pendências (rodada 6): linha inteira por default — os itens têm título +
  // meta + ações inline, espremidos numa track ficam ilegíveis.
  pending: true,
  today: false,
  inbox: false,
  digest: false,
  insights: true,
  activity: true,
};

// Estado completo persistido: alturas + larguras + ordem das caixas (null =
// ordem default) + caixas OCULTAS (rodada 6 — ocultar em vez de remover, padrão
// Home Assistant) + dismiss do card "Comece aqui" (spec 91/92 — o card de ativação
// some manual mesmo com passos pendentes; concluir os 4 passos também o esconde).
export interface HomePrefsState {
  heights: HomePrefs;
  sizes: HomeSizes;
  order: HomeBoxKey[] | null;
  // Opcional por retrocompat (blob antigo não tem o campo); sanitize normaliza
  // ausente pra [] — consumidores podem ler `hidden ?? []`.
  hidden?: HomeBoxKey[];
  // Larguras em quartos (rodada 6.2). Opcional por retrocompat; chave ausente
  // cai no legado `sizes` e depois no default (resolveSpans).
  spans?: HomeSpans;
  startDismissed: boolean;
}

// A caixa está expandida? (pref salva vence; ausente = default da caixa)
export const isBoxWide = (box: HomeBoxKey, sizes: HomeSizes): boolean =>
  (sizes[box] ?? (HOME_BOX_WIDE_DEFAULTS[box] ? 'wide' : 'normal')) === 'wide';

// ── Larguras em QUARTOS (rodada 6.2, pedido do dono: "pensa que a tela tá
// sempre dividida em quartos") ───────────────────────────────────────────────
// Todo card ocupa 1..4 quartos da linha; o grid da home tem 4 colunas fixas.
// Substitui o par normal|wide na PRÁTICA — `sizes` continua aceito no schema
// por retrocompat de blob antigo (wide=4, normal=2 na leitura via resolveSpans).
export type HomeBoxSpan = 1 | 2 | 3 | 4;
export type HomeSpans = Partial<Record<HomeBoxKey, HomeBoxSpan>>;

// Defaults de largura em quartos. Atividade ocupa a linha inteira por CSS e
// fica fora dos controles (como sempre).
export const HOME_BOX_SPAN_DEFAULTS: Record<HomeBoxKey, HomeBoxSpan> = {
  pending: 4,
  today: 2,
  inbox: 2,
  digest: 2,
  insights: 4,
  activity: 4,
};

// Largura EFETIVA por caixa: span salvo vence; sem span, blob antigo com
// sizes ainda vale (wide=4, normal=2); sem nada, default da caixa.
export type HomeResolvedSpans = Record<HomeBoxKey, HomeBoxSpan>;
export function resolveSpans(state: { spans?: HomeSpans; sizes: HomeSizes }): HomeResolvedSpans {
  const out = {} as HomeResolvedSpans;
  for (const box of HOME_BOX_KEYS) {
    const legacy = state.sizes[box];
    out[box] = state.spans?.[box]
      ?? (legacy === 'wide' ? 4 : legacy === 'normal' ? 2 : HOME_BOX_SPAN_DEFAULTS[box]);
  }
  return out;
}

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

// Classe de largura do card (rodada 6.2): sempre um home-span-N; span 4 também
// carrega o alias home-card-wide (CSS/testes legados leem por ele).
export const homeSpanClass = (box: HomeBoxKey, spans: HomeResolvedSpans): string =>
  ` home-span-${spans[box]}${spans[box] === 4 ? ' home-card-wide' : ''}`;

// Classe do card OCULTO (rodada 6): display:none no view mode; visível
// esmaecido no edit mode (CSS da home decide — aqui só a marca no SSR).
export const homeHiddenClass = (box: HomeBoxKey, hidden: HomeBoxKey[] | undefined): string =>
  hidden?.includes(box) ? ' home-card-hidden' : '';

// Controles do MODO DE EDIÇÃO por card (rodada 6): subir/descer (reorder por
// teclado — cobre também touch, onde não há drag confiável) + ocultar (olho,
// padrão Home Assistant Visibility). SSR sempre; o CSS da home só os exibe sob
// .home-grid.home-editing. O client (home.bundle.js) faz o wiring.
export function homeEditControlsHtml(box: HomeBoxKey, hidden: HomeBoxKey[] | undefined): string {
  const isHidden = hidden?.includes(box) ?? false;
  const hideLabel = isHidden ? 'Mostrar card' : 'Ocultar card';
  return `<span class="home-edit-controls" data-home-controls="${box}">
    <button type="button" class="home-move-btn" data-home-move="up" aria-label="Mover card pra cima" title="Mover pra cima">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
    </button>
    <button type="button" class="home-move-btn" data-home-move="down" aria-label="Mover card pra baixo" title="Mover pra baixo">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <button type="button" class="home-hide-toggle" data-home-hide aria-label="${hideLabel}" title="${hideLabel}">
      <svg class="home-eye-open" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
      <svg class="home-eye-closed" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
    </button>
  </span>`;
}

// Alça de redimensionamento de ALTURA (borda de baixo). aria-hidden: interação
// de ponteiro; o teclado tem o fallback natural (o conteúdo rola de qualquer jeito).
export const HOME_RESIZE_HANDLE = '<div class="home-resize" aria-hidden="true"></div>';

// Controles de LARGURA no header do card (rodada 6.2): dois botões ‹ › que
// diminuem/aumentam a largura em quartos (1..4). A MESMA alça do canto também
// muda a largura arrastando na horizontal (snap por quarto, no client).
// data-home-span-default informa o client o default da caixa (só diferença do
// default é persistida, mesma semântica das alturas).
export function homeWidthControlsHtml(box: HomeBoxKey): string {
  return `<span class="home-width-controls" data-home-span-default="${HOME_BOX_SPAN_DEFAULTS[box]}">
    <button type="button" class="home-width-btn" data-home-width="minus" aria-label="Diminuir largura (um quarto a menos)" title="Diminuir largura">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <button type="button" class="home-width-btn" data-home-width="plus" aria-label="Aumentar largura (um quarto a mais)" title="Aumentar largura">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
  </span>`;
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
  const spansRaw = (raw as Record<string, unknown>).spans;
  const orderRaw = (raw as Record<string, unknown>).order;
  const hiddenRaw = (raw as Record<string, unknown>).hidden;
  const startDismissed = (raw as Record<string, unknown>).startDismissed === true;
  const hasHeights = !!heightsRaw && typeof heightsRaw === 'object';
  const hasSizes = !!sizesRaw && typeof sizesRaw === 'object';
  const hasSpans = !!spansRaw && typeof spansRaw === 'object';
  const hasOrder = Array.isArray(orderRaw);
  const hasHidden = Array.isArray(hiddenRaw);
  if (!hasHeights && !hasSizes && !hasSpans && !hasOrder && !hasHidden && !startDismissed) return null;

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

  // Larguras em quartos (rodada 6.2): inteiro 1..4 em chave conhecida.
  const spans: HomeSpans = {};
  if (hasSpans) {
    for (const key of HOME_BOX_KEYS) {
      const v = (spansRaw as Record<string, unknown>)[key];
      if (v === 1 || v === 2 || v === 3 || v === 4) spans[key] = v;
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
    // Chave faltante entra na POSIÇÃO do default, não no fim: blob salvo antes
    // de uma caixa nova existir (ou salvo com o card pending omitido por fila
    // vazia) não pode enterrar a caixa no rodapé — 'pending' é a primeira do
    // default justamente porque é o que espera o dono (revisão rodada 6).
    for (const k of HOME_BOX_KEYS) {
      if (seen.has(k)) continue;
      const defaultIdx = HOME_BOX_KEYS.indexOf(k);
      // Insere antes da primeira chave presente que vem DEPOIS dela no default.
      let at = o.length;
      for (let i = 0; i < o.length; i++) {
        if (HOME_BOX_KEYS.indexOf(o[i]) > defaultIdx) { at = i; break; }
      }
      o.splice(at, 0, k);
      seen.add(k);
    }
    order = o;
  }

  // Ocultas (rodada 6): só chaves conhecidas, sem duplicata. Ausente = []
  // (retrocompat — blob antigo carrega intacto; a preservação do salvo quando o
  // POST não traz o campo é papel do handleHomePrefsPost, como sizes).
  const hidden: HomeBoxKey[] = [];
  if (hasHidden) {
    const seenH = new Set<string>();
    for (const k of hiddenRaw as unknown[]) {
      if (typeof k === 'string' && (HOME_BOX_KEYS as readonly string[]).includes(k) && !seenH.has(k)) {
        seenH.add(k);
        hidden.push(k as HomeBoxKey);
      }
    }
  }

  return { heights, sizes, spans, order, hidden, startDismissed };
}

// Lê as prefs salvas; estado vazio (defaults) se nada salvo/ilegível.
export async function getHomePrefs(env: Env): Promise<HomePrefsState> {
  const empty: HomePrefsState = { heights: {}, sizes: {}, spans: {}, order: null, hidden: [], startDismissed: false };
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(HOME_PREFS_META_KEY).first<{ value: string }>();
  if (!row?.value) return empty;
  try { return sanitizeHomePrefs(JSON.parse(row.value)) ?? empty; } catch { return empty; }
}

// POST /app/home/prefs — salva o layout como padrão do dono. Body:
// { heights: { today?: px, ... }, sizes: { today?: 'wide'|'normal', ... },
//   order: ['inbox','today',...], hidden: ['digest', ...] }
// OU { reset: true } — apaga o layout salvo inteiro (volta tudo pro default)
// PRESERVANDO o startDismissed (restaurar o layout não ressuscita o "Comece
// aqui" dispensado — rodada 6, botão "Restaurar padrão" do modo de edição).
// Altura/largura omitida = default; order omitido/igual ao default = ordem padrão.
export async function handleHomePrefsPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  let body: unknown;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const b = body as Record<string, unknown>;
  if (b && typeof b === 'object' && b.reset === true) {
    const saved = await getHomePrefs(env);
    const cleared: HomePrefsState = { heights: {}, sizes: {}, spans: {}, order: null, hidden: [], startDismissed: saved.startDismissed };
    await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(HOME_PREFS_META_KEY, JSON.stringify(cleared)).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }
  const state = sanitizeHomePrefs(body);
  if (state === null) {
    return new Response(JSON.stringify({ error: 'invalid prefs' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  // O client de layout só manda heights/sizes/order/hidden — preserva o dismiss
  // do "Comece aqui" já salvo (spec 92), senão arrastar uma caixa ressuscitava o
  // card. Mesmo racional pro `sizes`/`hidden` ausentes (cliente antigo/cacheado
  // não pode zerar o que não conhece).
  if (b.startDismissed === undefined || b.sizes === undefined || b.hidden === undefined || b.spans === undefined) {
    const saved = await getHomePrefs(env);
    if (b.startDismissed === undefined) state.startDismissed = saved.startDismissed;
    if (b.sizes === undefined) state.sizes = saved.sizes;
    if (b.hidden === undefined) state.hidden = saved.hidden ?? [];
    if (b.spans === undefined) state.spans = saved.spans ?? {};
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
