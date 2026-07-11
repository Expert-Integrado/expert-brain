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
  insertNote,
  insertTask,
  getNotesByIds,
  listTaskComments,
  listKanbanColumns,
  resolveTaskColumn,
  getTagsByNote,
  listTaskProjects,
  listMentionsForNote,
  listTasksFromOrigin,
  listUsers,
  listAssigneesForTask,
  resolveActorProfile,
  KNOWLEDGE_KINDS,
  type NoteRow,
  type EdgeRow,
  type NoteKind,
} from '../db/queries.js';
import { validateDomains } from '../db/validation.js';
import { listTaskActivity } from '../db/task-activity.js';
import { reembedNoteIfNeeded } from '../db/note-write.js';
import { applyMentions } from '../mcp/mentions.js';
import { newId } from '../util/id.js';
import { getShareStatus } from './share.js';
import { renderCommentThread } from './comments-render.js';
import { visibleTags } from './tasks.js';
import { assigneeDotsHtml } from '../util/task-badges.js';
import { resolveDomainMeta, resolveKindMeta, type TaxonomyConfig } from './domain-colors.js';
import { getTaxonomyConfig, mergedDomainSlugs } from './taxonomy-config.js';
import { readCachedResurfaceDigest, isDigestEmpty, type ResurfaceDigest } from '../digest/resurface.js';
import { embed, upsertNoteVector, queryVector, type VectorMatch } from '../vector/index.js';
import { SIMILARITY_TOP_K, DEDUP_MIN_SCORE, persistSimilarEdgesFromMatches } from './similarity.js';

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

// Primeira linha (título/tldr derivado), truncada. Vazia → cai no corpo inteiro.
// Duplica o helper de mesmo nome em inbox.ts/home.ts (nenhum util compartilhado
// pra isto no repo — ver comentário equivalente nesses arquivos).
function firstLine(body: string, max: number): string {
  const line = body.split('\n')[0]?.trim() || body.trim();
  return line.slice(0, max);
}

// Rótulo do contador da lista (audit ui-audit/RELATORIO.md itens N1/N3/N4): pt-BR
// com separador de milhar + "notas de conhecimento" (explícito, em vez de só
// "notas") porque este total exclui tasks — diverge de propósito do "Notas" cru
// do /app/config "Status do vault" (esse conta TUDO, incl. tasks). "mostrando X
// de Y" só aparece quando há mais pra ver que o já exibido; quando shown >= total
// (tudo visível) cai no rótulo simples.
function formatCountLabel(shown: number, total: number): string {
  const noun = total === 1 ? 'nota de conhecimento' : 'notas de conhecimento';
  if (total === 0) return `0 ${noun}`;
  const totalFmt = total.toLocaleString('pt-BR');
  if (shown <= 0 || shown >= total) return `${totalFmt} ${noun}`;
  return `mostrando ${shown.toLocaleString('pt-BR')} de ${totalFmt} ${noun}`;
}

// Card "Do seu cérebro" (specs/50-console-v2/64-resurfacing-digest.md §2): fallback
// enquanto a home (spec 65) não existe — lê o CACHE (meta.resurface_digest, TTL 20h)
// gravado pelo cron diário, nunca recomputa aqui (a query de grau em edges é cara
// demais pro request path da lista de notas). Some sozinho quando o digest ainda
// não rodou ou está vazio.
// Exportado: reusado pela home (spec 65 §2, card "Do seu cérebro") pra não duplicar
// a marcação — a home lê o MESMO cache, nunca recomputa.
// opts.bare (Onda 9, spec 71): omite o <strong> interno — a home fornece o h2 do
// card (mesma anatomia dos vizinhos "Hoje"/"Inbox"); a lista de notas segue com o
// callout completo.
export function renderDigestCard(d: ResurfaceDigest, opts: { bare?: boolean } = {}): string {
  const items: string[] = [];
  for (const q of d.open_questions) {
    items.push(`<li>❓ <a href="${esc(q.url)}">${esc(q.title)}</a> — sem resposta há ${q.age_days}d</li>`);
  }
  for (const n of d.stale_central_notes) {
    items.push(`<li>🔗 <a href="${esc(n.url)}">${esc(n.title)}</a> — ${n.degree} conexões, ${n.age_days}d sem mexer</li>`);
  }
  for (const c of d.cooling_contacts) {
    items.push(`<li>🧊 <a href="${esc(c.url)}">${esc(c.name)}</a> — sem contato há ${c.days_since}d</li>`);
  }
  if (d.inbox_pending_over_7d) {
    items.push(`<li>📥 <a href="${esc(d.inbox_url)}">Inbox</a> — ${d.inbox_pending_over_7d} item(ns) parado(s) há mais de 7 dias</li>`);
  }
  if (opts.bare) {
    return `
    <div id="resurface-digest-card">
      <ul style="margin:0; padding-left:18px; line-height:1.6;">${items.join('')}</ul>
    </div>`;
  }
  return `
    <div class="callout-info" id="resurface-digest-card">
      <strong>Do seu cérebro</strong>
      <ul style="margin:8px 0 0; padding-left:18px; line-height:1.6;">${items.join('')}</ul>
    </div>`;
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
.mention-chip-remove:hover { color:var(--danger); }
.mention-add { position:relative; max-width:360px; }
.mention-add-input { width:100%; font-size:14px; padding:7px 10px; border-radius:var(--radius-sm); border:1px solid var(--border); background:var(--surface); color:var(--text); }
.mention-add-input:focus { outline:none; border-color:var(--accent-lav); }
.mention-suggest { position:absolute; z-index:20; left:0; right:0; margin-top:4px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-sm); max-height:240px; overflow-y:auto; box-shadow:0 8px 24px rgba(0,0,0,0.35); }
.mention-suggest-item { display:block; width:100%; text-align:left; padding:8px 12px; font-size:14px; background:transparent; border:none; color:var(--text); cursor:pointer; }
.mention-suggest-item:hover, .mention-suggest-item.active { background:rgba(var(--accent-lav-rgb),0.14); }
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

  // Card "Do seu cérebro" (spec 64) só na 1ª página — LEITURA do cache (nunca
  // recomputa aqui, ver renderDigestCard). Cosmético: qualquer falha some o card
  // sem derrubar a lista de notas.
  let digestCardHtml = '';
  if (offset === 0) {
    try {
      const digest = await readCachedResurfaceDigest(env);
      if (digest && !isDigestEmpty(digest)) digestCardHtml = renderDigestCard(digest);
    } catch (e) {
      console.error('resurface digest card: falha ao ler cache (card omitido)', e);
    }
  }

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

  // Contador (audit ui-audit/RELATORIO.md item N1): "mostrando X de Y" no no-JS
  // também — shownCount é cumulativo através das páginas por offset (cada "Carregar
  // mais" leva pra uma página nova com o offset seguinte), não só o tamanho desta
  // página. offset além do fim (page vazia) cai no rótulo simples (nada "mostrando").
  const shownCount = page.length === 0 ? total : offset + page.length;
  const countLabel = formatCountLabel(shownCount, total);

  const body = `
    <div class="page-header">
      <h1>Notas</h1>
      <span class="count" id="notes-count">${countLabel}</span>
      <button class="btn btn-primary notes-new-btn" id="notes-new-btn" type="button">
        <span class="notes-new-plus" aria-hidden="true">+</span> Nova nota
      </button>
    </div>

    ${digestCardHtml}

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

    <div class="modal" id="notes-create-modal" hidden aria-hidden="true">
      <div class="modal-backdrop" data-close-modal></div>
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="notes-create-title">
        <div class="modal-head">
          <h2 id="notes-create-title">Nova nota</h2>
          <button class="modal-x" data-close-modal type="button" aria-label="Fechar">✕</button>
        </div>
        <div class="modal-body">
          <form class="notes-create-form" id="notes-create-form">
            <label class="field">
              <span class="field-label">Título <span class="notes-create-req">obrigatório</span></span>
              <input type="text" name="title" id="notes-create-title-input" class="input" maxlength="200"
                placeholder="Sobre o que é a nota?" autocomplete="off" required />
            </label>
            <label class="field">
              <span class="field-label">Corpo <span class="notes-create-opt">opcional</span></span>
              <textarea name="body" class="textarea" rows="5" placeholder="Conteúdo em markdown"></textarea>
            </label>
            <div class="notes-create-foot">
              <span class="notes-create-msg" data-create-msg role="status" aria-live="polite"></span>
              <div class="notes-create-actions">
                <button class="btn" type="button" data-close-modal>Cancelar</button>
                <button class="btn btn-primary notes-create-submit" type="submit">Criar nota</button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>

    <script src="/app/notes/bundle.js?v=${assetVersion('notes.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    await renderShell({
      title: 'Notas',
      active: 'notes',
      email: session.email,
      env,
      body,
      extraHead: `<style>${NOTES_LIST_CSS}</style>`,
      sidebarCollapsed: sidebarCollapsedFromReq(req),
    })
  );
}

// CSS mínimo da lista/criação (audit ui-audit/RELATORIO.md item N2) — o modal em si
// (.modal/.modal-backdrop/.modal-dialog/.modal-head/.modal-x/.modal-body) e os campos
// (.field/.field-label/.input/.textarea/.btn/.btn-primary) reusam a biblioteca global
// (COMPONENTS_CSS, styles.ts); só o layout específico do form de criação mora aqui,
// espelhando .task-create-* (src/web/tasks.ts) reduzido a título+corpo.
const NOTES_LIST_CSS = `
.notes-new-btn { margin-left: auto; }
.notes-new-plus { font-size: 17px; line-height: 1; font-weight: 400; }
.notes-create-form { display: flex; flex-direction: column; gap: 16px; }
.notes-create-req { color: var(--danger); text-transform: none; letter-spacing: 0; font-weight: 500; }
.notes-create-opt { color: var(--text-subtle); text-transform: none; letter-spacing: 0; opacity: 0.8; }
.notes-create-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 4px; }
.notes-create-msg { font-size: 12px; color: var(--text-subtle); }
.notes-create-msg.saving { color: var(--text-dim); }
.notes-create-msg.err { color: var(--danger); }
.notes-create-actions { display: flex; gap: 10px; align-items: center; }
`;

// POST /app/notes/create — cria uma nota MÍNIMA (título + corpo opcional) direto da
// lista (audit ui-audit/RELATORIO.md item N2: assimetria com "+ Nova tarefa", que já
// tem /app/tasks/create). Espelha a FORMA de handleTaskCreatePost (mesmos 2 campos,
// mesmo contrato JSON de resposta) e reusa o MECANISMO de handleInboxToNotePost
// (src/web/inbox.ts): embed best-effort ANTES do insert + upsertNoteVector +
// persistSimilarEdgesFromMatches a partir dos MESMOS matches da pré-consulta de
// dedupe — zero segunda query ao Vectorize. Curadoria (kind/áreas/tldr) fica pro
// editor da nota depois de criada, igual ao fluxo do inbox — este endpoint não pede
// mais que o mínimo pra não duplicar o editor completo num modal.
export async function handleNoteCreatePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  let body: { title?: unknown; body?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  // title — obrigatório, 1..200 (mesma faixa do title de update_note/tasks/create).
  if (typeof body.title !== 'string') return json({ error: 'title must be a string' }, 400);
  const title = body.title.trim();
  if (title.length < 1 || title.length > 200) return json({ error: 'title must be 1-200 chars' }, 400);

  // body — opcional, texto livre (markdown). Vazio/ausente → cai no título (igual
  // tasks/create: `details || title`) — o body de nota não pode ficar vazio (regra
  // do update_note/handleNoteUpdatePost).
  let noteBody = title;
  if (body.body !== undefined) {
    if (typeof body.body !== 'string') return json({ error: 'body must be a string' }, 400);
    const b = body.body.trim();
    if (b) noteBody = b;
  }

  const tldr = firstLine(noteBody, 280) || title.slice(0, 280);
  // domains default (mesmo valor default de handleTaskCreatePost) — kind fica NULL
  // (sem badge na lista) até o dono curar no editor, igual a uma nota legada sem kind.
  const domains = ['operations'];
  const actor = `oauth:${session.email}`;
  const now = Date.now();
  const id = newId();

  // Embedding best-effort (mesmo padrão do inbox to-note, ver handleInboxToNotePost):
  // falha do Workers AI não derruba a criação — a nota nasce sem vetor e reembeda na
  // próxima curadoria (update_note/PATCH detecta tldr sem embedding correspondente).
  let vec: number[] | null = null;
  try {
    vec = await embed(env, tldr);
  } catch (err) {
    console.error('notes create: embed falhou, criando nota sem vetor (re-embeda na curadoria)', err);
  }

  // Pré-consulta de vizinhança best-effort — falha aqui não impede a criação, só
  // deixa a lista de matches vazia (sem dup check, sem similar_edges deste create).
  let matches: VectorMatch[] = [];
  if (vec) {
    try {
      matches = await queryVector(env, vec, SIMILARITY_TOP_K + 2);
    } catch (err) {
      console.error('notes create: pré-consulta de vizinhança falhou (segue sem dup check)', err);
    }
  }

  await insertNote(env, {
    id,
    title,
    body: noteBody,
    tldr,
    domains: JSON.stringify(domains),
    kind: null,
    created_at: now,
    updated_at: now,
  }, actor);

  if (vec) {
    try {
      await upsertNoteVector(env, id, vec, { domains, kind: null, created_at: now });
      // Reusa os matches da pré-consulta — mesma economia de 1-query-N-consumidores
      // do save_note/inbox to-note (nunca uma SEGUNDA query idêntica ao Vectorize).
      await persistSimilarEdgesFromMatches(env, id, matches);
    } catch (err) {
      console.error('notes create: upsert vetor/edges falhou (nota persistida)', err);
    }
  }

  // Melhor match do gate de dedup (mesmo limiar do inbox to-note/save_note): se bater,
  // devolve o id do candidato pro client redirecionar com ?dup=<id> — aviso PÓS-criação
  // no editor da nota nova, nunca tela de confirmação (a nota já existe).
  let dup: string | null = null;
  const best = matches[0];
  if (best && best.score >= DEDUP_MIN_SCORE) {
    const [candidate] = await getNotesByIds(env, [best.id], true);
    if (candidate) dup = candidate.id;
  }

  return json({ ok: true, id, title, dup }, 201);
}

// Banner de possível duplicata (spec 70-grafo-higiene/75 §2): o to-note do inbox
// redireciona pro detalhe com ?dup=<id> quando a pré-consulta de vizinhança bateu o
// gate de dedup (score >= DEDUP_MIN_SCORE). Aviso PÓS-criação — a nota já existe,
// isto não é tela de confirmação; o dono decide mesclar ou deletar.
function renderDupBanner(candidateId: string, candidateTitle: string): string {
  return `
    <div class="callout-info dup-banner" data-dup-banner>
      <strong>Possível duplicata de:</strong> <a href="/app/notes/${esc(candidateId)}">${esc(candidateTitle)}</a>
      <p style="margin:6px 0 0">Compare as duas — mescle o que faltar numa só e delete a repetida.</p>
    </div>`;
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

  // ?dup=<id> (spec 75): redirect pós-criação do to-note do inbox. Candidata sumida/
  // deletada/inexistente → banner some silenciosamente, sem 404 nem erro (a nota
  // principal já existe e é o que importa).
  const dupId = new URL(req.url).searchParams.get('dup');
  let dupBannerHtml = '';
  if (dupId) {
    const candidate = await getNoteById(env, dupId, false, /* includePrivate */ true);
    if (candidate) dupBannerHtml = renderDupBanner(candidate.id, candidate.title);
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
        ? tasksFromNote.map((t) => `<a class="note-card" href="/app/tasks/${esc(t.id)}"><div class="title">${esc(t.title)}</div><div class="meta"><span class="badge">${esc(TASK_STATUS_LABELS[t.status ?? 'open'] ?? (t.status ?? 'open'))}</span></div></a>`).join('')
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

  // Visibilidade da NOTA (spec 65): seletor único de 3 níveis substitui a antiga
  // seção "Compartilhamento" + o toggle "Tornar privada" do note-edit-meta.
  const noteShareStatus = isPrivate ? null : await getShareStatus(env, note.id, Date.now());
  const noteVisibilitySection = renderVisibilitySection({
    kind: 'note',
    id: note.id,
    isPrivate,
    shared: noteShareStatus?.shared ?? false,
    expired: noteShareStatus?.expired ?? false,
    expiresBrt: noteShareStatus?.expires_brt ?? '',
    includeMedia: noteShareStatus?.include_media ?? false,
  });

  const body = `
    ${dupBannerHtml}
    <div class="note-edit" data-note-id="${esc(note.id)}" data-updated-at="${note.updated_at}">
      <div class="note-edit-titlerow">
        <textarea class="note-edit-title" data-field="title" maxlength="200" rows="1" placeholder="Título da nota" aria-label="Título da nota">${esc(note.title)}</textarea>
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
      </div>

      <div class="note-edit-ctl note-edit-ctl-tldr">
        <span class="note-edit-lbl">Resumo (tldr · 10-280)</span>
        <textarea class="note-edit-tldr" data-field="tldr" rows="2" maxlength="280" aria-label="Resumo">${esc(note.tldr ?? '')}</textarea>
        <span class="note-edit-tldr-count" data-tldr-count>${tldrLen}/280</span>
      </div>
    </div>

    <div class="note-edit-bodyrow note-edit" data-note-id="${esc(note.id)}">
      <div class="note-edit-bodyview" data-bodyview>
        <div class="note-edit-bodyhead">
          <span class="note-edit-lbl">Corpo</span>
          <button type="button" class="note-edit-editbtn" data-edit-body title="Editar em markdown">Editar</button>
        </div>
        <div class="note-body note-edit-preview${note.body.trim() ? '' : ' note-edit-preview-empty'}" data-preview>${note.body.trim()
          ? renderMarkdown(note.body, { titleIndex, idSet, currentId: note.id })
          : '<span class="note-edit-empty-trigger" data-edit-body>Sem descrição</span>'}</div>
        <button type="button" class="note-edit-editbtn" data-edit-body title="Editar em markdown">Editar</button>
      </div>
      <div class="note-edit-bodyedit" data-bodyedit hidden>
        <textarea class="note-edit-body" data-field="body" rows="12" aria-label="Corpo em markdown">${esc(note.body)}</textarea>
        <div class="note-edit-bodyedit-actions">
          <button type="button" class="note-edit-save" data-save="body">Salvar</button>
          <button type="button" class="note-edit-cancel" data-cancel-body>Cancelar</button>
        </div>
      </div>
      <div class="note-edit-status" data-editstatus role="status" aria-live="polite"></div>
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

    <section class="note-media" data-note-id="${esc(note.id)}">
      <h2>Mídia</h2>
      <div id="media-grid" class="media-grid"></div>
      <label id="media-dropzone" class="media-dropzone">
        <input type="file" id="media-file-input" multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.md,.zip" hidden />
        <span>Arraste arquivos aqui ou <u>clique pra escolher</u> · até 50MB</span>
      </label>
    </section>

    ${noteVisibilitySection}

    ${mentionsHtml}
    ${tasksFromNoteHtml}

    ${outboundHtml}
    ${inboundHtml}

    ${relatedIds.length > 0 ? `<script src="/app/notes/local-graph.bundle.js?v=${assetVersion('local-graph.bundle.js')}" defer></script>` : ''}
    <script src="/app/notes/edit.bundle.js?v=${assetVersion('note-edit.bundle.js')}" defer></script>
    <script src="/app/notes/media.bundle.js?v=${assetVersion('note-media.bundle.js')}" defer></script>
  `;

  return htmlResponse(
    await renderShell({ title: note.title, active: 'notes', email: session.email, env, body, extraHead: `<style>${NOTE_MEDIA_CSS}${NOTE_EDIT_CSS}${MENTIONS_CSS}${SHARE_SECTION_CSS}${NOTE_SHARE_WRAP_CSS}</style>`, sidebarCollapsed: sidebarCollapsedFromReq(req) })
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
      // O editor não mexe no selo (toggle é rota própria) — vale o estado atual da nota.
      notePrivate: (existing.private ?? 0) === 1,
    });
  }

  // Re-embeda pela função compartilhada (só se tldr/domains/kind mudou de fato).
  // Best-effort: a edição já está persistida em D1 (o UPDATE acima commitou). Uma
  // falha de Workers AI/Vectorize não pode perder o save do usuário nem retornar
  // erro — o recall só fica ~1-2 min desatualizado até o próximo write path.
  let reembedded = false;
  if (hasFieldEdit) {
    try {
      // reembedNoteIfNeeded agora retorna { reembedded, matches } (spec 76) — o
      // caminho web só consome o flag, sem UI nova pros matches.
      ({ reembedded } = await reembedNoteIfNeeded(env, existing, {
        title, body: noteBody, tldr, domains, kind,
      }));
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
      // A task herdou a privacidade da nota de origem — o evento acompanha.
      notePrivate: (origin.private ?? 0) === 1,
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

// ─────────────── Seletor único de visibilidade (spec 60-ux-reforma/65) ───────────────
// Um radiogroup de 3 níveis substitui as antigas seções "Privacidade" (specs 31/59) e
// "Compartilhamento público" (spec 33) nos detalhes de NOTA e de TASK:
//   Privado      → private=1 (nunca tem link público; marcar privada revoga no server)
//   Normal       → private=0 sem link — o DEFAULT do sistema; visível só pro dono e
//                  suas credenciais, NÃO fica na internet (a palavra "pública" da UI
//                  antiga induzia a achar que sim)
//   Link público → private=0 + link /s/token vivo (read-only, com validade)
// ZERO endpoint novo: o wiring em client/visibility-ui.ts reusa POST {endpoint}/private,
// /share e /unshare. As classes .task-share-* internas do painel são as mesmas de
// antes (CSS reaproveitado); o radiogroup ganha .vis-*.
function renderVisibilitySection(o: {
  kind: 'task' | 'note';
  id: string;
  isPrivate: boolean;
  shared: boolean;
  expired: boolean;
  expiresBrt: string;
  includeMedia: boolean | null; // null = opção não existe (task)
}): string {
  const state = o.isPrivate ? 'private' : o.shared ? 'link' : 'normal';
  const kindLabel = o.kind === 'task' ? 'task' : 'nota';
  const endpoint = o.kind === 'task' ? '/app/tasks' : '/app/notes';
  const privateAction = o.kind === 'task' ? '/app/tasks/private' : `/app/notes/${esc(o.id)}/private`;
  // Compacto (pedido do dono, 10/07/2026): só o rótulo visível; a explicação
  // longa vira tooltip (title) — sem legenda ocupando a sidebar.
  const opt = (value: string, icon: string, title: string, desc: string) => `
      <label class="vis-opt${state === value ? ' selected' : ''}" title="${esc(desc)}">
        <input type="radio" name="visibility" value="${value}"${state === value ? ' checked' : ''} />
        <span class="vis-opt-head"><span aria-hidden="true">${icon}</span>${title}</span>
      </label>`;
  const shareStateHtml = o.shared
    ? (o.expired
        ? `Havia um link público, mas <strong>expirou</strong> em ${esc(o.expiresBrt)}. Gere um novo.`
        : `Link público ativo, válido até <strong>${esc(o.expiresBrt)}</strong>. O link só aparece quando é gerado (o banco guarda só o hash) — gere de novo pra revê-lo (isso troca o link), ou revogue.`)
    : 'Gere um link público read-only pra enviar a alguém sem conta.';
  const mediaOpt = o.includeMedia === null ? '' : `
          <label class="note-share-media-opt">
            <input type="checkbox" data-share-media${o.includeMedia ? ' checked' : ''} />
            <span>Incluir mídia</span>
          </label>`;
  return `
    <section class="task-visibility" data-visibility data-kind="${o.kind}" data-id="${esc(o.id)}"
      data-share-endpoint="${endpoint}" data-private-action="${privateAction}"
      data-state="${state}" data-shared="${o.shared ? '1' : '0'}">
      <h2>Visibilidade</h2>
      <div class="vis-group" role="radiogroup" aria-label="Visibilidade da ${kindLabel}">
        ${opt('private', '🔒', 'Privado', 'Só você e credenciais com escopo private. Nunca tem link público.')}
        ${opt('normal', '👥', 'Normal', 'Você + seus agentes. Não fica na internet.')}
        ${opt('link', '🔗', 'Link público', 'Além do normal: quem tiver o link abre uma cópia read-only.')}
      </div>
      <div class="vis-panel" data-vis-panel${state === 'link' ? '' : ' hidden'}>
        <p class="task-share-state" data-share-state>${shareStateHtml}</p>
        <div class="task-share-controls">
          <label class="task-share-ttl">
            <span>Validade (dias)</span>
            <input type="number" min="1" max="365" value="30" data-share-days aria-label="Validade em dias" />
          </label>${mediaOpt}
          <button type="button" class="btn task-d-btn task-share-btn" data-share-generate>${o.shared && !o.expired ? 'Gerar novo link' : 'Gerar link'}</button>
          <button type="button" class="btn task-d-btn task-share-revoke" data-share-revoke${o.shared ? '' : ' hidden'}>Revogar</button>
        </div>
        <div class="task-share-link" data-share-link hidden>
          <input type="text" readonly data-share-url aria-label="Link público" />
          <button type="button" class="btn task-d-btn" data-share-copy>Copiar</button>
        </div>
      </div>
      <div class="task-share-status" data-share-status role="status" aria-live="polite"></div>
    </section>`;
}

const TASK_STATUS_LABELS: Record<string, string> = {
  open: 'A fazer',
  in_progress: 'Em progresso',
  done: 'Concluído',
  canceled: 'Cancelado',
};

// Ícone de lápis inline (CSP sem asset externo; stroke currentColor herda o tema).
const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

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
  const [comments, taxonomy, taskMentions, allUsers, taskAssignees, createdBy] = await Promise.all([
    listTaskComments(env, task.id, 500, 0),
    getTaxonomyConfig(env),
    // Menções (spec 62): contatos que esta task cita (chips de leitura + link).
    listMentionsForNote(env, task.id),
    // Responsáveis (spec 37): usuários pro picker + assignees atuais + autoria.
    listUsers(env, true),
    listAssigneesForTask(env, task.id),
    resolveActorProfile(env, task.created_by),
  ]);
  // Origem (spec 62): nota que originou a task ("Criar task desta nota").
  const originNote = task.origin_note_id
    ? await getNoteById(env, task.origin_note_id, false, /* includePrivate */ true)
    : null;
  const activitySection = `
    <section class="task-activity" id="atividade">
      <h2>Atividade</h2>
      ${renderCommentThread(comments, {
        deleteTaskId: task.id,
        withAvatars: true,
        // Realce de @menção (spec 82): só usuários ATIVOS — nome arquivado vira texto puro.
        mentionNames: allUsers.filter((u) => u.archived_at === null).map((u) => u.name),
      })}
      <form class="cmt-form" method="post" action="/app/tasks/comment">
        <input type="hidden" name="task_id" value="${esc(task.id)}" />
        <label class="cmt-field">
          <span class="cmt-lbl">Novo comentário</span>
          <textarea name="body" rows="3" maxlength="4000" required placeholder="Escreva um comentário"></textarea>
        </label>
        <div class="cmt-form-foot">
          <button type="submit" class="btn task-d-btn cmt-submit">Comentar</button>
        </div>
      </form>
    </section>`;

  // Visibilidade da TASK (spec 65): seletor único de 3 níveis substitui as antigas
  // seções "Privacidade" (spec 59) e "Compartilhamento público" (spec 33). Task
  // privada nem busca share status (nunca tem link — o server garante).
  const isPrivate = task.private === 1;
  const shareStatus = isPrivate ? null : await getShareStatus(env, task.id, Date.now());
  const visibilitySection = renderVisibilitySection({
    kind: 'task',
    id: task.id,
    isPrivate,
    shared: shareStatus?.shared ?? false,
    expired: shareStatus?.expired ?? false,
    expiresBrt: shareStatus?.expires_brt ?? '',
    includeMedia: null,
  });

  // Responsáveis (spec 74): dots (mesmo componente do board, task-badges.ts) +
  // popover estilo ClickUp num <details> nativo — abre/fecha sem JS (nenhum
  // atributo `hidden` escondendo o conteúdo pra sempre), e o form de checkboxes
  // de dentro é o MESMO endpoint de sempre (POST /app/tasks/assignees,
  // replace-set). O client (task-edit.ts) intercepta o submit por fetch pra
  // atualizar os dots sem reload; sem JS o form faz um POST normal (302 de
  // volta pro detalhe). Ativos sempre aparecem; arquivado SÓ se já é assignee
  // desta task (marcado e esmaecido — dá pra manter ou remover, não pra
  // atribuir novo arquivado).
  const assignedIds = new Set(taskAssignees.map((a) => a.id));
  const pickerUsers = allUsers.filter((u) => u.archived_at === null || assignedIds.has(u.id));
  const assigneeOptionAvatar = (u: (typeof pickerUsers)[number]): string => {
    let h = 0;
    for (let i = 0; i < u.id.length; i++) h = (h * 31 + u.id.charCodeAt(i)) % 360;
    const parts = u.name.trim().split(/\s+/).filter(Boolean);
    const initials = ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
    if (u.avatar_key) {
      // avatar_key com blob sumido (404) cai no fallback global de iniciais do
      // task-badges via data-hue/data-initials — sem ícone quebrado no picker.
      return `<img class="task-assignees-opt-avatar" src="/app/users/${esc(u.id)}/avatar" alt="" data-hue="${h}" data-initials="${esc(initials)}" data-fallback-class="task-assignees-opt-avatar">`;
    }
    return `<span class="task-assignees-opt-avatar" style="background:hsl(${h},42%,36%)">${esc(initials)}</span>`;
  };
  const assigneeChecks = pickerUsers
    .map((u) => {
      const checked = assignedIds.has(u.id) ? ' checked' : '';
      const archived = u.archived_at !== null;
      const typeTag = u.type === 'agent' ? '<span class="task-assignee-type">agente</span>' : '';
      return `<label class="task-assignees-opt${archived ? ' archived' : ''}">
        <input type="checkbox" name="user_ids" value="${esc(u.id)}"${checked}
          data-user-name="${esc(u.name)}" data-user-type="${esc(u.type)}" data-user-avatar="${u.avatar_key ? '1' : '0'}">
        ${assigneeOptionAvatar(u)}
        <span class="task-assignees-opt-name">${esc(u.name)}${archived ? ' (arquivado)' : ''}</span>
        ${typeTag}
      </label>`;
    })
    .join('');
  const assigneesSection = pickerUsers.length
    ? `<div class="task-sidebar-field">
        <span class="task-sidebar-lbl">Responsáveis</span>
        <details class="task-assignees-picker" data-assignees-picker>
          <summary class="task-assignees-summary" aria-label="Editar responsáveis">
            ${assigneeDotsHtml(taskAssignees)}
            <span class="task-assignees-addbtn" aria-hidden="true">+</span>
          </summary>
          <div class="task-assignees-popover">
            <form method="post" action="/app/tasks/assignees" class="task-assignees-form" data-assignees-form>
              <input type="hidden" name="task_id" value="${esc(task.id)}">
              <div class="task-assignees-list">${assigneeChecks}</div>
              <div class="task-assignees-actions">
                <button type="submit" class="btn task-d-btn" data-assignees-save>Salvar</button>
                <button type="button" class="btn task-d-btn" data-assignees-cancel>Cancelar</button>
                <span class="task-assignees-msg" data-assignees-msg role="status" aria-live="polite"></span>
              </div>
            </form>
          </div>
        </details>
      </div>`
    : `<div class="task-sidebar-field">
        <span class="task-sidebar-lbl">Responsáveis</span>
        <span style="color:var(--text-dim);font-size:13px">Nenhum usuário cadastrado — crie em <a href="/app/config?saved=users#users">Configurações → Usuários</a>.</span>
      </div>`;

  // "Criado por" (spec 37): a CREDENCIAL que criou — carimbo automático de
  // auditoria, distinto de responsáveis (decisão). NUNCA editável: não há form,
  // não há endpoint de escrita; é assinatura da infra. Bloco próprio com a
  // bolinha do usuário resolvido (ou o nome da chave). Null em task pré-0012 → omite.
  let createdBySection = '';
  if (createdBy) {
    const cbUser = createdBy.user;
    let dot: string;
    let label: string;
    let via = '';
    if (cbUser) {
      let h = 0;
      for (let i = 0; i < cbUser.id.length; i++) h = (h * 31 + cbUser.id.charCodeAt(i)) % 360;
      const parts = cbUser.name.trim().split(/\s+/).filter(Boolean);
      const initials = ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
      dot = cbUser.avatar
        ? `<img class="task-createdby-dot" src="/app/users/${esc(cbUser.id)}/avatar" alt="" data-hue="${h}" data-initials="${esc(initials)}" data-fallback-class="task-createdby-dot task-createdby-initials">`
        : `<span class="task-createdby-dot task-createdby-initials" style="background:hsl(${h},42%,36%)">${esc(initials)}</span>`;
      label = cbUser.name;
      if (cbUser.type === 'agent') via = createdBy.key_name ? `agente · chave ${createdBy.key_name}` : 'agente';
      else if (createdBy.key_name) via = `chave ${createdBy.key_name}`;
    } else if (createdBy.key_name) {
      dot = `<span class="task-createdby-dot task-createdby-key" title="Chave de API sem usuário vinculado">🔑</span>`;
      label = createdBy.key_name;
      via = 'chave de API';
    } else {
      dot = `<span class="task-createdby-dot task-createdby-key">🔑</span>`;
      label = createdBy.actor.startsWith('oauth:') ? 'dono (login)' : createdBy.actor;
    }
    createdBySection = `
          <div class="task-sidebar-field">
            <span class="task-sidebar-lbl">Criado por</span>
            <div class="task-createdby" title="Carimbo automático da credencial que criou a task — não editável">
              ${dot}
              <span class="task-createdby-name">${esc(label)}</span>
              ${via ? `<span class="task-createdby-via">${esc(via)}</span>` : ''}
            </div>
          </div>`;
  }

  // Funil de status estilo Pipedrive (pedido do dono, 10/07/2026): as colunas
  // ATIVAS do kanban viram etapas clicáveis numa barra horizontal no topo do
  // detalhe — substitui o antigo select "Coluna" da sidebar E o botão "✓ Concluir"
  // (mover pra coluna de categoria done É o novo concluir; o endpoint
  // /app/tasks/move já deriva status+completed_at da categoria). Clique numa
  // etapa → POST /app/tasks/move no client (task-edit.ts), que repinta a barra
  // sem reload. Coluna atual arquivada (drift raro): etapa extra desabilitada no
  // fim, só pra não mentir o estado.
  const allColumns = await listKanbanColumns(env, true);
  const activeColumns = allColumns.filter((c) => c.archived_at === null);
  const resolvedCol = resolveTaskColumn(task, allColumns);
  const currentColIdx = resolvedCol ? activeColumns.findIndex((c) => c.id === resolvedCol.id) : -1;
  const funnelSteps = activeColumns.map((c, i) => {
    const cls = ['task-funnel-step'];
    if (currentColIdx >= 0 && i <= currentColIdx) cls.push('reached');
    if (i === currentColIdx) cls.push('current');
    if (c.category === 'done') cls.push('cat-done');
    if (c.category === 'canceled') cls.push('cat-canceled');
    return `<button type="button" class="${cls.join(' ')}" data-funnel-col="${esc(c.id)}" title="Mover pra ${esc(c.label)}"><span class="task-funnel-lbl">${esc(c.label)}</span></button>`;
  }).join('');
  const archivedFunnelStep = resolvedCol && resolvedCol.archived_at !== null
    ? `<button type="button" class="task-funnel-step current archived" disabled><span class="task-funnel-lbl">${esc(resolvedCol.label)} (arquivada)</span></button>`
    : '';
  const funnelHtml = `<div class="task-funnel" data-funnel role="group" aria-label="Etapa da task">${funnelSteps}${archivedFunnelStep}</div>`;

  // Histórico (pedido do dono, 10/07/2026): toda edição gera log (task_activity,
  // migration 0019) — aqui é só leitura + tradução pra frases PT. Actors
  // repetidos resolvem uma vez só (o mesmo resolveActorProfile do "Criado por").
  const activityLog = await listTaskActivity(env, task.id, 30);
  const actorNames = new Map<string, string>();
  for (const entry of activityLog) {
    const a = entry.actor ?? '';
    if (actorNames.has(a)) continue;
    if (!a) { actorNames.set(a, 'sistema'); continue; }
    const prof = await resolveActorProfile(env, a);
    actorNames.set(a, prof?.user?.name ?? prof?.key_name ?? 'sistema');
  }
  const historyPhrase = (e: { field: string; old_value: string | null; new_value: string | null }): string => {
    const nv = e.new_value ?? '';
    const ov = e.old_value ?? '';
    switch (e.field) {
      case 'created': return 'criou a task';
      case 'title': return `renomeou pra "${nv}"`;
      case 'body': return 'editou a descrição';
      case 'column': return ov ? `moveu de ${ov} pra ${nv}` : `moveu pra ${nv}`;
      case 'priority': return `prioridade: ${ov || '(nenhuma)'} → ${nv || '(nenhuma)'}`;
      case 'due': return `prazo: ${nv}`;
      case 'tags': return `tags: ${nv}`;
      case 'project': return `projeto: ${nv || '(nenhum)'}`;
      case 'assignees': return `responsáveis: ${nv || 'ninguém'}`;
      case 'visibility': return `visibilidade: ${nv}`;
      case 'share': return nv;
      case 'status': return `status: ${nv}`;
      default: return `${e.field}: ${nv}`;
    }
  };
  const historySection = activityLog.length
    ? `<details class="task-history">
        <summary class="task-history-summary">Histórico (${activityLog.length})</summary>
        <ul class="task-history-list">${activityLog.map((e) => `
          <li><span class="task-history-when">${esc(formatBrtDateTime(e.at))}</span> · <span class="task-history-who">${esc(actorNames.get(e.actor ?? '') ?? 'sistema')}</span> ${esc(historyPhrase(e))}</li>`).join('')}
        </ul>
      </details>`
    : '';

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
      <a href="/app/tasks" class="task-d-back">← Tarefas</a>
      <span class="task-d-tag">Tarefa</span>
      ${isPrivate ? '<span class="private-badge" title="Task privada — invisível pra credenciais sem escopo private">🔒 privada</span>' : ''}
      ${originNote ? `<span class="task-d-origin">de <a href="/app/notes/${esc(originNote.id)}">${esc(originNote.title)}</a></span>` : ''}
      <div class="task-d-actions"><a href="/app/tasks" class="btn task-d-btn">Abrir no board</a></div>
    </div>

    ${funnelHtml}

    <div class="task-edit" data-task-id="${esc(task.id)}" data-updated-at="${task.updated_at}">
      <div class="task-detail-grid">
        <div class="task-detail-main">
          <div class="task-edit-titlerow">
            <textarea class="task-edit-title" data-field="title" maxlength="200" rows="1" placeholder="Título da task" aria-label="Título da task" title="Clique pra editar — Enter salva, Esc cancela">${esc(task.title)}</textarea>
          </div>

          <div class="task-edit-bodyrow">
            <div class="task-edit-bodyview" data-bodyview>
              <div class="task-edit-bodyhead">
                <span class="task-edit-lbl">Descrição</span>
                <button type="button" class="task-edit-pencil" data-edit-body title="Editar descrição" aria-label="Editar descrição">${PENCIL_SVG}</button>
              </div>
              <div class="note-body task-edit-preview${task.body.trim() ? '' : ' task-edit-preview-empty'}" data-preview>${task.body.trim()
                ? renderMarkdown(task.body, { titleIndex: new Map(), idSet: new Set(), currentId: task.id })
                : '<span class="task-edit-empty-trigger" data-edit-body>Sem descrição</span>'}</div>
            </div>
            <div class="task-edit-bodyedit" data-bodyedit hidden>
              <textarea class="task-edit-body" data-field="body" rows="10" aria-label="Descrição">${esc(task.body)}</textarea>
              <div class="task-edit-bodyedit-actions">
                <button type="button" class="btn task-d-btn task-edit-save" data-save="body">Salvar</button>
                <button type="button" class="btn task-d-btn task-edit-cancel" data-cancel-body>Cancelar</button>
              </div>
            </div>
          </div>

          <div class="task-edit-status" data-editstatus role="status" aria-live="polite"></div>

          ${activitySection}
        </div>

        <aside class="task-detail-sidebar">
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

          ${assigneesSection}

          ${createdBySection}

          ${datesHtml}

          ${visibilitySection}

          ${historySection}
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
// Complemento da seção de share NO DETALHE DE NOTA: o layout base (.task-d-btn) vem
// do TASK_DETAIL_CSS, que a página de nota não carrega — repõe só o necessário, mais
// o espaçamento da seção e o checkbox "incluir mídia" (exclusivo de nota).
const NOTE_SHARE_WRAP_CSS = `
.note-share-wrap { margin: 32px 0 8px; }
.note-share-media-opt { display:flex; align-items:center; gap:7px; font-size:13px; color:var(--text-dim); cursor:pointer; padding-bottom:8px; }
.note-share-media-opt input { accent-color: var(--accent-lav); }
`;

// CSS da seção "Compartilhamento público" (spec 33) — usada no detalhe de TASK
// e no detalhe de NOTA (mesmas classes .task-share*, wiring em client/visibility-ui.ts).
const SHARE_SECTION_CSS = `
/* Compartilhamento público (spec 33) — vive na sidebar (spec 52), espaçamento
   vem do gap do flex column ao redor, não de margin própria */
/* .task-d-btn é CO-CLASSE do .btn (Onda 3/5): o markup usa class="btn task-d-btn";
   aqui só o ajuste fino sobre o componente. Definido UMA vez (esta folha entra
   tanto no detalhe de task quanto no de nota). */
.task-d-btn { font-size:13px; padding:7px 14px; border-color:var(--border); background:var(--surface); color:var(--text); white-space:nowrap; }
.task-d-btn:hover { border-color:var(--border-strong); }
.task-share h2 { font-size:15px; margin-bottom:10px; }
.task-share-state { color:var(--text-dim); font-size:13px; line-height:1.5; margin-bottom:14px; }
.task-share-state strong { color:var(--text); }
.task-share-controls { display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
.task-share-ttl { display:flex; flex-direction:column; gap:6px; }
.task-share-ttl span { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-subtle); font-weight:600; }
.task-share-ttl input {
  width:96px; background:var(--bg-accent); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:7px 10px; font-size:13px; font-family:inherit;
}
.task-share-ttl input:focus { outline:none; border-color:var(--accent-lav); }
.task-share-btn { border-color:rgba(var(--accent-lav-rgb),0.4); color:var(--accent-lav); }
.task-share-btn:hover { background:rgba(var(--accent-lav-rgb),0.12); }
.task-share-revoke { border-color:var(--danger-border); color:var(--danger); }
.task-share-revoke:hover { background:var(--danger-bg); }
.task-share-revoke[hidden] { display:none; }
.task-share-link { display:flex; gap:8px; align-items:center; margin-bottom:10px; }
.task-share-link[hidden] { display:none; }
.task-share-link input {
  flex:1; min-width:0; background:var(--bg-accent); border:1px solid var(--border-strong); color:var(--text);
  border-radius:var(--radius-sm); padding:8px 12px; font-size:13px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
}
.task-share-link input:focus { outline:none; border-color:var(--accent-lav); }
.task-share-status { font-size:13px; min-height:18px; }
.task-share-status.ok { color:var(--success); }
.task-share-status.err { color:var(--danger); }
.task-share-status.saving { color:var(--text-dim); }

/* Seletor único de visibilidade (spec 65) — radiogroup de 3 níveis, task e nota.
   Compacto (10/07/2026): só rótulos, explicação no title (tooltip do browser). */
.task-visibility h2 { font-size:15px; margin-bottom:10px; }
.vis-group { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
.vis-opt {
  display:inline-flex; align-items:center; gap:7px;
  border:1px solid var(--border); border-radius:999px;
  padding:5px 12px; cursor:pointer;
  transition:border-color 140ms var(--ease), background 140ms var(--ease);
}
.vis-opt:hover { border-color:var(--border-strong); }
.vis-opt.selected { border-color:var(--accent-lav); background:rgba(var(--accent-lav-rgb),0.08); }
.vis-opt input[type="radio"] { margin:0; accent-color:var(--accent-lav); }
.vis-opt-head { display:flex; align-items:center; gap:6px; font-size:12.5px; font-weight:600; color:var(--text); white-space:nowrap; }
.vis-panel { border-top:1px dashed var(--border); padding-top:12px; margin-bottom:10px; }
.vis-panel[hidden] { display:none; }
`;

const TASK_DETAIL_CSS = `
/* Banner: breadcrumb + tag à esquerda, ações agrupadas à direita (1 canto só) */
.task-d-banner { display:flex; align-items:center; gap:12px; margin-bottom:22px; }
.task-d-back { color:var(--text-dim); font-size:13px; text-decoration:none; }
.task-d-back:hover { color:var(--text); }
.task-d-tag { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--accent-lav); border:1px solid rgba(var(--accent-lav-rgb),0.35); border-radius:999px; padding:2px 10px; }
.task-d-actions { display:flex; gap:10px; margin-left:auto; }
/* .task-d-btn: definição única em SHARE_SECTION_CSS (co-classe do .btn, Onda 5) */

/* Funil de status estilo Pipedrive (10/07/2026): etapas em chevron, esquerda →
   direita, com a etapa atual + anteriores preenchidas. Cada etapa é um <button>
   (CSP: wiring em task-edit.ts). clip-path desenha a seta; margem negativa
   encaixa uma etapa na outra. Rola horizontal no mobile. */
.task-funnel { display:flex; margin:0 0 22px; overflow-x:auto; padding-bottom:2px; }
.task-funnel-step {
  position:relative; flex:1 1 0; min-width:92px; height:34px; border:none; cursor:pointer;
  background:var(--bg-accent); color:var(--text-dim); font-family:inherit; font-size:12px; font-weight:600;
  display:inline-flex; align-items:center; justify-content:center; padding:0 18px 0 22px;
  clip-path:polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%, 12px 50%);
  margin-left:-8px; transition:background 140ms var(--ease), color 140ms var(--ease);
}
.task-funnel-step:first-child { clip-path:polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%); margin-left:0; padding-left:16px; }
.task-funnel-step:hover { background:var(--surface-raised); color:var(--text); }
.task-funnel-step.reached { background:rgba(var(--accent-lav-rgb),0.28); color:var(--text); }
.task-funnel-step.current { background:var(--accent-lav); color:#fff; }
.task-funnel-step.current.cat-done { background:var(--success); }
.task-funnel-step.reached.cat-done:not(.current) { background:var(--success-bg); }
.task-funnel-step.current.cat-canceled { background:var(--surface-raised); color:var(--text-dim); }
.task-funnel-step.archived { cursor:default; opacity:0.6; }
.task-funnel-lbl { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* Histórico (10/07/2026): feed compacto de edições na sidebar */
.task-history { border-top:1px dashed var(--border); padding-top:12px; }
.task-history-summary {
  cursor:pointer; font-size:10.5px; text-transform:uppercase; letter-spacing:.07em;
  color:var(--text-subtle); font-weight:600; list-style:none;
}
.task-history-summary::-webkit-details-marker { display:none; }
.task-history-summary::before { content:'▸ '; }
.task-history[open] .task-history-summary::before { content:'▾ '; }
.task-history-list {
  list-style:none; margin:10px 0 0; padding:0; display:flex; flex-direction:column; gap:7px;
  max-height:260px; overflow-y:auto; font-size:12px; color:var(--text-dim); line-height:1.45;
}
.task-history-when { color:var(--text-subtle); font-variant-numeric:tabular-nums; }
.task-history-who { color:var(--text); font-weight:600; }

/* Título: input grande, borda invisível até focar (estilo ClickUp) */
.task-edit-titlerow { display:flex; gap:12px; align-items:center; margin-bottom:20px; }
/* Textarea de 1 linha com auto-grow via JS (task-edit.ts) — título longo quebra
   em vez de cortar (input de linha única truncava). */
.task-edit-title {
  flex:1; min-width:0; font-family:var(--font-display); font-size:28px; font-weight:500; letter-spacing:-0.02em;
  color:var(--text); background:transparent; border:1px solid transparent;
  border-radius:var(--radius-sm); padding:8px 12px; transition:border-color 160ms var(--ease), background 160ms var(--ease);
  resize:none; overflow:hidden; line-height:1.25;
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
.task-sidebar-lbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-subtle); font-weight:600; }
.task-sidebar-val { font-size:13px; color:var(--text); }
.task-sidebar-dates { gap:10px; }
.task-sidebar-dates > div { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
/* Responsáveis estilo ClickUp (spec 74): dots (mesma classe do board, spec 37)
   + popover num <details> nativo — abre/fecha sem depender de JS. */
.task-assignees { display:inline-flex; align-items:center; }
.task-assignees .assignee-dot { margin-left:-6px; }
.task-assignees .assignee-dot:first-child { margin-left:0; }
.assignee-dot {
  width:20px; height:20px; border-radius:50%; object-fit:cover;
  border:1.5px solid var(--bg-accent); box-sizing:content-box;
  display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;
}
.assignee-dot-initials { color:#fff; font-size:9px; font-weight:600; letter-spacing:0.3px; line-height:1; }
.assignee-dot-agent { outline:1px dashed var(--text-dim); outline-offset:1px; }
.assignee-dot-more { background:var(--surface-raised); color:var(--text-dim); }
.assignee-dot-empty { border:1.5px dashed var(--border-strong); background:transparent; color:var(--text-dim); }
.task-assignees-picker { border:none; }
.task-assignees-summary {
  display:flex; align-items:center; gap:8px; cursor:pointer; list-style:none; padding:2px 0;
}
.task-assignees-summary::-webkit-details-marker { display:none; }
.task-assignees-summary::marker { content:''; }
.task-assignees-addbtn {
  display:inline-flex; align-items:center; justify-content:center;
  width:20px; height:20px; border-radius:50%; border:1px dashed var(--border-strong);
  color:var(--text-dim); font-size:13px; line-height:1; flex-shrink:0;
  transition:border-color 140ms var(--ease), color 140ms var(--ease);
}
.task-assignees-summary:hover .task-assignees-addbtn { border-color:var(--accent-lav); color:var(--accent-lav); }
.task-assignees-popover {
  margin-top:10px; padding:11px; border:1px solid var(--border); border-radius:var(--radius-sm);
  background:var(--surface);
}
.task-assignees-form { display:flex; flex-direction:column; gap:10px; }
.task-assignees-list { display:flex; flex-direction:column; gap:2px; max-height:220px; overflow-y:auto; }
.task-assignees-opt {
  display:flex; align-items:center; gap:8px; padding:5px 6px; border-radius:6px;
  font-size:13px; cursor:pointer; transition:background 120ms var(--ease);
}
.task-assignees-opt:hover { background:var(--bg-accent); }
.task-assignees-opt.archived { opacity:0.55; }
.task-assignees-opt input { accent-color:var(--accent-lav); margin:0; flex-shrink:0; }
.task-assignees-opt-avatar {
  width:22px; height:22px; border-radius:50%; object-fit:cover; flex-shrink:0;
  display:inline-flex; align-items:center; justify-content:center; color:#fff; font-size:10px; font-weight:600;
}
.task-assignees-opt-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.task-assignees-actions { display:flex; align-items:center; gap:10px; }
.task-assignees-msg { font-size:12px; color:var(--text-subtle); }
.task-assignees-msg.saving { color:var(--text-dim); }
.task-assignees-msg.ok { color:var(--success); }
.task-assignees-msg.err { color:var(--danger); }
.task-assignee-type { color:var(--text-dim); font-size:11px; border:1px dashed var(--border); border-radius:5px; padding:0 5px; margin-left:2px; }
/* Criado por (spec 37): carimbo read-only da credencial criadora, com avatar */
.task-createdby { display:flex; align-items:center; gap:8px; }
.task-createdby-dot { width:22px; height:22px; border-radius:50%; object-fit:cover; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0; }
.task-createdby-initials { color:#fff; font-size:10px; font-weight:600; }
.task-createdby-key { background:var(--surface-raised); font-size:11px; }
.task-createdby-name { font-size:13px; }
.task-createdby-via { color:var(--text-dim); font-size:11px; }
.task-edit-lbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-subtle); font-weight:600; }
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
  background:none; border:1px solid var(--border); color:var(--text-subtle);
  border-radius:var(--radius-sm); width:30px; height:32px; font-size:12px; cursor:pointer; flex-shrink:0;
  transition:color 160ms var(--ease), border-color 160ms var(--ease);
}
.task-edit-clear:hover { color:var(--danger); border-color:var(--danger-border); }
.task-edit-domains { display:flex; gap:6px; flex-wrap:wrap; align-items:center; min-height:24px; }
.task-edit-domains:empty::after { content:"—"; color:var(--text-subtle); }

/* Editor de tags (spec 52): chips + input inline, autosave via a fila de rajada */
.task-tags-editor { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.task-tag-chip {
  display:inline-flex; align-items:center; gap:3px; font-size:11px; font-weight:500;
  color:var(--text-dim); background:var(--surface-raised); border:1px solid var(--border);
  border-radius:999px; padding:3px 6px 3px 9px;
}
.task-tag-remove {
  background:none; border:none; color:var(--text-subtle); cursor:pointer; font-size:13px;
  line-height:1; padding:0 3px; transition:color 140ms var(--ease);
}
.task-tag-remove:hover { color:var(--danger); }
.task-tags-input {
  flex:1 1 70px; min-width:70px; background:transparent; border:1px solid transparent;
  color:var(--text); font-family:inherit; font-size:12px; padding:4px 7px; border-radius:6px;
  transition:border-color 160ms var(--ease), background 160ms var(--ease);
}
.task-tags-input::placeholder { color:var(--text-subtle); }
.task-tags-input:focus { outline:none; border-color:var(--accent-lav); background:var(--bg-accent); }

/* Campo único de descrição (spec 74): LEITURA por padrão (prévia + botão
   discreto "Editar"); clique troca pra EDIÇÃO (textarea + Salvar/Cancelar). */
.task-edit-bodyrow { margin-bottom:8px; }
.task-edit-bodyview { display:flex; flex-direction:column; gap:10px; }
/* [hidden] precisa de display:none EXPLÍCITO: CSS de autor (.task-edit-bodyview
   { display:flex }) ganha do [hidden] do UA stylesheet no empate de origem —
   sem isto, JS setar .hidden=true não escondia a view (prévia duplicada ao
   lado da textarea de edição). Mesmo fix do note-edit-bodyview. */
.task-edit-bodyview[hidden] { display:none; }
.task-edit-bodyhead { display:flex; align-items:center; justify-content:space-between; gap:10px; }
/* Botão-ícone de lápis (10/07/2026): único ponto de entrada da edição da
   descrição — discreto até o hover. */
.task-edit-pencil {
  display:inline-flex; align-items:center; justify-content:center;
  width:28px; height:28px; border-radius:var(--radius-sm);
  border:1px solid transparent; background:transparent; color:var(--text-dim); cursor:pointer;
  transition:color 140ms var(--ease), background 140ms var(--ease), border-color 140ms var(--ease);
}
.task-edit-pencil:hover { color:var(--text); background:var(--bg-accent); border-color:var(--border); }
.task-edit-preview-empty { color:var(--text-subtle); }
.task-edit-empty-trigger { cursor:pointer; text-decoration:underline dotted; text-underline-offset:3px; }
.task-edit-empty-trigger:hover { color:var(--text); }
.task-edit-bodyedit { display:flex; flex-direction:column; gap:10px; margin-top:10px; }
.task-edit-bodyedit[hidden] { display:none; }
.task-edit-bodyedit-actions { display:flex; gap:10px; }
.task-edit-body {
  width:100%; box-sizing:border-box; min-height:180px; resize:vertical;
  background:var(--surface); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:14px; font-size:14px; line-height:1.55;
  font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
  transition:border-color 160ms var(--ease);
}
.task-edit-body:focus { outline:none; border-color:var(--accent-lav); }
.task-edit-preview {
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
  padding:16px 20px;
}
.task-edit-status { font-size:13px; min-height:20px; margin-top:14px; }
.task-edit-status.ok { color:var(--success); }
.task-edit-status.saving { color:var(--text-dim); }
.task-edit-status.err { color:var(--danger); }
.task-edit-save.dirty { border-color:var(--accent-lav); color:var(--accent-lav); }

${SHARE_SECTION_CSS}

/* Atividade — thread de comentários (spec 53) no console do dono */
.task-activity { margin:32px 0 8px; }
.task-activity h2 { font-size:15px; margin-bottom:14px; }
.cmt-thread { list-style:none; margin:0 0 18px; padding:0; display:flex; flex-direction:column; gap:12px; }
.cmt-item { border:1px solid var(--border); border-radius:var(--radius); padding:11px 14px; background:var(--surface); }
.cmt-head { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.cmt-author { font-size:13px; font-weight:600; color:var(--text); }
.cmt-author-owner { color:var(--accent-lav); }
.cmt-author-agent { color:var(--info); }
.cmt-author-guest { color:var(--text); }
.cmt-time { font-size:11.5px; color:var(--text-subtle); font-variant-numeric:tabular-nums; }
.cmt-avatar { width:20px; height:20px; border-radius:50%; object-fit:cover; display:inline-flex; align-items:center; justify-content:center; font-size:9px; font-weight:700; color:#fff; flex:0 0 auto; }
.cmt-unsigned { font-size:10.5px; color:var(--text-subtle); border:1px solid var(--border); border-radius:999px; padding:1px 8px; }
.cmt-mention { color:var(--accent-lav); background:rgba(167,139,250,0.12); border-radius:4px; padding:0 3px; }
.cmt-body { font-size:14px; line-height:1.55; color:var(--text); word-break:break-word; }
.cmt-empty { color:var(--text-subtle); font-size:14px; margin-bottom:18px; }
.cmt-del-form { margin-left:auto; }
.cmt-del { background:none; border:none; color:var(--text-subtle); font-size:11.5px; cursor:pointer; padding:0; transition:color 140ms var(--ease); }
.cmt-del:hover { color:var(--danger); }
.cmt-form { display:flex; flex-direction:column; gap:10px; }
.cmt-field { display:flex; flex-direction:column; gap:6px; }
.cmt-lbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-subtle); font-weight:600; }
.cmt-form textarea {
  width:100%; box-sizing:border-box; resize:vertical; min-height:64px;
  background:var(--surface); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:11px 13px; font-family:inherit; font-size:14px; line-height:1.5;
  transition:border-color 160ms var(--ease);
}
.cmt-form textarea:focus { outline:none; border-color:var(--accent-lav); }
.cmt-form-foot { display:flex; justify-content:flex-end; }
.cmt-submit { border-color:rgba(var(--accent-lav-rgb),0.4); color:var(--accent-lav); }
.cmt-submit:hover { background:rgba(var(--accent-lav-rgb),0.12); }

/* Breakpoint canônico 767px (Onda 5 — alinhado ao shell) */
@media (max-width: 767px) {
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
/* Textarea de 1 linha com auto-grow via JS (note-edit.ts) — título longo quebra
   em vez de cortar/colidir com "Salvar" (o antigo input de linha única truncava). */
.note-edit-title {
  flex:1; min-width:0; font-family:var(--font-display); font-size:30px; font-weight:600; letter-spacing:-0.02em;
  color:var(--text); background:transparent; border:1px solid transparent;
  border-radius:var(--radius-sm); padding:6px 10px; transition:border-color 160ms var(--ease), background 160ms var(--ease);
  resize:none; overflow:hidden; line-height:1.25;
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
.note-edit-lbl { font-size:10.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--text-subtle); font-weight:600; }
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
.note-edit-domain-slug { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size:10.5px; color:var(--text-subtle); }
.note-edit-updated { font-size:12px; color:var(--text-subtle); margin-left:auto; align-self:center; }
.note-edit-copy {
  background:none; border:1px solid var(--border); border-radius:6px; color:var(--text-dim);
  cursor:pointer; font-size:12px; padding:5px 11px; align-self:center;
  transition:border-color 140ms var(--ease), color 140ms var(--ease);
}
.note-edit-copy:hover { border-color:var(--border-strong); color:var(--text); }

/* Selo de privacidade (spec 31): toggle no detalhe. O form é plano (sem JS) pra ser
   CSP-safe — a ÚNICA superfície que desmarca uma nota. O badge .private-badge é global
   (styles.ts) pra valer também na lista. */
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
.note-edit-tldr-count { position:absolute; right:4px; bottom:-16px; font-size:11px; color:var(--text-subtle); font-variant-numeric:tabular-nums; }
.note-edit-tldr-count.bad { color:var(--danger); }

.note-edit-bodyrow { margin-top:26px; margin-bottom:28px; }
/* Campo único de corpo (spec 74): LEITURA por padrão (prévia + botão discreto
   "Editar"); clique troca pra EDIÇÃO (textarea + Salvar/Cancelar). Os antigos
   rótulos de cabeçalho separados sumiram — o botão já diz o que faz. Rótulo
   "Corpo" + Editar TAMBÉM no topo do bloco (não só no rodapé — corpo longo não
   deve exigir rolar tudo pra achar a edição). */
.note-edit-bodyview { display:flex; flex-direction:column; gap:10px; }
/* [hidden] precisa de display:none EXPLÍCITO: a regra .note-edit-bodyview
   { display:flex } (CSS de autor) tem prioridade sobre o [hidden] do UA
   stylesheet (também autor-normal, mas o UA perde no empate de origem) — sem
   isto, JS setar .hidden=true NÃO escondia a view (prévia + textarea duplicadas
   visíveis ao mesmo tempo durante a edição). */
.note-edit-bodyview[hidden] { display:none; }
.note-edit-bodyhead { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.note-edit-editbtn {
  align-self:flex-end; font-size:12px; padding:5px 12px; border-radius:var(--radius-sm);
  border:1px solid var(--border); background:none; color:var(--text-dim); cursor:pointer;
  transition:border-color 140ms var(--ease), color 140ms var(--ease);
}
.note-edit-editbtn:hover { border-color:var(--border-strong); color:var(--text); }
.note-edit-preview-empty { color:var(--text-subtle); }
.note-edit-empty-trigger { cursor:pointer; text-decoration:underline dotted; text-underline-offset:3px; }
.note-edit-empty-trigger:hover { color:var(--text); }
.note-edit-bodyedit { display:flex; flex-direction:column; gap:10px; }
.note-edit-bodyedit[hidden] { display:none; }
.note-edit-bodyedit-actions { display:flex; gap:10px; }
.note-edit-cancel {
  font-size:13px; padding:7px 14px; border-radius:var(--radius-sm); border:1px solid var(--border);
  background:none; color:var(--text-dim); cursor:pointer;
  transition:border-color 160ms var(--ease), color 160ms var(--ease);
}
.note-edit-cancel:hover { border-color:var(--border-strong); color:var(--text); }
.note-edit-body {
  width:100%; box-sizing:border-box; min-height:220px; resize:vertical;
  background:var(--surface); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:14px; font-size:14px; line-height:1.55;
  font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
  transition:border-color 160ms var(--ease);
}
.note-edit-body:focus { outline:none; border-color:var(--accent-lav); }
.note-edit-preview {
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px 20px;
}
.note-edit-status { font-size:13px; min-height:20px; margin-top:14px; }
.note-edit-status.ok { color:var(--success); }
.note-edit-status.saving { color:var(--text-dim); }
.note-edit-status.err { color:var(--danger); }
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
.media-dropzone:hover, .media-dropzone.drag-over { color: var(--text); background: rgba(var(--accent-lav-rgb),0.07); border-color: var(--accent-lav); }
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
.media-modal .media-del { color: var(--danger); border-color: var(--danger-border); }
.media-modal .media-del:hover { background: var(--danger-bg); }
`;
