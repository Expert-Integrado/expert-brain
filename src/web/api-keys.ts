import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { htmlResponse } from './render.js';
import { ApiKeyLimitError, createApiKey, revokeApiKey, isApiKeyScope, type ApiKeyScope } from '../auth/api-keys.js';
import { getUserById } from '../db/queries.js';

// /app/api-keys virou redirect — a UI agora vive dentro de /app/config.
// Mantemos a rota só pra não quebrar bookmarks antigos.
export async function handleApiKeysPage(_req: Request, _env: Env): Promise<Response> {
  return new Response(null, {
    status: 302,
    headers: { location: '/app/config#api-keys' },
  });
}

// TTL curto pro KV flash: chave nasce, redireciona, a /app/config consome e
// apaga. 60s é folga suficiente pra qualquer redirect HTTP sem deixar a chave
// recuperável depois.
const API_KEY_FLASH_TTL = 60;

function flashId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function flashKvKey(id: string): string {
  return `flash:newkey:${id}`;
}

export async function handleApiKeyCreate(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const name = String(form.get('name') ?? '').trim().slice(0, 80);
  if (!name) return htmlResponse('Nome obrigatório', 400);
  // Escopo BASE (spec 17): valor inválido/ausente cai em 'full' (histórico).
  const scopeRaw = String(form.get('scope') ?? '');
  const base: ApiKeyScope = isApiKeyScope(scopeRaw) ? scopeRaw : 'full';
  // Escopo aditivo 'private' (spec 31): checkbox → CSV 'full,private' | 'read,private'.
  const wantsPrivate = String(form.get('private_scope') ?? '') === '1';
  const scopes = wantsPrivate ? `${base},private` : base;
  // Dono da chave (spec 86): OBRIGATÓRIO pra chave nova — chave sem dono não nasce
  // mais pela UI (o vínculo esquecível em dois passos foi a origem do bug do PC
  // assinando como Claude VPS). Precisa ser um usuário ATIVO.
  const userId = String(form.get('user_id') ?? '').trim();
  if (!userId) return htmlResponse('Dono da chave obrigatório — escolha o usuário que esta credencial identifica', 400);
  const owner = await getUserById(env, userId);
  if (!owner || owner.archived_at !== null) return htmlResponse('Usuário dono da chave não existe ou está arquivado', 400);
  let plainKey: string;
  try {
    const created = await createApiKey(env, session.email, name, scopes, userId);
    plainKey = created.plainKey;
  } catch (err) {
    if (err instanceof ApiKeyLimitError) {
      return htmlResponse(err.message, 429);
    }
    throw err;
  }
  // Não voltamos a chave na URL — fica no histórico do browser, em logs,
  // e pode vazar via Referer. Guarda no KV por 60s e devolve só um id opaco.
  const id = flashId();
  await env.OAUTH_KV.put(flashKvKey(id), plainKey, { expirationTtl: API_KEY_FLASH_TTL });
  return new Response(null, {
    status: 302,
    headers: { location: `/app/config?flash=${id}#api-keys` },
  });
}

export async function handleApiKeyRevoke(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id obrigatório', 400);
  await revokeApiKey(env, session.email, id);
  return new Response(null, { status: 302, headers: { location: '/app/config#api-keys' } });
}
