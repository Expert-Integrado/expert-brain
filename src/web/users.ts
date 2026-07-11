// Usuários e responsáveis (spec 37) — superfície web.
// "Usuário" aqui é perfil de ATRIBUIÇÃO (pessoa ou agente), NÃO login: nome + foto +
// bio, e no caso de agente o PAT que o identifica (resolve o 'me' das tools MCP).
// Seção "Usuários" em /app/config (aba Organização) + avatar servido do R2 +
// POST dos responsáveis de uma task (sidebar do detalhe). Padrão form+redirect
// (CSP sem inline), igual colunas/projetos.

import type { Env } from '../env.js';
import { esc } from '../util/html.js';
import { newId } from '../util/id.js';
import { requireSession } from './session.js';
import { htmlResponse } from './render.js';
import { listApiKeys, type ApiKeyRow } from '../auth/api-keys.js';
import { logTaskActivity } from '../db/task-activity.js';
import {
  USER_CAP, USER_TYPES, type UserType, type BrainUser,
  listUsers, getUserById, countUsers, createUser, updateUser, setUserAvatar,
  setUserArchived, getTaskById, setTaskAssignees, listAssigneesForTask, getOwnerUser,
} from '../db/queries.js';
import { produceAssignmentMailbox } from '../db/mailbox.js';

// ─────────────── Avatar (R2, binding MEDIA) ───────────────
// Foto de perfil mora em avatars/<user_id> — key fixa por usuário (re-upload
// sobrescreve; sem dedup nem media table: avatar não é anexo de nota).
const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2MB
const AVATAR_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const avatarR2Key = (userId: string): string => `avatars/${userId}`;

const usersRedirect = (): Response =>
  new Response(null, { status: 302, headers: { location: '/app/config?saved=users#users' } });

// ─────────────── Seção "Usuários" do /app/config ───────────────
const TYPE_LABELS: Record<UserType, string> = { person: 'Pessoa', agent: 'Agente' };

function typeOptions(selected: UserType): string {
  return USER_TYPES
    .map((t) => `<option value="${t}"${t === selected ? ' selected' : ''}>${esc(TYPE_LABELS[t])}</option>`)
    .join('');
}

// Chaves do usuário (spec 86 — 1:N, read-only aqui): o vínculo mora na CHAVE
// (api_keys.user_id, definido na criação em "Agentes externos e automações"), não é
// mais editado no usuário. Lista as N chaves que identificam este perfil, incluindo
// o vínculo LEGADO (users.api_key_id) enquanto a chave não migrar.
function userKeysCell(u: BrainUser, keys: ApiKeyRow[]): string {
  const mine = keys.filter((k) =>
    (k.user_id === u.id || (!k.user_id && u.api_key_id === k.id)) && k.revoked_at === null
  );
  if (mine.length === 0) {
    return `<span style="color:var(--text-dim);font-size:12px">Sem chave — crie uma em "Agentes externos e automações" escolhendo este usuário como dono</span>`;
  }
  return mine
    .map((k) => `<span class="badge-pill" title="${esc(k.prefix)}…">${esc(k.name)}${!k.user_id ? ' · vínculo legado' : ''}</span>`)
    .join(' ');
}

// Bolinha da tabela: foto (com cache-bust por updated_at) ou iniciais coloridas.
function avatarCell(u: BrainUser): string {
  if (u.avatar_key) {
    return `<img class="user-avatar-img" src="/app/users/${esc(u.id)}/avatar?v=${u.updated_at}" alt="Foto de ${esc(u.name)}" width="36" height="36">`;
  }
  let h = 0;
  for (let i = 0; i < u.id.length; i++) h = (h * 31 + u.id.charCodeAt(i)) % 360;
  const parts = u.name.trim().split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ??
    '')).toUpperCase();
  return `<span class="user-avatar-img user-avatar-initials" style="background:hsl(${h},42%,36%)">${esc(initials)}</span>`;
}

function renderUserRow(u: BrainUser, keys: ApiKeyRow[], all: BrainUser[], hasMedia: boolean): string {
  const archived = u.archived_at !== null;
  const isOwner = u.is_owner === 1;
  // Tipo do dono é travado (o perfil-pessoa do dono é a âncora do 'me' OAuth);
  // agente troca PAT à vontade. Pessoa comum também pode ter PAT (instância dela).
  const typeCell = isOwner
    ? `<span class="badge-pill">${esc(TYPE_LABELS[u.type])} · dono</span><input type="hidden" name="type" value="${esc(u.type)}">`
    : `<select name="type">${typeOptions(u.type)}</select>`;
  const avatarForms = hasMedia
    ? `<form method="post" action="/app/config/users/avatar" enctype="multipart/form-data" class="row" style="gap:6px;align-items:center">
         <input type="hidden" name="id" value="${esc(u.id)}">
         <input type="file" name="file" accept="image/jpeg,image/png,image/webp,image/gif" required style="max-width:180px">
         <button type="submit" class="btn btn-sm">Enviar foto</button>
       </form>
       ${u.avatar_key ? `<form method="post" action="/app/config/users/avatar" style="display:inline">
         <input type="hidden" name="id" value="${esc(u.id)}">
         <input type="hidden" name="remove" value="1">
         <button type="submit" class="btn btn-ghost btn-sm">Remover foto</button>
       </form>` : ''}`
    : `<span style="color:var(--text-dim);font-size:12px">Foto requer R2 (MEDIA) habilitado</span>`;
  const archiveCell = isOwner
    ? '—'
    : archived
      ? `<form method="post" action="/app/config/users/archive" style="display:inline">
           <input type="hidden" name="id" value="${esc(u.id)}">
           <input type="hidden" name="archived" value="0">
           <button type="submit">Desarquivar</button>
         </form>`
      : `<form method="post" action="/app/config/users/archive" style="display:inline">
           <input type="hidden" name="id" value="${esc(u.id)}">
           <input type="hidden" name="archived" value="1">
           <button type="submit" class="btn btn-danger btn-sm">Arquivar</button>
         </form>`;
  return `<tr${archived ? ' style="opacity:0.55"' : ''}>
    <td>${avatarCell(u)}</td>
    <td>
      <form method="post" action="/app/config/users/update" class="user-edit-form">
        <input type="hidden" name="id" value="${esc(u.id)}">
        <div class="row" style="gap:6px;align-items:center;flex-wrap:wrap">
          <input type="text" name="name" value="${esc(u.name)}" required maxlength="60" class="input-text" style="width:150px" aria-label="Nome">
          ${typeCell}
        </div>
        <input type="text" name="bio" value="${esc(u.bio ?? '')}" maxlength="200" class="input-text" placeholder="Pra que serve / quem é (opcional)" style="width:100%;margin-top:6px" aria-label="Descrição">
        <div class="row" style="gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">
          <button type="submit">Salvar</button>
        </div>
      </form>
      <div style="margin-top:6px">${userKeysCell(u, keys)}</div>
    </td>
    <td>${avatarForms}</td>
    <td>${archiveCell}</td>
  </tr>`;
}

export function renderUsersSection(
  users: BrainUser[],
  keys: ApiKeyRow[],
  savedUsers: boolean,
  hasMedia: boolean
): string {
  const total = users.length;
  const rows = users.map((u) => renderUserRow(u, keys, users, hasMedia)).join('');
  const atCap = total >= USER_CAP;
  return `
    <details class="disclosure-advanced conn-section" id="users"${savedUsers ? ' open' : ''}>
      <summary>
        <span class="adv-title">Usuários</span>
        <span class="adv-sub">Pessoas e agentes que podem ser responsáveis por tarefas — nome, foto e vínculo com chave de API</span>
      </summary>
      <div class="adv-body">
        <div class="adv-section">
          <p>Usuário aqui <strong>não é login</strong> — é um perfil de atribuição: a bolinha de responsável nas tarefas, como no ClickUp. <strong>Pessoa</strong> é alguém de carne e osso; <strong>agente</strong> é uma instância de IA (ex: Claude na VPS, OpenClaw). O vínculo com credencial mora na <em>chave</em> (escolha o dono ao criar a chave em "Agentes externos e automações") — um usuário pode ter várias chaves e o <code>assignee: 'me'</code> das tools MCP resolve pra esse perfil. Arquivar não apaga histórico: as tasks antigas continuam mostrando o responsável. ${total}/${USER_CAP} usuários.</p>
          <table class="keys-table">
            <thead><tr>
              <th></th><th>Perfil (nome, tipo, descrição, chave)</th><th>Foto</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="adv-section">
          <h3>Novo usuário</h3>
          ${atCap
            ? `<p style="color:var(--text-dim)">Limite de ${USER_CAP} usuários atingido. Arquive um perfil sem uso antes de criar outro.</p>`
            : `<form method="post" action="/app/config/users/create" class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
            <div style="display:flex;flex-direction:column;gap:4px">
              <label for="new-user-name" style="font-size:12px;color:var(--text-dim)">Nome</label>
              <input id="new-user-name" type="text" name="name" required maxlength="60" placeholder="Ex.: Claude VPS" class="input-text" style="width:170px">
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label for="new-user-type" style="font-size:12px;color:var(--text-dim)">Tipo</label>
              <select id="new-user-type" name="type">${typeOptions('agent')}</select>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px">
              <label for="new-user-bio" style="font-size:12px;color:var(--text-dim)">Descrição (opcional)</label>
              <input id="new-user-bio" type="text" name="bio" maxlength="200" placeholder="Ex.: instância na VPS, roda os crons" class="input-text" style="width:240px">
            </div>
            <button type="submit" class="btn btn-primary">Criar usuário</button>
          </form>
          <p style="color:var(--text-dim);font-size:13px;margin-top:8px">Depois de criar, gere a chave de API do agente em "Agentes externos e automações" (escolhendo este usuário como dono) e envie a foto na própria linha da tabela.</p>`}
        </div>
      </div>
    </details>`;
}

// ─────────────── CSS da seção + bolinhas (injetado pelo config e board) ───────────────
export const USERS_SECTION_CSS = `
.user-avatar-img { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; display: inline-flex; align-items: center; justify-content: center; }
.user-avatar-initials { color: #fff; font-size: 13px; font-weight: 600; letter-spacing: 0.5px; }
.user-edit-form { min-width: 260px; }
`;

// ─────────────── Handlers ───────────────

// POST /app/config/users/create — form { name, type, bio? }.
export async function handleUserCreatePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const name = String(form.get('name') ?? '').trim();
  if (name.length < 1 || name.length > 60) return htmlResponse('Nome deve ter 1 a 60 caracteres', 400);
  const typeRaw = String(form.get('type') ?? '');
  if (!USER_TYPES.includes(typeRaw as UserType)) return htmlResponse('Tipo inválido', 400);
  const bio = String(form.get('bio') ?? '').trim().slice(0, 200) || null;

  const count = await countUsers(env);
  if (count >= USER_CAP) {
    return htmlResponse(`Limite de ${USER_CAP} usuários atingido. Arquive um perfil sem uso antes de criar outro.`, 400);
  }

  await createUser(env, { id: `user_${newId().slice(0, 8)}`, name, type: typeRaw as UserType, bio, api_key_id: null }, Date.now());
  return usersRedirect();
}

// POST /app/config/users/update — form { id, name, type, bio }. O vínculo com chave
// NÃO é mais editado aqui (spec 86): o dono mora na CHAVE (api_keys.user_id, definido
// na criação). O campo legado users.api_key_id fica intocado — segue servindo de
// fallback de resolução até a chave migrar.
export async function handleUserUpdatePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id do usuário obrigatório', 400);
  const user = await getUserById(env, id);
  if (!user) return htmlResponse('Usuário não encontrado', 404);

  const name = String(form.get('name') ?? '').trim();
  if (name.length < 1 || name.length > 60) return htmlResponse('Nome deve ter 1 a 60 caracteres', 400);
  const typeRaw = String(form.get('type') ?? '');
  if (!USER_TYPES.includes(typeRaw as UserType)) return htmlResponse('Tipo inválido', 400);
  // Tipo do dono é imutável (âncora do 'me' das sessões OAuth).
  const type = user.is_owner === 1 ? user.type : (typeRaw as UserType);
  const bio = String(form.get('bio') ?? '').trim().slice(0, 200) || null;

  await updateUser(env, id, { name, type, bio }, Date.now());
  return usersRedirect();
}

// POST /app/config/users/archive — form { id, archived: '1'|'0' }.
export async function handleUserArchivePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id do usuário obrigatório', 400);
  const wantArchived = String(form.get('archived') ?? '') === '1';
  const ok = await setUserArchived(env, id, wantArchived ? Date.now() : null);
  if (!ok) return htmlResponse('Usuário não encontrado (o perfil do dono não é arquivável)', 404);
  return usersRedirect();
}

// POST /app/config/users/avatar — multipart { id, file } pra subir, { id, remove: '1' }
// pra remover. Foto ≤2MB, jpeg/png/webp/gif, mora em avatars/<id> no R2 (MEDIA).
export async function handleUserAvatarPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  if (!env.MEDIA) return htmlResponse('Armazenamento de mídia (R2) não habilitado nesta instância', 400);
  const form = await req.formData();

  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id do usuário obrigatório', 400);
  const user = await getUserById(env, id);
  if (!user) return htmlResponse('Usuário não encontrado', 404);

  if (String(form.get('remove') ?? '') === '1') {
    await env.MEDIA.delete(avatarR2Key(id));
    await setUserAvatar(env, id, null, null, Date.now());
    return usersRedirect();
  }

  const entry = form.get('file');
  if (!entry || typeof entry === 'string' || typeof (entry as any).arrayBuffer !== 'function') {
    return htmlResponse('Envie um arquivo de imagem no campo "file"', 400);
  }
  const file = entry as unknown as File;
  if (file.size > AVATAR_MAX_BYTES) return htmlResponse('Foto grande demais (máx 2MB)', 413);
  const mime = (file.type || '').toLowerCase();
  if (!AVATAR_MIMES.has(mime)) return htmlResponse('Formato não suportado — use JPEG, PNG, WebP ou GIF', 415);

  const bytes = new Uint8Array(await file.arrayBuffer());
  await env.MEDIA.put(avatarR2Key(id), bytes, { httpMetadata: { contentType: mime } });
  await setUserAvatar(env, id, avatarR2Key(id), mime, Date.now());
  return usersRedirect();
}

// GET /app/users/:id/avatar — serve a foto. SÓ sessão de browser (o board e a
// config são as únicas superfícies que a referenciam); nada de URL pública.
export async function handleUserAvatarGet(req: Request, env: Env, id: string): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  if (!env.MEDIA) return new Response('media não habilitada', { status: 404 });
  const user = await getUserById(env, id);
  if (!user || !user.avatar_key) return new Response('sem foto', { status: 404 });
  const obj = await env.MEDIA.get(user.avatar_key);
  if (!obj) return new Response('blob ausente no R2', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'content-type': user.avatar_mime ?? 'application/octet-stream',
      // private: foto atrás de sessão. As URLs geradas levam ?v=<updated_at>,
      // então o cache pode ser generoso — troca de foto troca a URL.
      'cache-control': 'private, max-age=86400',
    },
  });
}

// POST /app/tasks/assignees — form { task_id, user_ids... } (checkboxes da sidebar
// do detalhe). Replace-set: enviar sem nenhum user_id LIMPA os responsáveis.
export async function handleTaskAssigneesPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();

  const taskId = String(form.get('task_id') ?? '').trim();
  if (!taskId) return htmlResponse('task_id obrigatório', 400);
  const task = await getTaskById(env, taskId, true);
  if (!task) return htmlResponse('Task não encontrada', 404);

  const rawIds = form.getAll('user_ids').map((v) => String(v).trim()).filter(Boolean);
  if (rawIds.length > 16) return htmlResponse('Máximo de 16 responsáveis por task', 400);
  // Atribuição NOVA exige usuário ATIVO; manter um arquivado que JÁ era assignee
  // desta task pode (o picker o mostra esmaecido — remover histórico é opt-in).
  const [active, current] = await Promise.all([
    listUsers(env, false),
    listAssigneesForTask(env, taskId),
  ]);
  const allowed = new Set([...active.map((u) => u.id), ...current.map((a) => a.id)]);
  for (const uid of rawIds) {
    if (!allowed.has(uid)) return htmlResponse(`Usuário '${uid}' não existe ou está arquivado`, 400);
  }

  const now = Date.now();
  await setTaskAssignees(env, taskId, rawIds, now);

  // Mailbox (spec 82): item 'assignment' só pra quem foi ADICIONADO agora (o set
  // anterior está em `current`, lido antes do replace). Ator = perfil do dono
  // (sessão de browser). Best-effort por construção.
  const currentIds = new Set(current.map((a) => a.id));
  const added = rawIds.filter((uid) => !currentIds.has(uid));
  if (added.length > 0) {
    const owner = await getOwnerUser(env);
    await produceAssignmentMailbox(env, {
      taskId, addedUserIds: added, actorUserId: owner?.id ?? null, now,
    });
  }

  // Log de atividade (spec 74): nomes legíveis, ANTES (já lido acima em `current`) vs
  // DEPOIS (relido pra refletir o replace-set que acabou de gravar, na mesma ordem
  // canônica dono-primeiro de listAssigneesForTask — mais confiável que remontar a
  // partir de `rawIds`, cuja ordem é a dos checkboxes do form).
  const oldLabel = current.length > 0 ? current.map((a) => a.name).join(', ') : 'Sem responsável';
  const afterList = await listAssigneesForTask(env, taskId);
  const newLabel = afterList.length > 0 ? afterList.map((a) => a.name).join(', ') : 'Sem responsável';
  if (oldLabel !== newLabel) {
    await logTaskActivity(env, taskId, `oauth:${session.email}`, [
      { field: 'assignees', old_value: oldLabel, new_value: newLabel },
    ]);
  }

  return new Response(null, { status: 302, headers: { location: `/app/tasks/${taskId}` } });
}
