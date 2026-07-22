// Rotas HTTP do Google Contacts sync (specs/google-contacts-sync.md).
//
// Auth (ver src/auth/tokens.ts):
//   GET  /google/status, /google/labels        → OWNER_TOKEN ou CONTACTS_PROXY_TOKEN
//   POST /google/connect-start|config|sync|disconnect → OWNER_TOKEN ou CONTACTS_WRITE_TOKEN
//   GET  /google/callback                       → PÚBLICA (browser do dono vindo do
//        Google; a autenticidade é o nonce `state` de uso único em KV, TTL 600s).

import type { Env } from "../env";
import { buildAuthUrl, exchangeCode, refreshAccessToken, resolveGoogleClient, scopeCanWrite, GOOGLE_SCOPE, GOOGLE_SCOPE_WRITE } from "./oauth";
import { listContactGroups } from "./people";
import { GSYNC_KV, runGoogleSync, type GsyncOauth, type GsyncConfig } from "./sync";
import { writeBackEnabled, GPUSH_KV } from "./push";

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...init?.headers },
  });
const err = (status: number, message: string) => json({ ok: false, error: message }, { status });

// Destino do browser depois do callback — o painel "Google Contatos" na config do
// Brain DESTA instalação. Nunca aceita valor do request (open-redirect); a ordem é
// env dedicado > PUBLIC_BRAIN_URL da instalação > default do repo canônico.
const REDIRECT_AFTER_DEFAULT = "https://expert-brain.contato-d9a.workers.dev/app/config";

function redirectAfter(env: Env, result: string): Response {
  const brainBase = env.PUBLIC_BRAIN_URL ? `${env.PUBLIC_BRAIN_URL.replace(/\/+$/, "")}/app/config` : "";
  const base = env.GSYNC_REDIRECT_AFTER || brainBase || REDIRECT_AFTER_DEFAULT;
  return Response.redirect(`${base}?google=${encodeURIComponent(result)}#google-contatos`, 302);
}

// Client ID nunca volta inteiro pro painel — o prefixo basta pra pessoa reconhecer
// qual credencial está ativa. O secret NUNCA aparece em resposta nenhuma.
function maskClientId(clientId: string): string {
  return clientId.length <= 12 ? clientId : `${clientId.slice(0, 12)}…`;
}

// Estado de conexão preso ao client que emitiu o grant: trocar/remover o client
// mata o refresh (invalid_client), então desconectamos proativamente. Os vínculos
// google_links FICAM — reconectar com a mesma conta reconcilia no full sync.
async function clearOauthState(env: Env): Promise<void> {
  await Promise.all([
    env.CACHE.delete(GSYNC_KV.oauth),
    env.CACHE.delete(GSYNC_KV.syncToken),
    env.CACHE.delete(GSYNC_KV.cursor),
    env.CACHE.delete(GSYNC_KV.alert),
  ]);
}

function callbackUri(req: Request): string {
  return `${new URL(req.url).origin}/google/callback`;
}

// GET /google/status — visão pro painel: configurado? (KV do painel ou env),
// conectado?, etiquetas configuradas, último run, falhas, alerta, nº de vínculos,
// e a callback_uri que o wizard exibe pra pessoa registrar no console do Google.
export async function handleGoogleStatus(req: Request, env: Env): Promise<Response> {
  const [client, oauthRaw, configRaw, lastRunRaw, failuresRaw, alertRaw, wbEnabled, pushFailuresRaw, lastPushRaw] = await Promise.all([
    resolveGoogleClient(env),
    env.CACHE.get(GSYNC_KV.oauth),
    env.CACHE.get(GSYNC_KV.config),
    env.CACHE.get(GSYNC_KV.lastRun),
    env.CACHE.get(GSYNC_KV.failures),
    env.CACHE.get(GSYNC_KV.alert),
    writeBackEnabled(env),
    env.CACHE.get(GPUSH_KV.failures),
    env.CACHE.get(GPUSH_KV.lastPush),
  ]);
  const parse = (raw: string | null) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
  const oauth = parse(oauthRaw) as GsyncOauth | null;
  const [linked, pending] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM google_links").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM google_push_queue").first<{ n: number }>(),
  ]);
  return json({
    ok: true,
    configured: !!client,
    mode: client?.mode ?? null,
    client_id: client ? maskClientId(client.client_id) : null,
    callback_uri: callbackUri(req),
    connected: !!oauth?.refresh_token,
    connected_at: oauth?.connected_at ?? null,
    groups: (parse(configRaw) as GsyncConfig | null)?.groups ?? [],
    last_run: parse(lastRunRaw),
    consecutive_failures: parseInt(failuresRaw ?? "0", 10) || 0,
    alert: parse(alertRaw),
    linked_count: linked?.n ?? 0,
    // Write-back vault→Google (seção write-back da spec): estado do toggle, se o
    // grant atual autoriza escrita, fila pendente e telemetria do último envio.
    write_back: { enabled: wbEnabled },
    can_write: scopeCanWrite(oauth?.scope),
    push_pending: pending?.n ?? 0,
    push_failures: parseInt(pushFailuresRaw ?? "0", 10) || 0,
    last_push: parse(lastPushRaw),
  });
}

// POST /google/client — credencial do OAuth client colada no painel do Brain
// (specs/google-contacts-sync.md, modo painel). Grava em KV gsync:client, com
// precedência sobre env. {clear:true} remove e volta pro env (se houver) ou pro
// estado não-configurado. Trocar de client desconecta (ver clearOauthState).
export async function handleGoogleClientPost(req: Request, env: Env): Promise<Response> {
  let body: { client_id?: unknown; client_secret?: unknown; clear?: unknown };
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  const current = await resolveGoogleClient(env);

  if (body.clear === true) {
    await env.CACHE.delete(GSYNC_KV.client);
    // Se a credencial ativa era a do painel, o grant foi emitido sob ela — sem o
    // client, o refresh morre em invalid_client. Desconecta proativamente.
    if (current?.mode === "panel") await clearOauthState(env);
    return json({ ok: true, cleared: true, disconnected: current?.mode === "panel" });
  }

  const clientId = typeof body.client_id === "string" ? body.client_id.trim() : "";
  const clientSecret = typeof body.client_secret === "string" ? body.client_secret.trim() : "";
  if (!clientId.endsWith(".apps.googleusercontent.com") || /\s/.test(clientId)) {
    return err(400, "client_id_invalid");
  }
  if (!clientSecret) return err(400, "client_secret_required");

  // Mesmo client_id re-salvo (ex.: secret regenerado) mantém o grant; client_id
  // DIFERENTE invalida o grant antigo → desconecta. google_links ficam.
  const changed = !!current && current.client_id !== clientId;
  await env.CACHE.put(GSYNC_KV.client, JSON.stringify({ client_id: clientId, client_secret: clientSecret }));
  if (changed) await clearOauthState(env);
  return json({ ok: true, mode: "panel", client_id: maskClientId(clientId), disconnected: changed });
}

// GET /google/labels — etiquetas (contactGroups) da conta conectada, pra UI de
// configuração escolher o que sincronizar.
export async function handleGoogleLabels(env: Env): Promise<Response> {
  const raw = await env.CACHE.get(GSYNC_KV.oauth);
  const oauth = raw ? (JSON.parse(raw) as GsyncOauth) : null;
  if (!oauth?.refresh_token) return err(409, "not_connected");
  const token = await refreshAccessToken(env, oauth.refresh_token);
  if (!token.ok) return err(502, token.error);
  const groups = await listContactGroups(token.access_token);
  if (!groups.ok) return err(502, groups.error);
  return json({ ok: true, labels: groups.groups });
}

// POST /google/connect-start — gera a URL de consentimento com nonce anti-CSRF de
// uso único (KV, TTL 600s). O client redireciona o browser do dono pra auth_url.
export async function handleGoogleConnectStart(req: Request, env: Env): Promise<Response> {
  const client = await resolveGoogleClient(env);
  if (!client) return err(503, "google_client_not_configured");
  const state = crypto.randomUUID();
  await env.CACHE.put(`${GSYNC_KV.statePrefix}${state}`, "1", { expirationTtl: 600 });
  // Escopo segue o toggle do write-back: ligado pede leitura+escrita (o botão
  // "Reautorizar" do painel dispara este MESMO endpoint), desligado segue readonly.
  const scope = (await writeBackEnabled(env)) ? GOOGLE_SCOPE_WRITE : GOOGLE_SCOPE;
  return json({ ok: true, auth_url: buildAuthUrl(client.client_id, callbackUri(req), state, scope) });
}

// GET /google/callback — PÚBLICA. Valida o nonce (get + delete = uso único),
// troca o code por refresh_token e leva o browser de volta pro Brain. Qualquer
// falha vira redirect com ?google=error:<reason> — nunca 500 na cara do dono.
export async function handleGoogleCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return redirectAfter(env, "error:missing_params");
  const stateKey = `${GSYNC_KV.statePrefix}${state}`;
  const known = await env.CACHE.get(stateKey);
  if (!known) return redirectAfter(env, "error:bad_state");
  await env.CACHE.delete(stateKey);
  const ex = await exchangeCode(env, code, callbackUri(req));
  if (!ex.ok) return redirectAfter(env, `error:${ex.error}`);
  const oauth: GsyncOauth = { refresh_token: ex.refresh_token, connected_at: new Date().toISOString(), scope: ex.scope };
  await env.CACHE.put(GSYNC_KV.oauth, JSON.stringify(oauth));
  // Conexão nova invalida estado de sync antigo (outra conta ou re-consentimento).
  await env.CACHE.delete(GSYNC_KV.syncToken);
  await env.CACHE.delete(GSYNC_KV.cursor);
  await env.CACHE.delete(GSYNC_KV.alert);
  return redirectAfter(env, "connected");
}

// POST /google/config {groups: string[]} — etiquetas a sincronizar. Vazio é
// válido (pausa o sync sem desconectar). Formato: "contactGroups/<id>".
export async function handleGoogleConfig(req: Request, env: Env): Promise<Response> {
  let body: { groups?: unknown };
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  if (!Array.isArray(body.groups)) return err(400, "groups must be an array");
  const groups = body.groups.filter((g): g is string => typeof g === "string" && g.startsWith("contactGroups/"));
  if (groups.length !== body.groups.length) return err(400, "groups must be contactGroups/<id> strings");
  await env.CACHE.put(GSYNC_KV.config, JSON.stringify({ groups } satisfies GsyncConfig));
  // Mudança de escopo = a seleção incremental antiga não representa mais o filtro;
  // força uma varredura FULL no próximo run pra aplicar o recorte novo inteiro.
  await env.CACHE.delete(GSYNC_KV.syncToken);
  await env.CACHE.delete(GSYNC_KV.cursor);
  return json({ ok: true, groups });
}

// POST /google/sync — dispara a engine (mesma do cron diário).
export async function handleGoogleSyncRun(env: Env): Promise<Response> {
  return json(await runGoogleSync(env));
}

// POST /google/write-back {enabled:boolean} — toggle do envio vault→Google.
// Desligar NÃO mexe no grant nem limpa a fila na hora (o drain re-checa o toggle
// e faz noop+dequeue) — religar não perde nada. O painel decide se precisa de
// reautorização comparando com o can_write do status.
export async function handleGoogleWriteBackPost(req: Request, env: Env): Promise<Response> {
  let body: { enabled?: unknown };
  try { body = await req.json(); } catch { return err(400, "invalid json"); }
  if (typeof body.enabled !== "boolean") return err(400, "enabled must be boolean");
  await env.CACHE.put(GSYNC_KV.writeBack, JSON.stringify({ enabled: body.enabled, updated_at: new Date().toISOString() }));
  return json({ ok: true, enabled: body.enabled });
}

// POST /google/disconnect — remove o grant + estado + vínculos. As ENTIDADES
// ficam (com tudo que o sync preencheu); só a ponte com o Google some. A credencial
// do client (gsync:client/env) permanece — desconectar não é desconfigurar.
// A fila de push morre junto: sem vínculo não há push, e fila zumbi suja o status.
export async function handleGoogleDisconnect(env: Env): Promise<Response> {
  await clearOauthState(env);
  await env.DB.prepare("DELETE FROM google_push_queue").run();
  const del = await env.DB.prepare("DELETE FROM google_links").run();
  return json({ ok: true, links_removed: del.meta?.changes ?? 0 });
}
