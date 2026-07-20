import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { assetVersion } from './asset-version.js';
import { listTasksDueBefore, listInboxItems, countPendingInbox, INBOX_BODY_MAX, type TaskRow, type InboxItem } from '../db/queries.js';
import { OWNER_TASK_VIS } from '../auth/visibility.js';
import { readCachedResurfaceDigest, isDigestEmpty } from '../digest/resurface.js';
import { renderDigestCard } from './notes.js';
import { relativeDue } from '../util/time.js';
import { JOURNAL_CSS } from './journal.js';
import { getHomePrefs, HOME_BOX_KEYS, homeBoxAttrs, homeItemAttr, homeWideClass, homeHiddenClass, homeSizeToggleHtml, homeEditControlsHtml, HOME_RESIZE_HANDLE, type HomeBoxKey, type HomePrefs, type HomeSizes, type HomePrefsState } from './home-prefs.js';
import { renderInsightsCard } from './insights.js';
import { brtYearMonth, getMonthInsightsCached } from '../db/insights-queries.js';
import { fleetHomeStripHtml } from './fleet.js';
import { buildPendingItems, pendingKindsLabel, PENDING_CSS } from './pending.js';
import { pendingBlockHtml, type PendingItem } from '../util/task-badges.js';

// Home "Hoje" (specs/50-console-v2/65-home-hoje-e-journal.md §2): cards SSR, cada
// um TOLERANTE a falha isolada — uma query que falha vira um card de ERRO visível
// (try/catch por card, Onda 5), nunca derruba a página inteira. Abaixo dos cards, o
// feed "Atividade" (o antigo /app/journal, absorvido na home — spec 69) carrega
// ASSÍNCRONO no client (journal.bundle.js busca /app/journal em JSON): uma das
// fontes do feed é o proxy pro Worker do Contacts e ela NÃO pode travar o SSR da
// home no request path (Riscos da spec 65: "home lenta por depender do proxy").

// Horizonte "Hoje" = 24h à frente + tudo já vencido — MESMA convenção do lembrete
// diário (src/notify.ts) e do filtro "hoje" do board de tasks (src/web/tasks.ts),
// não um corte de calendário BRT à parte.
const TODAY_HORIZON_MS = 24 * 60 * 60 * 1000;
// O card Inbox é a superfície PRINCIPAL do inbox (Onda 8, spec 70): mostra até 20
// itens (uma linha cada, com triagem inline) dentro da caixa rolável; acima disso o
// "ver tudo" leva pra /app/inbox (triagem completa, com markdown).
const INBOX_PREVIEW = 20;
const INBOX_SCAN_LIMIT = 200;

const HOME_CSS = `
.home-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 18px; align-items: start; }
/* min-width:auto (default de item de grid) deixa o conteúdo min-content INFLAR as
   tracks — a Atividade (span total, chips nowrap no feed) estourava a página na
   horizontal. Todo filho da grid pode encolher abaixo do conteúdo. */
.home-grid > * { min-width: 0; }
/* Caixas de tamanho previsível (Onda 8): altura capada + scroll interno SÓ no
   conteúdo (o título e o form de captura ficam fixos) — 26 tasks atrasadas não
   esticam mais a home inteira. Conteúdo curto NÃO estica a caixa (max-height).
   Onda 9b (spec 72): a altura é a custom property --home-card-h, ajustável
   puxando a borda de baixo (persistida em home_prefs) — o fallback aqui é
   o default e DEVE bater com HOME_BOX_DEFAULTS (home-prefs.ts). */
.home-card { max-height: var(--home-card-h, 420px); display: flex; flex-direction: column; overflow: hidden; }
.home-card > :last-child { overflow-y: auto; min-height: 0; scrollbar-width: thin; }
/* fonte/peso herdam do .card h2 (Onda 3) — aqui só o layout flex: link e botão de
   largura encostam à direita (margin-left:auto no primeiro deles; com os dois,
   o botão segue o link só com o gap). */
.home-card h2 { display: flex; align-items: center; justify-content: flex-start; gap: 10px; margin: 0 0 14px; flex: none; }
.home-card h2 a { margin-left: auto; font-size: 12px; font-weight: 500; color: var(--accent-lav); text-decoration: none; white-space: nowrap; }
.home-card h2 a:hover { text-decoration: underline; }
/* ── Largura do card (revisão 19/07): normal = 1 track do grid; expandido =
   linha inteira. O toggle mora no header; em mobile (1 coluna) ele some. ── */
.home-grid > .home-card-wide { grid-column: 1 / -1; }
.home-size-toggle {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  margin-left: auto; padding: 4px; background: none; border: none; border-radius: 6px;
  color: var(--text-subtle); cursor: pointer;
  transition: color 140ms var(--ease), background 140ms var(--ease);
}
.home-card h2 a ~ .home-size-toggle { margin-left: 0; }
.home-size-toggle:hover { color: var(--accent-lav); background: rgba(var(--accent-lav-rgb), 0.1); }
/* Um ícone por estado — a classe do card decide, o client só troca a classe. */
.home-card-wide .home-size-icon-expand { display: none; }
.home-card:not(.home-card-wide) .home-size-icon-reduce { display: none; }
@media (max-width: 767px) { .home-size-toggle { display: none; } }
/* Captura rápida do inbox DENTRO do card (Onda 8): o inbox saiu do menu — cria por aqui */
.home-inbox-capture { display: flex; gap: 8px; margin: 0 0 12px; flex: none; }
.home-inbox-capture input[type="text"] {
  flex: 1; min-width: 0; background: var(--bg-accent); border: 1px solid var(--border);
  color: var(--text); border-radius: var(--radius-sm); padding: 7px 10px;
  font-size: 13px; font-family: inherit; transition: border-color 160ms var(--ease);
}
.home-inbox-capture input[type="text"]::placeholder { color: var(--text-subtle); }
.home-inbox-capture input[type="text"]:focus { outline: none; border-color: var(--accent-lav); }
.home-inbox-item { display: flex; align-items: center; gap: 8px; }
.home-inbox-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.home-inbox-actions { display: flex; gap: 4px; flex: none; }
.home-inbox-actions form { margin: 0; display: inline-flex; }
.home-inbox-btn {
  background: none; border: 1px solid var(--border); color: var(--text-dim);
  border-radius: 6px; padding: 2px 8px; font-size: 11px; font-family: inherit; cursor: pointer;
  transition: color 140ms var(--ease), border-color 140ms var(--ease);
}
.home-inbox-btn:hover { color: var(--text); border-color: var(--border-strong); }
.home-inbox-btn.danger:hover { color: var(--danger); border-color: var(--danger); }
.home-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.home-list li { display: flex; align-items: center; gap: 8px; font-size: 13.5px; line-height: 1.4; }
.home-list a { color: var(--text); text-decoration: none; }
.home-list a:hover { color: var(--accent-lav); }
.home-task-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.home-task-complete {
  flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--border-strong);
  background: transparent; cursor: pointer; color: var(--text-dim); font-size: 11px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
}
.home-task-complete:hover { border-color: var(--accent-lav); color: var(--accent-lav); }
.home-task-when { flex-shrink: 0; font-size: 11.5px; color: var(--text-subtle); margin-left: auto; }
.home-task-when.overdue { color: var(--danger); }
.home-empty { color: var(--text-dim); font-size: 13px; margin: 0; }
.home-error { color: var(--danger); }
.home-private-badge { font-size: 10px; color: var(--text-subtle); flex-shrink: 0; }
/* Feed "Atividade" (spec 69) — o antigo Journal. Onda 9b (spec 72): a seção virou
   FILHA da .home-grid (span total) pra entrar na reordenação junto com os cards.
   Onda 8: caixa FECHADA de altura fixa com scroll interno. */
.home-grid > .home-activity { grid-column: 1 / -1; }
.home-activity-title { font-family: var(--font-display); font-size: 18px; font-weight: 500; margin: 0 0 14px; }
.home-activity-box {
  max-height: var(--home-card-h, 560px); overflow-y: auto; scrollbar-width: thin;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 6px 18px 14px;
}
/* ── Manipulação direta das caixas (Onda 9b, spec 72 — "igual ao ClickUp") ──
   Arrastar pelo TÍTULO reordena (ghost segue o ponteiro; as demais caixas
   reorganizam ao vivo); puxar a BORDA DE BAIXO redimensiona. Persistência no
   soltar (POST /app/home/prefs). Sem modal. */
.home-box-handle { cursor: grab; touch-action: none; }
.home-box-handle a { cursor: pointer; }
html.home-arranging, html.home-arranging * { cursor: grabbing !important; user-select: none !important; }
.home-box-ghost {
  position: fixed; z-index: 400; pointer-events: none; margin: 0; opacity: .92;
  transform: scale(1.02); box-shadow: 0 18px 48px rgba(0, 0, 0, .5);
}
.home-box-dragging { opacity: .4; outline: 2px dashed var(--accent-lav); outline-offset: 2px; border-radius: var(--radius); }
.home-card { position: relative; }
.home-activity { position: relative; }
.home-resize {
  position: absolute; left: 12px; right: 12px; bottom: -2px; height: 14px; z-index: 2;
  cursor: ns-resize; touch-action: none; display: flex; align-items: center; justify-content: center;
}
.home-resize::after {
  content: ''; width: 44px; height: 4px; border-radius: 2px;
  background: var(--border-strong); opacity: 0; transition: opacity 140ms var(--ease);
}
.home-card:hover .home-resize::after, .home-activity:hover .home-resize::after,
.home-resize.active::after { opacity: .9; background: var(--accent-lav); }
/* Card "Comece aqui" (spec 92): checklist de ativação acima do grid. */
.start-here { margin-bottom: 18px; }
.start-here h2 { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 12px; }
.start-here h2 form { margin: 0; }
.start-dismiss {
  background: none; border: none; color: var(--text-subtle); font-size: 11.5px;
  font-family: inherit; cursor: pointer; padding: 2px 4px;
}
.start-dismiss:hover { color: var(--text-dim); }
.start-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; counter-reset: none; }
.start-step { display: flex; align-items: center; gap: 10px; font-size: 13.5px; line-height: 1.45; }
.start-check {
  flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%;
  border: 1px solid var(--border-strong); display: inline-flex; align-items: center;
  justify-content: center; font-size: 12px; color: var(--ok, #34d399);
}
.start-step-done .start-check { border-color: var(--ok, #34d399); }
.start-step-done .start-step-body { color: var(--text-subtle); text-decoration: line-through; }
.start-step-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.start-hint { font-size: 12px; color: var(--text-subtle); overflow-wrap: anywhere; }
.start-hint code { font-size: 11px; }
.start-step .btn { flex-shrink: 0; }
/* ── Modo de edição explícito (rodada 6, padrão Metabase/Grafana): a home em
   view mode é LIMPA — nenhuma alça visível. O SSR continua emitindo handle/
   resize/toggle/controles (testes travam o markup); só o CSS os revela sob
   .home-grid.home-editing (classe togglada pelo botão Personalizar). ── */
.home-grid:not(.home-editing) .home-resize,
.home-grid:not(.home-editing) .home-size-toggle,
.home-grid:not(.home-editing) .home-edit-controls { display: none; }
.home-grid:not(.home-editing) .home-box-handle { cursor: default; touch-action: auto; }
/* Borda tracejada nos cards em edição (afford "isto é editável"). */
.home-grid.home-editing > * { outline: 1px dashed color-mix(in srgb, var(--accent-lav) 55%, transparent); outline-offset: 3px; }
.home-grid.home-editing > .home-box-dragging { outline: 2px dashed var(--accent-lav); outline-offset: 2px; }
/* Controles por card no edit mode: subir/descer (teclado/touch) + ocultar (olho). */
.home-edit-controls { display: inline-flex; gap: 2px; align-items: center; flex: none; }
.home-activity-title { display: flex; align-items: center; gap: 10px; }
.home-activity-title .home-edit-controls { margin-left: auto; }
.home-move-btn, .home-hide-toggle {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 4px; background: none; border: none; border-radius: 6px;
  color: var(--text-subtle); cursor: pointer;
  transition: color 140ms var(--ease), background 140ms var(--ease);
}
.home-move-btn:hover, .home-hide-toggle:hover { color: var(--accent-lav); background: rgba(var(--accent-lav-rgb), 0.1); }
/* Olho aberto = card visível; fechado = oculto (a classe do card decide). */
.home-hide-toggle .home-eye-closed { display: none; }
.home-card-hidden .home-hide-toggle .home-eye-open { display: none; }
.home-card-hidden .home-hide-toggle .home-eye-closed { display: inline; }
/* Card OCULTO: some no view mode; no edit mode fica visível esmaecido
   (ocultar em vez de remover — padrão Home Assistant Visibility). */
.home-grid:not(.home-editing) > .home-card-hidden { display: none; }
.home-grid.home-editing > .home-card-hidden { opacity: .45; }
/* Botão "Personalizar" (lápis) no topo — aria-pressed marca o modo ativo. */
#home-edit-toggle { margin-left: auto; }
#home-edit-toggle[aria-pressed="true"] { color: var(--accent-lav); border-color: var(--accent-lav); }
/* Barra do modo de edição (rodapé do grid): Salvar/Cancelar; Restaurar padrão
   à direita. Só aparece em edição (irmã da grid — seletor ~). */
.home-edit-bar { display: none; }
.home-grid.home-editing ~ .home-edit-bar { display: flex; align-items: center; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
.home-edit-bar #home-edit-reset { margin-left: auto; }
.home-edit-hint { font-size: 12px; color: var(--text-subtle); }
/* ── Card "Pendências com você" (rodada 6): reusa o bloco do board
   (pendingBlockHtml + PENDING_CSS). Fallback de altura próprio (320) —
   MANTER EM SINCRONIA com HOME_BOX_DEFAULTS.pending. ── */
.home-card[data-home-box="pending"] { max-height: var(--home-card-h, 320px); }
.home-pending-count { font-size: 12px; font-weight: 500; color: var(--text-dim); white-space: nowrap; }
/* O h2 do card já é o cabeçalho — o head interno do bloco vira redundância. */
.home-pending-card .task-pending-head { display: none; }
.home-pending-card .task-pending { margin-bottom: 0; }
`;

// Helpers de SSR das caixas (boxAttrs/itemAttr/resizeHandle/size toggle) moram
// em home-prefs.ts desde a revisão 19/07 — compartilhados com o card de
// Estatísticas (insights.ts) sem criar ciclo de import. Nos cards, item e alvo
// de altura são o MESMO elemento; na Atividade o alvo é a caixa interna.
const boxAttrs = homeBoxAttrs;
const itemAttr = homeItemAttr;
const resizeHandle = HOME_RESIZE_HANDLE;

// ── Card "Comece aqui" (spec 91/92) ─────────────────────────────────────────
// Ativação SEM tabela nova: os 4 passos são DERIVADOS dos dados que já existem.
// agent = alguma chave de API já foi USADA (conectar sem usar não conta);
// note = alguma nota viva que não é task; install = assinatura de push como
// proxy de "instalou o PWA"; task = alguma task viva.
export interface ActivationState {
  agent: boolean;
  note: boolean;
  install: boolean;
  task: boolean;
}

export async function getActivationState(env: Env): Promise<ActivationState> {
  const row = await env.DB.prepare(
    `SELECT
      EXISTS(SELECT 1 FROM api_keys WHERE last_used_at IS NOT NULL) AS agent,
      EXISTS(SELECT 1 FROM notes WHERE kind != 'task' AND deleted_at IS NULL) AS note,
      EXISTS(SELECT 1 FROM push_subscriptions) AS install,
      EXISTS(SELECT 1 FROM notes WHERE kind = 'task' AND deleted_at IS NULL) AS task`
  ).first<{ agent: number; note: number; install: number; task: number }>();
  return {
    agent: row?.agent === 1,
    note: row?.note === 1,
    install: row?.install === 1,
    task: row?.task === 1,
  };
}

// Card do checklist de ativação. Some sozinho quando os 4 passos completam
// (retorna '') — o dismiss manual é decidido pelo caller (home-prefs).
// origin = origem da instância (o comando de conexão do agente é copiável).
export function renderStartHereCard(state: ActivationState, origin: string): string {
  if (state.agent && state.note && state.install && state.task) return '';
  const step = (done: boolean, title: string, ctaHtml: string, hint = '') =>
    `<li class="start-step${done ? ' start-step-done' : ''}">
      <span class="start-check" aria-hidden="true">${done ? '✓' : ''}</span>
      <span class="start-step-body"><strong>${title}</strong>${hint ? `<span class="start-hint">${hint}</span>` : ''}</span>
      ${done ? '' : ctaHtml}
    </li>`;
  return `<section class="card start-here" id="start-here">
    <h2>Comece aqui
      <form method="post" action="/app/home/start-dismiss"><button type="submit" class="start-dismiss" title="Dispensar este card" aria-label="Dispensar o card Comece aqui">dispensar ✕</button></form>
    </h2>
    <ol class="start-steps">
      ${step(state.agent, 'Conecte seu primeiro agente',
        `<a class="btn btn-sm" href="/app/config#api-keys">criar chave</a>`,
        `no seu Claude Code: <code>claude mcp add --transport http expert-brain ${esc(origin)}/mcp</code>`)}
      ${step(state.note, 'Capture sua primeira nota',
        `<button type="button" class="btn btn-sm" data-cmd-open>capturar</button>`,
        'pela busca (Ctrl+K), pelo card Inbox ou peça pro seu agente salvar')}
      ${step(state.install, 'Instale no celular',
        `<a class="btn btn-sm" href="/app/config#pwa-install">instalar</a>`,
        'PWA com compartilhamento direto pro inbox e lembrete diário')}
      ${step(state.task, 'Crie sua primeira task',
        `<a class="btn btn-sm" href="/app/tasks">abrir o board</a>`)}
    </ol>
  </section>`;
}

function taskWhenHtml(t: TaskRow, now: number): string {
  if (t.due_at === null) return '';
  const overdue = t.due_at < now;
  return `<span class="home-task-when${overdue ? ' overdue' : ''}">${esc(relativeDue(t.due_at, now))}</span>`;
}

// Card 1 — Hoje: tasks due hoje/atrasadas, com quick-complete (checkbox → mesmo
// endpoint do board, POST /app/tasks/complete) + link pro board completo.
// Exportado: testado isoladamente (sem D1/HTTP) em test/web/home.test.ts.
export function renderTodayCard(tasks: TaskRow[], now: number, prefs: HomePrefs = {}, sizes: HomeSizes = {}, hidden: HomeBoxKey[] = []): string {
  if (tasks.length === 0) {
    return `<section class="card home-card${homeWideClass('today', sizes)}${homeHiddenClass('today', hidden)}"${itemAttr('today')}${boxAttrs('today', prefs)}>${resizeHandle}
      <h2 class="home-box-handle">Hoje <a href="/app/tasks">board completo →</a>${homeSizeToggleHtml('today', sizes)}${homeEditControlsHtml('today', hidden)}</h2>
      <p class="home-empty">Nada vencendo nas próximas 24h.</p>
    </section>`;
  }
  const items = tasks
    .map((t) => {
      const priv = t.private === 1 ? '<span class="home-private-badge" title="Task privada">🔒</span>' : '';
      return `<li>
        <button type="button" class="home-task-complete" data-id="${esc(t.id)}" aria-label="Concluir ${esc(t.title)}" title="Concluir">✓</button>
        <a class="home-task-title" href="/app/tasks/${esc(t.id)}">${esc(t.title)}</a>${priv}
        ${taskWhenHtml(t, now)}
      </li>`;
    })
    .join('');
  return `<section class="card home-card${homeWideClass('today', sizes)}${homeHiddenClass('today', hidden)}"${itemAttr('today')}${boxAttrs('today', prefs)}>${resizeHandle}
    <h2 class="home-box-handle">Hoje <a href="/app/tasks">board completo →</a>${homeSizeToggleHtml('today', sizes)}${homeEditControlsHtml('today', hidden)}</h2>
    <ul class="home-list" id="home-today-list">${items}</ul>
  </section>`;
}

// Primeira linha do corpo cru do inbox, truncada — mesmo padrão de inbox.ts.
function firstLine(body: string, max: number): string {
  const line = body.split('\n')[0]?.trim() || body.trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// Card 2 — Inbox (Onda 8, spec 70): o inbox saiu do menu — este card é a superfície
// principal: captura rápida (form nativo, CSP-safe) + até 20 pendentes com triagem
// inline (nota / tarefa / descartar, mesmos endpoints do /app/inbox). O "ver tudo"
// leva pra página completa (corpo em markdown, itens além do cap).
// Exportado: testado isoladamente em test/web/home.test.ts.
export function renderInboxCard(pending: number, items: InboxItem[], prefs: HomePrefs = {}, sizes: HomeSizes = {}, hidden: HomeBoxKey[] = []): string {
  const capture = `<form class="home-inbox-capture" method="post" action="/app/inbox/add">
      <input type="text" name="text" maxlength="${INBOX_BODY_MAX}" placeholder="Capturar ideia solta — tria depois" aria-label="Captura rápida pro inbox" autocomplete="off" required />
      <input type="hidden" name="next" value="/app" />
      <button type="submit" class="btn btn-sm">Capturar</button>
    </form>`;
  if (pending === 0) {
    return `<section class="card home-card${homeWideClass('inbox', sizes)}${homeHiddenClass('inbox', hidden)}"${itemAttr('inbox')}${boxAttrs('inbox', prefs)}>${resizeHandle}
      <h2 class="home-box-handle">Inbox <a href="/app/inbox">ver tudo →</a>${homeSizeToggleHtml('inbox', sizes)}${homeEditControlsHtml('inbox', hidden)}</h2>
      ${capture}
      <p class="home-empty">Inbox vazio.</p>
    </section>`;
  }
  // listInboxItems ordena created_at ASC (mais antigo primeiro, ordem de triagem) —
  // os mais recentes pra home são o FIM dessa lista, invertido.
  const preview = items.slice(-INBOX_PREVIEW).reverse();
  const rows = preview
    .map((it) => `<li class="home-inbox-item">
      <a class="home-inbox-text" href="/app/inbox" title="Abrir no inbox">${esc(firstLine(it.body, 140))}</a>
      <span class="home-inbox-actions">
        <form method="post" action="/app/inbox/to-note"><input type="hidden" name="id" value="${esc(it.id)}" /><button type="submit" class="home-inbox-btn" title="Virar nota">nota</button></form>
        <form method="post" action="/app/inbox/to-task"><input type="hidden" name="id" value="${esc(it.id)}" /><button type="submit" class="home-inbox-btn" title="Virar tarefa">tarefa</button></form>
        <form method="post" action="/app/inbox/resolve"><input type="hidden" name="id" value="${esc(it.id)}" /><input type="hidden" name="action" value="discard" /><input type="hidden" name="next" value="/app" /><button type="submit" class="home-inbox-btn danger" title="Descartar" aria-label="Descartar">✕</button></form>
      </span>
    </li>`)
    .join('');
  return `<section class="card home-card${homeWideClass('inbox', sizes)}${homeHiddenClass('inbox', hidden)}"${itemAttr('inbox')}${boxAttrs('inbox', prefs)}>${resizeHandle}
    <h2 class="home-box-handle">Inbox <a href="/app/inbox">${pending} pendente${pending === 1 ? '' : 's'} →</a>${homeSizeToggleHtml('inbox', sizes)}${homeEditControlsHtml('inbox', hidden)}</h2>
    ${capture}
    <ul class="home-list home-inbox-list">${rows}</ul>
  </section>`;
}

// Feed "Atividade" (spec 69): o antigo /app/journal absorvido na home. SSR só do
// esqueleto (filtros + placeholder); journal.bundle.js busca a primeira página em
// JSON (data-lazy="1") e injeta — o proxy do Contacts fica FORA do request path.
// O card "Últimas interações" foi absorvido junto: o feed já traz as interações
// (chip laranja + filtro próprio), então o card seria informação duplicada.
function renderActivityFeedSection(prefs: HomePrefs = {}, hidden: HomeBoxKey[] = []): string {
  return `<section class="home-activity${homeHiddenClass('activity', hidden)}" id="atividade"${itemAttr('activity')}>${resizeHandle}
    <h2 class="home-activity-title home-box-handle">Atividade${homeEditControlsHtml('activity', hidden)}</h2>
    <div class="journal-filters">
      <label><input type="checkbox" class="journal-filter" value="note" checked /> Notas</label>
      <label><input type="checkbox" class="journal-filter" value="task" checked /> Tarefas</label>
      <label><input type="checkbox" class="journal-filter" value="contact" checked /> Interações</label>
    </div>
    <div class="home-activity-box"${boxAttrs('activity', prefs)}>
      <div id="journal-groups" data-lazy="1"><p class="home-empty">Carregando a atividade…</p></div>
    </div>
    <noscript><p class="home-empty"><a href="/app/journal?feed=1">Abrir o feed de atividade</a></p></noscript>
  </section>`;
}

// Falha numa fonte NÃO some mais o card (Onda 5, spec 66): vira um .error-state
// visível — o dono percebe que a fonte quebrou em vez de achar que não há dados.
function renderCardError(titleHtml: string, msg: string, box?: HomeBoxKey, prefs: HomePrefs = {}, sizes: HomeSizes = {}, hidden: HomeBoxKey[] = []): string {
  // A âncora #estatisticas (palette "Ir pras Estatísticas") precisa existir
  // TAMBÉM no card de erro — senão falha da query mensal quebra o link.
  const anchor = box === 'insights' ? ' id="estatisticas"' : '';
  return `<section class="card home-card${box ? homeWideClass(box, sizes) + homeHiddenClass(box, hidden) : ''}"${anchor}${box ? itemAttr(box) + boxAttrs(box, prefs) : ''}>${box ? resizeHandle : ''}
    <h2${box ? ' class="home-box-handle"' : ''}>${titleHtml}${box ? homeSizeToggleHtml(box, sizes) + homeEditControlsHtml(box, hidden) : ''}</h2>
    <p class="error-state">${esc(msg)}</p>
  </section>`;
}

// Card "Pendências com você" (rodada 6, 20/07): as filas que esperam o dono —
// perguntas de agentes + entregas da coluna Validação humana — na PRIMEIRA
// posição default da home. Reusa pendingBlockHtml SEM fork (mesmo markup do
// board); backPath='/app' faz os forms sem JS voltarem pra home no 302. VAZIO =
// card OMITIDO do grid (padrão digest) — pendência zero não merece caixa vazia.
// Exportado: testado isolado em test/web/home.test.ts.
export function renderPendingCard(items: PendingItem[], prefs: HomePrefs = {}, sizes: HomeSizes = {}, hidden: HomeBoxKey[] = []): string {
  if (!items || items.length === 0) return '';
  const kinds = pendingKindsLabel(items);
  return `<section class="card home-card home-pending-card${homeWideClass('pending', sizes)}${homeHiddenClass('pending', hidden)}"${itemAttr('pending')}${boxAttrs('pending', prefs)}>${resizeHandle}
    <h2 class="home-box-handle">Pendências com você <span class="home-pending-count">· ${items.length} — ${esc(kinds)}</span> <a href="/app/tasks">abrir o board →</a>${homeSizeToggleHtml('pending', sizes)}${homeEditControlsHtml('pending', hidden)}</h2>
    <div class="task-pending home-pending-body" id="home-pending-body">${pendingBlockHtml(items, '/app')}</div>
  </section>`;
}

export async function handleHomePage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const now = Date.now();

  // Layout salvo das caixas (Onda 9b) — falha na leitura degrada pros defaults.
  let prefsState: HomePrefsState = { heights: {}, sizes: {}, order: null, hidden: [], startDismissed: false };
  try { prefsState = await getHomePrefs(env); } catch (e) {
    console.error('home: falha ao ler home_prefs (defaults aplicados)', e);
  }
  const prefs = prefsState.heights;
  const sizes = prefsState.sizes;
  const hidden = prefsState.hidden ?? [];

  // Card "Comece aqui" (spec 92): acima do grid, fora do sistema de caixas
  // arrastáveis (é temporário por natureza). Falha na derivação NÃO vira card de
  // erro — ativação é acessório, a home nunca piora por causa dele.
  let startHereHtml = '';
  if (!prefsState.startDismissed) {
    try {
      startHereHtml = renderStartHereCard(await getActivationState(env), new URL(req.url).origin);
    } catch (e) {
      console.error('home: falha ao derivar o checklist de ativação (card omitido)', e);
    }
  }

  // Faixa da frota (spec 80/92): linha de navegação acima do grid, fora das
  // caixas arrastáveis. Instância sem agentes não ganha faixa; falha só omite.
  let fleetStripHtml = '';
  try {
    fleetStripHtml = await fleetHomeStripHtml(env, now);
  } catch (e) {
    // Falha NÃO pode ser 100% silenciosa (revisão 19/07): a faixa carrega a fila
    // de "Validação humana"/bloqueios — sumir sem sinal esconde trabalho parado.
    // Linha discreta no lugar, com rota pro board (as pendências moram lá).
    console.error('home: falha ao montar a faixa da frota (linha de aviso)', e);
    fleetStripHtml = '<p class="config-subtitle" role="status">Não deu pra carregar a faixa dos agentes agora — <a href="/app/tasks">abrir as Tarefas</a>.</p>';
  }

  // Cada card é buscado/renderizado de forma isolada — falha numa fonte vira um
  // card de erro visível SÓ nela, nunca derruba a home inteira (critério de aceite).

  // Card "Pendências com você" (rodada 6): PRIMEIRO na ordem default. Vazio =
  // omitido (renderPendingCard devolve ''); falha = card de erro visível.
  let pendingCardHtml = '';
  try {
    pendingCardHtml = renderPendingCard(await buildPendingItems(env), prefs, sizes, hidden);
  } catch (e) {
    console.error('home: falha ao carregar as pendências (card de erro)', e);
    pendingCardHtml = renderCardError('Pendências com você <a href="/app/tasks">abrir o board →</a>', 'Não deu pra carregar as pendências agora. Recarregue a página.', 'pending', prefs, sizes, hidden);
  }

  let todayCardHtml = '';
  try {
    // OWNER_TASK_VIS: a home é superfície de SESSÃO do dono (spec 65 §4), mesma
    // convenção do board de tasks e do lembrete diário.
    const tasks = await listTasksDueBefore(env, now + TODAY_HORIZON_MS, OWNER_TASK_VIS);
    todayCardHtml = renderTodayCard(tasks, now, prefs, sizes, hidden);
  } catch (e) {
    console.error('home: falha ao carregar tasks de hoje', e);
    todayCardHtml = renderCardError('Hoje <a href="/app/tasks">board completo →</a>', 'Não deu pra carregar as tasks agora. Recarregue a página.', 'today', prefs, sizes, hidden);
  }

  let inboxCardHtml = '';
  try {
    const [pending, items] = await Promise.all([
      countPendingInbox(env),
      listInboxItems(env, { pendingOnly: true, limit: INBOX_SCAN_LIMIT }),
    ]);
    inboxCardHtml = renderInboxCard(pending, items, prefs, sizes, hidden);
  } catch (e) {
    console.error('home: falha ao carregar inbox (spec 63 pode não ter rodado)', e);
    inboxCardHtml = renderCardError('Inbox <a href="/app/inbox">ver tudo →</a>', 'Não deu pra carregar o inbox agora. Recarregue a página.', 'inbox', prefs, sizes, hidden);
  }

  let digestCardHtml = '';
  let hasDigestBox = false;
  try {
    const digest = await readCachedResurfaceDigest(env);
    if (digest && !isDigestEmpty(digest)) {
      // Digest vazio/inexistente continua OMITIDO de propósito (não é erro) —
      // só a FALHA de leitura vira card de erro visível. Onda 9: o card ganhou o
      // MESMO h2 dos vizinhos (era o "card sem título" do feedback do dono) — o
      // renderDigestCard entra em modo bare (sem o <strong> interno duplicado).
      digestCardHtml = `<section class="card home-card${homeWideClass('digest', sizes)}${homeHiddenClass('digest', hidden)}"${itemAttr('digest')}${boxAttrs('digest', prefs)}>${resizeHandle}
        <h2 class="home-box-handle">Do seu cérebro <a href="/app/notes">notas →</a>${homeSizeToggleHtml('digest', sizes)}${homeEditControlsHtml('digest', hidden)}</h2>
        ${renderDigestCard(digest, { bare: true })}
      </section>`;
      hasDigestBox = true;
    }
  } catch (e) {
    console.error('home: falha ao ler cache do resurface digest (spec 64 pode não ter rodado)', e);
    digestCardHtml = renderCardError('Do seu cérebro', 'Não deu pra ler o digest agora. Recarregue a página.', 'digest', prefs, sizes, hidden);
    hasDigestBox = true;
  }

  // Card "Estatísticas" (spec 99; fusão do /app/insights na home, 19/07): o
  // dashboard mensal COMPLETO (mês corrente + delta vs anterior) mora aqui —
  // a página /app/insights virou redirect. Payload vem do cache KV (1h) — a
  // home não paga as agregações a cada visita.
  let insightsCardHtml = '';
  try {
    const cur = brtYearMonth(now);
    const prev = cur.month === 1 ? { year: cur.year - 1, month: 12 } : { year: cur.year, month: cur.month - 1 };
    const [curData, prevData] = await Promise.all([
      getMonthInsightsCached(env, cur.year, cur.month, now),
      getMonthInsightsCached(env, prev.year, prev.month, now),
    ]);
    insightsCardHtml = renderInsightsCard(cur.year, cur.month, curData, prevData, prefs, sizes, hidden);
  } catch (e) {
    console.error('home: falha ao carregar o resumo mensal (spec 99)', e);
    insightsCardHtml = renderCardError('Estatísticas', 'Não deu pra carregar o resumo do mês agora. Recarregue a página.', 'insights', prefs, sizes, hidden);
  }

  // Onda 9b (spec 72): TODAS as caixas (atividade inclusa) são filhas do grid,
  // renderizadas na ordem salva — arrastar pelo título reordena, puxar a borda
  // redimensiona (padrão ClickUp, feedback do dono). Digest ausente é pulado.
  const boxHtml: Record<HomeBoxKey, string> = {
    pending: pendingCardHtml,
    today: todayCardHtml,
    inbox: inboxCardHtml,
    digest: hasDigestBox ? digestCardHtml : '',
    insights: insightsCardHtml,
    activity: renderActivityFeedSection(prefs, hidden),
  };
  const gridHtml = (prefsState.order ?? [...HOME_BOX_KEYS]).map((box) => boxHtml[box]).join('\n      ');

  // Modo de edição (rodada 6): "Personalizar" (lápis, aria-pressed) entra em
  // edit mode; a barra Salvar/Cancelar/Restaurar padrão fica logo após o grid
  // (visível só em edição — CSS ~). Sem JS o botão é inerte e a home segue
  // 100% funcional em view mode (aceito por design).
  const body = `
    <div class="page-header"><h1>Início</h1>
      <button type="button" class="btn btn-sm btn-ghost" id="home-edit-toggle" aria-pressed="false" title="Personalizar o layout da home">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
        Personalizar
      </button>
    </div>
    ${startHereHtml}
    ${fleetStripHtml}
    <div class="home-grid">
      ${gridHtml}
    </div>
    <div class="home-edit-bar" id="home-edit-bar">
      <button type="button" class="btn btn-primary" id="home-edit-save">Salvar</button>
      <button type="button" class="btn btn-ghost" id="home-edit-cancel">Cancelar</button>
      <span class="home-edit-hint">arraste pelo título ou use as setas pra reordenar · puxe a borda de baixo pra redimensionar</span>
      <button type="button" class="btn btn-ghost" id="home-edit-reset">Restaurar padrão</button>
    </div>
    <script src="/app/home/bundle.js?v=${assetVersion('home.bundle.js')}" defer></script>
    <script src="/app/journal/bundle.js?v=${assetVersion('journal.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    await renderShell({
      title: 'Início',
      active: 'home',
      email: session.email,
      env,
      body,
      extraHead: `<style>${HOME_CSS}${PENDING_CSS}${JOURNAL_CSS}</style>`,
      sidebarCollapsed: sidebarCollapsedFromReq(req),
    })
  );
}
