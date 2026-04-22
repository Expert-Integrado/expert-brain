import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse } from './render.js';
import { renderMarkdown } from './markdown.js';
import {
  getNoteById,
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
    `SELECT id, title, domains, kind, tldr, updated_at FROM notes ORDER BY updated_at DESC`
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
      <h1>Notes</h1>
      <span class="count" id="notes-count">${notes.length} ${notes.length === 1 ? 'note' : 'notes'}</span>
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
          placeholder="Search notes (press / to focus)"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="notes-toolbar-actions">
          <label>
            <span class="sr-label">Sort</span>
            <select id="notes-sort" class="notes-select">
              <option value="updated_desc">Updated ↓</option>
              <option value="title_asc">Title A–Z</option>
              <option value="kind">Kind</option>
            </select>
          </label>
          <label>
            <span class="sr-label">Layout</span>
            <select id="notes-layout" class="notes-select">
              <option value="cards">Cards</option>
              <option value="compact">Compact</option>
            </select>
          </label>
        </div>
      </div>

      <div class="notes-filter-group">
        <span class="notes-filter-label">Domains</span>
        <div id="notes-domain-chips" class="notes-chips"></div>
      </div>
      <div class="notes-filter-group">
        <span class="notes-filter-label">Kinds</span>
        <div id="notes-kind-chips" class="notes-chips"></div>
      </div>
    </div>

    ${notes.length === 0 ? '<p style="color:var(--text-dim)">No notes yet.</p>' : ''}
    <div id="notes-list" data-layout="cards">${ssrItems}</div>

    <script src="/app/notes/bundle.js" defer></script>
  `;

  return htmlResponse(
    renderShell({ title: 'Notes', active: 'notes', email: session.email, body })
  );
}

export async function handleNoteDetail(req: Request, env: Env, id: string): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const note = await getNoteById(env, id);
  if (!note) {
    return htmlResponse(
      renderShell({
        title: 'Not found',
        active: 'notes',
        email: session.email,
        body: '<h1>Note not found</h1><p><a href="/app/notes">← Back to notes</a></p>',
      }),
      404
    );
  }

  // Build a title-index for wikilink resolution.
  // (Small table — under a few thousand rows — single query is fine.)
  const allTitlesRes = await env.DB.prepare(`SELECT id, title FROM notes`).all<{ id: string; title: string }>();
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
      `SELECT * FROM notes WHERE id IN (${placeholders})`
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
    ? `<h2>Connected to</h2><div class="note-edges">${outbound
        .map((e) => renderEdgeCard(e.to_id, e.relation_type, e.why, 'out'))
        .join('')}</div>`
    : '';

  const inboundHtml = inbound.length
    ? `<h2>Referenced by</h2><div class="note-edges">${inbound
        .map((e) => renderEdgeCard(e.from_id, e.relation_type, e.why, 'in'))
        .join('')}</div>`
    : '';

  const body = `
    <h1>${esc(note.title)}</h1>
    <div class="meta" style="margin-bottom:20px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      ${note.kind ? `<span class="kind-badge">${esc(note.kind)}</span>` : ''}
      ${domainsToBadges(note.domains)}
      <span>Updated ${formatDate(note.updated_at)}</span>
    </div>

    ${relatedIds.length > 0 ? `<div id="local-graph" data-note-id="${esc(note.id)}" class="local-graph"></div>` : ''}

    <div class="note-body">${renderMarkdown(note.body, { titleIndex, idSet, currentId: note.id })}</div>
    ${outboundHtml}
    ${inboundHtml}

    ${relatedIds.length > 0 ? '<script src="/app/notes/local-graph.bundle.js" defer></script>' : ''}
  `;

  return htmlResponse(
    renderShell({ title: note.title, active: 'notes', email: session.email, body })
  );
}
