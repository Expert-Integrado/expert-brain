// Compartilhamento público read-only de TASK por token (/s/<token>).
//
// Segurança (requisitos NÃO-negociáveis, ver specs/30-features/33-...):
// - Token = 32 bytes de crypto.getRandomValues, base64url, prefixo `ebs_`. NUNCA
//   derivado do id da task (ids são nanoids curtos, enumeráveis).
// - O banco guarda SOMENTE sha256Hex(token) na coluna notes.share_token. O plaintext
//   aparece UMA vez, na resposta de criação. Vazamento do D1 não vaza links válidos.
// - Lookup por hash via índice UNIQUE parcial (idx_notes_share_token) — sem comparação
//   de plaintext em código, então não há timing side-channel de igualdade. (A busca é
//   por igualdade de HASH no D1, que é um lookup de índice, não um scan constante em JS.)
// - Rota pública renderiza standalone (sem shell logado, sem /app/*, sem edges, sem
//   dados do dono). Token inválido/expirado/revogado → MESMO 404 genérico.
//
// Escopo desta onda: SÓ task (kind='task'). Nota de conhecimento fica pra depois.

import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { NEBULA_CSS, FONT_LINKS } from './styles.js';
import { renderMarkdown } from './markdown.js';
import {
  getTaskById,
  addTaskComment,
  listTaskComments,
  countTaskComments,
  type TaskRow,
  type TaskComment,
} from '../db/queries.js';
import { formatBrtDateTime } from '../util/time.js';
import { PRIORITIES } from '../util/priority.js';
import { newId } from '../util/id.js';
import { renderCommentThread } from './comments-render.js';

const TOKEN_PREFIX = 'ebs_';
const DEFAULT_EXPIRES_DAYS = 30;
const MAX_EXPIRES_DAYS = 365;
const MIN_EXPIRES_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

// Comentário de convidado (spec 53). Nome obrigatório ≤60; corpo ≤2000 no público
// (o schema do banco aceita até 4000 — dono/agente podem mais). Rate-limit no
// GRAPH_CACHE (sem namespace novo): 10/h por token, 5/h por IP, janela de 1h.
// Teto absoluto por task pra fechar o form contra botnet multi-IP.
const GUEST_MAX_NAME = 60;
const GUEST_MAX_BODY = 2000;
const RL_TTL_SECONDS = 3600;
const RL_MAX_PER_TOKEN = 10;
const RL_MAX_PER_IP = 5;
const GUEST_HARD_CAP = 200;

// base64url de bytes crus (mesmo padrão de auth/api-keys.ts randomSecret).
function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 32 bytes random → base64url (43 chars) com prefixo ebs_. Total ~47 chars url-safe.
function generateToken(): string {
  return `${TOKEN_PREFIX}${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

// Formato do token na URL pública: prefixo + base64url longo. O `{40,}` garante que
// o link tem entropia suficiente (43 chars pra 32 bytes) e mantém o regex estrito.
export const SHARE_TOKEN_RE = /^ebs_[A-Za-z0-9_-]{40,}$/;

export function absoluteShareUrl(env: Env, token: string): string {
  const base = env.WORKER_URL?.replace(/\/$/, '') ?? '';
  return `${base}/s/${token}`;
}

export interface CreateShareOk {
  ok: true;
  token: string; // plaintext — só existe aqui, uma vez
  url: string;
  expires_at: number;
  expires_brt: string;
}
export type CreateShareResult =
  | CreateShareOk
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'already-shared'; expires_at: number; expires_brt: string };

// Cria (ou renova) o share de uma task. Valida kind='task' + não-deletada.
// - Se já há um share VIVO (token presente e não expirado) e renew !== true → devolve
//   'already-shared' com a expiração atual, sem rotacionar (não invalida o link já
//   enviado). O plaintext não pode ser reconstruído (só guardamos o hash), então
//   pra reobter a URL o dono renova (renew:true) — o link antigo é substituído.
// - renew:true (ou sem share vivo) → gera token novo, grava hash + expiração, devolve
//   a URL absoluta uma única vez.
export async function createShare(
  env: Env,
  taskId: string,
  opts: { expiresDays?: number; renew?: boolean },
  now: number
): Promise<CreateShareResult> {
  const task = await getTaskById(env, taskId);
  if (!task) return { ok: false, reason: 'not-found' };

  const alreadyLive =
    task.share_token != null &&
    task.share_expires_at != null &&
    task.share_expires_at > now;

  if (alreadyLive && !opts.renew) {
    return {
      ok: false,
      reason: 'already-shared',
      expires_at: task.share_expires_at!,
      expires_brt: formatBrtDateTime(task.share_expires_at!),
    };
  }

  const days = clampDays(opts.expiresDays);
  const expiresAt = now + days * DAY_MS;
  const token = generateToken();
  const tokenHash = await sha256Hex(token);

  // Guarda o HASH (nunca o plaintext) + expiração. WHERE kind='task' é defesa em
  // profundidade — o getTaskById acima já garantiu, mas o UPDATE reafirma o escopo.
  await env.DB.prepare(
    `UPDATE notes SET share_token = ?, share_expires_at = ? WHERE id = ? AND kind = 'task' AND deleted_at IS NULL`
  ).bind(tokenHash, expiresAt, taskId).run();

  return {
    ok: true,
    token,
    url: absoluteShareUrl(env, token),
    expires_at: expiresAt,
    expires_brt: formatBrtDateTime(expiresAt),
  };
}

function clampDays(raw?: number): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_EXPIRES_DAYS;
  const n = Math.floor(raw);
  if (n < MIN_EXPIRES_DAYS) return MIN_EXPIRES_DAYS;
  if (n > MAX_EXPIRES_DAYS) return MAX_EXPIRES_DAYS;
  return n;
}

// Revogação REAL: limpa token + expiração. O próximo request na rota pública não
// encontra hash → 404. Retorna true se havia um share pra limpar.
export async function revokeShare(env: Env, taskId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE notes SET share_token = NULL, share_expires_at = NULL
     WHERE id = ? AND kind = 'task' AND share_token IS NOT NULL`
  ).bind(taskId).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Estado do share de uma task pra UI logada (nunca expõe token plaintext).
export interface ShareStatus {
  shared: boolean;
  expires_at: number | null;
  expires_brt: string | null;
  expired: boolean;
}
export async function getShareStatus(env: Env, taskId: string, now: number): Promise<ShareStatus | null> {
  const task = await getTaskById(env, taskId);
  if (!task) return null;
  const shared = task.share_token != null;
  const expiresAt = task.share_expires_at ?? null;
  return {
    shared,
    expires_at: expiresAt,
    expires_brt: expiresAt != null ? formatBrtDateTime(expiresAt) : null,
    expired: shared && expiresAt != null && expiresAt <= now,
  };
}

// Resolve um token público → a task, SÓ se: hash bate, share não expirou, task é
// kind='task', viva (deleted_at IS NULL). Re-checa TUDO a cada acesso (revogar/expirar/
// deletar mata o link no request seguinte). Retorna null pra QUALQUER motivo de falha
// (o caller responde o mesmo 404 genérico, sem distinguir a causa).
export async function resolveShare(env: Env, token: string, now: number): Promise<TaskRow | null> {
  if (!SHARE_TOKEN_RE.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT id, title, body, tldr, domains, kind, status, due_at, priority, completed_at,
            created_at, updated_at, share_token, share_expires_at
     FROM notes
     WHERE share_token = ? AND kind = 'task' AND deleted_at IS NULL`
  ).bind(tokenHash).first<TaskRow>();
  if (!row) return null;
  if (row.share_expires_at == null || row.share_expires_at <= now) return null;
  return row;
}

// ───────────────────────────── Página pública ─────────────────────────────

const NOT_FOUND_HTML = `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Link inválido</title>
${FONT_LINKS}
<style>${NEBULA_CSS}
.share-404 { max-width: 480px; margin: 18vh auto; padding: 0 24px; text-align: center; }
.share-404 h1 { font-family: var(--font-display); font-size: 24px; margin-bottom: 10px; }
.share-404 p { color: var(--text-dim); }
</style></head>
<body><div class="share-404">
<h1>Link inválido ou expirado</h1>
<p>Este link de compartilhamento não existe mais, expirou ou foi revogado.</p>
</div></body></html>`;

// Headers aplicados a TODAS as respostas de /s/* (200 e 404): no-store, noindex,
// CSP restritiva (sem script — a página é 100% server-rendered), frame DENY.
function shareHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    'content-security-policy':
      "default-src 'self'; " +
      "script-src 'none'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data:; " +
      "connect-src 'none'; " +
      "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
}

export function shareNotFound(): Response {
  return new Response(NOT_FOUND_HTML, { status: 404, headers: shareHeaders() });
}

const STATUS_LABELS: Record<string, string> = {
  open: 'A fazer',
  in_progress: 'Em progresso',
  done: 'Concluído',
  canceled: 'Cancelado',
};

function priorityBadge(priority: number | null): string {
  if (priority == null) return '';
  const meta = PRIORITIES.find((p) => p.value === priority);
  if (!meta) return '';
  // Bandeirinha inline (sem depender de flagSvg do bundle client — aqui é SSR puro).
  const flag = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="flex-shrink:0;vertical-align:-1px"><path d="M4 2v12" stroke="${meta.color}" stroke-width="1.6" stroke-linecap="round"/><path d="M4.8 2.6h7.2c.5 0 .8.6.5 1L11 6l1.5 2.4c.3.5 0 1-.5 1H4.8V2.6Z" fill="${meta.color}"/></svg>`;
  return `<span class="share-badge">${flag}${esc(meta.label)}</span>`;
}

function domainsToBadges(raw: string): string {
  let arr: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) arr = parsed.map(String).filter(Boolean);
  } catch { /* ignore */ }
  return arr.map((d) => `<span class="share-badge share-badge-domain">${esc(d)}</span>`).join('');
}

// Estado do form de comentário do convidado (spec 53): mensagem de erro/aviso a
// exibir e valores digitados pra preservar no re-render (rate-limit/validação).
export interface ShareCommentFormState {
  error?: string;   // vermelho (rate-limit, validação)
  notice?: string;  // verde (comentário enviado)
  name?: string;    // valor a repovoar no campo nome
  body?: string;    // valor a repovoar no campo comentário
  formClosed?: boolean; // teto absoluto atingido — esconde o form
}

// Renderiza a página read-only de UMA task + a thread de comentários e o form do
// convidado (spec 53). SEM: edges, anexos, links pra /app/*, dados do dono. O corpo
// usa o MESMO pipeline de escaping (renderMarkdown) com resolver vazio — todo
// [[wikilink]] vira span quebrado. Os comentários são texto puro escapado (nunca
// markdown). O form é HTML puro (POST, sem JS, sem cookie) + honeypot invisível.
export function renderSharePage(
  task: TaskRow,
  comments: TaskComment[],
  token: string,
  form: ShareCommentFormState = {},
  status = 200
): Response {
  const taskStatus = task.status ?? 'open';
  const statusLabel = STATUS_LABELS[taskStatus] ?? taskStatus;
  const due = task.due_at != null ? formatBrtDateTime(task.due_at) : null;
  const bodyHtml = task.body?.trim()
    ? renderMarkdown(task.body, { titleIndex: new Map(), idSet: new Set(), currentId: task.id })
    : '<p class="share-empty">Sem descrição.</p>';

  const metaRows = [
    `<div class="share-meta-row"><span class="share-meta-lbl">Status</span><span class="share-badge share-badge-status share-status-${esc(taskStatus)}">${esc(statusLabel)}</span></div>`,
    task.priority != null
      ? `<div class="share-meta-row"><span class="share-meta-lbl">Prioridade</span>${priorityBadge(task.priority)}</div>`
      : '',
    due
      ? `<div class="share-meta-row"><span class="share-meta-lbl">Prazo</span><span class="share-value">${esc(due)}</span></div>`
      : '',
    task.domains && task.domains !== '[]'
      ? `<div class="share-meta-row"><span class="share-meta-lbl">Áreas</span><span class="share-domains">${domainsToBadges(task.domains)}</span></div>`
      : '',
  ].filter(Boolean).join('');

  const html = `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#070a13">
<title>${esc(task.title)}</title>
${FONT_LINKS}
<style>${NEBULA_CSS}${SHARE_CSS}</style>
</head><body>
<main class="share-wrap">
  <article class="share-card">
    <span class="share-tag">Tarefa compartilhada · somente leitura</span>
    <h1 class="share-title">${esc(task.title)}</h1>
    <div class="share-meta">${metaRows}</div>
    <div class="share-body note-body">${bodyHtml}</div>
  </article>
  ${renderShareComments(token, comments, form)}
  <footer class="share-footer">compartilhado via Expert Brain</footer>
</main>
</body></html>`;

  return new Response(html, { status, headers: shareHeaders() });
}

// Seção "Comentários" da página pública: thread + form do convidado. O form posta
// em /s/<token>/comment (mesma origem → CSP form-action 'self' via default-src).
function renderShareComments(token: string, comments: TaskComment[], form: ShareCommentFormState): string {
  const errorHtml = form.error ? `<p class="cmt-msg cmt-msg-err" role="alert">${esc(form.error)}</p>` : '';
  const noticeHtml = form.notice ? `<p class="cmt-msg cmt-msg-ok" role="status">${esc(form.notice)}</p>` : '';
  const formHtml = form.formClosed
    ? `<p class="cmt-empty">Os comentários deste link foram encerrados.</p>`
    : `<form class="cmt-form" method="post" action="/s/${esc(token)}/comment#comentarios">
        <label class="cmt-field">
          <span class="cmt-lbl">Seu nome</span>
          <input type="text" name="name" maxlength="${GUEST_MAX_NAME}" required
            value="${esc(form.name ?? '')}" autocomplete="off" placeholder="Como você quer assinar" />
        </label>
        <label class="cmt-field">
          <span class="cmt-lbl">Comentário</span>
          <textarea name="body" rows="4" maxlength="${GUEST_MAX_BODY}" required
            placeholder="Escreva um comentário">${esc(form.body ?? '')}</textarea>
        </label>
        <label class="cmt-hp" aria-hidden="true"><span>Não preencha este campo</span>
          <input type="text" name="website" tabindex="-1" autocomplete="off" /></label>
        <div class="cmt-form-foot">
          <button type="submit" class="cmt-submit">Comentar</button>
        </div>
      </form>`;
  return `<section class="cmt-section" id="comentarios">
    <h2 class="cmt-h2">Comentários</h2>
    ${errorHtml}${noticeHtml}
    ${renderCommentThread(comments)}
    ${formHtml}
  </section>`;
}

const SHARE_CSS = `
.share-wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 64px; }
.share-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 34px 34px 30px;
}
.share-tag {
  display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: .07em;
  color: var(--accent-lav); border: 1px solid var(--border-strong);
  border-radius: 999px; padding: 4px 12px; margin-bottom: 18px;
}
.share-title {
  font-family: var(--font-display); font-size: 30px; font-weight: 600; letter-spacing: -0.02em;
  line-height: 1.2; color: var(--text); margin-bottom: 22px;
}
.share-meta {
  display: flex; flex-direction: column; gap: 10px;
  padding: 16px 18px; margin-bottom: 26px;
  background: var(--bg-accent); border: 1px solid var(--border); border-radius: var(--radius);
}
.share-meta-row { display: flex; align-items: center; gap: 14px; }
.share-meta-lbl {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em;
  color: var(--text-faint); font-weight: 600; width: 96px; flex-shrink: 0;
}
.share-value { color: var(--text); font-size: 14px; }
.share-badge {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12.5px; padding: 3px 10px; border-radius: 999px;
  background: var(--surface-raised); border: 1px solid var(--border); color: var(--text);
}
.share-badge-status { text-transform: none; }
.share-status-done { color: #bbf7d0; border-color: rgba(74,222,128,0.4); }
.share-status-canceled { color: var(--text-dim); }
.share-domains { display: inline-flex; gap: 6px; flex-wrap: wrap; }
.share-badge-domain { font-size: 12px; }
.share-body { color: var(--text); line-height: 1.65; font-size: 15px; }
.share-body h1, .share-body h2, .share-body h3 { font-family: var(--font-display); margin: 20px 0 10px; }
.share-body p { margin: 0 0 12px; }
.share-body ul, .share-body ol { margin: 0 0 12px; padding-left: 22px; }
.share-body code { background: var(--bg-accent); padding: 1px 6px; border-radius: 5px; font-size: 13px; }
.share-body pre { background: var(--bg-accent); padding: 14px; border-radius: var(--radius-sm); overflow-x: auto; }
.share-body a { color: var(--accent-lav); }
.share-body .wikilink.broken { color: var(--text-dim); border-bottom: 1px dotted var(--text-faint); cursor: default; }
.share-empty { color: var(--text-faint); font-style: italic; }
.share-footer { text-align: center; margin-top: 22px; font-size: 12px; color: var(--text-faint); letter-spacing: .02em; }

/* Comentários (spec 53) — thread + form do convidado, SSR puro */
.cmt-section { margin-top: 26px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 26px 30px 28px; }
.cmt-h2 { font-family: var(--font-display); font-size: 18px; font-weight: 600; margin-bottom: 16px; }
.cmt-thread { list-style: none; margin: 0 0 20px; padding: 0; display: flex; flex-direction: column; gap: 14px; }
.cmt-item { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; background: var(--bg-accent); }
.cmt-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.cmt-author { font-size: 13px; font-weight: 600; color: var(--text); }
.cmt-author-owner { color: var(--accent-lav); }
.cmt-author-agent { color: #93c5fd; }
.cmt-author-guest { color: var(--text); }
.cmt-time { font-size: 11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.cmt-body { font-size: 14px; line-height: 1.55; color: var(--text); word-break: break-word; }
.cmt-empty { color: var(--text-faint); font-size: 14px; margin-bottom: 20px; }
.cmt-msg { font-size: 13px; margin-bottom: 14px; padding: 8px 12px; border-radius: var(--radius-sm); }
.cmt-msg-err { color: #fca5a5; background: rgba(239,68,68,0.12); }
.cmt-msg-ok { color: #86efac; background: rgba(74,222,128,0.12); }
.cmt-form { display: flex; flex-direction: column; gap: 12px; }
.cmt-field { display: flex; flex-direction: column; gap: 6px; }
.cmt-lbl { font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-faint); font-weight: 600; }
.cmt-form input[type=text], .cmt-form textarea {
  background: var(--bg-accent); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 9px 12px; font-family: inherit; font-size: 14px; width: 100%; box-sizing: border-box;
}
.cmt-form textarea { resize: vertical; line-height: 1.5; }
.cmt-form input[type=text]:focus, .cmt-form textarea:focus { outline: none; border-color: var(--accent-lav); }
/* Honeypot: fora da tela pra humanos, presente no DOM pra bots preencherem */
.cmt-hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.cmt-form-foot { display: flex; justify-content: flex-end; }
.cmt-submit {
  padding: 9px 20px; border: none; border-radius: var(--radius-sm);
  background: var(--accent-lav); color: #0b0713; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}
.cmt-submit:hover { filter: brightness(1.08); }
`;

// Handler da rota pública GET /s/<token>. Zero auth. Token inválido/expirado/
// revogado/inexistente → MESMO 404 genérico (não confirma existência de task).
// Carrega a thread de comentários (últimos 200, ordem cronológica) pra render.
export async function handleSharePage(_req: Request, env: Env, token: string): Promise<Response> {
  const task = await resolveShare(env, token, Date.now());
  if (!task) return shareNotFound();
  const comments = await listTaskComments(env, task.id, 200, 0);
  return renderSharePage(task, comments, token);
}

// ─────────────── Comentário de convidado (POST /s/<token>/comment) ───────────────
// SEM auth. Tudo passa por resolveShare (revogar/expirar/deletar corta leitura E
// escrita no mesmo instante). Rate-limit no GRAPH_CACHE (sem namespace novo).

// SHA-256 hex de uma string. Reusa o mesmo helper do lookup de token (definido no
// topo deste módulo) — aqui só chamamos a versão já existente.

// Lê o contador de rate-limit. Chave ausente/lixo → 0.
async function rlCount(env: Env, key: string): Promise<number> {
  const raw = await env.GRAPH_CACHE.get(key);
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Incrementa o contador com TTL de 1h (expirationTtl reinicia a janela a cada post
// aceito — quem para de postar destrava em 1h; quem estoura não incrementa).
async function rlBump(env: Env, key: string, current: number): Promise<void> {
  await env.GRAPH_CACHE.put(key, String(current + 1), { expirationTtl: RL_TTL_SECONDS });
}

// Handler POST /s/<token>/comment. Fluxo: resolveShare → honeypot → validação →
// rate-limit (token + IP) → teto absoluto → grava guest → redirect 303 #comentarios.
export async function handleShareCommentPost(req: Request, env: Env, token: string): Promise<Response> {
  const now = Date.now();
  const task = await resolveShare(env, token, now);
  // Share inexistente/expirado/revogado/deletado → MESMO 404 do GET (não vaza).
  if (!task) return shareNotFound();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    const comments = await listTaskComments(env, task.id, 200, 0);
    return renderSharePage(task, comments, token, { error: 'Não consegui ler o formulário. Tente de novo.' }, 400);
  }

  // Honeypot: bot que preenche o campo invisível → descarta em silêncio (200, nada
  // gravado, sem erro visível). Um humano nunca preenche (display:none).
  const honeypot = String(form.get('website') ?? '').trim();
  if (honeypot) {
    const comments = await listTaskComments(env, task.id, 200, 0);
    return renderSharePage(task, comments, token, { notice: 'Comentário enviado.' }, 200);
  }

  const name = String(form.get('name') ?? '').trim().slice(0, GUEST_MAX_NAME);
  const rawBody = String(form.get('body') ?? '');
  const body = rawBody.trim().slice(0, GUEST_MAX_BODY);

  const reRender = (state: ShareCommentFormState, httpStatus: number) =>
    listTaskComments(env, task.id, 200, 0).then((cs) => renderSharePage(task, cs, token, state, httpStatus));

  // Validação: nome e corpo obrigatórios (guest DEVE assinar).
  if (!name) return reRender({ error: 'Informe seu nome.', name, body }, 400);
  if (!body) return reRender({ error: 'Escreva um comentário.', name, body }, 400);

  // Teto absoluto por task (defesa contra botnet multi-IP): fecha o form.
  const guestCount = await countTaskComments(env, task.id, 'guest');
  if (guestCount >= GUEST_HARD_CAP) {
    return reRender({ error: 'Este link atingiu o limite de comentários.', formClosed: true }, 429);
  }

  // Rate-limit: por token (10/h) e por IP (5/h). IP vem de CF-Connecting-IP e é
  // HASHEADO antes de virar chave (nunca persiste IP puro). Ausência de IP → só
  // o limite por token vale. Estourou qualquer um → 429 (não incrementa).
  const tokenKey = `rl:cmt:t:${await sha256Hex(token)}`;
  const tokenCount = await rlCount(env, tokenKey);
  if (tokenCount >= RL_MAX_PER_TOKEN) {
    return reRender({ error: 'Muitos comentários neste link. Tente novamente mais tarde.', name, body }, 429);
  }
  const ip = req.headers.get('CF-Connecting-IP')?.trim() || '';
  let ipKey = '';
  let ipCount = 0;
  if (ip) {
    ipKey = `rl:cmt:ip:${await sha256Hex(ip)}`;
    ipCount = await rlCount(env, ipKey);
    if (ipCount >= RL_MAX_PER_IP) {
      return reRender({ error: 'Muitos comentários do seu dispositivo. Tente novamente mais tarde.', name, body }, 429);
    }
  }

  // Grava o comentário do convidado.
  await addTaskComment(env, {
    id: `cmt_${newId()}`,
    task_id: task.id,
    author: 'guest',
    author_name: name,
    body,
    created_at: now,
  });

  // Incrementa os contadores só APÓS gravar com sucesso.
  await rlBump(env, tokenKey, tokenCount);
  if (ipKey) await rlBump(env, ipKey, ipCount);

  // Redirect 303 de volta pra página (padrão POST→redirect→GET, sem reenvio ao dar
  // F5). Âncora #comentarios leva direto pra thread.
  return new Response(null, {
    status: 303,
    headers: { location: `/s/${token}#comentarios`, 'cache-control': 'no-store' },
  });
}
