import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { assetVersion } from './asset-version.js';
import { listTasksDueBefore, listInboxItems, countPendingInbox, type TaskRow, type InboxItem } from '../db/queries.js';
import { readCachedResurfaceDigest, isDigestEmpty } from '../digest/resurface.js';
import { renderDigestCard } from './notes.js';
import { relativeDue } from '../util/time.js';

// Home "Hoje" (specs/50-console-v2/65-home-hoje-e-journal.md §2): 4 cards SSR, cada
// um TOLERANTE a falha isolada — uma query que falha vira um card de ERRO visível
// (try/catch por card, Onda 5), nunca derruba a página inteira. O card "Últimas
// interações" é a ÚNICA
// exceção: carrega ASSÍNCRONO no client (skeleton aqui, populado por home.bundle.js)
// porque depende do proxy pro Worker do Contacts — não trava o SSR da home no request
// path (Riscos da spec: "home lenta por depender do proxy").

// Horizonte "Hoje" = 24h à frente + tudo já vencido — MESMA convenção do lembrete
// diário (src/notify.ts) e do filtro "hoje" do board de tasks (src/web/tasks.ts),
// não um corte de calendário BRT à parte.
const TODAY_HORIZON_MS = 24 * 60 * 60 * 1000;
const INBOX_PREVIEW = 3;
const INBOX_SCAN_LIMIT = 200;
const CONTACT_EVENTS_PREVIEW = 5;

const HOME_CSS = `
.home-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 18px; align-items: start; }
/* fonte/peso herdam do .card h2 (Onda 3) — aqui só o layout flex do link à direita */
.home-card h2 { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 14px; }
.home-card h2 a { font-size: 12px; font-weight: 500; color: var(--accent-lav); text-decoration: none; white-space: nowrap; }
.home-card h2 a:hover { text-decoration: underline; }
.home-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.home-list li { display: flex; align-items: center; gap: 8px; font-size: 13.5px; line-height: 1.4; }
.home-list a { color: var(--text); text-decoration: none; }
.home-list a:hover { color: var(--accent-lav); }
.home-task-title, .home-event-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.home-task-complete {
  flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--border-strong);
  background: transparent; cursor: pointer; color: var(--text-dim); font-size: 11px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
}
.home-task-complete:hover { border-color: var(--accent-lav); color: var(--accent-lav); }
.home-task-when, .home-event-when { flex-shrink: 0; font-size: 11.5px; color: var(--text-faint); margin-left: auto; }
.home-task-when.overdue { color: var(--danger); }
.home-event-kind { flex-shrink: 0; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-faint); }
.home-empty { color: var(--text-dim); font-size: 13px; margin: 0; }
.home-error { color: var(--danger); }
.home-private-badge { font-size: 10px; color: var(--text-faint); flex-shrink: 0; }
`;

function taskWhenHtml(t: TaskRow, now: number): string {
  if (t.due_at === null) return '';
  const overdue = t.due_at < now;
  return `<span class="home-task-when${overdue ? ' overdue' : ''}">${esc(relativeDue(t.due_at, now))}</span>`;
}

// Card 1 — Hoje: tasks due hoje/atrasadas, com quick-complete (checkbox → mesmo
// endpoint do board, POST /app/tasks/complete) + link pro board completo.
// Exportado: testado isoladamente (sem D1/HTTP) em test/web/home.test.ts.
export function renderTodayCard(tasks: TaskRow[], now: number): string {
  if (tasks.length === 0) {
    return `<section class="card home-card">
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
  return `<section class="card home-card">
    <h2>Hoje <a href="/app/tasks">board completo →</a></h2>
    <ul class="home-list" id="home-today-list">${items}</ul>
  </section>`;
}

// Primeira linha do corpo cru do inbox, truncada — mesmo padrão de inbox.ts.
function firstLine(body: string, max: number): string {
  const line = body.split('\n')[0]?.trim() || body.trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// Card 2 — Inbox: contagem de pendentes + 3 mais recentes + link pro /app/inbox.
// Exportado: testado isoladamente em test/web/home.test.ts.
export function renderInboxCard(pending: number, items: InboxItem[]): string {
  if (pending === 0) {
    return `<section class="card home-card">
      <h2>Inbox <a href="/app/inbox">ver tudo →</a></h2>
      <p class="home-empty">Inbox vazio.</p>
    </section>`;
  }
  // listInboxItems ordena created_at ASC (mais antigo primeiro, ordem de triagem) —
  // os "3 mais recentes" pra home são o FIM dessa lista, invertido.
  const preview = items.slice(-INBOX_PREVIEW).reverse();
  const list = preview.map((it) => `<li><a href="/app/inbox">${esc(firstLine(it.body, 140))}</a></li>`).join('');
  return `<section class="card home-card">
    <h2>Inbox <a href="/app/inbox">${pending} pendente${pending === 1 ? '' : 's'} →</a></h2>
    <ul class="home-list">${list}</ul>
  </section>`;
}

// Card 4 — Últimas interações: SKELETON server-side, populado por home.bundle.js
// (GET /app/contacts/events/recent) — nunca bloqueia o SSR da home no proxy.
// As linhas .skeleton (Onda 3) têm texto transparente só pra dar dimensão; o client
// substitui o innerHTML inteiro, então elas somem sozinhas quando os dados chegam.
function renderInteractionsCardSkeleton(): string {
  return `<section class="card home-card">
    <h2>Últimas interações <a href="/app/journal">journal completo →</a></h2>
    <ul class="home-list" id="home-events-list" data-limit="${CONTACT_EVENTS_PREVIEW}">
      <li class="skeleton">Carregando as últimas interações…</li>
      <li class="skeleton">Carregando as últimas interações</li>
      <li class="skeleton">Carregando…</li>
    </ul>
  </section>`;
}

// Falha numa fonte NÃO some mais o card (Onda 5, spec 66): vira um .error-state
// visível — o dono percebe que a fonte quebrou em vez de achar que não há dados.
function renderCardError(titleHtml: string, msg: string): string {
  return `<section class="card home-card">
    <h2>${titleHtml}</h2>
    <p class="error-state">${esc(msg)}</p>
  </section>`;
}

export async function handleHomePage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const now = Date.now();

  // Cada card é buscado/renderizado de forma isolada — falha numa fonte vira um
  // card de erro visível SÓ nela, nunca derruba a home inteira (critério de aceite).
  let todayCardHtml = '';
  try {
    // includePrivate=true: a home é superfície de SESSÃO do dono (spec 65 §4), mesma
    // convenção do board de tasks e do lembrete diário.
    const tasks = await listTasksDueBefore(env, now + TODAY_HORIZON_MS, true);
    todayCardHtml = renderTodayCard(tasks, now);
  } catch (e) {
    console.error('home: falha ao carregar tasks de hoje', e);
    todayCardHtml = renderCardError('Hoje <a href="/app/tasks">board completo →</a>', 'Não deu pra carregar as tasks agora. Recarregue a página.');
  }

  let inboxCardHtml = '';
  try {
    const [pending, items] = await Promise.all([
      countPendingInbox(env),
      listInboxItems(env, { pendingOnly: true, limit: INBOX_SCAN_LIMIT }),
    ]);
    inboxCardHtml = renderInboxCard(pending, items);
  } catch (e) {
    console.error('home: falha ao carregar inbox (spec 63 pode não ter rodado)', e);
    inboxCardHtml = renderCardError('Inbox <a href="/app/inbox">ver tudo →</a>', 'Não deu pra carregar o inbox agora. Recarregue a página.');
  }

  let digestCardHtml = '';
  try {
    const digest = await readCachedResurfaceDigest(env);
    if (digest && !isDigestEmpty(digest)) {
      // Digest vazio/inexistente continua OMITIDO de propósito (não é erro) —
      // só a FALHA de leitura vira card de erro visível.
      digestCardHtml = `<section class="card home-card">${renderDigestCard(digest)}</section>`;
    }
  } catch (e) {
    console.error('home: falha ao ler cache do resurface digest (spec 64 pode não ter rodado)', e);
    digestCardHtml = renderCardError('Do seu cérebro', 'Não deu pra ler o digest agora. Recarregue a página.');
  }

  const body = `
    <div class="page-header"><h1>Início</h1></div>
    <div class="home-grid">
      ${todayCardHtml}
      ${inboxCardHtml}
      ${digestCardHtml}
      ${renderInteractionsCardSkeleton()}
    </div>
    <script src="/app/home/bundle.js?v=${assetVersion('home.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    await renderShell({
      title: 'Início',
      active: 'home',
      email: session.email,
      env,
      body,
      extraHead: `<style>${HOME_CSS}</style>`,
      sidebarCollapsed: sidebarCollapsedFromReq(req),
    })
  );
}
