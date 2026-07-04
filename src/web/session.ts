const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function signSession(
  email: string,
  secret: string,
  issuedAt: number
): Promise<string> {
  const e = b64urlEncode(encoder.encode(email));
  const i = b64urlEncode(encoder.encode(String(issuedAt)));
  const sig = await hmac(secret, `${e}.${i}`);
  return `${e}.${i}.${b64urlEncode(sig)}`;
}

export async function verifySession(
  token: string,
  secret: string,
  nowSeconds: number
): Promise<{ email: string; issuedAt: number } | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [e, i, s] = parts;
  const expected = await hmac(secret, `${e}.${i}`);
  const got = b64urlDecode(s);
  if (!constantTimeEqual(expected, got)) return null;
  const email = new TextDecoder().decode(b64urlDecode(e));
  const issuedAt = Number(new TextDecoder().decode(b64urlDecode(i)));
  if (!Number.isFinite(issuedAt)) return null;
  if (nowSeconds - issuedAt > SESSION_TTL_SECONDS) return null;
  return { email, issuedAt };
}

import type { Env } from '../env.js';

export function sessionCookie(token: string, opts: { clear?: boolean } = {}): string {
  const maxAge = opts.clear ? 0 : SESSION_TTL_SECONDS;
  return `eb_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/app; Max-Age=${maxAge}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export type SessionResult =
  | { ok: true; email: string }
  | { ok: false; response: Response };

// Requests de dados (fetch de JSON dos bundles client, ou mutação em rota de
// dados) não podem "passar" silenciosamente quando a sessão expira: o browser
// segue o 302 pra /app/login e o fetch recebe `res.ok === true` com o HTML de
// login no corpo. Pra esses casos devolvemos 401 JSON — o client sabe tratar.
// Navegação de página (GET sem accept: application/json) continua com o 302
// normal pro fluxo de login. Ver specs/20-frontend/21-csp-botoes-mortos-e-sessao-expirada.md.
function isDataRequest(req: Request, url: URL): boolean {
  if ((req.headers.get('accept') || '').includes('application/json')) return true;
  if (req.method !== 'GET' && /\/(data|status|complete|link|prefs|media)(\/|$)/.test(url.pathname)) return true;
  return false;
}

export async function requireSession(req: Request, env: Env): Promise<SessionResult> {
  if (!env.SESSION_SECRET) {
    return { ok: false, response: new Response('Session secret not configured', { status: 503 }) };
  }
  const token = readCookie(req.headers.get('cookie'), 'eb_session');
  const url = new URL(req.url);
  const next = encodeURIComponent(url.pathname + url.search);
  const dataRequest = isDataRequest(req, url);
  const unauthorized = (): Response =>
    dataRequest
      ? new Response(JSON.stringify({ error: 'session expired' }), {
          status: 401,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      : new Response(null, { status: 302, headers: { location: `/app/login?next=${next}` } });
  if (!token) return { ok: false, response: unauthorized() };
  const verified = await verifySession(token, env.SESSION_SECRET, Math.floor(Date.now() / 1000));
  if (!verified) return { ok: false, response: unauthorized() };
  return { ok: true, email: verified.email };
}
