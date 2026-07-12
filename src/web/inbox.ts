import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { requireSession } from './session.js';
import { renderShell, htmlResponse, sidebarCollapsedFromReq } from './render.js';
import { formError, formErrorBanner } from './form-error.js';
import { renderMarkdown } from './markdown.js';
import { newId } from '../util/id.js';
import { embed, upsertNoteVector, queryVector, type VectorMatch } from '../vector/index.js';
import { SIMILARITY_TOP_K, DEDUP_MIN_SCORE, persistSimilarEdgesFromMatches } from './similarity.js';
import {
  insertInboxItem,
  listInboxItems,
  getInboxItem,
  resolveInboxItem,
  countPendingInbox,
  insertNote,
  insertTask,
  getNotesByIds,
  INBOX_BODY_MAX,
} from '../db/queries.js';
import {
  MEDIA_KINDS, type MediaKind,
  insertMedia, insertInboxMedia, getInboxMediaById, listInboxMediaByItem,
  listInboxMediaByItems, deleteInboxMediaById, countMediaByHashAllTables,
} from '../db/media-queries.js';
import { putBlobDedup, kindFromMime, safeDispositionFilename, MAX_BYTES } from '../media/store.js';

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

// Onda 8 (spec 70): o card Inbox da home usa os MESMOS endpoints — o hidden `next`
// devolve o dono pra onde ele estava. Allowlist fechada: só '/app' (home) é aceito;
// qualquer outro valor cai no default /app/inbox (nunca redirect arbitrário).
function backTo(form: FormData): Response {
  const next = String(form.get('next') ?? '').trim();
  const location = next === '/app' ? '/app' : '/app/inbox';
  return new Response(null, { status: 302, headers: { location } });
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
.inbox-item-media { display: flex; gap: 8px; flex-wrap: wrap; }
.inbox-item-img {
  display: block; max-width: 100%; max-height: 220px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.inbox-item-file {
  font-size: 13px; color: var(--accent-lav); text-decoration: none;
  border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px;
}
.inbox-item-file:hover { border-color: var(--border-strong); }
`;

// ───────────────── Web Share Target nível 2 (arquivo, spec 68) ─────────────────

// Duck-type de File (mesmo racional de media.ts): o lib do Worker não tipa File
// como construtor utilizável — um File tem .arrayBuffer()/.size/.name/.type.
function asFile(entry: unknown): File | null {
  if (!entry || typeof entry === 'string') return null;
  const f = entry as File;
  return typeof f.arrayBuffer === 'function' && f.size > 0 ? f : null;
}

// Cria um item do inbox vindo de share (source 'pwa-share'), com anexo opcional.
// O item é criado ANTES da mídia de propósito: captura não pode virar dead-end por
// falha de upload — no pior caso o texto fica sem o anexo (erro logado).
async function createSharedInboxItem(env: Env, text: string, file: File | null): Promise<string> {
  const now = Date.now();
  const id = `ibx_${newId()}`;
  const body = (text || (file?.name ? `(arquivo compartilhado: ${file.name})` : '(arquivo compartilhado)')).slice(0, INBOX_BODY_MAX);
  await insertInboxItem(env, { id, body, source: 'pwa-share', created_at: now });
  if (file) {
    const mime = file.type || 'application/octet-stream';
    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored = await putBlobDedup(env, bytes, mime);
    await insertInboxMedia(env, {
      id: newId(), item_id: id, kind: kindFromMime(mime),
      r2_key: stored.r2_key, content_hash: stored.content_hash,
      mime_type: mime, size_bytes: bytes.length,
      original_filename: file.name || null, created_at: now,
    });
  }
  return id;
}

// Remove as mídias de um item descartado; o blob R2 só sai se esta era a ÚLTIMA
// referência ao content_hash nas DUAS tabelas (note_media + inbox_media, dedup).
export async function discardInboxMedia(env: Env, itemId: string): Promise<void> {
  const rows = await listInboxMediaByItem(env, itemId);
  for (const m of rows) {
    await deleteInboxMediaById(env, m.id);
    const remaining = await countMediaByHashAllTables(env, m.content_hash);
    if (remaining === 0 && env.MEDIA) await env.MEDIA.delete(m.r2_key);
  }
}

// Migra as mídias do item pra nota/task recém-criada: mesma key R2 (dedup por
// construção) — só nasce a linha em note_media e morre a de inbox_media. Best-effort:
// falha aqui não desfaz a criação (o anexo é acessório da captura, não o núcleo).
async function migrateInboxMediaToNote(env: Env, itemId: string, noteId: string, now: number): Promise<void> {
  try {
    const rows = await listInboxMediaByItem(env, itemId);
    for (const m of rows) {
      await insertMedia(env, {
        id: newId(), note_id: noteId,
        kind: MEDIA_KINDS.includes(m.kind as MediaKind) ? (m.kind as MediaKind) : 'document',
        r2_key: m.r2_key, content_hash: m.content_hash, mime_type: m.mime_type,
        size_bytes: m.size_bytes, original_filename: m.original_filename, created_at: now,
      });
      await deleteInboxMediaById(env, m.id);
    }
  } catch (err) {
    console.error('inbox: migração de mídia na triagem falhou (item triado, anexo ficou pra trás)', err);
  }
}

// POST /app/inbox/share — alvo do `share_target` do manifest (multipart). O caminho
// NORMAL nunca chega aqui: o service worker intercepta o POST, guarda o arquivo no
// Cache API e redireciona pro GET (o POST de navegação top-level não manda o cookie
// SameSite=Lax, então esta rota quase sempre chegaria sem sessão). Fallback defensivo
// pra SW ausente/desatualizado: com sessão + arquivo captura completo; sem sessão,
// degrada pro fluxo GET (texto preservado nos params; o arquivo se perde).
export async function handleInboxSharePost(req: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response(null, { status: 303, headers: { location: '/app/inbox' } });
  }
  const title = String(form.get('title') ?? '').trim();
  const text = String(form.get('text') ?? '').trim();
  const sharedUrl = String(form.get('url') ?? '').trim();
  const file = asFile(form.get('media'));

  const session = await requireSession(req, env);
  if (session.ok && file && file.size <= MAX_BYTES) {
    const body = [title, text, sharedUrl].filter(Boolean).join('\n\n');
    try {
      await createSharedInboxItem(env, body, file);
      return new Response(null, { status: 303, headers: { location: '/app/inbox' } });
    } catch (err) {
      console.error('inbox share: captura com arquivo falhou (degrada pro prefill de texto)', err);
    }
  }
  const params = new URLSearchParams();
  if (title) params.set('title', title);
  if (text) params.set('text', text);
  if (sharedUrl) params.set('url', sharedUrl);
  const qs = params.toString();
  return new Response(null, { status: 303, headers: { location: `/app/inbox${qs ? `?${qs}` : ''}` } });
}

// POST /app/inbox/share-upload — segunda perna do share de arquivo: o client
// (shell.ts) resgata o blob que o SW guardou no Cache API e sobe AQUI via fetch
// same-origin (cookie de sessão flui normal). JSON, não redirect.
export async function handleInboxShareUploadPost(req: Request, env: Env): Promise<Response> {
  const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  const session = await requireSession(req, env);
  if (!session.ok) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: jsonHeaders });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'multipart inválido' }), { status: 400, headers: jsonHeaders });
  }
  const text = String(form.get('text') ?? '').trim();
  const file = asFile(form.get('media'));
  if (!text && !file) return new Response(JSON.stringify({ ok: false, error: 'nada pra capturar' }), { status: 400, headers: jsonHeaders });
  if (file && file.size > MAX_BYTES) {
    return new Response(JSON.stringify({ ok: false, error: 'arquivo acima de 50MB' }), { status: 413, headers: jsonHeaders });
  }
  try {
    const id = await createSharedInboxItem(env, text, file);
    return new Response(JSON.stringify({ ok: true, id }), { status: 201, headers: jsonHeaders });
  } catch (err) {
    console.error('inbox share-upload falhou', err);
    return new Response(JSON.stringify({ ok: false, error: 'falha ao capturar' }), { status: 500, headers: jsonHeaders });
  }
}

// GET /app/inbox/media/:id — serve o anexo de um item do inbox. SÓ sessão (o inbox
// é superfície do dono; não há signed URL aqui — o <img> da página logada já manda
// o cookie).
export async function handleInboxMediaServe(req: Request, env: Env, mediaId: string): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const media = await getInboxMediaById(env, mediaId);
  if (!media || !env.MEDIA) return htmlResponse('não encontrado', 404);
  const obj = await env.MEDIA.get(media.r2_key);
  if (!obj) return htmlResponse('não encontrado', 404);
  const headers = new Headers();
  headers.set('content-type', obj.httpMetadata?.contentType || media.mime_type || 'application/octet-stream');
  headers.set('cache-control', 'private, max-age=3600');
  headers.set('content-length', String(media.size_bytes));
  const safeName = media.original_filename ? safeDispositionFilename(media.original_filename) : '';
  if (safeName) {
    headers.set('content-disposition', `inline; filename="${safeName}"`);
  }
  return new Response(obj.body, { headers });
}

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

  // Anexos dos itens (spec 68 — share de arquivo): 1 query pra todos os itens da página.
  const mediaByItem = await listInboxMediaByItems(env, items.map((it) => it.id));

  const itemsHtml = items
    .map((it) => {
      const bodyHtml = renderMarkdown(it.body, { titleIndex: emptyTitle, idSet: emptyIds, currentId: it.id });
      const mediaHtml = (mediaByItem.get(it.id) ?? [])
        .map((m) => m.kind === 'image'
          ? `<a href="/app/inbox/media/${esc(m.id)}" target="_blank" rel="noopener"><img class="inbox-item-img" src="/app/inbox/media/${esc(m.id)}" alt="${esc(m.original_filename ?? 'imagem anexada')}" loading="lazy"></a>`
          : `<a class="inbox-item-file" href="/app/inbox/media/${esc(m.id)}" target="_blank" rel="noopener">${esc(m.original_filename ?? m.mime_type)}</a>`)
        .join('');
      return `
      <div class="inbox-item">
        <div class="inbox-item-head">
          <span class="inbox-item-source">${esc(it.source)}</span>
          <span>·</span>
          <span>${esc(ageLabel(it.created_at, now))}</span>
        </div>
        <div class="inbox-item-body">${bodyHtml}</div>
        ${mediaHtml ? `<div class="inbox-item-media">${mediaHtml}</div>` : ''}
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
    ${formErrorBanner(new URL(req.url))}
    <p class="config-subtitle"><a href="/app">← Início</a></p>

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
      // O Inbox saiu do menu (Onda 8): esta página é alcançada pelo card da home
      // ("ver tudo") e pelo Web Share Target do PWA — na nav, Início fica ativo.
      title: 'Inbox',
      active: 'home',
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
  // Vazio: no-op silencioso (volta pra origem), não é erro do usuário.
  if (!text) return backTo(form);
  const body = text.slice(0, INBOX_BODY_MAX);
  const rawSource = String(form.get('source') ?? '').trim();
  const source = ADD_POST_SOURCES.has(rawSource) ? rawSource : 'console';

  await insertInboxItem(env, {
    id: `ibx_${newId()}`,
    body,
    source,
    created_at: Date.now(),
  });
  return backTo(form);
}

// POST /app/inbox/resolve — marca triado (usado pelo "Descartar"). Form-encoded + redirect.
export async function handleInboxResolvePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return formError(req, 'id obrigatório', { returnTo: '/app/inbox' });
  const action = String(form.get('action') ?? 'discard').trim();
  if (action !== 'note' && action !== 'task' && action !== 'discard') {
    return formError(req, 'ação inválida', { returnTo: '/app/inbox' });
  }
  const resultId = String(form.get('result_id') ?? '').trim() || null;
  await resolveInboxItem(env, id, action, resultId, Date.now());
  // Descartar joga fora também o anexo (spec 68); best-effort — falha não trava a triagem.
  if (action === 'discard') {
    try {
      await discardInboxMedia(env, id);
    } catch (err) {
      console.error('inbox discard: limpeza de mídia falhou', err);
    }
  }
  return backTo(form);
}

// POST /app/inbox/to-note — cria uma NOTA (fluxo normal: embed + insertNote + upsert
// vetor, igual save_note) pré-preenchida com o item, RESOLVE o item com o result_id e
// redireciona pro editor da nota (pré-preenchido) pra curadoria. Embedding é best-effort:
// se o Workers AI falhar, a nota é criada mesmo assim (editável; re-embeda na 1ª curadoria).
//
// Aviso de duplicata (spec 75-paridade-gate-web): pré-consulta de vizinhança IGUAL ao
// save_note, ANTES do insert (o noteId ainda não está no índice, então todo match é
// candidato legítimo). Os MESMOS matches alimentam depois persistSimilarEdgesFromMatches
// — zero segunda query idêntica ao Vectorize (o antigo refreshSimilarEdges refazia a
// consulta). Melhor match >= DEDUP_MIN_SCORE redireciona com ?dup=<id> — aviso PÓS-criação
// (a nota já existe), nunca tela de confirmação. Falha da pré-consulta ou do Vectorize em
// geral nunca derruba a criação da nota (best-effort do início ao fim).
export async function handleInboxToNotePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return formError(req, 'id obrigatório', { returnTo: '/app/inbox' });

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

  // Pré-consulta de vizinhança best-effort — falha aqui não impede a criação, só
  // deixa a lista de matches vazia (sem dup check, sem similar_edges deste save).
  let matches: VectorMatch[] = [];
  if (vec) {
    try {
      matches = await queryVector(env, vec, SIMILARITY_TOP_K + 2);
    } catch (err) {
      console.error('inbox to-note: pré-consulta de vizinhança falhou (segue sem dup check)', err);
    }
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
      // Reusa os matches da pré-consulta — substitui o refreshSimilarEdges antigo,
      // que fazia uma SEGUNDA query idêntica ao Vectorize.
      await persistSimilarEdgesFromMatches(env, noteId, matches);
    } catch (err) {
      console.error('inbox to-note: upsert vetor/edges falhou (nota persistida)', err);
    }
  }

  await migrateInboxMediaToNote(env, id, noteId, now);
  await resolveInboxItem(env, id, 'note', noteId, now);

  // Melhor match do gate de dedup (spec 71/75): hidrata a candidata pra confirmar que
  // existe/está viva (sessão é do dono → canSeePrivate=true) antes de linkar no redirect.
  // Some silenciosamente se o Vectorize apontar pra algo já deletado/inexistente.
  const best = matches[0];
  if (best && best.score >= DEDUP_MIN_SCORE) {
    const [candidate] = await getNotesByIds(env, [best.id], true);
    if (candidate) {
      return new Response(null, { status: 302, headers: { location: `/app/notes/${noteId}?dup=${candidate.id}` } });
    }
  }

  return new Response(null, { status: 302, headers: { location: `/app/notes/${noteId}` } });
}

// POST /app/inbox/to-task — cria uma TASK (fluxo normal: insertTask, igual /app/tasks/
// create) pré-preenchida com o item, RESOLVE o item e redireciona pro detalhe da task.
export async function handleInboxToTaskPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return formError(req, 'id obrigatório', { returnTo: '/app/inbox' });

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

  await migrateInboxMediaToNote(env, id, taskId, now);
  await resolveInboxItem(env, id, 'task', taskId, now);
  return new Response(null, { status: 302, headers: { location: `/app/tasks/${taskId}` } });
}
