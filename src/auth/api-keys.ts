import type { Env } from '../env.js';

const PREFIX = 'eb_pat_';

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomId(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(12)));
}

function randomSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export interface ApiKeyRow {
  id: string;
  owner_email: string;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface CreateApiKeyResult {
  row: ApiKeyRow;
  plainKey: string;
}

export const MAX_ACTIVE_KEYS = 20;

export class ApiKeyLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`Limite de ${limit} chaves ativas atingido. Revogue uma antes de criar outra.`);
    this.name = 'ApiKeyLimitError';
  }
}

export async function createApiKey(
  env: Env,
  ownerEmail: string,
  name: string
): Promise<CreateApiKeyResult> {
  // Cap por owner pra evitar criação ilimitada via sessão comprometida.
  // revokeApiKey hoje faz DELETE, então count(*) bate com "ativas".
  const countRow = await env.DB.prepare(
    `SELECT count(*) c FROM api_keys WHERE owner_email = ? AND revoked_at IS NULL`
  ).bind(ownerEmail).first<{ c: number }>();
  if ((countRow?.c ?? 0) >= MAX_ACTIVE_KEYS) {
    throw new ApiKeyLimitError(MAX_ACTIVE_KEYS);
  }
  const id = randomId();
  const secret = randomSecret();
  const plainKey = `${PREFIX}${id}_${secret}`;
  const keyHash = await sha256Hex(plainKey);
  const now = Date.now();
  const prefix = plainKey.slice(0, PREFIX.length + 6);
  await env.DB.prepare(
    `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, ownerEmail, name, prefix, keyHash, now).run();
  return {
    row: { id, owner_email: ownerEmail, name, prefix, created_at: now, last_used_at: null, revoked_at: null },
    plainKey,
  };
}

export async function listApiKeys(env: Env, ownerEmail: string): Promise<ApiKeyRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, owner_email, name, prefix, created_at, last_used_at, revoked_at
     FROM api_keys WHERE owner_email = ? ORDER BY created_at DESC`
  ).bind(ownerEmail).all<ApiKeyRow>();
  return res.results ?? [];
}

export async function revokeApiKey(env: Env, ownerEmail: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `DELETE FROM api_keys WHERE id = ? AND owner_email = ?`
  ).bind(id, ownerEmail).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function validateApiKey(env: Env, plainKey: string): Promise<string | null> {
  if (!plainKey || !plainKey.startsWith(PREFIX)) return null;
  const keyHash = await sha256Hex(plainKey);
  const row = await env.DB.prepare(
    `SELECT owner_email, revoked_at FROM api_keys WHERE key_hash = ?`
  ).bind(keyHash).first<{ owner_email: string; revoked_at: number | null }>();
  if (!row) return null;
  if (row.revoked_at) return null;
  // Best-effort update of last_used_at; don't block if fails
  env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?`)
    .bind(Date.now(), keyHash).run().catch(() => {});
  return row.owner_email;
}
