import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { newId } from '../util/id.js';
import { listTasksDueBefore, countPendingInbox, countTasksAwaitingOwner } from '../db/queries.js';
import { OWNER_TASK_VIS } from '../auth/visibility.js';
import {
  upsertPushSubscription, deletePushSubscriptionByEndpoint,
  listPushSubscriptions, markPushSubscriptionOk,
} from '../db/push-queries.js';

// Web Push do console (specs/50-console-v2/68 — notificações nível 2).
//
// Desenho deliberadamente SEM payload: o envio é um POST vazio pro endpoint do push
// service com autenticação VAPID (JWT ES256 assinado via WebCrypto) — dispensa a
// criptografia de conteúdo do RFC 8291 inteira. O service worker, ao receber o push,
// busca /app/push/pending COM o cookie de sessão do dispositivo e monta a notificação
// com dados frescos (mais simples E mais atual que payload congelado no envio).
//
// Chave VAPID: UM secret só (VAPID_PRIVATE_KEY, JWK P-256 completo com d/x/y, setado
// via `wrangler secret put` — nunca impresso). A chave PÚBLICA (uncompressed point,
// base64url) é DERIVADA dos campos x/y do mesmo JWK — não existe segundo secret pra
// dessincronizar. Sem o secret, toda a superfície degrada pra no-op ({configured:false}).

const encoder = new TextEncoder();

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// ───────────────────────── base64url / chaves ─────────────────────────

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface VapidJwk { kty: string; crv: string; d?: string; x: string; y: string; }

function parseVapidJwk(env: Env): VapidJwk | null {
  if (!env.VAPID_PRIVATE_KEY) return null;
  try {
    const jwk = JSON.parse(env.VAPID_PRIVATE_KEY) as VapidJwk;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) return null;
    return jwk;
  } catch {
    return null;
  }
}

// Chave pública no formato que o PushManager.subscribe e o header `k=` esperam:
// ponto EC não-comprimido (0x04 || x || y), base64url.
export function vapidPublicKeyFromJwk(jwk: VapidJwk): string {
  const x = b64urlToBytes(jwk.x);
  const y = b64urlToBytes(jwk.y);
  const point = new Uint8Array(1 + x.length + y.length);
  point[0] = 0x04;
  point.set(x, 1);
  point.set(y, 1 + x.length);
  return bytesToB64url(point);
}

// ───────────────────────── VAPID JWT (RFC 8292) ─────────────────────────

// `aud` é a ORIGEM do push service (não do nosso Worker); `sub` é um contato do
// operador — usamos a URL pública do Worker (nenhum e-mail hardcoded).
async function vapidAuthHeader(env: Env, jwk: VapidJwk, endpoint: string, nowMs: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk as JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const aud = new URL(endpoint).origin;
  const sub = env.VAPID_SUBJECT || env.WORKER_URL || 'https://workers.dev';
  const header = bytesToB64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(encoder.encode(JSON.stringify({
    aud,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    sub,
  })));
  const signingInput = `${header}.${payload}`;
  // WebCrypto ECDSA devolve a assinatura RAW (r||s, 64 bytes) — exatamente o formato JWS.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput));
  const jwt = `${signingInput}.${bytesToB64url(new Uint8Array(sig))}`;
  return `vapid t=${jwt}, k=${vapidPublicKeyFromJwk(jwk)}`;
}

// ───────────────────────── envio ─────────────────────────

export interface PushSendResult { configured: boolean; sent: number; removed: number; failed: number; }

// POST vazio (sem payload) pra cada assinatura. 404/410 = endpoint expirou no push
// service → remove a linha. Falha de UMA assinatura nunca derruba as demais.
export async function sendPushToAll(env: Env, nowMs: number): Promise<PushSendResult> {
  const jwk = parseVapidJwk(env);
  if (!jwk) return { configured: false, sent: 0, removed: 0, failed: 0 };
  const subs = await listPushSubscriptions(env);
  let sent = 0, removed = 0, failed = 0;
  for (const s of subs) {
    try {
      const auth = await vapidAuthHeader(env, jwk, s.endpoint, nowMs);
      const res = await fetch(s.endpoint, {
        method: 'POST',
        headers: { Authorization: auth, TTL: '86400', Urgency: 'normal' },
      });
      if (res.status === 404 || res.status === 410) {
        await deletePushSubscriptionByEndpoint(env, s.endpoint);
        removed++;
      } else if (res.ok) {
        await markPushSubscriptionOk(env, s.id, nowMs);
        sent++;
      } else {
        console.warn('push: envio falhou', JSON.stringify({ status: res.status }));
        failed++;
      }
    } catch (err) {
      console.warn('push: envio falhou', err);
      failed++;
    }
  }
  return { configured: true, sent, removed, failed };
}

// Pendências do dono (o que a notificação anuncia): tasks atrasadas + vencendo em
// 24h + itens do inbox. Compartilhado entre o handler /app/push/pending (SW) e o
// gate do cron (só empurra push se há o que anunciar).
async function pendingSummary(env: Env, nowMs: number): Promise<{ overdue: number; today: number; inbox: number; blocked: number }> {
  const tasks = await listTasksDueBefore(env, nowMs + 24 * 3600_000, OWNER_TASK_VIS);
  const overdue = tasks.filter((t) => t.due_at !== null && t.due_at < nowMs).length;
  const today = tasks.length - overdue;
  const inbox = await countPendingInbox(env);
  // Fila "aguardando o dono" (spec 88): agente travou num [bloqueio] sem resposta.
  // O comment_task já empurra push na hora do bloqueio; aqui a contagem entra no
  // TEXTO da notificação e no gate do digest (bloqueio sozinho já justifica push).
  const blocked = await countTasksAwaitingOwner(env);
  return { overdue, today, inbox, blocked };
}

// Cron diário (scheduled.ts): empurra o push pros dispositivos SE houver pendência.
// Sem assinatura/sem chave/sem pendência = no-op silencioso (zero ruído).
export async function runPushDigest(env: Env, nowMs: number): Promise<PushSendResult & { skipped?: string }> {
  const jwk = parseVapidJwk(env);
  if (!jwk) return { configured: false, sent: 0, removed: 0, failed: 0, skipped: 'vapid não configurado' };
  const subs = await listPushSubscriptions(env);
  if (subs.length === 0) return { configured: true, sent: 0, removed: 0, failed: 0, skipped: 'sem assinaturas' };
  const p = await pendingSummary(env, nowMs);
  if (p.overdue + p.today + p.inbox + p.blocked === 0) {
    return { configured: true, sent: 0, removed: 0, failed: 0, skipped: 'nada pendente' };
  }
  return sendPushToAll(env, nowMs);
}

// ───────────────────────── handlers (sessão do dono) ─────────────────────────

// GET /app/push/vapid-key — chave pública pro PushManager.subscribe do client.
// { key: null } quando o secret não foi setado (a UI mostra "não configurado").
export async function handlePushVapidKeyGet(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return json({ error: 'unauthorized' }, 401);
  const jwk = parseVapidJwk(env);
  return json({ key: jwk ? vapidPublicKeyFromJwk(jwk) : null });
}

// POST /app/push/subscribe — grava a assinatura do dispositivo (JSON do
// PushSubscription.toJSON()). Upsert por endpoint.
export async function handlePushSubscribePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return json({ error: 'unauthorized' }, 401);
  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  const endpoint = String(body.endpoint ?? '').trim();
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1024) return json({ error: 'endpoint inválido' }, 400);
  await upsertPushSubscription(env, {
    id: newId(),
    endpoint,
    p256dh: body.keys?.p256dh ? String(body.keys.p256dh).slice(0, 256) : null,
    auth: body.keys?.auth ? String(body.keys.auth).slice(0, 256) : null,
    created_at: Date.now(),
  });
  return json({ ok: true });
}

// POST /app/push/unsubscribe — remove a assinatura do dispositivo.
export async function handlePushUnsubscribePost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return json({ error: 'unauthorized' }, 401);
  let body: { endpoint?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  const endpoint = String(body.endpoint ?? '').trim();
  if (!endpoint) return json({ error: 'endpoint obrigatório' }, 400);
  await deletePushSubscriptionByEndpoint(env, endpoint);
  return json({ ok: true });
}

// GET /app/push/pending — o service worker chama isto AO RECEBER um push (com o
// cookie de sessão do device) e monta a notificação com o texto retornado.
export async function handlePushPendingGet(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return json({ error: 'unauthorized' }, 401);
  const now = Date.now();
  const p = await pendingSummary(env, now);
  const parts: string[] = [];
  // Bloqueio primeiro: agente PARADO esperando decisão é a pendência mais cara.
  if (p.blocked) parts.push(`${p.blocked} aguardando decisão sua`);
  if (p.overdue) parts.push(`${p.overdue} task(s) atrasada(s)`);
  if (p.today) parts.push(`${p.today} vence(m) hoje`);
  if (p.inbox) parts.push(`${p.inbox} no inbox`);
  const badge = p.overdue + p.today + p.inbox + p.blocked;
  return json({
    title: 'Expert Brain',
    body: parts.length ? parts.join(' · ') : 'Tudo em dia.',
    badge_count: badge,
    url: p.blocked ? '/app/tasks' : p.inbox && !p.overdue && !p.today ? '/app/inbox' : '/app',
  });
}

// POST /app/push/test — botão "Enviar teste" da config: dispara um push real pra
// todas as assinaturas (a notificação em si nasce no SW via /app/push/pending).
export async function handlePushTestPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return json({ error: 'unauthorized' }, 401);
  const r = await sendPushToAll(env, Date.now());
  if (!r.configured) return json({ ok: false, error: 'push não configurado no servidor (VAPID_PRIVATE_KEY ausente)' }, 503);
  return json({ ok: true, ...r });
}
