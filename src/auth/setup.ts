import type { Env } from '../env.js';
import { runMigrations } from '../db/migrate.js';
import { renderNotConfigured } from '../static/wizard.js';

export function isSetup(env: Env): boolean {
  return Boolean(env.OWNER_EMAIL && env.OWNER_PASSWORD_HASH && env.SESSION_SECRET);
}

async function countKvPrefix(env: Env, prefix: string): Promise<number> {
  try {
    let cursor: string | undefined;
    let total = 0;
    // Paginate through up to ~1000 keys (single-user, should never get close)
    for (let i = 0; i < 10; i++) {
      const res = await env.OAUTH_KV.list({ prefix, cursor, limit: 1000 });
      total += res.keys.length;
      if (res.list_complete) break;
      cursor = res.cursor;
    }
    return total;
  } catch {
    return 0;
  }
}

export async function getVaultStatus(env: Env): Promise<{
  notes: number;
  edges: number;
  lastWrite: number | null;
  clients: number;
  tokens: number;
  connected: boolean;
}> {
  const [n, e, lw, clients, tokens] = await Promise.all([
    env.DB.prepare(`SELECT count(*) c FROM notes`).first<{ c: number }>(),
    env.DB.prepare(`SELECT count(*) c FROM edges`).first<{ c: number }>(),
    env.DB.prepare(`SELECT max(updated_at) m FROM notes`).first<{ m: number | null }>(),
    countKvPrefix(env, 'client:'),
    countKvPrefix(env, 'token:'),
  ]);
  return {
    notes: n?.c ?? 0,
    edges: e?.c ?? 0,
    lastWrite: lw?.m ?? null,
    clients,
    tokens,
    connected: tokens > 0,
  };
}

export async function handleRoot(_req: Request, env: Env): Promise<Response> {
  if (!isSetup(env)) {
    return new Response(renderNotConfigured(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  // Root now funnels configured vaults into the dashboard login. The old
  // landing page (status + MCP URL + skill + personalization) moved to
  // /app/config, accessible only after login.
  return new Response(null, { status: 302, headers: { location: '/app/login' } });
}

export async function handleStatus(env: Env): Promise<Response> {
  if (!isSetup(env)) {
    return new Response(JSON.stringify({ configured: false }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  const status = await getVaultStatus(env);
  return new Response(JSON.stringify({ configured: true, ...status }), {
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleProvision(env: Env): Promise<Response> {
  await runMigrations(env);
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
}
