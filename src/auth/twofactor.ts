// Verificação em duas etapas do LOGIN DO DONO (spec 100-seguranca-conta/102).
// Estado na tabela `meta` (D1) — sem migration; backup codes hasheados com o
// mesmo PBKDF2 da senha. O token intermediário do login (cookie eb_2fa) é
// assinado com secret DERIVADO do SESSION_SECRET: requireSession não compara
// e-mail com OWNER_EMAIL, então um token intermediário assinado com o mesmo
// secret viraria sessão plena se copiado pro cookie eb_session — bypass exato
// do que o 2FA protege (senha roubada).

import type { Env } from '../env.js';
import { hashPassword, verifyPassword } from './password.js';
import { generateTotpSecret, verifyTotp } from './totp.js';
import { signSession, verifySession } from '../web/session.js';

const KEY_SECRET = 'totp_secret';
const KEY_ENABLED = 'totp_enabled';
const KEY_ENABLED_AT = 'totp_enabled_at';
const KEY_PENDING = 'totp_pending_secret';
const KEY_BACKUP = 'totp_backup_codes';

const BACKUP_CODE_COUNT = 8;
// Sem ambiguos (I/L/O/0/1) — codigo vai ser lido de papel/1Password e digitado.
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

async function metaGet(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function metaSet(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(key, value)
    .run();
}

async function metaDel(env: Env, key: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM meta WHERE key = ?`).bind(key).run();
}

export async function twoFactorEnabled(env: Env): Promise<boolean> {
  if ((await metaGet(env, KEY_ENABLED)) !== '1') return false;
  return (await metaGet(env, KEY_SECRET)) !== null;
}

export async function twoFactorEnabledAt(env: Env): Promise<number | null> {
  const raw = await metaGet(env, KEY_ENABLED_AT);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function pendingTotpSecret(env: Env): Promise<string | null> {
  if (await twoFactorEnabled(env)) return null;
  return metaGet(env, KEY_PENDING);
}

/**
 * Inicia (ou retoma) o setup: gera um secret pendente que só vira 2FA de
 * verdade depois de `confirmTwoFactor` provar que o app do dono gera códigos
 * certos — nunca há lockout por secret não cadastrado. Refresh da página
 * reusa o pendente em vez de trocar o secret embaixo do app já cadastrado.
 */
export async function startTwoFactor(env: Env): Promise<string> {
  if (await twoFactorEnabled(env)) throw new Error('two-factor already enabled');
  const existing = await metaGet(env, KEY_PENDING);
  if (existing) return existing;
  const secret = generateTotpSecret();
  await metaSet(env, KEY_PENDING, secret);
  return secret;
}

export async function cancelTwoFactorSetup(env: Env): Promise<void> {
  await metaDel(env, KEY_PENDING);
}

function formatBackupCode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += BACKUP_ALPHABET[bytes[i] % BACKUP_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Normaliza input digitado pro formato canonico XXXX-XXXX (ou null se nao parece backup code). */
function canonicalBackupCode(input: string): string | null {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (stripped.length !== 8) return null;
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
}

/**
 * Confirma o setup: código TOTP válido contra o secret PENDENTE promove ele a
 * secret real, liga o 2FA e gera os backup codes — retornados em claro UMA
 * única vez (armazenados só como hash). Código errado => null, nada muda.
 */
export async function confirmTwoFactor(env: Env, code: string, nowMs: number): Promise<string[] | null> {
  const pending = await metaGet(env, KEY_PENDING);
  if (!pending) return null;
  if (!(await verifyTotp(pending, code, nowMs))) return null;

  const codes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    codes.push(formatBackupCode(crypto.getRandomValues(new Uint8Array(8))));
  }
  const hashes = await Promise.all(codes.map((c) => hashPassword(c)));

  await metaSet(env, KEY_SECRET, pending);
  await metaSet(env, KEY_ENABLED, '1');
  await metaSet(env, KEY_ENABLED_AT, String(Math.floor(nowMs / 1000)));
  await metaSet(env, KEY_BACKUP, JSON.stringify(hashes));
  await metaDel(env, KEY_PENDING);
  return codes;
}

export async function backupCodesRemaining(env: Env): Promise<number> {
  const raw = await metaGet(env, KEY_BACKUP);
  if (!raw) return 0;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Verifica um segundo fator já com 2FA LIGADO. Formato decide o caminho:
 * 6 dígitos => TOTP; qualquer coisa que normalize pra XXXX-XXXX => backup
 * code, que é CONSUMIDO (removido do array) ao acertar.
 */
export async function verifySecondFactor(
  env: Env,
  code: string,
  nowMs: number
): Promise<'totp' | 'backup' | null> {
  const secret = await metaGet(env, KEY_SECRET);
  if (!secret || (await metaGet(env, KEY_ENABLED)) !== '1') return null;

  const digits = code.replace(/\s+/g, '');
  if (/^\d{6}$/.test(digits)) {
    return (await verifyTotp(secret, digits, nowMs)) ? 'totp' : null;
  }

  const canonical = canonicalBackupCode(code);
  if (!canonical) return null;
  const raw = await metaGet(env, KEY_BACKUP);
  if (!raw) return null;
  let hashes: string[];
  try {
    hashes = JSON.parse(raw);
    if (!Array.isArray(hashes)) return null;
  } catch {
    return null;
  }
  for (let i = 0; i < hashes.length; i++) {
    if (await verifyPassword(canonical, hashes[i])) {
      hashes.splice(i, 1);
      await metaSet(env, KEY_BACKUP, JSON.stringify(hashes));
      return 'backup';
    }
  }
  return null;
}

/** Desliga o 2FA — exige um segundo fator válido (TOTP ou backup code). */
export async function disableTwoFactor(env: Env, code: string, nowMs: number): Promise<boolean> {
  const kind = await verifySecondFactor(env, code, nowMs);
  if (!kind) return false;
  await metaDel(env, KEY_ENABLED);
  await metaDel(env, KEY_ENABLED_AT);
  await metaDel(env, KEY_SECRET);
  await metaDel(env, KEY_BACKUP);
  await metaDel(env, KEY_PENDING);
  return true;
}

// ─────────── Token intermediário do login (cookie eb_2fa) ───────────

export const TWOFA_COOKIE = 'eb_2fa';
const TWOFA_TTL_SECONDS = 300;

// Secret derivado: a assinatura de um eb_2fa NUNCA valida como eb_session.
function twoFactorSecret(env: Env): string {
  return `${env.SESSION_SECRET}:2fa`;
}

export async function signTwoFactorToken(email: string, env: Env, nowSeconds: number): Promise<string> {
  return signSession(email, twoFactorSecret(env), nowSeconds);
}

export async function verifyTwoFactorToken(
  token: string,
  env: Env,
  nowSeconds: number
): Promise<string | null> {
  const verified = await verifySession(token, twoFactorSecret(env), nowSeconds);
  if (!verified) return null;
  // verifySession aplica o TTL de sessão (7d); o intermediário expira em 5min.
  if (nowSeconds - verified.issuedAt > TWOFA_TTL_SECONDS) return null;
  return verified.email;
}

export function twoFactorCookie(token: string, opts: { clear?: boolean } = {}): string {
  const maxAge = opts.clear ? 0 : TWOFA_TTL_SECONDS;
  return `${TWOFA_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/app; Max-Age=${maxAge}`;
}
