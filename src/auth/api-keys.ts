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

// Escopo BASE de um PAT (spec 10-backend/17). 'full' = CRUD completo do vault (padrão,
// idêntico ao comportamento histórico de toda chave). 'read' = somente leitura: as
// tools de escrita nem são registradas no MCP dessa sessão.
export type ApiKeyScope = 'full' | 'read';

export const API_KEY_SCOPES: readonly ApiKeyScope[] = ['full', 'read'] as const;

export function isApiKeyScope(v: unknown): v is ApiKeyScope {
  return v === 'full' || v === 'read';
}

// scopes virou LISTA CSV (spec 30-features/31): o escopo base ('full'|'read') mais
// escopos aditivos, hoje só 'private' (acesso a notas privadas). Exemplos: 'full',
// 'read', 'full,private', 'read,private'. Nenhuma migração de dados: os valores
// existentes ('full'/'read') já são CSVs de 1 item. `hasScope` testa se um escopo
// específico está presente; ausente/vazio → trata como 'full' (comportamento
// histórico de OAuth e de chave sem escopo — nunca restringe por dado corrompido).
export function hasScope(scopes: string | undefined, scope: string): boolean {
  return (scopes ?? 'full').split(',').map((s) => s.trim()).includes(scope);
}

export interface ApiKeyRow {
  id: string;
  owner_email: string;
  name: string;
  prefix: string;
  scopes: string; // CSV — ver hasScope
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  // Dono da chave (spec 86 — 1:N: um usuário pode ter N chaves; a identidade de
  // assinatura resolve por aqui). NULL = chave legada sem dono (segue funcionando,
  // sem assinatura, via fallback users.api_key_id quando existir).
  user_id: string | null;
  // Sistema onde a chave vive (spec 87 — 'frota', 'hermes', 'openclaw'...): só
  // agrupamento na listagem do /app/config. NULL = sem sistema.
  system: string | null;
}

// Retorno de validateApiKey: quem é o dono, os escopos da chave (CSV) e o id dela (pra
// autoria de escrita created_by/updated_by). null quando a chave é inválida/revogada.
export interface ValidatedApiKey {
  email: string;
  scopes: string; // CSV — ver hasScope
  keyId: string;
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
  name: string,
  scopes: string = 'full', // CSV (spec 31): 'full' | 'read' | 'full,private' | 'read,private'
  userId: string | null = null, // dono da chave (spec 86) — o caller valida que o usuário existe/ativo
  system: string | null = null // sistema/dispositivo (spec 87) — só agrupamento visual
): Promise<CreateApiKeyResult> {
  // Cap por owner pra evitar criação ilimitada via sessão comprometida. revokeApiKey
  // faz UPDATE (revogação lógica), então o count precisa filtrar revoked_at IS NULL
  // pra contar só as ativas — o que ele já faz.
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
    `INSERT INTO api_keys (id, owner_email, name, prefix, key_hash, scopes, created_at, user_id, system) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, ownerEmail, name, prefix, keyHash, scopes, now, userId, system).run();
  return {
    row: { id, owner_email: ownerEmail, name, prefix, scopes, created_at: now, last_used_at: null, revoked_at: null, user_id: userId, system },
    plainKey,
  };
}

export async function listApiKeys(env: Env, ownerEmail: string): Promise<ApiKeyRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, owner_email, name, prefix, scopes, created_at, last_used_at, revoked_at, user_id, system
     FROM api_keys WHERE owner_email = ? ORDER BY created_at DESC`
  ).bind(ownerEmail).all<ApiKeyRow>();
  return res.results ?? [];
}

// Revogação LÓGICA (spec 17): UPDATE em vez de DELETE, pra a linha sobreviver como
// trilha de auditoria e o check `if (row.revoked_at)` em validateApiKey deixar de ser
// código morto. `AND revoked_at IS NULL` evita sobrescrever o timestamp de uma revoga
// duplicada. Retorna true se revogou de fato (linha ativa existia).
export async function revokeApiKey(env: Env, ownerEmail: string, id: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND owner_email = ? AND revoked_at IS NULL`
  ).bind(Date.now(), id, ownerEmail).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Vínculo tardio de dono em chave ÓRFÃ (adendo spec 87, 11/07/2026): a criação exige
// dono, mas as chaves emitidas antes da 0021 nasceram sem — e a listagem não tinha
// como corrigir. Orphan-only de propósito: re-apontar uma chave que JÁ assina como
// alguém trocaria a identidade de um agente vivo em silêncio; pra isso, revoga e cria.
export async function assignApiKeyUser(env: Env, ownerEmail: string, id: string, userId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE api_keys SET user_id = ? WHERE id = ? AND owner_email = ? AND revoked_at IS NULL AND user_id IS NULL`
  ).bind(userId, id, ownerEmail).run();
  return (res.meta?.changes ?? 0) > 0;
}

// Edição do `system` (agrupamento da listagem) de chave ATIVA — pedido 11/07.
// Diferente do dono (identidade, orphan-only acima), o sistema é só rótulo de
// organização: editável a qualquer momento; NULL volta pro grupo "Sem sistema".
export async function setApiKeySystem(env: Env, ownerEmail: string, id: string, system: string | null): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE api_keys SET system = ? WHERE id = ? AND owner_email = ? AND revoked_at IS NULL`
  ).bind(system, id, ownerEmail).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function validateApiKey(
  env: Env,
  plainKey: string,
  ctx?: ExecutionContext
): Promise<ValidatedApiKey | null> {
  if (!plainKey || !plainKey.startsWith(PREFIX)) return null;
  const keyHash = await sha256Hex(plainKey);
  const row = await env.DB.prepare(
    `SELECT id, owner_email, scopes, revoked_at FROM api_keys WHERE key_hash = ?`
  ).bind(keyHash).first<{ id: string; owner_email: string; scopes: string | null; revoked_at: number | null }>();
  if (!row) return null;
  if (row.revoked_at) return null;
  // last_used_at: fire-and-forget, mas via ctx.waitUntil quando disponível — sem ele,
  // o runtime do Workers pode cancelar a promise depois de enviar a resposta e o
  // "último uso" fica silenciosamente desatualizado. Fallback pro .catch() flutuante
  // quando não há ctx (ex.: chamadas de teste), pra não travar a validação.
  // Throttle (spec 87): máx 1 escrita por hora por chave — com o heartbeat da frota
  // a cada 30min, sem isto cada request viraria um UPDATE no D1 só pra granularidade
  // de "usada há Xh". Flag `pat_touch:<keyId>` no KV com TTL 1h: presente → pula a
  // escrita. O get/put é awaited (decide a escrita); KV indisponível → grava como antes
  // (o throttle é otimização, nunca pode derrubar a validação).
  let shouldTouch = true;
  try {
    const flagKey = `pat_touch:${row.id}`;
    if (await env.OAUTH_KV.get(flagKey)) shouldTouch = false;
    else await env.OAUTH_KV.put(flagKey, '1', { expirationTtl: 3600 });
  } catch { /* KV fora do ar → mantém o comportamento histórico (grava) */ }
  if (shouldTouch) {
    const touch = env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?`)
      .bind(Date.now(), keyHash).run();
    if (ctx) ctx.waitUntil(touch.then(() => undefined).catch(() => {}));
    else void touch.catch(() => {});
  }
  // scopes é um CSV (spec 31) — preservado NA ÍNTEGRA (ex.: 'read,private'). NÃO
  // reduzir a 'full'|'read' aqui: isso descartaria o escopo 'private'. Valor
  // null/vazio (legado/corrompido) cai em 'full' (comportamento histórico — nunca
  // restringe uma chave por dado ausente). O gate de escopo (registry) e a
  // visibilidade de nota privada (canSeePrivate) usam hasScope() sobre este CSV.
  const scopes: string = row.scopes && row.scopes.trim() ? row.scopes : 'full';
  return { email: row.owner_email, scopes, keyId: row.id };
}
