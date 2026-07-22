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
  return `mv_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/app; Max-Age=${maxAge}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

// Material efetivo da chave HMAC de sessão (spec 20-frontend/27). Combina:
//  - SESSION_SECRET (secret estático)
//  - epoch (contador em KV, key 'session:epoch', default '0') — bump = revoga TODAS
//    as sessões (logout num dispositivo derruba os outros; Console é single-user)
//  - fingerprint do password hash (sha256 truncado) — troca de OWNER_PASSWORD_HASH
//    revoga tudo automaticamente, sem passo manual
// Custo: 1 KV read por request autenticado (cacheado no edge). Por consistência
// eventual do KV, o bump pode levar ~60s pra valer em outros POPs — o alvo é matar
// token roubado de 7 dias, não revogação sub-segundo.
export async function getSessionKeyMaterial(env: Env): Promise<string> {
  let epoch = '0';
  try {
    epoch = (await env.CACHE.get('session:epoch')) ?? '0';
  } catch {
    // KV transiente: usa epoch 0 (fail-open — não pode derrubar todo login).
  }
  let pwdFp = '';
  if (env.OWNER_PASSWORD_HASH) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.OWNER_PASSWORD_HASH));
    pwdFp = Array.from(new Uint8Array(digest).slice(0, 8))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return `${env.SESSION_SECRET}|${epoch}|${pwdFp}`;
}

// Bump do epoch: invalida imediatamente todas as sessões emitidas. Chave
// PERMANENTE (sem TTL) — ausência = epoch 0.
export async function bumpSessionEpoch(env: Env): Promise<void> {
  try {
    const n = parseInt((await env.CACHE.get('session:epoch')) ?? '0', 10) || 0;
    await env.CACHE.put('session:epoch', String(n + 1));
  } catch {
    // KV transiente: o logout ainda limpa o cookie local.
  }
}

export type SessionResult =
  | { ok: true; email: string }
  | { ok: false; response: Response };

export async function requireSession(req: Request, env: Env): Promise<SessionResult> {
  if (!env.SESSION_SECRET) {
    return { ok: false, response: new Response('Session secret not configured', { status: 503 }) };
  }
  const token = readCookie(req.headers.get('cookie'), 'mv_session');
  const url = new URL(req.url);
  const next = encodeURIComponent(url.pathname + url.search);
  const redirect = new Response(null, {
    status: 302,
    headers: { location: `/app/login?next=${next}` },
  });
  if (!token) return { ok: false, response: redirect };
  const verified = await verifySession(token, await getSessionKeyMaterial(env), Math.floor(Date.now() / 1000));
  if (!verified) return { ok: false, response: redirect };
  return { ok: true, email: verified.email };
}
