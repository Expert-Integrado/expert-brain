import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { formError } from './form-error.js';
import { ApiKeyLimitError, assignApiKeyUser, createApiKey, revokeApiKey, setApiKeySystem, isApiKeyScope, type ApiKeyScope } from '../auth/api-keys.js';
import { presetById } from '../auth/presets.js';
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
  if (!name) return formError(req, 'Nome obrigatório', { field: 'name', returnTo: '/app/config#api-keys' });
  // Papel da credencial (spec 91): o select de preset é o ÚNICO escritor dos tokens
  // de restrição (notes:none/contacts:none/tasks:assigned) — a UI nunca digita CSV.
  // preset ausente ou 'custom' cai no form legado (escopo base + checkbox private),
  // então o POST antigo (scripts, testes, bookmarks de form) segue funcionando.
  const presetRaw = String(form.get('preset') ?? '').trim();
  const preset = presetRaw && presetRaw !== 'custom' ? presetById(presetRaw) : null;
  let scopes: string;
  if (preset) {
    scopes = preset.scopes;
  } else {
    // Escopo BASE (spec 17): valor inválido/ausente cai em 'full' (histórico).
    const scopeRaw = String(form.get('scope') ?? '');
    const base: ApiKeyScope = isApiKeyScope(scopeRaw) ? scopeRaw : 'full';
    // Escopo aditivo 'private' (spec 31): checkbox → CSV 'full,private' | 'read,private'.
    const wantsPrivate = String(form.get('private_scope') ?? '') === '1';
    scopes = wantsPrivate ? `${base},private` : base;
  }
  // Dono da chave (spec 86): OBRIGATÓRIO pra chave nova — chave sem dono não nasce
  // mais pela UI (o vínculo esquecível em dois passos foi a origem do bug do PC
  // assinando como Claude VPS). Precisa ser um usuário ATIVO.
  const userId = String(form.get('user_id') ?? '').trim();
  if (!userId) return formError(req, 'Dono da chave obrigatório — escolha o usuário que esta credencial identifica', { field: 'user_id', returnTo: '/app/config#api-keys' });
  const owner = await getUserById(env, userId);
  if (!owner || owner.archived_at !== null) return formError(req, 'Usuário dono da chave não existe ou está arquivado', { field: 'user_id', returnTo: '/app/config#api-keys' });
  // Sistema (spec 87): texto livre curto pro agrupamento da listagem ('frota',
  // 'hermes'...). Opcional — vazio vira NULL (grupo "sem sistema").
  const systemRaw = String(form.get('system') ?? '').trim().slice(0, 40);
  const system = systemRaw || null;
  let plainKey: string;
  try {
    const created = await createApiKey(env, session.email, name, scopes, userId, system);
    plainKey = created.plainKey;
  } catch (err) {
    if (err instanceof ApiKeyLimitError) {
      return formError(req, err.message, { status: 429, returnTo: '/app/config#api-keys' });
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

// Vínculo tardio de dono em chave órfã (adendo spec 87): mesma validação de dono da
// criação; orphan-only é garantido no UPDATE (assignApiKeyUser) — chave com dono,
// revogada ou inexistente cai no 400 genérico sem vazar qual das três.
export async function handleApiKeyOwner(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  const userId = String(form.get('user_id') ?? '').trim();
  if (!id || !userId) return formError(req, 'id e user_id obrigatórios', { returnTo: '/app/config#api-keys' });
  const owner = await getUserById(env, userId);
  if (!owner || owner.archived_at !== null) return formError(req, 'Usuário dono da chave não existe ou está arquivado', { field: 'user_id', returnTo: '/app/config#api-keys' });
  const ok = await assignApiKeyUser(env, session.email, id, userId);
  if (!ok) return formError(req, 'Chave não encontrada, revogada ou já tem dono — pra trocar identidade, revogue e crie outra', { returnTo: '/app/config#api-keys' });
  // ?saved=keys reabre o accordion (fix KEYS-STATE-LOST): o fetch do ajax-form
  // perde o #api-keys do Location — sem o query param a seção voltava fechada.
  return new Response(null, { status: 302, headers: { location: '/app/config?saved=keys#api-keys' } });
}

// Edição tardia do sistema (pedido 11/07): o agrupamento nascia na criação e
// ficava travado — agora edita inline na listagem. Só chave ativa; vazio limpa.
export async function handleApiKeySystem(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return formError(req, 'id obrigatório', { returnTo: '/app/config#api-keys' });
  const systemRaw = String(form.get('system') ?? '').trim().slice(0, 40);
  const ok = await setApiKeySystem(env, session.email, id, systemRaw || null);
  if (!ok) return formError(req, 'Chave não encontrada ou revogada', { returnTo: '/app/config#api-keys' });
  return new Response(null, { status: 302, headers: { location: '/app/config?saved=keys#api-keys' } });
}

export async function handleApiKeyRevoke(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return formError(req, 'id obrigatório', { returnTo: '/app/config#api-keys' });
  await revokeApiKey(env, session.email, id);
  return new Response(null, { status: 302, headers: { location: '/app/config?saved=keys#api-keys' } });
}
