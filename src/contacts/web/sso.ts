import type { Env } from '../env.js';
import { signSession, sessionCookie, getSessionKeyMaterial } from './session.js';

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// GET /app/sso — recebe o handoff assinado do Expert Brain (/app/contacts-sso) e
// cria a sessão do Console SEM senha. O dono só tem o login do Brain; este endpoint
// faz o login dele "carregar" pra cá. Confiança = assinatura HMAC com SSO_SECRET
// (mesmo segredo nos dois Workers); só o Brain consegue produzir um sig válido.
// Token expira em 60s + nonce SINGLE-USE em KV (spec 20-frontend/27): a mesma URL
// não cria uma segunda sessão. Honestidade: KV é eventualmente consistente — um
// replay em POP diferente dentro de segundos PODE passar; o single-use mata o
// replay trivial (URL capturada em history/log reutilizada dentro da janela) e
// reduz a janela de 60s reutilizável pra 1 uso. Contra atacante posicionado em
// rede, a proteção é o TLS. Qualquer falha → manda pro login normal.
export async function handleSso(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get('exp') || '0');
  const nonce = url.searchParams.get('nonce') || '';
  const sig = url.searchParams.get('sig') || '';
  const loginRedirect = new Response(null, { status: 302, headers: { location: '/app/login' } });

  if (!env.SSO_SECRET || !env.SESSION_SECRET || !env.OWNER_EMAIL) return loginRedirect;
  // Formato antigo (sem nonce) deixa de ser aceito — Brain é deployado junto.
  if (!nonce || !/^[0-9a-f-]{16,64}$/i.test(nonce)) return loginRedirect;
  if (!Number.isFinite(exp) || Date.now() > exp) return loginRedirect;

  const expected = await hmacHex(env.SSO_SECRET, `sso:${exp}:${nonce}`);
  if (!constTimeEq(expected, sig)) return loginRedirect;

  // Single-use: nonce já visto → login normal. TTL 120s cobre a janela de 60s
  // com folga; depois disso o próprio exp rejeita.
  try {
    if (await env.CACHE.get(`ssonon:${nonce}`)) return loginRedirect;
    await env.CACHE.put(`ssonon:${nonce}`, '1', { expirationTtl: 120 });
  } catch {
    // KV transiente: segue sem a marcação (o exp de 60s continua limitando).
  }

  // Assinatura válida, não expirada e primeiro uso → cria a sessão do dono.
  const token = await signSession(env.OWNER_EMAIL, await getSessionKeyMaterial(env), Math.floor(Date.now() / 1000));
  return new Response(null, {
    status: 302,
    headers: { location: '/app/graph', 'set-cookie': sessionCookie(token) },
  });
}
