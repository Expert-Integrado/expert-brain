import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { assetVersion } from './asset-version.js';
import { renderMarkdown } from './markdown.js';
import { brtDatetimeLocal, brtDateOnly, brtTimeOnly, formatBrtDateTime } from '../util/time.js';
import { PRIORITIES } from '../util/priority.js';
import {
  getNoteById,
  getTaskById,
  getEdgesFrom,
  getEdgesTo,
  updateNote,
  setNotePrivate,
  insertTask,
  listTaskComments,
  listKanbanColumns,
  resolveTaskColumn,
  getTagsByNote,
  listTaskProjects,
  listMentionsForNote,
  listTasksFromOrigin,
  TASK_STATUSES,
  KNOWLEDGE_KINDS,
  type NoteRow,
  type EdgeRow,
  type NoteKind,
} from '../db/queries.js';
import { validateDomains } from '../db/validation.js';
import { reembedNoteIfNeeded } from '../db/note-write.js';
import { applyMentions } from '../mcp/mentions.js';
import { newId } from '../util/id.js';
import { getShareStatus } from './share.js';
import { renderCommentThread } from './comments-render.js';
import { visibleTags } from './tasks.js';
import { resolveDomainMeta, resolveKindMeta, type TaxonomyConfig } from './domain-colors.js';
import { getTaxonomyConfig, mergedDomainSlugs } from './taxonomy-config.js';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

interface NoteListItem {
  id: string;
  title: string;
  domains: string;
  kind: string | null;
  tldr: string;
  updated_at: number;
  private: number; // selo de privacidade (spec 31): 1 = badge 🔒 no card
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

function domainsToBadges(raw: string, taxonomy: TaxonomyConfig): string {
  return parseDomains(raw)
    .map((d) => {
      const meta = resolveDomainMeta(d, taxonomy);
      return `<span class="badge" style="--chip:${esc(meta.color)}">${esc(meta.label)}</span>`;
    })
    .join('');
}

const NOTES_PAGE_SIZE = 100;

// Menções (spec 62): chips + editor @ na nota, chips read-only na task. CSS enxuto,
// reusa as variáveis do tema. Injetado no extraHead do detalhe de nota e de task.
const MENTIONS_CSS = `
.note-mentions, .note-origin-tasks { margin-top:28px; }
.mention-chips { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
.mention-chip { display:inline-flex; align-items:center; gap:6px; font-size:13px; padding:3px 6px 3px 10px; border:1px solid var(--border); border-radius:999px; background:var(--surface); }
.mention-chip a { color:var(--text); text-decoration:none; }
.mention-chip a:hover { color:var(--accent-lav); }
.mention-chip-remove { border:none; background:transparent; color:var(--text-dim); cursor:pointer; font-size:15px; line-height:1; padding:0 4px; }
.mention-chip-remove:hover { color:#fca5a5; }
.mention-add { position:relative; max-width:360px; }
.mention-add-input { width:100%; font-size:14px; padding:7px 10px; border-radius:var(--radius-sm); border:1px solid var(--border); background:var(--surface); color:var(--text); }
.mention-add-input:focus { outline:none; border-color:var(--accent-lav); }
.mention-suggest { position:absolute; z-index:20; left:0; right:0; margin-top:4px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-sm); max-height:240px; overflow-y:auto; box-shadow:0 8px 24px rgba(0,0,0,0.35); }
.mention-suggest-item { display:block; width:100%; text-align:left; padding:8px 12px; font-size:14px; background:transparent; border:none; color:var(--text); cursor:pointer; }
.mention-suggest-item:hover, .mention-suggest-item.active { background:rgba(167,139,250,0.14); }
.mention-suggest-empty { padding:8px 12px; font-size:13px; color:var(--text-dim); }
.mention-status { font-size:13px; color:var(--text-dim); margin-top:8px; min-height:1em; }
.note-origin-empty { color:var(--text-dim); font-size:14px; }
.task-d-origin { font-size:13px; color:var(--text-dim); }
.task-d-origin a { color:var(--accent-lav); text-decoration:none; }
`;

export async function handleNotesList(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  // Paginação SSR (spec 23): LIMIT + OFFSET em vez de serializar as ~1800 notas
  // em toda visita. offset saneado — inteiro >= 0; qualquer lixo vira 0.
  const url = new URL(req.url);
  const rawOffset = Number(url.searchParams.get('offset') ?? '0');
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  const [rows, totalRow, taxonomy] = await Promise.all([
    env.DB.prepare(
      // Sessão do dono (requireSession) — a lista mostra TODAS as notas, privadas
      // incluídas, com o badge 🔒 (spec 31). Nenhum filtro de private aqui.
      `SELECT id, title, domains, kind, tldr, updated_at, private FROM notes
       WHERE deleted_at IS NULL AND (kind IS NULL OR kind <> 'task')
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`
    ).bind(NOTES_PAGE_SIZE + 1, offset).all<NoteListItem>(),
    env.DB.prepare(
      `SELECT COUNT(*) c FROM notes WHERE deleted_at IS NULL AND (kind IS NULL OR kind <> 'task')`
    ).first<{ c: number }>(),
    getTaxonomyConfig(env),
  ]);
  const all = rows.results ?? [];
  // Buscamos PAGE_SIZE+1 pra saber se há mais SEM um COUNT extra da página.
  const page = all.slice(0, NOTES_PAGE_SIZE);
  const hasMore = all.length > NOTES_PAGE_SIZE;
  const total = totalRow?.c ?? page.length;

  // SSR list — client bundle replaces this once /app/graph/meta loads, but
  // leaving it in place keeps the no-JS fallback useful and gives the browser
  // something to paint immediately.
  const ssrItems = page
    .map((n) => {
      const kindMeta = n.kind ? resolveKindMeta(n.kind, taxonomy) : null;
      const privBadge = n.private ? '<span class="private-badge" title="Nota privada">🔒 privada</span>' : '';
      return `
      <a class="note-card" href="/app/notes/${esc(n.id)}" data-note-id="${esc(n.id)}" data-updated-at="${n.updated_at}"${n.private ? ' data-private="1"' : ''}>
        <div class="note-card-head">${kindMeta ? `<span class="kind-badge" style="--chip:${esc(kindMeta.color)}">${esc(kindMeta.label)}</span>` : ''}${privBadge}<span class="note-card-date">${formatDate(n.updated_at)}</span></div>
        <div class="title">${esc(n.title)}</div>
        ${n.tldr ? `<div class="note-card-tldr">${esc(n.tldr)}</div>` : ''}
        <div class="meta">${domainsToBadges(n.domains, taxonomy)}</div>
      </a>`;
    })
    .join('');

  // Link no-JS-friendly de paginação. Com JS o client vira janela de render (append),
  // sem JS o link navega pra próxima página por offset. Empty-state só quando o vault
  // está vazio (total===0); offset além do fim mostra "voltar ao início".
  const loadMoreHtml = hasMore
    ? `<a id="notes-load-more" class="notes-load-more" href="/app/notes?offset=${offset + NOTES_PAGE_SIZE}">Carregar mais</a>`
    : (offset > 0 && page.length === 0
        ? `<a id="notes-load-more" class="notes-load-more" href="/app/notes">← Voltar pro início</a>`
        : '');

  const body = `
    <div class="page-header">
      <h1>Notas</h1>
      <span class="count" id="notes-count">${total} ${total === 1 ? 'nota' : 'notas'}</span>
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

    ${total === 0 ? '<p style="color:var(--text-dim)">Nenhuma nota ainda.</p>' : ''}
    <div id="notes-list" data-layout="cards">${ssrItems}</div>
    ${loadMoreHtml}

    <script src="/app/notes/bundle.js?v=${assetVersion('notes.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    await renderShell({ title: 'Notas', active: 'notes', email: session.email, env, body, sidebarCollapsed: sidebarCollapsedFromReq(req) })
  );
}

export async function handleNoteDetail(req: Request, env: Env, id: string): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  // Sessão do dono (requireSession) vê notas privadas normalmente (spec 31).
  const note = await getNoteById(env, id, false, /* includePrivate */ true);
  if (!note) {
    return htmlResponse(
      await renderShell({
        title: 'Não encontrada',
        active: 'notes',
        email: session.email,
        env,
        body: '<h1>Nota não encontrada</h1><p><a href="/app/notes">← Voltar pras notas</a></p>',
        sidebarCollapsed: sidebarCollapsedFromReq(req),
      }),
      404
    );
  }
  const isPrivate = (note.private ?? 0) === 1;

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

  const [outbound, inbound, taxonomy, mentions, tasksFromNote] = await Promise.all([
    getEdgesFrom(env, id, /* includePrivate */ true),
    getEdgesTo(env, id, /* includePrivate */ true),
    getTaxonomyConfig(env),
    // Menções (spec 62): contatos citados por esta nota (chips) + tasks originadas dela.
    listMentionsForNote(env, id),
    listTasksFromOrigin(env, id, /* includePrivate */ true),
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

  // Menções (spec 62): seção de contatos citados, editável via @autocomplete (note-edit.ts).
  // Os chips SSR nascem prontos; o client hidrata add/remove. data-mentions-editor guarda
  // o id da nota; cada chip tem data-entity-id pra o botão de remover.
  const mentionChip = (entityId: string, label: string | null): string =>
    `<span class="mention-chip" data-entity-id="${esc(entityId)}">
      <a href="/app/contacts/${esc(entityId)}">${esc(label || entityId)}</a>
      <button type="button" class="mention-chip-remove" data-mention-remove="${esc(entityId)}" title="Remover menção" aria-label="Remover menção">×</button>
    </span>`;
  const mentionsHtml = `
    <section class="note-mentions" data-mentions-editor="${esc(note.id)}">
      <h2>Contatos mencionados</h2>
      <div class="mention-chips" data-mention-chips>${mentions.map((m) => mentionChip(m.entity_id, m.entity_label)).join('')}</div>
      <div class="mention-add">
        <input type="text" class="mention-add-input" data-mention-input placeholder="@ mencionar contato..." autocomplete="off" />
        <div class="mention-suggest" data-mention-suggest hidden></div>
      </div>
      <div class="mention-status" data-mention-status role="status" aria-live="polite"></div>
    </section>`;

  // Tasks originadas desta nota (spec 62 §4) + botão "Criar task desta nota".
  const tasksFromNoteHtml = `
    <section class="note-origin-tasks" data-origin-tasks="${esc(note.id)}">
      <h2>Tasks originadas desta nota</h2>
      <div class="note-edges" data-origin-tasks-list>${tasksFromNote.length
        ? tasksFromNote.map((t) => `<a class="note-card" href="/app/tasks/${esc(t.id)}"><div class="title">${esc(t.title)}</div><div class="meta"><span class="badge">${esc(t.status ?? 'open')}</span></div></a>`).join('')
        : '<p class="note-origin-empty">Nenhuma task nasceu desta nota ainda.</p>'}</div>
      <button type="button" class="note-edit-copy" data-create-task-from-note="${esc(note.id)}">Criar task desta nota</button>
    </section>`;

  // Edição inline (spec 36 fase 2). Modo LEITURA é o default visual: campos parecem
  // texto até hover/focus (borderless). Título grande editável, tldr com contador,
  // kind (select 7) e domínios (multi-select 12, máx 3) autosave, corpo markdown
  // com botão Salvar + prévia. Concorrência otimista via data-updated-at. CSP:
  // wiring todo em client/note-edit.ts (zero inline). Edges/grafo/mídia intocados.
  const currentDomains = parseDomains(note.domains);
  const kindOptions = KNOWLEDGE_KINDS.map((k) => {
    const label = resolveKindMeta(k, taxonomy).label;
    return `<option value="${esc(k)}"${k === note.kind ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
  // União: 12 canônicos + pré-criados na config + os domínios ATUAIS desta nota
  // (mesmo que fora do canon — legado ou salvo via allow_new_domain no MCP). Sem
  // isto, um domínio fora da lista nunca teria checkbox pra ser marcado de volta
  // e sumiria da nota no próximo autosave de domains (perda silenciosa de dado).
  const domainSlugs = mergedDomainSlugs(taxonomy, currentDomains);
  const domainChecks = domainSlugs.map((d) => {
    const checked = currentDomains.includes(d) ? ' checked' : '';
    const meta = resolveDomainMeta(d, taxonomy);
    const slugHint = meta.label !== d ? ` <code class="note-edit-domain-slug">${esc(d)}</code>` : '';
    return `<label class="note-edit-domain"><input type="checkbox" data-domain="${esc(d)}"${checked} />${esc(meta.label)}${slugHint}</label>`;
  }).join('');
  const tldrLen = (note.tldr ?? '').trim().length;

  const body = `
    <div class="note-edit" data-note-id="${esc(note.id)}" data-updated-at="${note.updated_at}">
      <div class="note-edit-titlerow">
        <input type="text" class="note-edit-title" data-field="title" value="${esc(note.title)}" maxlength="200" placeholder="Título da nota" aria-label="Título da nota" />
        ${isPrivate ? '<span class="private-badge" title="Nota privada — invisível pra credenciais sem escopo private">🔒 privada</span>' : ''}
        <button type="button" class="note-edit-save" data-save="title">Salvar</button>
      </div>

      <div class="note-edit-meta">
        <div class="note-edit-ctl">
          <span class="note-edit-lbl">Tipo</span>
          <select class="note-edit-select" data-field="kind" aria-label="Tipo da nota">${kindOptions}</select>
        </div>
        <div class="note-edit-ctl note-edit-ctl-domains">
          <span class="note-edit-lbl">Áreas (máx 3)</span>
          <div class="note-edit-domains" data-field="domains">${domainChecks}</div>
        </div>
        <span class="note-edit-updated">Atualizada ${formatDate(note.updated_at)}</span>
        <button id="btn-copy-link" class="note-edit-copy" type="button">Copiar link</button>
        <form method="post" action="/app/notes/${esc(note.id)}/private" class="note-private-form">
          <input type="hidden" name="private" value="${isPrivate ? '0' : '1'}" />
          <button type="submit" class="note-edit-copy note-private-toggle" data-private-toggle>${isPrivate ? 'Tornar pública' : 'Tornar privada'}</button>
        </form>
      </div>

      <div class="note-edit-ctl note-edit-ctl-tldr">
        <span class="note-edit-lbl">Resumo (tldr · 10-280)</span>
        <textarea class="note-edit-tldr" data-field="tldr" rows="2" maxlength="280" aria-label="Resumo">${esc(note.tldr ?? '')}</textarea>
        <span class="note-edit-tldr-count" data-tldr-count>${tldrLen}/280</span>
      </div>
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

    <div class="note-edit-bodyrow note-edit" data-note-id="${esc(note.id)}">
      <div class="note-edit-bodyhead">
        <span class="note-edit-lbl">Corpo (markdown)</span>
        <button type="button" class="note-edit-save" data-save="body">Salvar corpo</button>
      </div>
      <textarea class="note-edit-body" data-field="body" rows="12" aria-label="Corpo em markdown">${esc(note.body)}</textarea>
      <div class="note-edit-preview-head">Prévia</div>
      <div class="note-body note-edit-preview" data-preview>${renderMarkdown(note.body, { titleIndex, idSet, currentId: note.id })}</div>
      <div class="note-edit-status" data-editstatus role="status" aria-live="polite"></div>
    </div>

    <section class="note-media" data-note-id="${esc(note.id)}">
      <h2>Mídia</h2>
      <div id="media-grid" class="media-grid"></div>
      <label id="media-dropzone" class="media-dropzone">
        <input type="file" id="media-file-input" multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.zip" hidden />
        <span>Arraste arquivos aqui ou <u>clique pra escolher</u> · até 50MB</span>
      </label>
    </section>

    ${mentionsHtml}
    ${tasksFromNoteHtml}

    ${outboundHtml}
    ${inboundHtml}

    ${relatedIds.length > 0 ? `<script src="/app/notes/local-graph.bundle.js?v=${assetVersion('local-graph.bundle.js')}" defer></script>` : ''}
    <script src="/app/notes/edit.bundle.js?v=${assetVersion('note-edit.bundle.js')}" defer></script>
    <script src="/app/notes/media.bundle.js?v=${assetVersion('note-media.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    await renderShell({ title: note.title, active: 'notes', email: session.email, env, body, extraHead: `<style>${NOTE_MEDIA_CSS}${NOTE_EDIT_CSS}${MENTIONS_CSS}</style>`, sidebarCollapsed: sidebarCollapsedFromReq(req) })
  );
}

// POST /app/notes/update — edição inline de NOTA de conhecimento pela UI (spec 36
// fase 2). SÓ sessão de browser (requireSession — sem Bearer de leitura): é edição
// humana logada, não automação. Body:
//   { id, patch: { title?, body?, tldr?, domains?, kind? }, expected_updated_at? }
// Validações IDÊNTICAS às de update_note (title 1-200, tldr 10-280, domains via
// validateDomains, kind nos 7 canônicos). 409 com current_updated_at em conflito;
// 400 em input inválido; 404 se a nota for task (task edita por /app/tasks/update)
// ou não existir. Reusa updateNote + reembedNoteIfNeeded (funções compartilhadas
// com a tool MCP) — zero lógica de reembed/validação reimplementada aqui.
export async function handleNoteUpdatePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  let body: {
    id?: string;
    patch?: {
      title?: unknown;
      body?: unknown;
      tldr?: unknown;
      domains?: unknown;
      kind?: unknown;
    };
    expected_updated_at?: unknown;
    // Menções (spec 62): ids de contato pra vincular/desvincular. Top-level (não no
    // patch) — não são colunas de `notes`, têm caminho próprio (tabela `mentions`).
    mentions?: unknown;
    mentions_remove?: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const id = (body.id || '').trim();
  if (!id) return json({ error: 'id required' }, 400);
  const p = (body.patch && typeof body.patch === 'object') ? body.patch : {};

  // Menções (spec 62): arrays de ids de contato (strings). Inválidos → 400.
  const parseIds = (v: unknown): string[] | undefined | null => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null;
    return (v as string[]).map((s) => s.trim()).filter(Boolean);
  };
  const mentionsAdd = parseIds(body.mentions);
  const mentionsRemove = parseIds(body.mentions_remove);
  if (mentionsAdd === null || mentionsRemove === null) {
    return json({ error: 'mentions/mentions_remove must be arrays of string ids' }, 400);
  }
  const touchesMentions = (mentionsAdd?.length ?? 0) > 0 || (mentionsRemove?.length ?? 0) > 0;

  // expected_updated_at (opcional): inteiro ms. null/omitido = last-write-wins.
  let expectedUpdatedAt: number | undefined;
  if (body.expected_updated_at !== undefined && body.expected_updated_at !== null) {
    if (typeof body.expected_updated_at !== 'number' || !Number.isFinite(body.expected_updated_at)) {
      return json({ error: 'expected_updated_at must be a number (unix ms)' }, 400);
    }
    expectedUpdatedAt = body.expected_updated_at;
  }

  // title — texto livre 1..200 (mesma faixa do inputSchema de update_note).
  let title: string | undefined;
  if (p.title !== undefined) {
    if (typeof p.title !== 'string') return json({ error: 'title must be a string' }, 400);
    const t = p.title.trim();
    if (t.length < 1 || t.length > 200) return json({ error: 'title must be 1-200 chars' }, 400);
    title = t;
  }

  // body — texto livre (markdown). min 1 (igual update_note). Só entra se presente.
  let noteBody: string | undefined;
  if (p.body !== undefined) {
    if (typeof p.body !== 'string') return json({ error: 'body must be a string' }, 400);
    const b = p.body.trim();
    if (b.length < 1) return json({ error: 'body must not be empty' }, 400);
    noteBody = b;
  }

  // tldr — 10..280 (Feynman, mesma regra de update_note).
  let tldr: string | undefined;
  if (p.tldr !== undefined) {
    if (typeof p.tldr !== 'string') return json({ error: 'tldr must be a string' }, 400);
    const t = p.tldr.trim();
    if (t.length < 10 || t.length > 280) return json({ error: 'tldr must be 10-280 chars' }, 400);
    tldr = t;
  }

  // domains — 1..3 slugs. Canônicos SEMPRE aceitos; slugs pré-criados na
  // taxonomia do dono (spec 54, /app/config "Áreas e tipos") também — só
  // texto arbitrário digitado às cegas continua rejeitado (allowNewDomain
  // segue false: essa é a válvula do MCP, não do editor web).
  let domains: string[] | undefined;
  if (p.domains !== undefined) {
    if (!Array.isArray(p.domains) || p.domains.some((d) => typeof d !== 'string')) {
      return json({ error: 'domains must be an array of strings' }, 400);
    }
    const arr = p.domains as string[];
    if (arr.length < 1 || arr.length > 3) return json({ error: 'domains must have 1-3 entries' }, 400);
    const taxonomyForValidation = await getTaxonomyConfig(env);
    const domainError = validateDomains(arr, {
      allowNewDomain: false,
      extraAllowed: Object.keys(taxonomyForValidation.domains),
    });
    if (domainError) return json({ error: domainError }, 400);
    domains = arr;
  }

  // kind — um dos 7 canônicos (KNOWLEDGE_KINDS; 'task' NÃO é aceito aqui).
  let kind: NoteKind | undefined;
  if (p.kind !== undefined) {
    const k = String(p.kind).trim();
    if (!(KNOWLEDGE_KINDS as readonly string[]).includes(k)) {
      return json({ error: `kind must be one of ${KNOWLEDGE_KINDS.join(', ')}` }, 400);
    }
    kind = k as NoteKind;
  }

  const hasFieldEdit = title !== undefined || noteBody !== undefined || tldr !== undefined
    || domains !== undefined || kind !== undefined;
  if (!hasFieldEdit && !touchesMentions) {
    return json({ error: 'patch must include at least one of: title, body, tldr, domains, kind (or mentions/mentions_remove)' }, 400);
  }

  // Sessão do dono edita notas privadas normalmente (spec 31).
  const existing = await getNoteById(env, id, false, /* includePrivate */ true);
  if (!existing) return json({ error: 'note not found' }, 404);
  // Task se edita SÓ por /app/tasks/update (mesma regra de update_note MCP). 404 pra
  // não vazar que o id existe como task neste editor de nota.
  if (existing.kind === 'task') {
    return json({ error: 'note not found' }, 404);
  }

  const now = Date.now();
  if (hasFieldEdit) {
    const result = await updateNote(env, id, {
      title, body: noteBody, tldr,
      domains: domains !== undefined ? JSON.stringify(domains) : undefined,
      kind,
      updated_at: now,
    }, expectedUpdatedAt);

    if (result === 'conflict') {
      // Relê pra devolver o updated_at atual — a UI mostra "editada em outro lugar,
      // recarregue" sem sobrescrever. Mesmo espírito do 409 de /app/tasks/update.
      const current = await getNoteById(env, id, false, /* includePrivate */ true);
      return json({
        error: 'conflict',
        message: 'Esta nota foi editada em outro lugar. Recarregue antes de salvar.',
        current_updated_at: current?.updated_at ?? null,
      }, 409);
    }
  }

  // Menções (spec 62): add/remove pelo editor (chips + @autocomplete). Tolerante a falha
  // do contacts (applyMentions engole tudo — a menção D1 grava, o evento é eco). A sessão
  // do dono vê privados, então seePrivate=true (fetch de label com o header).
  let mentionsChanged: { created: number; removed: number } | undefined;
  if (touchesMentions) {
    mentionsChanged = await applyMentions(env, {
      noteId: id,
      title: title ?? existing.title,
      url: `${(env.WORKER_URL ?? '').replace(/\/$/, '')}/app/notes/${id}`,
      add: mentionsAdd,
      remove: mentionsRemove,
      seePrivate: true,
    });
  }

  // Re-embeda pela função compartilhada (só se tldr/domains/kind mudou de fato).
  // Best-effort: a edição já está persistida em D1 (o UPDATE acima commitou). Uma
  // falha de Workers AI/Vectorize não pode perder o save do usuário nem retornar
  // erro — o recall só fica ~1-2 min desatualizado até o próximo write path.
  let reembedded = false;
  if (hasFieldEdit) {
    try {
      reembedded = await reembedNoteIfNeeded(env, existing, {
        title, body: noteBody, tldr, domains, kind,
      });
    } catch (err) {
      console.error('handleNoteUpdatePost: reembed failed (edit persisted anyway)', err);
    }
  }

  return json({
    ok: true,
    id,
    updated_at: now,
    reembedded,
    ...(mentionsChanged ? { mentions_created: mentionsChanged.created, mentions_removed: mentionsChanged.removed } : {}),
  });
}

// POST /app/notes/task-from-note — cria uma task A PARTIR de uma nota (spec 62 §2):
// registra origin_note_id + HERDA as menções da nota. Sessão do dono (requireSession).
// Body JSON { note_id, title? } — title default = título da nota. Retorna { ok, id, url }.
export async function handleTaskFromNotePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  let body: { note_id?: unknown; title?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
  const noteId = (typeof body.note_id === 'string' ? body.note_id : '').trim();
  if (!noteId) return json({ error: 'note_id required' }, 400);

  // Sessão do dono → vê nota privada. Task NÃO origina task (só nota de conhecimento).
  const origin = await getNoteById(env, noteId, false, /* includePrivate */ true);
  if (!origin || origin.kind === 'task') return json({ error: 'note not found' }, 404);

  const title = (typeof body.title === 'string' && body.title.trim())
    ? body.title.trim().slice(0, 200)
    : origin.title.slice(0, 200);

  const now = Date.now();
  const id = newId();
  await insertTask(env, {
    id,
    title,
    body: title,
    tldr: title.slice(0, 280),
    domains: JSON.stringify(['operations']),
    status: 'open',
    due_at: null,
    priority: null,
    project_id: null,
    // A task herda a privacidade da nota de origem (nota privada → task privada), pra
    // não vazar uma decisão sensível numa task pública.
    private: (origin.private ?? 0) === 1 ? 1 : 0,
    origin_note_id: noteId,
    created_at: now,
    updated_at: now,
  });

  // Herda as menções da nota de origem (spec 62 §2). Tolerante a falha do contacts.
  const inherited = await listMentionsForNote(env, noteId);
  if (inherited.length > 0) {
    await applyMentions(env, {
      noteId: id,
      title,
      url: `${(env.WORKER_URL ?? '').replace(/\/$/, '')}/app/tasks/${id}`,
      add: inherited.map((m) => m.entity_id),
      seePrivate: true,
    });
  }

  return json({ ok: true, id, url: `${(env.WORKER_URL ?? '').replace(/\/$/, '')}/app/tasks/${id}` });
}

// POST /app/notes/{id}/private — toggle do SELO DE PRIVACIDADE (spec 31). É a ÚNICA
// superfície que DESMARCA uma nota (torna pública). SÓ sessão de browser
// (requireSession — sem Bearer/PAT): é curadoria humana logada; PAT/bearer caem em
// 401/redirect antes de chegar aqui. Aceita form-encoded (a UI da nota usa um <form>
// simples, CSP-safe, e recebe 302 de volta pra nota) OU JSON { private: boolean }
// (recebe JSON). Task NÃO se marca aqui (404 — privacidade de task é a spec 59).
export async function handleNotePrivatePost(req: Request, env: Env, id: string): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const ct = req.headers.get('content-type') || '';
  const wantsJson = ct.includes('application/json');
  let makePrivate: boolean;
  if (wantsJson) {
    let reqBody: { private?: unknown };
    try { reqBody = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }
    if (typeof reqBody.private !== 'boolean') return json({ error: 'private must be a boolean' }, 400);
    makePrivate = reqBody.private;
  } else {
    const form = await req.formData();
    makePrivate = String(form.get('private') ?? '') === '1';
  }

  const existing = await getNoteById(env, id, false, /* includePrivate */ true);
  const notFound = (): Response => wantsJson
    ? json({ error: 'note not found' }, 404)
    : new Response(null, { status: 302, headers: { location: '/app/notes' } });
  if (!existing) return notFound();
  // Task tem superfície própria (spec 59) — 404 pra não vazar que o id existe como task.
  if (existing.kind === 'task') return notFound();

  await setNotePrivate(env, id, makePrivate ? 1 : 0, Date.now(), `oauth:${session.email}`);

  return wantsJson
    ? json({ ok: true, id, private: makePrivate })
    : new Response(null, { status: 302, headers: { location: `/app/notes/${id}` } });
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

  // includePrivate=true (spec 59): o detalhe é a sessão do dono — vê task privada.
  const task = await getTaskById(env, id, true);
  if (!task) {
    return htmlResponse(
      await renderShell({
        title: 'Não encontrada',
        active: 'tasks',
        email: session.email,
        env,
        body: '<h1>Task não encontrada</h1><p><a href="/app/tasks">← Voltar pras tasks</a></p>',
        sidebarCollapsed: sidebarCollapsedFromReq(req),
      }),
      404
    );
  }

  const status = task.status ?? 'open';
  const canClose = status === 'open' || status === 'in_progress';
  const dueDate = task.due_at !== null ? brtDateOnly(task.due_at) : '';
  const dueTime = task.due_at !== null ? brtTimeOnly(task.due_at) : '';

  // Estado do compartilhamento público (spec 33) pra o SSR já vir com o painel certo.
  // Nunca expõe token plaintext (o banco só tem o hash) — só se está compartilhada e
  // até quando. O link real só é revelado quando o dono clica "Compartilhar" e o
  // endpoint devolve a URL (uma vez). expired = tinha share mas passou da validade.
  // Thread de comentários (spec 53): últimos 500 em ordem cronológica. O dono pode
  // apagar qualquer um (deleteTaskId habilita o botão de moderação por item).
  const [comments, taxonomy, taskMentions] = await Promise.all([
    listTaskComments(env, task.id, 500, 0),
    getTaxonomyConfig(env),
    // Menções (spec 62): contatos que esta task cita (chips de leitura + link).
    listMentionsForNote(env, task.id),
  ]);
  // Origem (spec 62): nota que originou a task ("Criar task desta nota").
  const originNote = task.origin_note_id
    ? await getNoteById(env, task.origin_note_id, false, /* includePrivate */ true)
    : null;
  const activitySection = `
    <section class="task-activity" id="atividade">
      <h2>Atividade</h2>
      ${renderCommentThread(comments, { deleteTaskId: task.id })}
      <form class="cmt-form" method="post" action="/app/tasks/comment">
        <input type="hidden" name="task_id" value="${esc(task.id)}" />
        <label class="cmt-field">
          <span class="cmt-lbl">Novo comentário</span>
          <textarea name="body" rows="3" maxlength="4000" required placeholder="Escreva um comentário"></textarea>
        </label>
        <div class="cmt-form-foot">
          <button type="submit" class="task-d-btn cmt-submit">Comentar</button>
        </div>
      </form>
    </section>`;

  // Selo de privacidade (spec 59): task privada NUNCA tem link público. Em vez do painel
  // de compartilhamento, mostra um aviso — o link só volta a existir se a task for tornada
  // pública (toggle abaixo). Isso também evita o botão "Compartilhar" que erraria (409).
  const isPrivate = task.private === 1;
  const shareStatus = isPrivate ? null : await getShareStatus(env, task.id, Date.now());
  const shared = shareStatus?.shared ?? false;
  const shareExpiresBrt = shareStatus?.expires_brt ?? '';
  const shareExpired = shareStatus?.expired ?? false;
  const shareStateHtml = shared
    ? (shareExpired
        ? `Havia um link público, mas <strong>expirou</strong> em ${esc(shareExpiresBrt)}. Gere um novo abaixo.`
        : `Esta task tem um link público ativo, válido até <strong>${esc(shareExpiresBrt)}</strong>. O link só aparece no momento em que é gerado (o banco guarda só o hash). Gere de novo pra revê-lo (isso troca o link), ou revogue.`)
    : `Esta task não está compartilhada. Gere um link público read-only pra enviar a alguém sem conta.`;
  const shareSection = isPrivate
    ? `
    <section class="task-share" data-task-id="${esc(task.id)}" data-shared="0" data-private="1">
      <h2>Compartilhamento público</h2>
      <p class="task-share-state" data-share-state>Task <strong>privada</strong>: não pode ter link público. Torne-a pública (acima) pra compartilhar.</p>
    </section>`
    : `
    <section class="task-share" data-task-id="${esc(task.id)}" data-shared="${shared ? '1' : '0'}">
      <h2>Compartilhamento público</h2>
      <p class="task-share-state" data-share-state>${shareStateHtml}</p>
      <div class="task-share-controls">
        <label class="task-share-ttl">
          <span>Validade (dias)</span>
          <input type="number" min="1" max="365" value="30" data-share-days aria-label="Validade em dias" />
        </label>
        <button type="button" class="task-d-btn task-share-btn" data-share-generate>${shared && !shareExpired ? 'Gerar novo link' : 'Compartilhar'}</button>
        <button type="button" class="task-d-btn task-share-revoke" data-share-revoke ${shared ? '' : 'hidden'}>Revogar</button>
      </div>
      <div class="task-share-link" data-share-link hidden>
        <input type="text" readonly data-share-url aria-label="Link público" />
        <button type="button" class="task-d-btn" data-share-copy>Copiar</button>
      </div>
      <div class="task-share-status" data-share-status role="status" aria-live="polite"></div>
    </section>`;

  // Toggle privada/pública (spec 59): form plano (CSP-safe), sessão do dono. Marcar
  // privada revoga o link público na mesma escrita (server). Mesma UX do toggle de nota.
  const privateSection = `
    <section class="task-private" data-task-private>
      <h2>Privacidade</h2>
      <p class="task-private-state">${isPrivate
        ? 'Esta task é <strong>privada</strong>: invisível pra credenciais sem escopo <code>private</code> e sem link público.'
        : 'Esta task é <strong>pública</strong>: qualquer credencial válida a vê.'}</p>
      <form method="post" action="/app/tasks/private" class="task-private-form">
        <input type="hidden" name="id" value="${esc(task.id)}" />
        <input type="hidden" name="private" value="${isPrivate ? '0' : '1'}" />
        <button type="submit" class="task-d-btn" data-task-private-toggle>${isPrivate ? 'Tornar pública' : 'Tornar privada'}</button>
      </form>
    </section>`;

  // Botão concluir POSTa em /app/tasks/complete. A CSP do app (script-src 'self',
  // sem unsafe-inline/script-src-attr — ver src/web/render.ts:115) BLOQUEIA
  // handler inline; o wiring vive em client/note-media.ts, que já é carregado
  // nesta página, via data-attribute [data-task-complete].
  const completeBtn = canClose
    ? `<button type="button" class="task-d-btn task-d-complete" data-task-complete data-task-id="${esc(task.id)}">✓ Concluir</button>`
    : '';

  // Coluna do Kanban (spec 52): a sidebar troca o antigo select cru de "Status" por
  // um select de COLUNA (mais granular, espelha a interação do board — spec 51).
  // Só colunas ATIVAS são selecionáveis; muda via POST /app/tasks/move (não
  // /app/tasks/update), que já deriva status+completed_at da categoria da coluna.
  // Se a coluna atual da task estiver arquivada (drift raro — ex. seed
  // col_cancelado nasce arquivado), aparece como opção desabilitada só pra não
  // mentir o estado — o dono escolhe uma ativa pra sair dali.
  const allColumns = await listKanbanColumns(env, true);
  const activeColumns = allColumns.filter((c) => c.archived_at === null);
  const resolvedCol = resolveTaskColumn(task, allColumns);
  const columnGroups = TASK_STATUSES.map((cat) => {
    const cols = activeColumns.filter((c) => c.category === cat);
    if (cols.length === 0) return '';
    const opts = cols
      .map((c) => `<option value="${esc(c.id)}"${resolvedCol?.id === c.id ? ' selected' : ''}>${esc(c.label)}</option>`)
      .join('');
    return `<optgroup label="${esc(TASK_STATUS_LABELS[cat] ?? cat)}">${opts}</optgroup>`;
  }).join('');
  const archivedCurrentOption = resolvedCol && resolvedCol.archived_at !== null
    ? `<option value="${esc(resolvedCol.id)}" selected disabled>${esc(resolvedCol.label)} (arquivada)</option>`
    : '';
  const columnSelectHtml = `<select class="task-edit-select" data-field="column" aria-label="Coluna">${archivedCurrentOption}${columnGroups}</select>`;

  // Projeto/pasta (spec 58): select na sidebar — projetos ATIVOS + "Sem projeto".
  // Persiste via POST /app/tasks/update (patch.project_id). Se a task está num projeto
  // ARQUIVADO, mostra como opção selecionada desabilitada (não mente o estado; o dono
  // escolhe um ativo ou "Sem projeto" pra sair). O auto-create por label é caminho do
  // MCP — aqui só se escolhe entre projetos existentes.
  const allProjects = await listTaskProjects(env, true);
  const activeProjects = allProjects.filter((p) => p.archived_at === null);
  const currentProject = task.project_id ? allProjects.find((p) => p.id === task.project_id) ?? null : null;
  const currentArchived = currentProject !== null && currentProject.archived_at !== null;
  const projectOptions = [
    `<option value=""${task.project_id === null ? ' selected' : ''}>Sem projeto</option>`,
    ...(currentArchived ? [`<option value="${esc(currentProject!.id)}" selected disabled>${esc(currentProject!.label)} (arquivado)</option>`] : []),
    ...activeProjects.map((p) => `<option value="${esc(p.id)}"${task.project_id === p.id ? ' selected' : ''}>${esc(p.label)}</option>`),
  ].join('');
  const projectSelectHtml = `<select class="task-edit-select" data-field="project" aria-label="Projeto">${projectOptions}</select>`;

  // Tags (spec 52): editor de chips na sidebar, autosave via /app/tasks/update
  // (patch.tags). Reservadas dedupe:* NUNCA aparecem aqui (visibleTags filtra) —
  // o servidor as preserva automaticamente mesmo sem o dono vê-las.
  const tags = visibleTags(await getTagsByNote(env, task.id));

  // Options do select de prioridade (montado no servidor pra o SSR já vir com o
  // valor atual selecionado; a edição real é wired no client bundle). Rótulos
  // nomeados estilo ClickUp (spec 36 fase 3).
  const prioOptions = [
    `<option value=""${task.priority === null ? ' selected' : ''}>Sem prioridade</option>`,
    ...PRIORITIES.map((m) => `<option value="${m.value}"${task.priority === m.value ? ' selected' : ''}>${esc(m.label)}</option>`),
  ].join('');

  // Datas read-only da sidebar, sempre BRT.
  const datesHtml = `
    <div class="task-sidebar-field task-sidebar-dates">
      <div><span class="task-sidebar-lbl">Criada</span><span class="task-sidebar-val">${esc(formatBrtDateTime(task.created_at))}</span></div>
      <div><span class="task-sidebar-lbl">Atualizada</span><span class="task-sidebar-val">${esc(formatBrtDateTime(task.updated_at))}</span></div>
      ${task.completed_at !== null ? `<div><span class="task-sidebar-lbl">Concluída</span><span class="task-sidebar-val">${esc(formatBrtDateTime(task.completed_at))}</span></div>` : ''}
    </div>`;

  // Editor inline (spec 36/52). Duas colunas estilo ClickUp: corpo (título +
  // descrição + prévia + atividade) à esquerda, sidebar de metadados (coluna,
  // prioridade, prazo, tags, áreas, datas, compartilhar) à direita — empilha no
  // mobile. Concorrência otimista via data-updated-at. CSP: wiring todo em
  // client/task-edit.ts.
  const body = `
    <div class="task-d-banner">
      <a href="/app/tasks" class="task-d-back">← Tasks</a>
      <span class="task-d-tag">Task</span>
      ${isPrivate ? '<span class="private-badge" title="Task privada — invisível pra credenciais sem escopo private">🔒 privada</span>' : ''}
      ${originNote ? `<span class="task-d-origin">de <a href="/app/notes/${esc(originNote.id)}">${esc(originNote.title)}</a></span>` : ''}
      <div class="task-d-actions">${completeBtn}<a href="/app/tasks" class="task-d-btn">Abrir no board</a></div>
    </div>

    <div class="task-edit" data-task-id="${esc(task.id)}" data-updated-at="${task.updated_at}">
      <div class="task-detail-grid">
        <div class="task-detail-main">
          <div class="task-edit-titlerow">
            <input type="text" class="task-edit-title" data-field="title" value="${esc(task.title)}" maxlength="200" placeholder="Título da task" aria-label="Título da task" />
            <button type="button" class="task-d-btn task-edit-save" data-save="title">Salvar</button>
          </div>

          <div class="task-edit-bodyrow">
            <div class="task-edit-bodyhead">
              <span class="task-edit-lbl">Descrição (markdown)</span>
              <button type="button" class="task-d-btn task-edit-save" data-save="body">Salvar descrição</button>
            </div>
            <textarea class="task-edit-body" data-field="body" rows="10" aria-label="Descrição">${esc(task.body)}</textarea>
          </div>

          <div class="task-edit-previewrow">
            <div class="task-edit-preview-head">Prévia</div>
            <div class="note-body task-edit-preview" data-preview>${renderMarkdown(task.body, { titleIndex: new Map(), idSet: new Set(), currentId: task.id })}</div>
          </div>

          <div class="task-edit-status" data-editstatus role="status" aria-live="polite"></div>

          ${activitySection}
        </div>

        <aside class="task-detail-sidebar">
          <div class="task-sidebar-field">
            <span class="task-sidebar-lbl">Coluna</span>
            ${columnSelectHtml}
          </div>
          <div class="task-sidebar-field">
            <span class="task-sidebar-lbl">Projeto</span>
            ${projectSelectHtml}
          </div>
          <div class="task-sidebar-field">
            <span class="task-sidebar-lbl">Prioridade</span>
            <select class="task-edit-select" data-field="priority" aria-label="Prioridade">${prioOptions}</select>
          </div>
          <div class="task-sidebar-field">
            <span class="task-sidebar-lbl">Prazo (BRT)</span>
            <div class="task-edit-duerow">
              <input type="date" class="task-edit-due-date" data-field="due-date" value="${esc(dueDate)}" aria-label="Data do prazo" />
              <input type="time" class="task-edit-due-time" data-field="due-time" value="${esc(dueTime)}" aria-label="Hora do prazo (opcional)" />
              <button type="button" class="task-edit-clear" data-clear="due" title="Limpar prazo" aria-label="Limpar prazo">✕</button>
            </div>
          </div>
          <div class="task-sidebar-field">
            <span class="task-sidebar-lbl">Tags</span>
            <div class="task-tags-editor" data-tags-editor data-tags="${esc(JSON.stringify(tags))}">
              <input type="text" class="task-tags-input" data-tags-input maxlength="60" placeholder="+ tag" aria-label="Adicionar tag" />
            </div>
          </div>
          <div class="task-sidebar-field">
            <span class="task-sidebar-lbl">Áreas</span>
            <span class="task-edit-domains">${domainsToBadges(task.domains, taxonomy)}</span>
          </div>
          ${taskMentions.length ? `
          <div class="task-sidebar-field">
            <span class="task-sidebar-lbl">Contatos</span>
            <div class="mention-chips">${taskMentions.map((m) => `<span class="mention-chip"><a href="/app/contacts/${esc(m.entity_id)}">${esc(m.entity_label || m.entity_id)}</a></span>`).join('')}</div>
          </div>` : ''}

          ${datesHtml}

          ${privateSection}

          ${shareSection}
        </aside>
      </div>
    </div>

    <section class="note-media" data-note-id="${esc(task.id)}">
      <h2>Anexos</h2>
      <div id="media-grid" class="media-grid"></div>
      <label id="media-dropzone" class="media-dropzone">
        <input type="file" id="media-file-input" multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.zip" hidden />
        <span>Arraste arquivos aqui ou <u>clique pra escolher</u> · até 50MB</span>
      </label>
    </section>

    <script src="/app/tasks/edit.bundle.js?v=${assetVersion('task-edit.bundle.js')}" defer></script>
    <script src="/app/notes/media.bundle.js?v=${assetVersion('note-media.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    await renderShell({ title: task.title, active: 'tasks', email: session.email, env, body, extraHead: `<style>${NOTE_MEDIA_CSS}${TASK_DETAIL_CSS}${MENTIONS_CSS}</style>`, sidebarCollapsed: sidebarCollapsedFromReq(req) })
  );
}

// CSS do detalhe de task — re-diagramado tipo ClickUp (spec 36 fase 2): título
// grande borderless, linha de metadados alinhada em grid, ações agrupadas à
// direita do banner, descrição com label + botão à direita, prévia separada.
const TASK_DETAIL_CSS = `
/* Banner: breadcrumb + tag à esquerda, ações agrupadas à direita (1 canto só) */
.task-d-banner { display:flex; align-items:center; gap:12px; margin-bottom:22px; }
.task-d-back { color:var(--text-dim); font-size:13px; text-decoration:none; }
.task-d-back:hover { color:var(--text); }
.task-d-tag { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--accent-lav); border:1px solid rgba(167,139,250,0.35); border-radius:999px; padding:2px 10px; }
.task-d-actions { display:flex; gap:10px; margin-left:auto; }
.task-d-btn { font-size:13px; padding:7px 14px; border-radius:var(--radius-sm); border:1px solid var(--border); background:var(--surface); color:var(--text); cursor:pointer; text-decoration:none; transition:border-color 160ms var(--ease), background 160ms var(--ease); white-space:nowrap; }
.task-d-btn:hover { border-color:var(--border-strong); }
.task-d-complete { border-color:rgba(74,222,128,0.4); color:#bbf7d0; }
.task-d-complete:hover { background:rgba(74,222,128,0.12); }

/* Título: input grande, borda invisível até focar (estilo ClickUp) */
.task-edit-titlerow { display:flex; gap:12px; align-items:center; margin-bottom:20px; }
.task-edit-title {
  flex:1; min-width:0; font-family:var(--font-display); font-size:28px; font-weight:500; letter-spacing:-0.02em;
  color:var(--text); background:transparent; border:1px solid transparent;
  border-radius:var(--radius-sm); padding:8px 12px; transition:border-color 160ms var(--ease), background 160ms var(--ease);
}
.task-edit-title:hover { border-color:var(--border); }
.task-edit-title:focus { outline:none; border-color:var(--accent-lav); background:var(--surface); }

/* Duas colunas estilo ClickUp (spec 52): corpo + sidebar de metadados. Empilha
   no mobile (media query no fim do arquivo). */
.task-detail-grid { display:grid; grid-template-columns:1fr 300px; gap:28px; align-items:start; }
.task-detail-main { min-width:0; }
.task-detail-sidebar {
  display:flex; flex-direction:column; gap:20px;
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
  padding:18px 20px;
}
.task-sidebar-field { display:flex; flex-direction:column; gap:7px; }
.task-sidebar-lbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-faint); font-weight:600; }
.task-sidebar-val { font-size:13px; color:var(--text); }
.task-sidebar-dates { gap:10px; }
.task-sidebar-dates > div { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.task-edit-lbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-faint); font-weight:600; }
.task-edit-select {
  width:100%; background:var(--bg-accent); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:7px 11px; font-size:13px; font-family:inherit; cursor:pointer;
  transition:border-color 160ms var(--ease);
}
.task-edit-select:focus { outline:none; border-color:var(--accent-lav); }
.task-edit-duerow { display:flex; align-items:center; gap:8px; }
.task-edit-due-date, .task-edit-due-time {
  background:var(--bg-accent); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:7px 10px; font-size:13px; font-family:inherit;
  transition:border-color 160ms var(--ease);
}
.task-edit-due-time { width:96px; }
.task-edit-due-date { min-width:0; flex:1; }
.task-edit-due-date:focus, .task-edit-due-time:focus { outline:none; border-color:var(--accent-lav); }
.task-edit-clear {
  background:none; border:1px solid var(--border); color:var(--text-faint);
  border-radius:var(--radius-sm); width:30px; height:32px; font-size:12px; cursor:pointer; flex-shrink:0;
  transition:color 160ms var(--ease), border-color 160ms var(--ease);
}
.task-edit-clear:hover { color:#fca5a5; border-color:rgba(239,68,68,0.4); }
.task-edit-domains { display:flex; gap:6px; flex-wrap:wrap; align-items:center; min-height:24px; }
.task-edit-domains:empty::after { content:"—"; color:var(--text-faint); }

/* Editor de tags (spec 52): chips + input inline, autosave via a fila de rajada */
.task-tags-editor { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.task-tag-chip {
  display:inline-flex; align-items:center; gap:3px; font-size:11px; font-weight:500;
  color:var(--text-dim); background:var(--surface-raised); border:1px solid var(--border);
  border-radius:999px; padding:3px 6px 3px 9px;
}
.task-tag-remove {
  background:none; border:none; color:var(--text-faint); cursor:pointer; font-size:13px;
  line-height:1; padding:0 3px; transition:color 140ms var(--ease);
}
.task-tag-remove:hover { color:#fca5a5; }
.task-tags-input {
  flex:1 1 70px; min-width:70px; background:transparent; border:1px solid transparent;
  color:var(--text); font-family:inherit; font-size:12px; padding:4px 7px; border-radius:6px;
  transition:border-color 160ms var(--ease), background 160ms var(--ease);
}
.task-tags-input::placeholder { color:var(--text-faint); }
.task-tags-input:focus { outline:none; border-color:var(--accent-lav); background:var(--bg-accent); }

/* Descrição: label + botão Salvar alinhado à direita do label (não flutuando) */
.task-edit-bodyrow { margin-bottom:8px; }
.task-edit-bodyhead { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
.task-edit-body {
  width:100%; box-sizing:border-box; min-height:180px; resize:vertical;
  background:var(--surface); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:14px; font-size:14px; line-height:1.55;
  font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
  transition:border-color 160ms var(--ease);
}
.task-edit-body:focus { outline:none; border-color:var(--accent-lav); }

/* Prévia: bloco bem separado com cartão próprio */
.task-edit-previewrow { margin:22px 0 8px; }
.task-edit-preview-head { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-faint); font-weight:600; margin-bottom:10px; }
.task-edit-preview {
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
  padding:16px 20px;
}
.task-edit-preview:empty::after { content:"Nada pra pré-visualizar ainda."; color:var(--text-faint); font-size:13px; }
.task-edit-status { font-size:13px; min-height:20px; margin-top:14px; }
.task-edit-status.ok { color:#86efac; }
.task-edit-status.saving { color:var(--text-dim); }
.task-edit-status.err { color:#fca5a5; }
.task-edit-save.dirty { border-color:var(--accent-lav); color:var(--accent-lav); }

/* Compartilhamento público (spec 33) — vive na sidebar (spec 52), espaçamento
   vem do gap do flex column ao redor, não de margin própria */
.task-share h2 { font-size:15px; margin-bottom:10px; }
.task-share-state { color:var(--text-dim); font-size:13px; line-height:1.5; margin-bottom:14px; }
.task-share-state strong { color:var(--text); }
.task-share-controls { display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
.task-share-ttl { display:flex; flex-direction:column; gap:6px; }
.task-share-ttl span { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-faint); font-weight:600; }
.task-share-ttl input {
  width:96px; background:var(--bg-accent); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:7px 10px; font-size:13px; font-family:inherit;
}
.task-share-ttl input:focus { outline:none; border-color:var(--accent-lav); }
.task-share-btn { border-color:rgba(167,139,250,0.4); color:var(--accent-lav); }
.task-share-btn:hover { background:rgba(167,139,250,0.12); }
.task-share-revoke { border-color:rgba(239,68,68,0.4); color:#fca5a5; }
.task-share-revoke:hover { background:rgba(239,68,68,0.12); }
.task-share-revoke[hidden] { display:none; }
.task-share-link { display:flex; gap:8px; align-items:center; margin-bottom:10px; }
.task-share-link[hidden] { display:none; }
.task-share-link input {
  flex:1; min-width:0; background:var(--bg-accent); border:1px solid var(--border-strong); color:var(--text);
  border-radius:var(--radius-sm); padding:8px 12px; font-size:13px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
}
.task-share-link input:focus { outline:none; border-color:var(--accent-lav); }
.task-share-status { font-size:13px; min-height:18px; }
.task-share-status.ok { color:#86efac; }
.task-share-status.err { color:#fca5a5; }
.task-share-status.saving { color:var(--text-dim); }

/* Atividade — thread de comentários (spec 53) no console do dono */
.task-activity { margin:32px 0 8px; }
.task-activity h2 { font-size:15px; margin-bottom:14px; }
.cmt-thread { list-style:none; margin:0 0 18px; padding:0; display:flex; flex-direction:column; gap:12px; }
.cmt-item { border:1px solid var(--border); border-radius:var(--radius); padding:11px 14px; background:var(--surface); }
.cmt-head { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.cmt-author { font-size:13px; font-weight:600; color:var(--text); }
.cmt-author-owner { color:var(--accent-lav); }
.cmt-author-agent { color:#93c5fd; }
.cmt-author-guest { color:var(--text); }
.cmt-time { font-size:11.5px; color:var(--text-faint); font-variant-numeric:tabular-nums; }
.cmt-body { font-size:14px; line-height:1.55; color:var(--text); word-break:break-word; }
.cmt-empty { color:var(--text-faint); font-size:14px; margin-bottom:18px; }
.cmt-del-form { margin-left:auto; }
.cmt-del { background:none; border:none; color:var(--text-faint); font-size:11.5px; cursor:pointer; padding:0; transition:color 140ms var(--ease); }
.cmt-del:hover { color:#fca5a5; }
.cmt-form { display:flex; flex-direction:column; gap:10px; }
.cmt-field { display:flex; flex-direction:column; gap:6px; }
.cmt-lbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-faint); font-weight:600; }
.cmt-form textarea {
  width:100%; box-sizing:border-box; resize:vertical; min-height:64px;
  background:var(--surface); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:11px 13px; font-family:inherit; font-size:14px; line-height:1.5;
  transition:border-color 160ms var(--ease);
}
.cmt-form textarea:focus { outline:none; border-color:var(--accent-lav); }
.cmt-form-foot { display:flex; justify-content:flex-end; }
.cmt-submit { border-color:rgba(167,139,250,0.4); color:var(--accent-lav); }
.cmt-submit:hover { background:rgba(167,139,250,0.12); }

@media (max-width: 640px) {
  .task-d-banner { flex-wrap:wrap; }
  .task-d-actions { margin-left:0; width:100%; }
  .task-detail-grid { grid-template-columns:1fr; }
}
`;

// CSS do editor inline de nota (spec 36 fase 2). Modo LEITURA é o default visual:
// campos borderless que só revelam a moldura no hover/focus (edição discreta).
const NOTE_EDIT_CSS = `
.note-edit { margin-bottom: 8px; }
.note-edit-titlerow { display:flex; gap:12px; align-items:center; margin-bottom:16px; }
.note-edit-title {
  flex:1; min-width:0; font-family:var(--font-display); font-size:30px; font-weight:600; letter-spacing:-0.02em;
  color:var(--text); background:transparent; border:1px solid transparent;
  border-radius:var(--radius-sm); padding:6px 10px; transition:border-color 160ms var(--ease), background 160ms var(--ease);
}
.note-edit-title:hover { border-color:var(--border); }
.note-edit-title:focus { outline:none; border-color:var(--accent-lav); background:var(--surface); }
.note-edit-save {
  font-size:13px; padding:7px 14px; border-radius:var(--radius-sm); border:1px solid var(--border);
  background:var(--surface); color:var(--text-dim); cursor:pointer; white-space:nowrap;
  transition:border-color 160ms var(--ease), color 160ms var(--ease);
}
.note-edit-save:hover { border-color:var(--border-strong); color:var(--text); }
.note-edit-save.dirty { border-color:var(--accent-lav); color:var(--accent-lav); }

.note-edit-meta {
  display:flex; flex-wrap:wrap; align-items:flex-start; gap:20px;
  padding:14px 16px; margin-bottom:18px;
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
}
.note-edit-ctl { display:flex; flex-direction:column; gap:6px; }
.note-edit-lbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-faint); font-weight:600; }
.note-edit-select {
  background:var(--bg-accent); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:7px 11px; font-size:13px; font-family:inherit; cursor:pointer;
  transition:border-color 160ms var(--ease);
}
.note-edit-select:focus { outline:none; border-color:var(--accent-lav); }
.note-edit-ctl-domains { flex:1 1 auto; min-width:220px; }
.note-edit-domains { display:flex; flex-wrap:wrap; gap:6px 10px; }
.note-edit-domain {
  display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--text-dim);
  background:var(--bg-accent); border:1px solid var(--border); border-radius:999px; padding:3px 10px 3px 8px; cursor:pointer;
  transition:border-color 140ms var(--ease), color 140ms var(--ease);
}
.note-edit-domain:hover { border-color:var(--border-strong); color:var(--text); }
.note-edit-domain input { accent-color:var(--accent-lav); margin:0; }
.note-edit-domains.at-max .note-edit-domain input:not(:checked) { opacity:.4; }
/* spec 54 — slug canônico ao lado do label quando customizado, sempre mono */
.note-edit-domain-slug { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size:10.5px; color:var(--text-faint); }
.note-edit-updated { font-size:12px; color:var(--text-faint); margin-left:auto; align-self:center; }
.note-edit-copy {
  background:none; border:1px solid var(--border); border-radius:6px; color:var(--text-dim);
  cursor:pointer; font-size:12px; padding:5px 11px; align-self:center;
  transition:border-color 140ms var(--ease), color 140ms var(--ease);
}
.note-edit-copy:hover { border-color:var(--border-strong); color:var(--text); }

/* Selo de privacidade (spec 31): toggle no detalhe. O form é plano (sem JS) pra ser
   CSP-safe — a ÚNICA superfície que desmarca uma nota. O badge .private-badge é global
   (styles.ts) pra valer também na lista. */
.note-private-form { display:inline; margin:0; align-self:center; }
.note-private-toggle { cursor:pointer; }

.note-edit-ctl-tldr { position:relative; }
.note-edit-tldr {
  width:100%; box-sizing:border-box; resize:vertical; min-height:52px;
  background:transparent; border:1px solid transparent; color:var(--text);
  border-radius:var(--radius-sm); padding:9px 12px; font-family:inherit; font-size:14px; line-height:1.5;
  transition:border-color 160ms var(--ease), background 160ms var(--ease);
}
.note-edit-tldr:hover { border-color:var(--border); }
.note-edit-tldr:focus { outline:none; border-color:var(--accent-lav); background:var(--surface); }
.note-edit-tldr-count { position:absolute; right:4px; bottom:-16px; font-size:11px; color:var(--text-faint); font-variant-numeric:tabular-nums; }
.note-edit-tldr-count.bad { color:#fca5a5; }

.note-edit-bodyrow { margin-top:26px; }
.note-edit-bodyhead { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
.note-edit-body {
  width:100%; box-sizing:border-box; min-height:220px; resize:vertical;
  background:var(--surface); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:14px; font-size:14px; line-height:1.55;
  font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
  transition:border-color 160ms var(--ease);
}
.note-edit-body:focus { outline:none; border-color:var(--accent-lav); }
.note-edit-preview-head { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-faint); font-weight:600; margin:22px 0 10px; }
.note-edit-preview {
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px 20px;
}
.note-edit-preview:empty::after { content:"Nada pra pré-visualizar ainda."; color:var(--text-faint); font-size:13px; }
.note-edit-status { font-size:13px; min-height:20px; margin-top:14px; }
.note-edit-status.ok { color:#86efac; }
.note-edit-status.saving { color:var(--text-dim); }
.note-edit-status.err { color:#fca5a5; }
.note-edit-reload {
  font-size:12px; padding:4px 10px; border-radius:var(--radius-sm); border:1px solid var(--accent-lav);
  background:none; color:var(--accent-lav); cursor:pointer;
}
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
