import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { assetVersion } from './asset-version.js';
import { renderMarkdown } from './markdown.js';
import { formatBrtShort, relativeDue } from '../util/time.js';
import {
  getNoteById,
  getTaskById,
  getEdgesFrom,
  getEdgesTo,
  type NoteRow,
  type EdgeRow,
} from '../db/queries.js';

interface NoteListItem {
  id: string;
  title: string;
  domains: string;
  kind: string | null;
  tldr: string;
  updated_at: number;
}

// updated_at / created_at are stored as milliseconds (Date.now()) — not seconds.
function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// The `domains` column is a JSON-encoded string array (e.g. `["infra","ml"]`).
// Tolerate legacy CSV just in case some rows were written in the old format.
function parseDomains(raw: string): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
    } catch { /* fall through to CSV */ }
  }
  return trimmed.split(',').map((d) => d.trim()).filter(Boolean);
}

function domainsToBadges(raw: string): string {
  return parseDomains(raw)
    .map((d) => `<span class="badge">${esc(d)}</span>`)
    .join('');
}

export async function handleNotesList(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const rows = await env.DB.prepare(
    `SELECT id, title, domains, kind, tldr, updated_at FROM notes WHERE deleted_at IS NULL AND (kind IS NULL OR kind <> 'task') ORDER BY updated_at DESC`
  ).all<NoteListItem>();
  const notes = rows.results ?? [];

  // SSR list — client bundle replaces this once /app/graph/meta loads, but
  // leaving it in place keeps the no-JS fallback useful and gives the browser
  // something to paint immediately.
  const ssrItems = notes
    .map(
      (n) => `
      <a class="note-card" href="/app/notes/${esc(n.id)}" data-note-id="${esc(n.id)}" data-updated-at="${n.updated_at}">
        <div class="note-card-head">${n.kind ? `<span class="kind-badge">${esc(n.kind)}</span>` : ''}<span class="note-card-date">${formatDate(n.updated_at)}</span></div>
        <div class="title">${esc(n.title)}</div>
        ${n.tldr ? `<div class="note-card-tldr">${esc(n.tldr)}</div>` : ''}
        <div class="meta">${domainsToBadges(n.domains)}</div>
      </a>`
    )
    .join('');

  const body = `
    <div class="page-header">
      <h1>Notas</h1>
      <span class="count" id="notes-count">${notes.length} ${notes.length === 1 ? 'nota' : 'notas'}</span>
    </div>

    <div class="notes-toolbar">
      <div class="notes-search-row">
        <span class="notes-search-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
        </span>
        <input
          type="search"
          id="notes-search-input"
          class="notes-search-input"
          placeholder="Buscar notas (aperte / pra focar)"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="notes-toolbar-actions">
          <label>
            <span class="sr-label">Ordenar</span>
            <select id="notes-sort" class="notes-select">
              <option value="updated_desc">Atualizadas ↓</option>
              <option value="title_asc">Título A–Z</option>
              <option value="kind">Tipo</option>
            </select>
          </label>
          <label>
            <span class="sr-label">Layout</span>
            <select id="notes-layout" class="notes-select">
              <option value="cards">Cartões</option>
              <option value="compact">Compacto</option>
            </select>
          </label>
        </div>
      </div>

      <div class="notes-filter-group">
        <span class="notes-filter-label">Áreas</span>
        <div id="notes-domain-chips" class="notes-chips"></div>
      </div>
      <div class="notes-filter-group">
        <span class="notes-filter-label">Tipos</span>
        <div id="notes-kind-chips" class="notes-chips"></div>
      </div>
    </div>

    ${notes.length === 0 ? '<p style="color:var(--text-dim)">Nenhuma nota ainda.</p>' : ''}
    <div id="notes-list" data-layout="cards">${ssrItems}</div>

    <script src="/app/notes/bundle.js?v=${assetVersion('notes.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    renderShell({ title: 'Notas', active: 'notes', email: session.email, body, sidebarCollapsed: sidebarCollapsedFromReq(req) })
  );
}

export async function handleNoteDetail(req: Request, env: Env, id: string): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const note = await getNoteById(env, id);
  if (!note) {
    return htmlResponse(
      renderShell({
        title: 'Não encontrada',
        active: 'notes',
        email: session.email,
        body: '<h1>Nota não encontrada</h1><p><a href="/app/notes">← Voltar pras notas</a></p>',
        sidebarCollapsed: sidebarCollapsedFromReq(req),
      }),
      404
    );
  }

  // Task não é nota: ela tem superfície própria (/app/tasks/<id>). Redireciona pra
  // URL canônica de task — assim qualquer link antigo (card do board, noteUrl do MCP,
  // list_tasks_due_today) cai no detalhe de task em vez de no editor de nota.
  if (note.kind === 'task') {
    return new Response(null, { status: 302, headers: { location: `/app/tasks/${id}` } });
  }

  // Build a title-index for wikilink resolution.
  // (Small table — under a few thousand rows — single query is fine.)
  const allTitlesRes = await env.DB.prepare(`SELECT id, title FROM notes WHERE deleted_at IS NULL`).all<{ id: string; title: string }>();
  const titleIndex = new Map<string, string>(); // lowercased title → id
  const idSet = new Set<string>();
  for (const r of allTitlesRes.results ?? []) {
    titleIndex.set(r.title.trim().toLowerCase(), r.id);
    idSet.add(r.id);
  }

  const [outbound, inbound] = await Promise.all([
    getEdgesFrom(env, id),
    getEdgesTo(env, id),
  ]);

  const relatedIds = Array.from(
    new Set([...outbound.map((e) => e.to_id), ...inbound.map((e) => e.from_id)])
  );
  const related = new Map<string, NoteRow>();
  if (relatedIds.length > 0) {
    const placeholders = relatedIds.map(() => '?').join(',');
    const rs = await env.DB.prepare(
      `SELECT * FROM notes WHERE id IN (${placeholders}) AND deleted_at IS NULL`
    ).bind(...relatedIds).all<NoteRow>();
    for (const r of rs.results ?? []) related.set(r.id, r);
  }

  const renderEdgeCard = (otherId: string, relationType: string, why: string, direction: 'out' | 'in'): string => {
    const t = related.get(otherId);
    if (!t) return '';
    const arrow = direction === 'out' ? '→' : '←';
    return `<a class="note-card" href="/app/notes/${esc(t.id)}">
      <div class="title">${arrow} ${esc(t.title)}</div>
      <div class="meta"><span class="badge">${esc(relationType)}</span>${esc(why)}</div>
    </a>`;
  };

  const outboundHtml = outbound.length
    ? `<h2>Conectada a</h2><div class="note-edges">${outbound
        .map((e) => renderEdgeCard(e.to_id, e.relation_type, e.why, 'out'))
        .join('')}</div>`
    : '';

  const inboundHtml = inbound.length
    ? `<h2>Referenciada por</h2><div class="note-edges">${inbound
        .map((e) => renderEdgeCard(e.from_id, e.relation_type, e.why, 'in'))
        .join('')}</div>`
    : '';

  const body = `
    <h1>${esc(note.title)}</h1>
    <div class="meta" style="margin-bottom:20px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      ${note.kind ? `<span class="kind-badge">${esc(note.kind)}</span>` : ''}
      ${domainsToBadges(note.domains)}
      <span>Atualizada ${formatDate(note.updated_at)}</span>
      <button id="btn-copy-link" style="margin-left:auto;background:none;border:1px solid #333;border-radius:6px;color:#888;cursor:pointer;font-size:12px;padding:4px 10px">Copiar link</button>
    </div>

    ${relatedIds.length > 0 ? `
      <div class="local-graph-wrap">
        <div class="local-graph-controls">
          <label class="local-graph-hops">
            <span>Profundidade</span>
            <input type="range" id="local-graph-hops" min="1" max="3" step="1" value="1" />
            <span id="local-graph-hops-value">1 salto</span>
          </label>
        </div>
        <div id="local-graph" data-note-id="${esc(note.id)}" class="local-graph">
          <div id="local-graph-loading" class="center-loading" role="status" aria-live="polite">
            <div class="center-loading-spinner" aria-hidden="true"></div>
            <div>Carregando...</div>
          </div>
        </div>
      </div>
    ` : ''}

    <div class="note-body">${renderMarkdown(note.body, { titleIndex, idSet, currentId: note.id })}</div>

    <section class="note-media" data-note-id="${esc(note.id)}">
      <h2>Mídia</h2>
      <div id="media-grid" class="media-grid"></div>
      <label id="media-dropzone" class="media-dropzone">
        <input type="file" id="media-file-input" multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.zip" hidden />
        <span>Arraste arquivos aqui ou <u>clique pra escolher</u> · até 50MB</span>
      </label>
    </section>

    ${outboundHtml}
    ${inboundHtml}

    ${relatedIds.length > 0 ? `<script src="/app/notes/local-graph.bundle.js?v=${assetVersion('local-graph.bundle.js')}" defer></script>` : ''}
    <script src="/app/notes/media.bundle.js?v=${assetVersion('note-media.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    renderShell({ title: note.title, active: 'notes', email: session.email, body, extraHead: `<style>${NOTE_MEDIA_CSS}</style>`, sidebarCollapsed: sidebarCollapsedFromReq(req) })
  );
}

const TASK_STATUS_LABELS: Record<string, string> = {
  open: 'A fazer',
  in_progress: 'Em progresso',
  done: 'Concluído',
  canceled: 'Cancelado',
};

// Detalhe de TASK (/app/tasks/<id>). Task mora na mesma tabela que nota (kind='task'),
// mas NÃO se apresenta como nota: sem grafo, sem edges, sem "Copiar link" de nota —
// banner "Esta é uma task" + status/prazo/prioridade + descrição + anexos. Reusa o
// editor de mídia (task é nota por baixo, então attach_media já funciona pelo mesmo id).
export async function handleTaskDetail(req: Request, env: Env, id: string): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const task = await getTaskById(env, id);
  if (!task) {
    return htmlResponse(
      renderShell({
        title: 'Não encontrada',
        active: 'tasks',
        email: session.email,
        body: '<h1>Task não encontrada</h1><p><a href="/app/tasks">← Voltar pras tasks</a></p>',
        sidebarCollapsed: sidebarCollapsedFromReq(req),
      }),
      404
    );
  }

  const now = Date.now();
  const status = task.status ?? 'open';
  const statusLabel = TASK_STATUS_LABELS[status] ?? status;
  const overdue = task.due_at !== null && task.due_at < now && status !== 'done' && status !== 'canceled';
  const dueStr = task.due_at !== null ? `${formatBrtShort(task.due_at)} · ${relativeDue(task.due_at, now)}` : null;
  const canClose = status === 'open' || status === 'in_progress';

  const metaBits = [
    `<span class="task-d-status task-d-status-${esc(status)}">${esc(statusLabel)}</span>`,
    task.priority !== null ? `<span class="task-d-pill">P${task.priority}</span>` : '',
    dueStr ? `<span class="task-d-due${overdue ? ' overdue' : ''}">⏱ ${esc(dueStr)}</span>` : '',
    domainsToBadges(task.domains),
  ].filter(Boolean).join('');

  // Botão concluir POSTa em /app/tasks/complete. A CSP do app (script-src 'self',
  // sem unsafe-inline/script-src-attr — ver src/web/render.ts:115) BLOQUEIA
  // handler inline; o wiring vive em client/note-media.ts, que já é carregado
  // nesta página, via data-attribute [data-task-complete].
  const completeBtn = canClose
    ? `<button type="button" class="task-d-btn task-d-complete" data-task-complete data-task-id="${esc(task.id)}">✓ concluir</button>`
    : '';

  const body = `
    <div class="task-d-banner">
      <a href="/app/tasks" class="task-d-back">← Tasks</a>
      <span class="task-d-tag">Esta é uma task</span>
    </div>
    <h1>${esc(task.title)}</h1>
    <div class="task-d-meta">${metaBits}</div>
    <div class="task-d-actions">${completeBtn}<a href="/app/tasks" class="task-d-btn">abrir no board</a></div>

    <div class="note-body">${renderMarkdown(task.body, { titleIndex: new Map(), idSet: new Set(), currentId: task.id })}</div>

    <section class="note-media" data-note-id="${esc(task.id)}">
      <h2>Anexos</h2>
      <div id="media-grid" class="media-grid"></div>
      <label id="media-dropzone" class="media-dropzone">
        <input type="file" id="media-file-input" multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.zip" hidden />
        <span>Arraste arquivos aqui ou <u>clique pra escolher</u> · até 50MB</span>
      </label>
    </section>

    <script src="/app/notes/media.bundle.js?v=${assetVersion('note-media.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    renderShell({ title: task.title, active: 'tasks', email: session.email, body, extraHead: `<style>${NOTE_MEDIA_CSS}${TASK_DETAIL_CSS}</style>`, sidebarCollapsed: sidebarCollapsedFromReq(req) })
  );
}

// CSS do detalhe de task (banner + chips de status/prazo/prioridade + ações).
const TASK_DETAIL_CSS = `
.task-d-banner { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
.task-d-back { color:var(--text-dim); font-size:13px; text-decoration:none; }
.task-d-back:hover { color:var(--text); }
.task-d-tag { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--accent-lav); border:1px solid rgba(167,139,250,0.35); border-radius:999px; padding:2px 10px; }
.task-d-meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:18px; }
.task-d-status { font-size:12px; border-radius:999px; padding:3px 10px; border:1px solid var(--border-strong); color:var(--text); }
.task-d-status-open { border-color:rgba(167,139,250,0.4); }
.task-d-status-in_progress { border-color:rgba(96,165,250,0.5); color:#bfdbfe; }
.task-d-status-done { border-color:rgba(74,222,128,0.4); color:#bbf7d0; }
.task-d-status-canceled { color:var(--text-dim); }
.task-d-pill { font-size:12px; border-radius:6px; padding:3px 8px; background:var(--bg-accent); color:var(--text-dim); }
.task-d-due { font-size:12px; color:var(--text-dim); }
.task-d-due.overdue { color:#fca5a5; }
.task-d-actions { display:flex; gap:10px; margin-bottom:24px; }
.task-d-btn { font-size:13px; padding:7px 14px; border-radius:var(--radius-sm); border:1px solid var(--border); background:var(--surface); color:var(--text); cursor:pointer; text-decoration:none; }
.task-d-btn:hover { border-color:var(--border-strong); }
.task-d-complete { border-color:rgba(74,222,128,0.4); color:#bbf7d0; }
.task-d-complete:hover { background:rgba(74,222,128,0.12); }
`;

// CSS da seção de mídia da nota (injetado via extraHead — CSP permite inline style).
const NOTE_MEDIA_CSS = `
.note-media { margin: 32px 0 8px; }
.note-media h2 { font-size: 15px; margin-bottom: 12px; }
.media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; margin-bottom: 12px; }
.media-grid:empty { display: none; }
.media-tile {
  position: relative; aspect-ratio: 1; border-radius: var(--radius-sm); overflow: hidden;
  border: 1px solid var(--border); background: var(--bg-accent); cursor: pointer;
  display: flex; align-items: center; justify-content: center; color: var(--text-dim);
}
.media-tile:hover { border-color: var(--border-strong); }
.media-tile img, .media-tile video { width: 100%; height: 100%; object-fit: cover; display: block; }
.media-tile .media-doc { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px; text-align: center; font-size: 11px; word-break: break-word; }
.media-tile .media-doc svg { width: 28px; height: 28px; }
.media-dropzone {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  border: 1.5px dashed var(--border-strong); border-radius: var(--radius); padding: 18px;
  color: var(--text-dim); font-size: 13px; cursor: pointer; transition: all 160ms var(--ease);
}
.media-dropzone:hover, .media-dropzone.drag-over { color: var(--text); background: rgba(167,139,250,0.07); border-color: var(--accent-lav); }
.media-dropzone.uploading { opacity: 0.6; pointer-events: none; }
.media-modal {
  position: fixed; inset: 0; background: rgba(7,10,19,0.88); z-index: 1000;
  display: flex; align-items: center; justify-content: center; padding: 24px; flex-direction: column; gap: 14px;
}
.media-modal[hidden] { display: none; }
.media-modal img, .media-modal video { max-width: 90vw; max-height: 78vh; border-radius: var(--radius); }
.media-modal .media-modal-bar { display: flex; gap: 12px; align-items: center; }
.media-modal a, .media-modal button {
  background: var(--surface); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 7px 14px; font-size: 13px; cursor: pointer; text-decoration: none;
}
.media-modal .media-del { color: #fca5a5; border-color: rgba(239,68,68,0.3); }
.media-modal .media-del:hover { background: rgba(239,68,68,0.14); }
`;
