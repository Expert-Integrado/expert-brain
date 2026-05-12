import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { htmlResponse } from './render.js';
import { createApiKey, revokeApiKey } from '../auth/api-keys.js';

// /app/api-keys virou redirect — a UI agora vive dentro de /app/config.
// Mantemos a rota só pra não quebrar bookmarks antigos.
export async function handleApiKeysPage(_req: Request, _env: Env): Promise<Response> {
  return new Response(null, {
    status: 302,
    headers: { location: '/app/config#api-keys' },
  });
}

export async function handleApiKeyCreate(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const name = String(form.get('name') ?? '').trim().slice(0, 80);
  if (!name) return htmlResponse('Name required', 400);
  const { plainKey } = await createApiKey(env, session.email, name);
  return new Response(null, {
    status: 302,
    headers: { location: `/app/config?new=${encodeURIComponent(plainKey)}#api-keys` },
  });
}

export async function handleApiKeyRevoke(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const form = await req.formData();
  const id = String(form.get('id') ?? '').trim();
  if (!id) return htmlResponse('id required', 400);
  await revokeApiKey(env, session.email, id);
  return new Response(null, { status: 302, headers: { location: '/app/config#api-keys' } });
}
