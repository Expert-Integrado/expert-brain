import type { Env } from '../env.js';

// Rate limit de login por IP+e-mail no KV CACHE (spec 20-frontend/27 — espelho
// EXATO do módulo do Expert Brain, spec 10-backend/18: mesmas constantes, mesmo
// esquema de key; os dois repos mantêm o padrão único). Mata brute-force barato
// contra o PBKDF2 capado em 100k iterações (hard limit do runtime Workers). KV é
// eventualmente consistente entre POPs — isto NÃO é um contador atômico e não
// precisa ser: o objetivo é encarecer o ataque burro, não garantir contagem
// exata. Chaves expiram sozinhas (expirationTtl).

const WINDOW_S = 15 * 60; // janela de contagem
const MAX_FAILS = 5; // falhas permitidas por janela
const MAX_BLOCK_S = 24 * 60 * 60; // teto do backoff

type Bucket = { fails: number; blockedUntil: number }; // epoch seconds

async function emailKey(email: string): Promise<string> {
  // Não gravar e-mail em claro na key do KV.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function clientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') || 'unknown';
}

async function bucketKey(ip: string, email: string): Promise<string> {
  return `rl:login:${ip}:${await emailKey(email)}`;
}

async function readBucket(env: Env, key: string): Promise<Bucket> {
  try {
    const raw = await env.CACHE.get(key);
    if (raw) return JSON.parse(raw) as Bucket;
  } catch {
    // KV transiente ou JSON inválido: trata como bucket vazio (fail-open —
    // rate limit é defesa em profundidade, não pode derrubar o login do dono).
  }
  return { fails: 0, blockedUntil: 0 };
}

export async function checkLoginAllowed(
  env: Env,
  ip: string,
  email: string
): Promise<{ allowed: boolean; retryAfterS?: number }> {
  const b = await readBucket(env, await bucketKey(ip, email));
  const now = Math.floor(Date.now() / 1000);
  if (b.blockedUntil > now) return { allowed: false, retryAfterS: b.blockedUntil - now };
  return { allowed: true };
}

export async function registerLoginFailure(env: Env, ip: string, email: string): Promise<number> {
  const key = await bucketKey(ip, email);
  const b = await readBucket(env, key);
  const now = Math.floor(Date.now() / 1000);
  b.fails += 1;
  if (b.fails > MAX_FAILS) {
    // 15min → 30min → 60min → ... → cap 24h.
    const blockS = Math.min(WINDOW_S * 2 ** (b.fails - MAX_FAILS - 1), MAX_BLOCK_S);
    b.blockedUntil = now + blockS;
  }
  try {
    await env.CACHE.put(key, JSON.stringify(b), {
      expirationTtl: Math.max(WINDOW_S, b.blockedUntil - now) + 60,
    });
  } catch {
    // KV transiente: perde a contagem desta falha, login segue funcionando.
  }
  return b.fails;
}

export async function clearLoginFailures(env: Env, ip: string, email: string): Promise<void> {
  try {
    await env.CACHE.delete(await bucketKey(ip, email));
  } catch {
    // não-fatal
  }
}
