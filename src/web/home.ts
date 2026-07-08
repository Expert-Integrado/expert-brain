import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { assetVersion } from './asset-version.js';
import { listTasksDueBefore, listInboxItems, countPendingInbox, INBOX_BODY_MAX, type TaskRow, type InboxItem } from '../db/queries.js';
import { readCachedResurfaceDigest, isDigestEmpty } from '../digest/resurface.js';
import { renderDigestCard } from './notes.js';
import { relativeDue } from '../util/time.js';
import { JOURNAL_CSS } from './journal.js';
import { getHomePrefs, HOME_BOX_DEFAULTS, HOME_BOX_MIN, HOME_BOX_MAX, type HomeBoxKey, type HomePrefs } from './home-prefs.js';

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
/* Caixas de tamanho previsível (Onda 8): altura capada + scroll interno SÓ no
   conteúdo (o título e o form de captura ficam fixos) — 26 tasks atrasadas não
   esticam mais a home inteira. Conteúdo curto NÃO estica a caixa (max-height).
   Onda 9 (spec 71): a altura virou a custom property --home-card-h, ajustável por
   caixa no modal "Ajustar caixas" (persistida em home_prefs) — o fallback aqui é
   o default e DEVE bater com HOME_BOX_DEFAULTS (home-prefs.ts). */
.home-card { max-height: var(--home-card-h, 420px); display: flex; flex-direction: column; overflow: hidden; }
.home-card > :last-child { overflow-y: auto; min-height: 0; scrollbar-width: thin; }
/* fonte/peso herdam do .card h2 (Onda 3) — aqui só o layout flex do link à direita */
.home-card h2 { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 14px; flex: none; }
.home-card h2 a { font-size: 12px; font-weight: 500; color: var(--accent-lav); text-decoration: none; white-space: nowrap; }
.home-card h2 a:hover { text-decoration: underline; }
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
/* Feed "Atividade" (spec 69) — o antigo Journal, embutido abaixo dos cards.
   Onda 8: caixa FECHADA de altura fixa com scroll interno (o "Carregar mais" e o
   aviso de degradação nascem dentro dela — o client insere ao redor do container). */
.home-activity { margin-top: 28px; }
.home-activity-title { font-family: var(--font-display); font-size: 18px; font-weight: 500; margin: 0 0 14px; }
.home-activity-box {
  max-height: var(--home-card-h, 560px); overflow-y: auto; scrollbar-width: thin;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 6px 18px 14px;
}
/* Botão + modal "Ajustar caixas" (Onda 9, spec 71) */
#home-prefs-open { margin-left: auto; }
.home-prefs-row { display: flex; align-items: center; gap: 12px; margin: 0 0 14px; }
.home-prefs-label { flex: none; width: 130px; font-size: 13px; color: var(--text); }
.home-prefs-range { flex: 1; min-width: 0; accent-color: var(--accent-lav); }
.home-prefs-val { flex: none; width: 56px; text-align: right; font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.home-prefs-hint { font-size: 12px; color: var(--text-dim); margin: 0 0 16px; }
.home-prefs-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
`;

// style inline com a altura salva — ausente quando a caixa está no default (o CSS
// resolve pelo fallback do var()). data-home-box é o alvo do preview ao vivo do modal.
function boxAttrs(box: HomeBoxKey, prefs: HomePrefs): string {
  const h = prefs[box];
  return ` data-home-box="${box}"${h ? ` style="--home-card-h:${h}px"` : ''}`;
}

function taskWhenHtml(t: TaskRow, now: number): string {
  if (t.due_at === null) return '';
  const overdue = t.due_at < now;
  return `<span class="home-task-when${overdue ? ' overdue' : ''}">${esc(relativeDue(t.due_at, now))}</span>`;
}

// Card 1 — Hoje: tasks due hoje/atrasadas, com quick-complete (checkbox → mesmo
// endpoint do board, POST /app/tasks/complete) + link pro board completo.
// Exportado: testado isoladamente (sem D1/HTTP) em test/web/home.test.ts.
export function renderTodayCard(tasks: TaskRow[], now: number, prefs: HomePrefs = {}): string {
  if (tasks.length === 0) {
    return `<section class="card home-card"${boxAttrs('today', prefs)}>
      <h2>Hoje <a href="/app/tasks">board completo →</a></h2>
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
  return `<section class="card home-card"${boxAttrs('today', prefs)}>
    <h2>Hoje <a href="/app/tasks">board completo →</a></h2>
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
export function renderInboxCard(pending: number, items: InboxItem[], prefs: HomePrefs = {}): string {
  const capture = `<form class="home-inbox-capture" method="post" action="/app/inbox/add">
      <input type="text" name="text" maxlength="${INBOX_BODY_MAX}" placeholder="Capturar ideia solta — tria depois" aria-label="Captura rápida pro inbox" autocomplete="off" required />
      <input type="hidden" name="next" value="/app" />
      <button type="submit" class="btn btn-sm">Capturar</button>
    </form>`;
  if (pending === 0) {
    return `<section class="card home-card"${boxAttrs('inbox', prefs)}>
      <h2>Inbox <a href="/app/inbox">ver tudo →</a></h2>
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
  return `<section class="card home-card"${boxAttrs('inbox', prefs)}>
    <h2>Inbox <a href="/app/inbox">${pending} pendente${pending === 1 ? '' : 's'} →</a></h2>
    ${capture}
    <ul class="home-list home-inbox-list">${rows}</ul>
  </section>`;
}

// Feed "Atividade" (spec 69): o antigo /app/journal absorvido na home. SSR só do
// esqueleto (filtros + placeholder); journal.bundle.js busca a primeira página em
// JSON (data-lazy="1") e injeta — o proxy do Contacts fica FORA do request path.
// O card "Últimas interações" foi absorvido junto: o feed já traz as interações
// (chip laranja + filtro próprio), então o card seria informação duplicada.
function renderActivityFeedSection(prefs: HomePrefs = {}): string {
  return `<section class="home-activity" id="atividade">
    <h2 class="home-activity-title">Atividade</h2>
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
function renderCardError(titleHtml: string, msg: string, box?: HomeBoxKey, prefs: HomePrefs = {}): string {
  return `<section class="card home-card"${box ? boxAttrs(box, prefs) : ''}>
    <h2>${titleHtml}</h2>
    <p class="error-state">${esc(msg)}</p>
  </section>`;
}

// Modal "Ajustar caixas" (Onda 9, spec 71): um slider por caixa presente na página,
// preview ao vivo pelo client (home.bundle.js), persistência em POST /app/home/prefs.
// Rótulos em sincronia com os títulos dos cards.
const HOME_BOX_LABELS: Record<HomeBoxKey, string> = {
  today: 'Hoje',
  inbox: 'Inbox',
  digest: 'Do seu cérebro',
  activity: 'Atividade',
};

function renderHomePrefsModal(prefs: HomePrefs, boxes: HomeBoxKey[]): string {
  const rows = boxes
    .map((box) => {
      const def = HOME_BOX_DEFAULTS[box];
      const val = prefs[box] ?? def;
      return `<label class="home-prefs-row">
        <span class="home-prefs-label">${esc(HOME_BOX_LABELS[box])}</span>
        <input type="range" class="home-prefs-range" data-box="${box}" data-default="${def}" min="${HOME_BOX_MIN}" max="${HOME_BOX_MAX}" step="20" value="${val}" aria-label="Altura da caixa ${esc(HOME_BOX_LABELS[box])}" />
        <span class="home-prefs-val" data-val-for="${box}">${val}px</span>
      </label>`;
    })
    .join('');
  return `<div class="modal" id="home-prefs-modal" hidden>
    <div class="modal-backdrop"></div>
    <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="home-prefs-title">
      <div class="modal-head">
        <strong id="home-prefs-title">Ajustar caixas</strong>
        <button type="button" class="modal-x" aria-label="Fechar">✕</button>
      </div>
      <div class="modal-body">
        <p class="home-prefs-hint">Arraste pra mudar a altura de cada caixa — o resultado aparece na hora. Salvar vale pra todas as suas máquinas.</p>
        ${rows}
        <div class="home-prefs-actions">
          <button type="button" class="btn btn-sm" id="home-prefs-reset">Restaurar padrão</button>
          <button type="button" class="btn btn-primary btn-sm" id="home-prefs-save">Salvar</button>
        </div>
      </div>
    </div>
  </div>`;
}

export async function handleHomePage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const now = Date.now();

  // Alturas salvas das caixas (Onda 9) — falha na leitura degrada pros defaults.
  let prefs: HomePrefs = {};
  try { prefs = await getHomePrefs(env); } catch (e) {
    console.error('home: falha ao ler home_prefs (defaults aplicados)', e);
  }

  // Cada card é buscado/renderizado de forma isolada — falha numa fonte vira um
  // card de erro visível SÓ nela, nunca derruba a home inteira (critério de aceite).
  let todayCardHtml = '';
  try {
    // includePrivate=true: a home é superfície de SESSÃO do dono (spec 65 §4), mesma
    // convenção do board de tasks e do lembrete diário.
    const tasks = await listTasksDueBefore(env, now + TODAY_HORIZON_MS, true);
    todayCardHtml = renderTodayCard(tasks, now, prefs);
  } catch (e) {
    console.error('home: falha ao carregar tasks de hoje', e);
    todayCardHtml = renderCardError('Hoje <a href="/app/tasks">board completo →</a>', 'Não deu pra carregar as tasks agora. Recarregue a página.', 'today', prefs);
  }

  let inboxCardHtml = '';
  try {
    const [pending, items] = await Promise.all([
      countPendingInbox(env),
      listInboxItems(env, { pendingOnly: true, limit: INBOX_SCAN_LIMIT }),
    ]);
    inboxCardHtml = renderInboxCard(pending, items, prefs);
  } catch (e) {
    console.error('home: falha ao carregar inbox (spec 63 pode não ter rodado)', e);
    inboxCardHtml = renderCardError('Inbox <a href="/app/inbox">ver tudo →</a>', 'Não deu pra carregar o inbox agora. Recarregue a página.', 'inbox', prefs);
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
      digestCardHtml = `<section class="card home-card"${boxAttrs('digest', prefs)}>
        <h2>Do seu cérebro <a href="/app/notes">notas →</a></h2>
        ${renderDigestCard(digest, { bare: true })}
      </section>`;
      hasDigestBox = true;
    }
  } catch (e) {
    console.error('home: falha ao ler cache do resurface digest (spec 64 pode não ter rodado)', e);
    digestCardHtml = renderCardError('Do seu cérebro', 'Não deu pra ler o digest agora. Recarregue a página.', 'digest', prefs);
    hasDigestBox = true;
  }

  const modalBoxes: HomeBoxKey[] = hasDigestBox
    ? ['today', 'inbox', 'digest', 'activity']
    : ['today', 'inbox', 'activity'];

  const body = `
    <div class="page-header"><h1>Início</h1><button type="button" class="btn btn-ghost btn-sm" id="home-prefs-open">Ajustar caixas</button></div>
    <div class="home-grid">
      ${todayCardHtml}
      ${inboxCardHtml}
      ${digestCardHtml}
    </div>
    ${renderActivityFeedSection(prefs)}
    ${renderHomePrefsModal(prefs, modalBoxes)}
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
      extraHead: `<style>${HOME_CSS}${JOURNAL_CSS}</style>`,
      sidebarCollapsed: sidebarCollapsedFromReq(req),
    })
  );
}
