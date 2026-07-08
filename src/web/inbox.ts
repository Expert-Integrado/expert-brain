import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { renderMarkdown } from './markdown.js';
import { newId } from '../util/id.js';
import { embed, upsertNoteVector } from '../vector/index.js';
import { refreshSimilarEdges } from './similarity.js';
import {
  insertInboxItem,
  listInboxItems,
  getInboxItem,
  resolveInboxItem,
  countPendingInbox,
  insertNote,
  insertTask,
  INBOX_BODY_MAX,
} from '../db/queries.js';

// Página + endpoints do INBOX DE CAPTURA (spec 50-console-v2/63). Fila de triagem no
// console: lista de pendentes + quick-add + 3 ações por item (virar nota / virar task /
// descartar). TODAS as ações são <form> HTML nativos (POST + redirect) — CSP-safe, sem
// bundle client novo, sem inline handler. SÓ sessão de browser (requireSession): o inbox
// é superfície do dono; PAT/bearer caem em 401/redirect antes de chegar aqui.

// Defaults de uma nota nascida do inbox — o dono cura depois no editor (/app/notes/:id,
// que já edita kind/áreas/tldr inline). Não são curados aqui: o inbox é captura crua.
const NOTE_DEFAULT_KIND = 'insight';
const NOTE_DEFAULT_DOMAINS = ['personal-development'];
const TASK_DEFAULT_DOMAINS = ['operations'];

function backToInbox(): Response {
  return new Response(null, { status: 302, headers: { location: '/app/inbox' } });
}

// Idade legível ("agora", "há 3h", "há 2d") — o card mostra o quão parado o item está.
function ageLabel(createdAt: number, now: number): string {
  const ms = Math.max(0, now - createdAt);
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `há ${mins}min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `há ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `há ${days}d`;
}

// Primeira linha (título derivado), truncada. Vazia → cai no corpo inteiro.
function firstLine(body: string, max: number): string {
  const line = body.split('\n')[0]?.trim() || body.trim();
  return line.slice(0, max);
}

// Fontes aceitas no POST /app/inbox/add — allowlist fechada; qualquer outro
// valor (ou ausente) cai no default 'console'. 'pwa-share' vem do Web Share
// Target (specs/50-console-v2/68-pwa-instalavel.md).
const ADD_POST_SOURCES = new Set(['console', 'pwa-share']);

// Params do Web Share Target (manifest `share_target`, GET /app/inbox?title=&text=&url=)
// concatenados num rascunho único pro textarea do quick-add. Compartilhou → 1 toque
// → capturado. Trunca no mesmo teto do body do inbox.
function sharePrefillFromQuery(url: URL): string {
  const parts = ['title', 'text', 'url']
    .map((k) => url.searchParams.get(k)?.trim() || '')
    .filter(Boolean);
  return parts.join('\n\n').slice(0, INBOX_BODY_MAX);
}

const INBOX_CSS = `
.inbox-quickadd { display: flex; flex-direction: column; gap: 8px; margin: 0 0 24px; }
.inbox-quickadd textarea {
  width: 100%; box-sizing: border-box; min-height: 60px; resize: vertical;
  background: var(--surface); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 12px; font-size: 14px; font-family: inherit; line-height: 1.5;
}
.inbox-quickadd textarea:focus { outline: none; border-color: var(--accent-lav); }
.inbox-quickadd-foot { display: flex; justify-content: flex-end; }
/* .inbox-btn é co-classe de .btn (COMPONENTS_CSS) — aqui só o delta de densidade da tela */
.inbox-btn { font-size: 13px; padding: 7px 14px; border-color: var(--border); background: var(--surface); }
.inbox-btn:hover { border-color: var(--border-strong); }
.inbox-btn.primary { border-color: rgba(var(--accent-lav-rgb),0.4); color: color-mix(in srgb, var(--accent-lav) 60%, white); }
.inbox-btn.danger { color: var(--danger); }
.inbox-list { display: flex; flex-direction: column; gap: 12px; }
.inbox-item {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
}
.inbox-item-head { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text-subtle); }
.inbox-item-source { text-transform: uppercase; letter-spacing: .06em; }
.inbox-item-body { font-size: 14px; line-height: 1.55; color: var(--text); word-break: break-word; }
.inbox-item-body > :first-child { margin-top: 0; }
.inbox-item-body > :last-child { margin-bottom: 0; }
.inbox-item-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.inbox-item-actions form { margin: 0; }
.inbox-empty { color: var(--text-dim); }
`;

export async function handleInboxPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const now = Date.now();
  const items = await listInboxItems(env, { pendingOnly: true, limit: 500 });
  const pending = items.length;

  const url = new URL(req.url);
  const sharePrefill = sharePrefillFromQuery(url);
  const isShare = sharePrefill.length > 0;

  const emptyTitle = new Map<string, string>();
  const emptyIds = new Set<string>();

  const itemsHtml = items
    .map((it) => {
      const bodyHtml = renderMarkdown(it.body, { titleIndex: emptyTitle, idSet: emptyIds, currentId: it.id });
      return `
      <div class="inbox-item">
        <div class="inbox-item-head">
          <span class="inbox-item-source">${esc(it.source)}</span>
          <span>·</span>
          <span>${esc(ageLabel(it.created_at, now))}</span>
        </div>
        <div class="inbox-item-body">${bodyHtml}</div>
        <div class="inbox-item-actions">
          <form method="post" action="/app/inbox/to-note">
            <input type="hidden" name="id" value="${esc(it.id)}" />
            <button type="submit" class="btn inbox-btn primary">Virar nota</button>
          </form>
          <form method="post" action="/app/inbox/to-task">
            <input type="hidden" name="id" value="${esc(it.id)}" />
            <button type="submit" class="btn inbox-btn">Virar task</button>
          </form>
          <form method="post" action="/app/inbox/resolve">
            <input type="hidden" name="id" value="${esc(it.id)}" />
            <input type="hidden" name="action" value="discard" />
            <button type="submit" class="btn inbox-btn danger">Descartar</button>
          </form>
        </div>
      </div>`;
    })
    .join('');

  const body = `
    <div class="page-header">
      <h1>Inbox</h1>
      <span class="count">${pending} ${pending === 1 ? 'pendente' : 'pendentes'}</span>
    </div>

    <form class="inbox-quickadd" method="post" action="/app/inbox/add">
      <textarea name="text" maxlength="${INBOX_BODY_MAX}" placeholder="Captura rápida — uma ideia, um lembrete solto. Tria depois." aria-label="Captura rápida" required>${esc(sharePrefill)}</textarea>
      <input type="hidden" name="source" value="${isShare ? 'pwa-share' : 'console'}" />
      <div class="inbox-quickadd-foot">
        <button type="submit" class="btn inbox-btn primary"${isShare ? ' autofocus' : ''}>Capturar</button>
      </div>
    </form>

    ${pending === 0
      ? '<p class="inbox-empty">Inbox vazio. Nada pra triar.</p>'
      : `<div class="inbox-list">${itemsHtml}</div>`}
  `;

  return htmlResponse(
    await renderShell({
      title: 'Inbox',
      active: 'inbox',
      email: session.email,
      env,
      body,
      extraHead: `<style>${INBOX_CSS}</style>`,
      sidebarCollapsed: sidebarCollapsedFromReq(req),
    })
  );
}

// POST /app/inbox/add — quick-add do console. source='console' por default; o hidden
// input do form manda 'pwa-share' quando a página chegou via Web Share Target (specs/
// 50-console-v2/68-pwa-instalavel.md) — allowlist fechada (ADD_POST_SOURCES), qualquer
// outro valor cai no default. Form-encoded + redirect.
export async function handleInboxAddPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const form = await req.formData();
  const text = String(form.get('text') ?? '').trim();
  // Vazio: no-op silencioso (volta pro inbox), não é erro do usuário.
  if (!text) return backToInbox();
  const body = text.slice(0, INBOX_BODY_MAX);
  const rawSource = String(form.get('source') ?? '').trim();
  const source = ADD_POST_SOURCES.has(rawSource) ? rawSource : 'console';

  await insertInboxItem(env, {
    id: `ibx_${newId()}`,
    body,
    source,
    created_at: Date.now(),
  });
  return backToInbox();
}

// POST /app/inbox/resolve — marca triado (usado pelo "Descartar"). Form-encoded + redirect.
export async function handleInboxResolvePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id obrigatório', 400);
  const action = String(form.get('action') ?? 'discard').trim();
  if (action !== 'note' && action !== 'task' && action !== 'discard') {
    return htmlResponse('ação inválida', 400);
  }
  const resultId = String(form.get('result_id') ?? '').trim() || null;
  await resolveInboxItem(env, id, action, resultId, Date.now());
  return backToInbox();
}

// POST /app/inbox/to-note — cria uma NOTA (fluxo normal: embed + insertNote + upsert
// vetor, igual save_note) pré-preenchida com o item, RESOLVE o item com o result_id e
// redireciona pro editor da nota (pré-preenchido) pra curadoria. Embedding é best-effort:
// se o Workers AI falhar, a nota é criada mesmo assim (editável; re-embeda na 1ª curadoria).
export async function handleInboxToNotePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id obrigatório', 400);

  const item = await getInboxItem(env, id);
  // Item inexistente OU já triado: não recria nada (evita processar 2x). Volta pro inbox.
  if (!item || item.triaged_at !== null) return backToInbox();

  const now = Date.now();
  const noteId = newId();
  const title = firstLine(item.body, 200) || 'Nota';
  const tldr = firstLine(item.body, 280) || item.body.slice(0, 280);
  const actor = `oauth:${session.email}`;

  // Embedding best-effort ANTES do insert (mesmo modelo do save_note), mas sem derrubar
  // a criação se o AI falhar — captura não pode virar dead-end por erro transitório.
  let vec: number[] | null = null;
  try {
    vec = await embed(env, tldr);
  } catch (err) {
    console.error('inbox to-note: embed falhou, criando nota sem vetor (re-embeda na curadoria)', err);
  }

  await insertNote(env, {
    id: noteId,
    title,
    body: item.body,
    tldr,
    domains: JSON.stringify(NOTE_DEFAULT_DOMAINS),
    kind: NOTE_DEFAULT_KIND,
    created_at: now,
    updated_at: now,
  }, actor);

  if (vec) {
    try {
      await upsertNoteVector(env, noteId, vec, { domains: NOTE_DEFAULT_DOMAINS, kind: NOTE_DEFAULT_KIND, created_at: now });
      await refreshSimilarEdges(env, noteId, vec);
    } catch (err) {
      console.error('inbox to-note: upsert vetor/edges falhou (nota persistida)', err);
    }
  }

  await resolveInboxItem(env, id, 'note', noteId, now);
  return new Response(null, { status: 302, headers: { location: `/app/notes/${noteId}` } });
}

// POST /app/inbox/to-task — cria uma TASK (fluxo normal: insertTask, igual /app/tasks/
// create) pré-preenchida com o item, RESOLVE o item e redireciona pro detalhe da task.
export async function handleInboxToTaskPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id obrigatório', 400);

  const item = await getInboxItem(env, id);
  if (!item || item.triaged_at !== null) return backToInbox();

  const now = Date.now();
  const taskId = newId();
  const title = firstLine(item.body, 200) || 'Task';
  const actor = `oauth:${session.email}`;

  await insertTask(env, {
    id: taskId,
    title,
    body: item.body,
    tldr: title.slice(0, 280),
    domains: JSON.stringify(TASK_DEFAULT_DOMAINS),
    status: 'open',
    due_at: null,
    priority: null,
    completed_at: null,
    created_at: now,
    updated_at: now,
  }, actor);

  await resolveInboxItem(env, id, 'task', taskId, now);
  return new Response(null, { status: 302, headers: { location: `/app/tasks/${taskId}` } });
}
