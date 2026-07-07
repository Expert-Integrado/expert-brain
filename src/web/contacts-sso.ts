import type { Env } from '../env.js';
import { requireSession } from './session.js';

// URL do Expert Console (front multi-vault, co-hospedado no Worker do Contacts).
const CONSOLE_URL = 'https://expert-contacts.contato-d9a.workers.dev';
const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// GET /app/contacts-sso — handoff de sessão do Brain pro Expert Console.
// Exige sessão do Brain; gera um token CURTO assinado (HMAC com SSO_SECRET, válido
// 60s) e redireciona pro /app/sso do Console, que valida e cria a PRÓPRIA sessão.
// Assim o login do Brain "carrega" pro Console — o Eric nunca digita senha lá
// (ele só tem o login do Brain). Sem PII na URL: assina só a expiração.
// Fallback: sem SSO_SECRET, redireciona direto pro Console (que aí pede login normal).
export async function handleContactsSso(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  if (!env.SSO_SECRET) {
    return new Response(null, { status: 302, headers: { location: `${CONSOLE_URL}/app` } });
  }

  // Nonce single-use (spec 20-frontend/27): o Console marca cada nonce em KV e
  // rejeita reuso — a URL do handoff (que vaza em history/log por ser query
  // string) só cria sessão UMA vez.
  const exp = Date.now() + 60_000;
  const nonce = crypto.randomUUID();
  const sig = await hmacHex(env.SSO_SECRET, `sso:${exp}:${nonce}`);
  return new Response(null, {
    status: 302,
    headers: { location: `${CONSOLE_URL}/app/sso?exp=${exp}&nonce=${nonce}&sig=${sig}` },
  });
}
