import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { assetVersion } from './asset-version.js';
import {
  listNoteCreatedActivity,
  listNoteUpdatedActivity,
  listTaskCreatedActivity,
  listTaskCompletedActivity,
  type JournalNoteActivityRow,
  type JournalTaskActivityRow,
} from '../db/queries.js';
import { fetchContactEventsServerSide, type RecentContactEvent } from './contacts-data.js';
import {
  SOURCE_KEYS,
  EMPTY_CURSORS,
  mergeJournalPage,
  cursorsFromParams,
  journalUrl,
  renderJournalItems,
  type SourceKey,
  type JournalItemView,
  type JournalCursors,
} from './journal-render.js';

// Journal cronológico unificado (specs/50-console-v2/65-home-hoje-e-journal.md §3):
// mescla 4 streams LOCAIS (notas criadas/atualizadas, tasks criadas/concluídas) + 1
// stream via proxy (interações de contato) por timestamp desc, com cursor composto
// (ts,id) por fonte local e offset pra fonte remota (journal-render.ts, testado
// isoladamente). Zero tabela/índice novo — volume baixo, "carregar mais" refaz a
// consulta de cada fonte a partir do cursor.

const PAGE_SIZE = 30;

function baseUrl(env: Env): string {
  return (env.WORKER_URL ?? '').replace(/\/$/, '');
}

function toNoteItem(r: JournalNoteActivityRow, type: 'note_created' | 'note_updated', base: string): JournalItemView {
  return {
    type,
    ts: r.ts,
    id: r.id,
    title: r.title,
    private: r.private === 1,
    url: `${base}/app/notes/${r.id}`,
    chipLabel: type === 'note_created' ? 'nota criada' : 'nota atualizada',
    dataKind: 'note',
  };
}

function toTaskItem(r: JournalTaskActivityRow, type: 'task_created' | 'task_completed', base: string): JournalItemView {
  return {
    type,
    ts: r.ts,
    id: r.id,
    title: r.title,
    private: r.private === 1,
    url: `${base}/app/tasks/${r.id}`,
    chipLabel: type === 'task_created' ? 'task criada' : 'task concluída',
    dataKind: 'task',
  };
}

// events.ts (contacts) grava `ts` como TEXT `datetime('now')` do SQLite — sempre UTC,
// formato "YYYY-MM-DD HH:MM:SS". Fallback ts=0 (nunca lança) joga o item pro fim do
// pool combinado em vez de derrubar o merge inteiro por 1 registro malformado.
function parseContactEventTs(v: string): number {
  const iso = v.includes('T') ? v : v.replace(' ', 'T');
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? 0 : ms;
}

function toContactItem(ev: RecentContactEvent, base: string): JournalItemView {
  return {
    type: 'contact_event',
    ts: parseContactEventTs(ev.ts),
    id: ev.id,
    title: ev.entity_name || 'Contato',
    private: false,
    url: `${base}/app/contacts/${encodeURIComponent(ev.entity_id)}`,
    chipLabel: `interação · ${ev.kind}`,
    dataKind: 'contact',
  };
}

interface FetchResult {
  batches: Record<SourceKey, JournalItemView[]>;
  overflow: Record<SourceKey, boolean>;
  contactsOk: boolean;
}

// Busca `limit+1` de CADA fonte (mesmo truque de /app/notes — NOTES_PAGE_SIZE+1):
// o item extra nunca entra no merge, só sinaliza "pode ter mais além desta janela"
// sem precisar de um COUNT(*) por fonte a cada "carregar mais". includePrivate=true
// em tudo — journal é superfície de SESSÃO do dono (spec 65 §4, mesma convenção do
// board de tasks e da lista de notas).
async function fetchBatches(env: Env, cursors: JournalCursors, limit: number): Promise<FetchResult> {
  const fetchLimit = limit + 1;
  const base = baseUrl(env);

  const [noteCreatedRaw, noteUpdatedRaw, taskCreatedRaw, taskCompletedRaw, contactRes] = await Promise.all([
    listNoteCreatedActivity(env, { before: cursors.note_created ?? undefined, limit: fetchLimit, includePrivate: true })
      .catch((e) => { console.error('journal: fonte note_created falhou (omitida nesta página)', e); return []; }),
    listNoteUpdatedActivity(env, { before: cursors.note_updated ?? undefined, limit: fetchLimit, includePrivate: true })
      .catch((e) => { console.error('journal: fonte note_updated falhou (omitida nesta página)', e); return []; }),
    listTaskCreatedActivity(env, { before: cursors.task_created ?? undefined, limit: fetchLimit, includePrivate: true })
      .catch((e) => { console.error('journal: fonte task_created falhou (omitida nesta página)', e); return []; }),
    listTaskCompletedActivity(env, { before: cursors.task_completed ?? undefined, limit: fetchLimit, includePrivate: true })
      .catch((e) => { console.error('journal: fonte task_completed falhou (omitida nesta página)', e); return []; }),
    fetchContactEventsServerSide(env, { offset: cursors.contact_event?.offset ?? 0, limit: fetchLimit })
      .catch((e): { ok: false } => { console.error('journal: fonte contact_event falhou (omitida nesta página)', e); return { ok: false }; }),
  ]);

  const overflow: Record<SourceKey, boolean> = {
    note_created: noteCreatedRaw.length > limit,
    note_updated: noteUpdatedRaw.length > limit,
    task_created: taskCreatedRaw.length > limit,
    task_completed: taskCompletedRaw.length > limit,
    contact_event: contactRes.ok && contactRes.events.length > limit,
  };

  const batches: Record<SourceKey, JournalItemView[]> = {
    note_created: noteCreatedRaw.slice(0, limit).map((r) => toNoteItem(r, 'note_created', base)),
    note_updated: noteUpdatedRaw.slice(0, limit).map((r) => toNoteItem(r, 'note_updated', base)),
    task_created: taskCreatedRaw.slice(0, limit).map((r) => toTaskItem(r, 'task_created', base)),
    task_completed: taskCompletedRaw.slice(0, limit).map((r) => toTaskItem(r, 'task_completed', base)),
    contact_event: contactRes.ok ? contactRes.events.slice(0, limit).map((ev) => toContactItem(ev, base)) : [],
  };

  return { batches, overflow, contactsOk: contactRes.ok };
}

const JOURNAL_CSS = `
.journal-filters { display: flex; gap: 18px; margin-bottom: 20px; font-size: 13px; color: var(--text-dim); }
.journal-filters label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.journal-day { font-family: var(--font-display); font-size: 14px; font-weight: 500; color: var(--text-dim); margin: 22px 0 10px; }
.journal-day:first-child { margin-top: 0; }
.journal-list { list-style: none; margin: 0 0 4px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.journal-item { display: flex; align-items: center; gap: 10px; font-size: 13.5px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.journal-time { flex-shrink: 0; width: 40px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.journal-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); text-decoration: none; }
.journal-title:hover { color: var(--accent-lav); }
.journal-priv { font-size: 10px; color: var(--text-faint); flex-shrink: 0; }
.journal-chip { flex-shrink: 0; font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--text-dim); }
.journal-chip-note { color: var(--accent-lav); border-color: rgba(var(--accent-lav-rgb),0.35); }
.journal-chip-task { color: #5eead4; border-color: color-mix(in srgb, #5eead4 35%, transparent); }
.journal-chip-contact { color: #fb923c; border-color: color-mix(in srgb, #fb923c 35%, transparent); }
.journal-degraded { color: var(--text-dim); font-size: 13px; margin: 0 0 16px; }
/* Filtros client-side (journal.bundle.js): a classe vai no container, não no item —
   itens anexados por "Carregar mais" já nascem filtrados sem JS por item. */
#journal-groups.journal-hide-note .journal-item[data-kind="note"] { display: none; }
#journal-groups.journal-hide-task .journal-item[data-kind="task"] { display: none; }
#journal-groups.journal-hide-contact .journal-item[data-kind="contact"] { display: none; }
`;

export async function handleJournalPage(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const now = Date.now();
  const url = new URL(req.url);
  const cursors = cursorsFromParams(url.searchParams);
  const isFirstPage = SOURCE_KEYS.every((k) => cursors[k] === null);
  const wantsJson = (req.headers.get('accept') || '').includes('application/json');

  let items: JournalItemView[] = [];
  let nextCursors: JournalCursors = EMPTY_CURSORS;
  let hasMore = false;
  let contactsDegraded = false;

  try {
    const { batches, overflow, contactsOk } = await fetchBatches(env, cursors, PAGE_SIZE);
    contactsDegraded = !contactsOk;
    const merged = mergeJournalPage(batches, cursors, PAGE_SIZE);
    items = merged.items;
    nextCursors = merged.cursors;
    hasMore = merged.leftover || SOURCE_KEYS.some((k) => overflow[k]);
  } catch (e) {
    // Falha ao montar a página inteira (ex.: DB fora do ar) — feed vazio em vez de
    // 500 (critério "home e journal degradam, não quebram").
    console.error('journal: falha ao montar a página (feed vazio nesta resposta)', e);
  }

  const nextUrl = hasMore ? journalUrl(nextCursors) : null;

  // Modo dados (client "Carregar mais", appFetch manda accept:application/json) —
  // devolve só o necessário pro append: HTML dos itens (renderJournalItems já sabe
  // continuar o agrupamento por dia a partir de `carry`) + a próxima URL.
  if (wantsJson) {
    const carry = url.searchParams.get('carry');
    const { html, lastLabel } = renderJournalItems(items, now, carry || null);
    return new Response(JSON.stringify({ ok: true, html, last_label: lastLabel, next_url: nextUrl }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const { html: groupsHtml, lastLabel } = renderJournalItems(items, now, null);
  const emptyHtml = isFirstPage && items.length === 0
    ? '<p class="home-empty">Nada por aqui ainda — crie uma nota, uma task ou registre uma interação.</p>'
    : (items.length === 0 ? '<p class="home-empty">Fim do journal.</p>' : '');

  // `carry` viaja na querystring só pro round-trip do "Carregar mais" (o handler lê
  // de volta acima, no ramo wantsJson) — não faz parte do cursor de nenhuma fonte.
  const loadMoreHref = nextUrl
    ? `${nextUrl}${nextUrl.includes('?') ? '&' : '?'}carry=${encodeURIComponent(lastLabel ?? '')}`
    : null;
  const loadMoreHtml = loadMoreHref
    ? `<a id="journal-load-more" class="notes-load-more" href="${esc(loadMoreHref)}">Carregar mais</a>`
    : '';

  const degradedHtml = contactsDegraded
    ? '<p class="journal-degraded">Interações de contato indisponíveis no momento — notas e tasks seguem normais.</p>'
    : '';

  const body = `
    <div class="page-header"><h1>Journal</h1></div>
    ${degradedHtml}
    <div class="journal-filters">
      <label><input type="checkbox" class="journal-filter" value="note" checked /> Notas</label>
      <label><input type="checkbox" class="journal-filter" value="task" checked /> Tasks</label>
      <label><input type="checkbox" class="journal-filter" value="contact" checked /> Interações</label>
    </div>
    <div id="journal-groups">${groupsHtml}${emptyHtml}</div>
    ${loadMoreHtml}
    <script src="/app/journal/bundle.js?v=${assetVersion('journal.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    await renderShell({
      title: 'Journal',
      active: 'journal',
      email: session.email,
      env,
      body,
      extraHead: `<style>${JOURNAL_CSS}</style>`,
      sidebarCollapsed: sidebarCollapsedFromReq(req),
    })
  );
}
