// Senha do dono com override gravável + código de recuperação
// (spec 100-seguranca-conta/103). O Worker não troca o próprio secret em
// runtime, então a senha EFETIVA é meta.owner_password_hash com fallback pro
// env OWNER_PASSWORD_HASH (bootstrap de instância nova). Rollback de
// emergência: apagar a linha da meta volta pro secret.

import type { Env } from '../env.js';
import { hashPassword, verifyPassword } from './password.js';

const KEY_PASSWORD = 'owner_password_hash';
const KEY_RECOVERY = 'recovery_code_hash';
const KEY_RECOVERY_AT = 'recovery_code_created_at';

export const PASSWORD_MIN_LEN = 10;

// Mesmo alfabeto sem ambíguos dos backup codes (I/L/O/0/1 fora) — o código
// vai ser lido de papel/1Password e digitado sob stress.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

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

/** Verifica a senha do dono contra o hash efetivo (meta > env). */
export async function verifyOwnerPassword(env: Env, plain: string): Promise<boolean> {
  const stored = (await metaGet(env, KEY_PASSWORD)) ?? env.OWNER_PASSWORD_HASH;
  if (!stored) return false;
  return verifyPassword(plain, stored);
}

/** Grava a senha nova na meta — dali em diante ela manda sobre o secret. */
export async function setOwnerPassword(env: Env, plain: string): Promise<void> {
  await metaSet(env, KEY_PASSWORD, await hashPassword(plain));
}

/** Validação única de senha nova (recover e trocar-senha usam a mesma régua). */
export function passwordPolicyError(password: string, confirm: string): string | null {
  if (password.length < PASSWORD_MIN_LEN) {
    return `A senha nova precisa de pelo menos ${PASSWORD_MIN_LEN} caracteres — uma frase curta funciona bem.`;
  }
  if (password !== confirm) return 'A confirmação não bate com a senha nova.';
  return null;
}

function formatRecoveryCode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

function canonicalRecoveryCode(input: string): string | null {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (stripped.length !== 12) return null;
  return `${stripped.slice(0, 4)}-${stripped.slice(4, 8)}-${stripped.slice(8)}`;
}

/**
 * Gera (ou REGENERA, invalidando o anterior) o código de recuperação.
 * Plaintext retorna UMA vez — só o hash PBKDF2 persiste.
 */
export async function generateRecoveryCode(env: Env, nowMs: number): Promise<string> {
  const code = formatRecoveryCode(crypto.getRandomValues(new Uint8Array(12)));
  await metaSet(env, KEY_RECOVERY, await hashPassword(code));
  await metaSet(env, KEY_RECOVERY_AT, String(Math.floor(nowMs / 1000)));
  return code;
}

/** Confere o código SEM consumir — o consumo só acontece após a troca dar certo. */
export async function verifyRecoveryCode(env: Env, code: string): Promise<boolean> {
  const canonical = canonicalRecoveryCode(code);
  if (!canonical) return false;
  const stored = await metaGet(env, KEY_RECOVERY);
  if (!stored) return false;
  return verifyPassword(canonical, stored);
}

export async function consumeRecoveryCode(env: Env): Promise<void> {
  await metaDel(env, KEY_RECOVERY);
  await metaDel(env, KEY_RECOVERY_AT);
}

/** Estado pro card da config: null = nenhum código ativo. */
export async function recoveryCodeInfo(env: Env): Promise<{ createdAt: number | null } | null> {
  const stored = await metaGet(env, KEY_RECOVERY);
  if (!stored) return null;
  const raw = await metaGet(env, KEY_RECOVERY_AT);
  const n = raw === null ? NaN : Number(raw);
  return { createdAt: Number.isFinite(n) ? n : null };
}
