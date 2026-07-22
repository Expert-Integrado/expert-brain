// OAuth do Google Contacts (specs/google-contacts-sync.md) — fluxo web-server.
// Escopo READONLY de propósito: o sync é mão única Google→Contacts, este Worker
// NUNCA escreve no Google. O refresh token vive em KV (gsync:oauth), fora do D1 —
// o backup semanal D1→R2 não carrega credencial.
//
// O OAuth client (id+secret) tem DUAS fontes, resolvidas por resolveGoogleClient:
// 1. KV gsync:client — gravado pelo painel do Brain (POST /google/client), a rota
//    padrão de instalação self-hosted: a pessoa cria o client no console do Google
//    DELA e cola as credenciais na tela, sem terminal.
// 2. env GOOGLE_CLIENT_ID/SECRET (wrangler secret) — fallback pra instalações que
//    preferem credencial fora do KV. Painel salvo VENCE o env.
// Mesmo racional de segurança do refresh token: credencial em KV, fora do backup.

import type { Env } from "../env";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";
// Escopo FULL (leitura+escrita) — pedido no connect SÓ quando o write-back está
// ligado (specs/google-contacts-sync.md, seção write-back). Inclui a leitura:
// nunca pedir os dois juntos.
export const GOOGLE_SCOPE_WRITE = "https://www.googleapis.com/auth/contacts";
const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Chaves KV que vivem AQUI (e não no GSYNC_KV de sync.ts) pra não criar ciclo de
// import — sync.ts e push.ts importam deste módulo e re-expõem/consomem as chaves.
export const GSYNC_CLIENT_KV = "gsync:client";
export const GSYNC_OAUTH_KV = "gsync:oauth";
export const GSYNC_WRITEBACK_KV = "gsync:write_back";

// O grant atual autoriza escrita? Instalação antiga (GsyncOauth sem `scope`
// gravado) responde false — segue readonly até reautorizar pelo painel.
export function scopeCanWrite(scope: string | undefined | null): boolean {
  return !!scope && scope.split(/\s+/).includes(GOOGLE_SCOPE_WRITE);
}

export interface GoogleClientCreds {
  client_id: string;
  client_secret: string;
  mode: "panel" | "env";
}

// Resolve a credencial ativa: KV do painel primeiro, env como fallback, null se
// nada configurado (integração desligada — rotas respondem erro limpo).
export async function resolveGoogleClient(env: Env): Promise<GoogleClientCreds | null> {
  try {
    const raw = await env.CACHE.get(GSYNC_CLIENT_KV);
    if (raw) {
      const parsed = JSON.parse(raw) as { client_id?: string; client_secret?: string };
      if (parsed.client_id && parsed.client_secret) {
        return { client_id: parsed.client_id, client_secret: parsed.client_secret, mode: "panel" };
      }
    }
  } catch { /* JSON inválido no KV = trata como ausente e cai pro env */ }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, mode: "env" };
  }
  return null;
}

// URL de consentimento. access_type=offline + prompt=consent garantem que o
// callback SEMPRE recebe refresh_token (sem prompt=consent o Google omite o
// refresh em re-autorizações e o sync morre no primeiro expiry).
// `scope` é decidido pelo caller: readonly por padrão; full quando o write-back
// está ligado (reautorização pelo painel passa por este mesmo fluxo).
export function buildAuthUrl(clientId: string, redirectUri: string, state: string, scope: string = GOOGLE_SCOPE): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_BASE}?${q}`;
}

export type TokenExchange =
  | { ok: true; refresh_token: string; access_token: string; scope: string }
  | { ok: false; error: string };

// Troca o authorization code do callback por tokens. Erro vira valor (nunca throw):
// o callback redireciona o browser do dono com ?google=error&reason=..., não 500.
export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<TokenExchange> {
  const client = await resolveGoogleClient(env);
  if (!client) return { ok: false, error: "google_client_not_configured" };
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) return { ok: false, error: `token_exchange_${res.status}` };
  // `scope` do token response é a fonte AUTORITATIVA do que foi concedido (o query
  // do callback é só informativo) — o write-back usa pra saber se pode escrever.
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; scope?: string };
  if (!data.access_token) return { ok: false, error: "no_access_token" };
  if (!data.refresh_token) return { ok: false, error: "no_refresh_token" };
  return { ok: true, refresh_token: data.refresh_token, access_token: data.access_token, scope: data.scope ?? "" };
}

export type TokenRefresh =
  | { ok: true; access_token: string }
  | { ok: false; error: string; reconnect: boolean };

// Refresh token → access token de curta duração (por invocação de sync; nunca
// persistido). `reconnect: true` = o grant morreu (revogado/expirado no Google) e
// só reconectar resolve — o caller grava gsync:alert pro status/UI avisarem o dono.
export async function refreshAccessToken(env: Env, refreshToken: string): Promise<TokenRefresh> {
  const client = await resolveGoogleClient(env);
  if (!client) {
    return { ok: false, error: "google_client_not_configured", reconnect: false };
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    // 400 invalid_grant = revogado/expirado → precisa reconectar. Outros status
    // (5xx, rede) são transientes: o próximo cron tenta de novo.
    let reconnect = false;
    if (res.status === 400 || res.status === 401) {
      try {
        const body = (await res.json()) as { error?: string };
        reconnect = body.error === "invalid_grant" || res.status === 401;
      } catch { reconnect = res.status === 401; }
    }
    return { ok: false, error: `token_refresh_${res.status}`, reconnect };
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) return { ok: false, error: "no_access_token", reconnect: false };
  return { ok: true, access_token: data.access_token };
}
