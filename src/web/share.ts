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
import { getTaskById, type TaskRow } from '../db/queries.js';
import { formatBrtDateTime } from '../util/time.js';
import { PRIORITIES } from '../util/priority.js';

const TOKEN_PREFIX = 'ebs_';
const DEFAULT_EXPIRES_DAYS = 30;
const MAX_EXPIRES_DAYS = 365;
const MIN_EXPIRES_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

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

// Renderiza a página read-only de UMA task. SEM: edges, anexos, links pra /app/*,
// dados do dono. O corpo usa o MESMO pipeline de escaping (renderMarkdown) com
// resolver vazio — todo [[wikilink]] vira span quebrado, nunca âncora pra outra nota.
export function renderSharePage(task: TaskRow): Response {
  const status = task.status ?? 'open';
  const statusLabel = STATUS_LABELS[status] ?? status;
  const due = task.due_at != null ? formatBrtDateTime(task.due_at) : null;
  const bodyHtml = task.body?.trim()
    ? renderMarkdown(task.body, { titleIndex: new Map(), idSet: new Set(), currentId: task.id })
    : '<p class="share-empty">Sem descrição.</p>';

  const metaRows = [
    `<div class="share-meta-row"><span class="share-meta-lbl">Status</span><span class="share-badge share-badge-status share-status-${esc(status)}">${esc(statusLabel)}</span></div>`,
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
  <footer class="share-footer">compartilhado via Expert Brain</footer>
</main>
</body></html>`;

  return new Response(html, { status: 200, headers: shareHeaders() });
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
`;

// Handler da rota pública GET /s/<token>. Zero auth. Token inválido/expirado/
// revogado/inexistente → MESMO 404 genérico (não confirma existência de task).
export async function handleSharePage(_req: Request, env: Env, token: string): Promise<Response> {
  const task = await resolveShare(env, token, Date.now());
  if (!task) return shareNotFound();
  return renderSharePage(task);
}
