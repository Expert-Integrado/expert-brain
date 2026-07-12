import type { Env, AuthContext } from '../../env.js';
import {
  getUserByIdOrName,
  getUserByApiKeyId,
  getOwnerUser,
  listUsers,
  type BrainUser,
  type AssigneeRef,
} from '../../db/queries.js';
import { scopesAssignedOnly, type TaskVisibility } from '../../auth/visibility.js';
import { canSeePrivate } from '../helpers.js';

// Resolução do param `assignees`/`assignee` (spec 37). Diferente de projeto
// (project-ref.ts), usuário NUNCA é auto-criado: usuário é identidade — criar é ato
// deliberado do dono no console (/app/config, seção Usuários). Ref sem match → erro
// listando os ativos, pra o agente corrigir sem outro round-trip.

export type UserResolve =
  | { ok: true; user: BrainUser }
  | { ok: false; error: string };

export function toAssigneeRef(u: BrainUser): AssigneeRef {
  return { id: u.id, name: u.name, type: u.type, avatar: u.avatar_key !== null };
}

// Identidade de QUEM chama: PAT → usuário-agente com api_key_id = keyId;
// sessão OAuth do dono (sem keyId) → perfil-pessoa is_owner. Null quando o PAT
// não tem perfil vinculado (o chamador decide o erro).
export async function resolveMe(env: Env, auth: AuthContext | undefined): Promise<BrainUser | null> {
  if (!auth) return null;
  if (auth.keyId === undefined) return getOwnerUser(env);
  return getUserByApiKeyId(env, auth.keyId);
}

// Visibilidade row-level de TASK da credencial (spec 91): resolve o TaskVisibility
// pra passar às funções base de leitura/escrita de task. FAIL-CLOSED: credencial
// `tasks:assigned` SEM perfil vinculado não vira "vê tudo" nem "vazio silencioso" —
// vira erro instrutivo (o dono vincula em /app/config), porque sem user não há como
// computar "atribuídas a mim".
export type TaskVisResolve =
  | { ok: true; vis: TaskVisibility }
  | { ok: false; error: string };

export async function resolveTaskVis(env: Env, auth: AuthContext | undefined): Promise<TaskVisResolve> {
  const includePrivate = canSeePrivate(auth);
  if (!auth || !scopesAssignedOnly(auth.scopes)) {
    return { ok: true, vis: { includePrivate, assignedOnlyUserId: null } };
  }
  const me = await resolveMe(env, auth);
  if (!me) {
    return {
      ok: false,
      error:
        'This credential is restricted to ASSIGNED tasks (tasks:assigned) but has no linked user profile, ' +
        'so its task visibility cannot be resolved. The owner links this PAT to an agent user at /app/config ' +
        '(Usuários). Do NOT retry until linked.',
    };
  }
  return { ok: true, vis: { includePrivate, assignedOnlyUserId: me.id } };
}

async function activeUsersHint(env: Env): Promise<string> {
  const users = await listUsers(env, false);
  if (users.length === 0) return 'No users exist yet — the owner creates them at /app/config (Usuários).';
  const names = users.map((u) => `${u.name} (${u.id}, ${u.type})`).join('; ');
  return `Active users: ${names}.`;
}

export async function resolveUserRef(env: Env, ref: string, auth: AuthContext | undefined): Promise<UserResolve> {
  const trimmed = ref.trim();
  if (!trimmed) return { ok: false, error: 'Empty assignee ref. Pass a user id, a user name, or "me".' };

  if (trimmed.toLowerCase() === 'me') {
    const me = await resolveMe(env, auth);
    if (me) return { ok: true, user: me };
    return {
      ok: false,
      error:
        'This credential has no linked user profile, so "me" cannot be resolved. ' +
        'The owner can link this PAT to an agent user at /app/config (Usuários), or pass an explicit user id/name. ' +
        (await activeUsersHint(env)),
    };
  }

  const active = await getUserByIdOrName(env, trimmed, true);
  if (active) return { ok: true, user: active };

  const archived = await getUserByIdOrName(env, trimmed, false);
  if (archived) {
    return {
      ok: false,
      error: `User '${archived.name}' is archived and cannot be assigned. The owner can unarchive it at /app/config (Usuários).`,
    };
  }

  return {
    ok: false,
    error: `User '${trimmed}' not found. Users are NOT auto-created — the owner manages them at /app/config (Usuários). ` +
      (await activeUsersHint(env)),
  };
}

// Resolve a lista `assignees` inteira (dedupe por id). Qualquer ref inválida aborta
// com o erro dela — atribuição parcial silenciosa esconderia um typo.
export async function resolveAssigneeRefs(
  env: Env, refs: string[], auth: AuthContext | undefined
): Promise<{ ok: true; users: BrainUser[] } | { ok: false; error: string }> {
  const seen = new Map<string, BrainUser>();
  for (const ref of refs) {
    const r = await resolveUserRef(env, ref, auth);
    if (!r.ok) return r;
    seen.set(r.user.id, r.user);
  }
  return { ok: true, users: [...seen.values()] };
}
