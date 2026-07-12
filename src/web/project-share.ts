// Board compartilhado por PROJETO (spec 80-frota-agentes/85): /p/<token> expõe o
// recorte de UM projeto — colunas + cards + threads — pra um humano ou IA de fora,
// com permissão controlada pelo token ('read' | 'comment'). Regras duras:
//   - NUNCA vaza: notas, grafo, contatos, tasks privadas (fail-closed, mesmo racional
//     do share de task), outros projetos, navegação pro console.
//   - Guardamos o HASH do token (nunca o plaintext) — a URL só aparece uma vez, no
//     flash da criação (mesmo padrão da chave de API, spec 87).
//   - Comentário externo entra como author='guest' assinando o LABEL do share (o
//     CHECK da migration 0010 fecha o enum em owner/guest/agent — 'guest' É a classe
//     externa; o selo EXTERNO no render diferencia de agente assinado, spec 81 §3).
//     Identidade verificável é exclusiva de credencial: author_user_id fica NULL.
//   - Comentário externo gera mailbox pros assignees ativos (comment_on_assigned) —
//     SEM parse de menção (externo não escala pro mailbox de qualquer usuário).
//   - Rate-limit e tetos: a MESMA régua do /s/ (rlCount/rlBump no GRAPH_CACHE).

import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { newId } from '../util/id.js';
import { requireSession } from './session.js';
import { htmlResponse } from './render.js';
import { formError } from './form-error.js';
import { formatBrtDateTime } from '../util/time.js';
import { PUBLIC_CSS, FONT_LINKS } from './styles.js';
import {
  shareHeaders, shareNotFound, rlCount, rlBump,
  GUEST_MAX_BODY, GUEST_HARD_CAP, RL_MAX_PER_TOKEN, RL_MAX_PER_IP,
} from './share.js';
import { renderCommentThread } from './comments-render.js';
import {
  listKanbanColumns, listTaskComments, countTaskComments, addTaskComment,
  type KanbanColumn, type TaskCommentView, type TaskStatus,
} from '../db/queries.js';
import { produceExternalCommentMailbox } from '../db/mailbox.js';

const TOKEN_PREFIX = 'ebp_';
export const PROJECT_SHARE_TOKEN_RE = /^ebp_[A-Za-z0-9_-]{40,}$/;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type ProjectShareMode = 'read' | 'comment';

export interface ProjectShareRow {
  id: string;
  prefix: string;
  project_id: string;
  label: string;
  mode: ProjectShareMode;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

export interface CreateProjectShareResult {
  id: string;
  token: string; // plaintext — só existe aqui, uma vez (o banco guarda o hash)
  url: string;
  prefix: string;
  expires_at: number | null;
}

const DAY_MS = 86400000;
const MAX_EXPIRES_DAYS = 365;

export function absoluteProjectShareUrl(env: Env, token: string): string {
  const base = env.WORKER_URL?.replace(/\/$/, '') ?? '';
  return `${base}/p/${token}`;
}

// Cria um share pro projeto. O caller (console) valida sessão e projeto ativo;
// aqui valida-se de novo que o projeto existe e está vivo (defesa em profundidade).
export async function createProjectShare(
  env: Env,
  projectId: string,
  opts: { label: string; mode: ProjectShareMode; expiresDays?: number | null },
  now: number
): Promise<CreateProjectShareResult> {
  const project = await env.DB.prepare(
    `SELECT id FROM task_projects WHERE id = ? AND archived_at IS NULL`
  ).bind(projectId).first<{ id: string }>();
  if (!project) throw new Error('Projeto não existe ou está arquivado');

  const token = `${TOKEN_PREFIX}${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const tokenHash = await sha256Hex(token);
  const prefix = token.slice(0, TOKEN_PREFIX.length + 6);
  const id = `psh_${newId()}`;
  const days = opts.expiresDays != null && Number.isFinite(opts.expiresDays)
    ? Math.min(Math.max(Math.floor(opts.expiresDays), 1), MAX_EXPIRES_DAYS)
    : null;
  const expiresAt = days != null ? now + days * DAY_MS : null;

  await env.DB.prepare(
    `INSERT INTO project_shares (id, token_hash, prefix, project_id, label, mode, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, tokenHash, prefix, projectId, opts.label, opts.mode, now, expiresAt).run();

  return { id, token, url: absoluteProjectShareUrl(env, token), prefix, expires_at: expiresAt };
}

// Lista shares (de um projeto, ou todos quando projectId omitido) — inclui revogados
// (trilha de auditoria; a UI separa). Nunca expõe token_hash.
export async function listProjectShares(env: Env, projectId?: string): Promise<ProjectShareRow[]> {
  const where = projectId ? 'WHERE project_id = ?' : '';
  const stmt = env.DB.prepare(
    `SELECT id, prefix, project_id, label, mode, created_at, expires_at, revoked_at
     FROM project_shares ${where} ORDER BY created_at DESC`
  );
  const r = await (projectId ? stmt.bind(projectId) : stmt).all<ProjectShareRow>();
  return r.results ?? [];
}

// Revogação imediata: o próximo request no /p/ não resolve mais o hash → 404.
export async function revokeProjectShare(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE project_shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`
  ).bind(Date.now(), id).run();
  return (res.meta?.changes ?? 0) > 0;
}

interface ResolvedProjectShare extends ProjectShareRow {
  project_label: string;
}

// Token plaintext → share vivo (não-revogado, não-expirado, projeto vivo). Qualquer
// falha → null (o caller responde o MESMO 404 neutro — não vaza o que existe).
async function resolveProjectShare(env: Env, token: string, now: number): Promise<ResolvedProjectShare | null> {
  if (!PROJECT_SHARE_TOKEN_RE.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT ps.id, ps.prefix, ps.project_id, ps.label, ps.mode, ps.created_at, ps.expires_at, ps.revoked_at,
            p.label AS project_label
     FROM project_shares ps
     JOIN task_projects p ON p.id = ps.project_id AND p.archived_at IS NULL
     WHERE ps.token_hash = ? AND ps.revoked_at IS NULL`
  ).bind(tokenHash).first<ResolvedProjectShare>();
  if (!row) return null;
  if (row.expires_at != null && row.expires_at <= now) return null;
  return row;
}

interface ShareTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  column_id: string | null;
  due_at: number | null;
  priority: number | null;
}

// Tasks visíveis do recorte: kind task, viva, NÃO-privada, DESTE projeto. O filtro de
// privada é inegociável (spec 85 critério 3) — vale mesmo pro token 'comment'.
async function listShareTasks(env: Env, projectId: string): Promise<ShareTaskRow[]> {
  const r = await env.DB.prepare(
    `SELECT id, title, status, column_id, due_at, priority
     FROM notes
     WHERE kind = 'task' AND deleted_at IS NULL AND (private IS NULL OR private = 0) AND project_id = ?
     ORDER BY (due_at IS NULL), due_at ASC, priority ASC, created_at ASC`
  ).bind(projectId).all<ShareTaskRow>();
  return r.results ?? [];
}

const PRIORITY_LABELS: Record<number, string> = { 1: 'Crítica', 2: 'Alta', 3: 'Normal', 4: 'Baixa' };

interface PageState {
  error?: string;
  notice?: string;
}

function renderProjectSharePage(
  env: Env,
  share: ResolvedProjectShare,
  columns: KanbanColumn[],
  tasks: ShareTaskRow[],
  commentsByTask: Map<string, TaskCommentView[]>,
  token: string,
  state: PageState = {},
  status = 200
): Response {
  // Card cai na coluna do column_id quando ela está ativa; senão na primeira coluna
  // ativa da categoria do status (mesmo invariante do board logado).
  const active = columns.filter((c) => c.archived_at === null);
  const colById = new Map(active.map((c) => [c.id, c] as const));
  const defaultByCat = new Map<string, KanbanColumn>();
  for (const c of active) if (!defaultByCat.has(c.category)) defaultByCat.set(c.category, c);
  const byColumn = new Map<string, ShareTaskRow[]>();
  for (const t of tasks) {
    const col = (t.column_id && colById.get(t.column_id)) || defaultByCat.get(t.status);
    if (!col) continue;
    if (!byColumn.has(col.id)) byColumn.set(col.id, []);
    byColumn.get(col.id)!.push(t);
  }

  const canComment = share.mode === 'comment';
  const taskCard = (t: ShareTaskRow): string => {
    const comments = commentsByTask.get(t.id) ?? [];
    const due = t.due_at != null ? `<span class="psh-due">até ${esc(formatBrtDateTime(t.due_at))}</span>` : '';
    const prio = t.priority != null && PRIORITY_LABELS[t.priority]
      ? `<span class="psh-prio">${esc(PRIORITY_LABELS[t.priority])}</span>` : '';
    const form = canComment
      ? `<form method="post" action="/p/${esc(token)}/comment" class="psh-cmt-form">
           <input type="hidden" name="task_id" value="${esc(t.id)}">
           <input type="text" name="website" class="psh-hp" tabindex="-1" autocomplete="off" aria-hidden="true">
           <textarea name="body" rows="3" maxlength="${GUEST_MAX_BODY}" required placeholder="Escreva um comentário"></textarea>
           <button type="submit">Comentar como ${esc(share.label)}</button>
         </form>`
      : '';
    return `<article class="psh-card" id="task-${esc(t.id)}">
      <h3>${esc(t.title)}</h3>
      <p class="psh-meta">${prio}${due}</p>
      <details${comments.length > 0 || canComment ? '' : ' hidden'}>
        <summary>Comentários (${comments.length})</summary>
        ${renderCommentThread(comments, { emptyLabel: 'Ainda não há comentários.', externalBadge: true })}
        ${form}
      </details>
    </article>`;
  };

  const colSections = active
    .filter((c) => (byColumn.get(c.id) ?? []).length > 0)
    .map((c) => `<section class="psh-col">
      <h2>${esc(c.label)} <span class="psh-count">${(byColumn.get(c.id) ?? []).length}</span></h2>
      ${(byColumn.get(c.id) ?? []).map(taskCard).join('')}
    </section>`)
    .join('');

  const flash = state.error
    ? `<p class="psh-flash psh-error">${esc(state.error)}</p>`
    : state.notice
      ? `<p class="psh-flash psh-notice">${esc(state.notice)}</p>`
      : '';

  const html = `<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(share.project_label)} · board compartilhado</title>
${FONT_LINKS}
<style>${PUBLIC_CSS}</style>
<style>
  .psh-wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px 60px; }
  .psh-head h1 { margin: 0 0 4px; }
  .psh-head p { color: var(--text-dim, #999); margin: 0 0 20px; }
  .psh-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; align-items: start; }
  .psh-col h2 { font-size: 1rem; margin: 0 0 10px; }
  .psh-count { opacity: 0.6; font-weight: normal; }
  .psh-card { border: 1px solid var(--border, #333); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  .psh-card h3 { margin: 0 0 6px; font-size: 0.95rem; }
  .psh-meta { margin: 0 0 6px; display: flex; gap: 8px; font-size: 0.8rem; color: var(--text-dim, #999); }
  .psh-card details summary { cursor: pointer; font-size: 0.85rem; color: var(--text-dim, #999); }
  .psh-cmt-form textarea { width: 100%; margin-top: 8px; }
  .psh-cmt-form button { margin-top: 6px; }
  .psh-hp { display: none; }
  .psh-flash { border-radius: 8px; padding: 10px 14px; }
  .psh-error { border: 1px solid #a33; }
  .psh-notice { border: 1px solid #3a6; }
  .cmt-external { font-size: 0.7rem; letter-spacing: 0.05em; border: 1px solid var(--accent-lav, #a78bfa); color: var(--accent-lav, #a78bfa); border-radius: 4px; padding: 0 5px; }
</style></head>
<body><div class="psh-wrap">
  <header class="psh-head">
    <h1>${esc(share.project_label)}</h1>
    <p>Board compartilhado · visão de ${esc(share.label)} · ${canComment ? 'leitura e comentários' : 'somente leitura'}</p>
  </header>
  ${flash}
  ${tasks.length === 0 ? '<p>Nenhuma tarefa neste projeto ainda.</p>' : `<div class="psh-board">${colSections}</div>`}
</div></body></html>`;
  return new Response(html, { status, headers: shareHeaders() });
}

// GET /p/<token>
export async function handleProjectSharePage(_req: Request, env: Env, token: string): Promise<Response> {
  const now = Date.now();
  const share = await resolveProjectShare(env, token, now);
  if (!share) return shareNotFound();
  const [columns, tasks] = await Promise.all([listKanbanColumns(env, true), listShareTasks(env, share.project_id)]);
  const commentsByTask = new Map<string, TaskCommentView[]>();
  await Promise.all(tasks.map(async (t) => {
    commentsByTask.set(t.id, await listTaskComments(env, t.id, 200, 0));
  }));
  return renderProjectSharePage(env, share, columns, tasks, commentsByTask, token);
}

// POST /p/<token>/comment — só em share 'comment'; token 'read' cai no 404 neutro
// (a permissão é do TOKEN; esconder o form não é o gate).
export async function handleProjectShareCommentPost(req: Request, env: Env, token: string): Promise<Response> {
  const now = Date.now();
  const share = await resolveProjectShare(env, token, now);
  if (!share || share.mode !== 'comment') return shareNotFound();

  const rerender = async (state: PageState, status: number): Promise<Response> => {
    const [columns, tasks] = await Promise.all([listKanbanColumns(env, true), listShareTasks(env, share.project_id)]);
    const commentsByTask = new Map<string, TaskCommentView[]>();
    await Promise.all(tasks.map(async (t) => {
      commentsByTask.set(t.id, await listTaskComments(env, t.id, 200, 0));
    }));
    return renderProjectSharePage(env, share, columns, tasks, commentsByTask, token, state, status);
  };

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return rerender({ error: 'Não consegui ler o formulário. Tente de novo.' }, 400);
  }

  // Honeypot (mesmo padrão do /s/): bot que preenche o campo invisível → descarta em
  // silêncio (200, nada gravado).
  if (String(form.get('website') ?? '').trim()) {
    return rerender({ notice: 'Comentário enviado.' }, 200);
  }

  const taskId = String(form.get('task_id') ?? '').trim();
  const body = String(form.get('body') ?? '').trim().slice(0, GUEST_MAX_BODY);
  if (!body) return rerender({ error: 'Escreva um comentário.' }, 400);

  // A task precisa estar DENTRO do recorte: deste projeto, viva e não-privada. Task
  // de fora (ou privada) → 400 sem detalhar qual das condições falhou.
  const task = await env.DB.prepare(
    `SELECT id FROM notes
     WHERE id = ? AND kind = 'task' AND deleted_at IS NULL AND (private IS NULL OR private = 0) AND project_id = ?`
  ).bind(taskId, share.project_id).first<{ id: string }>();
  if (!task) return rerender({ error: 'Tarefa não encontrada neste board.' }, 400);

  // Teto absoluto por task (guest inclui os externos do /p/ — mesma classe).
  if ((await countTaskComments(env, task.id, 'guest')) >= GUEST_HARD_CAP) {
    return rerender({ error: 'Esta tarefa atingiu o limite de comentários.' }, 429);
  }

  // Rate-limit: por token (10/h) e por IP (5/h), chaves próprias do /p/.
  const tokenKey = `rl:pcmt:t:${await sha256Hex(token)}`;
  const tokenCount = await rlCount(env, tokenKey);
  if (tokenCount >= RL_MAX_PER_TOKEN) {
    return rerender({ error: 'Muitos comentários neste link. Tente novamente mais tarde.' }, 429);
  }
  const ip = req.headers.get('CF-Connecting-IP')?.trim() || '';
  let ipKey = '';
  let ipCount = 0;
  if (ip) {
    ipKey = `rl:pcmt:ip:${await sha256Hex(ip)}`;
    ipCount = await rlCount(env, ipKey);
    if (ipCount >= RL_MAX_PER_IP) {
      return rerender({ error: 'Muitos comentários do seu dispositivo. Tente novamente mais tarde.' }, 429);
    }
  }

  // Grava assinando o LABEL do share. Externo NUNCA assina credencial (spec 81):
  // author_user_id NULL por construção.
  const commentId = `cmt_${newId()}`;
  await addTaskComment(env, {
    id: commentId,
    task_id: task.id,
    author: 'guest',
    author_name: share.label,
    body,
    created_at: now,
    author_user_id: null,
  });

  // Mailbox pros assignees ativos (best-effort — nunca derruba a escrita).
  await produceExternalCommentMailbox(env, { taskId: task.id, commentId });

  await rlBump(env, tokenKey, tokenCount);
  if (ipKey) await rlBump(env, ipKey, ipCount);

  return new Response(null, {
    status: 303,
    headers: { location: `/p/${token}#task-${task.id}`, 'cache-control': 'no-store' },
  });
}

// ─────────────── Gestão no console (/app/project-shares/*) ───────────────
// A URL /p/ com o token plaintext só aparece UMA vez: vai pro KV com TTL curto e a
// /app/config consome via ?pflash= (mesmo padrão do flash da chave de API — nunca
// token em query string persistente/histórico).
const PSHARE_FLASH_TTL = 60;

export function pshareFlashKey(id: string): string {
  return `flash:pshare:${id}`;
}

function flashId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export async function handleProjectShareCreate(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const projectId = String(form.get('project_id') ?? '').trim();
  const label = String(form.get('label') ?? '').trim().slice(0, 60);
  const modeRaw = String(form.get('mode') ?? '');
  const mode: ProjectShareMode = modeRaw === 'comment' ? 'comment' : 'read';
  const daysRaw = String(form.get('expires_days') ?? '').trim();
  const expiresDays = daysRaw ? Number(daysRaw) : null;
  if (!projectId) return formError(req, 'Projeto obrigatório', { field: 'project_id', returnTo: '/app/config#projects' });
  if (!label) return formError(req, 'Identidade externa (label) obrigatória — é como o comentário de fora assina', { field: 'label', returnTo: '/app/config#projects' });
  let created: CreateProjectShareResult;
  try {
    created = await createProjectShare(env, projectId, { label, mode, expiresDays }, Date.now());
  } catch (err) {
    return formError(req, err instanceof Error ? err.message : 'Falha ao criar o share', { returnTo: '/app/config#projects' });
  }
  const id = flashId();
  await env.OAUTH_KV.put(pshareFlashKey(id), created.url, { expirationTtl: PSHARE_FLASH_TTL });
  return new Response(null, {
    status: 302,
    headers: { location: `/app/config?pflash=${id}#projects` },
  });
}

export async function handleProjectShareRevoke(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return formError(req, 'id obrigatório', { returnTo: '/app/config#projects' });
  await revokeProjectShare(env, id);
  return new Response(null, { status: 302, headers: { location: '/app/config?saved=projects#projects' } });
}
