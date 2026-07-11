import type { Env } from '../env.js';

// Assinaturas Web Push (migration 0026, specs/50-console-v2/68). Uma linha por
// dispositivo/browser do dono; `endpoint` (URL única do push service) é UNIQUE —
// re-assinar o mesmo device atualiza a linha em vez de duplicar.

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
  created_at: number;
  last_ok_at: number | null;
}

export async function upsertPushSubscription(
  env: Env,
  s: { id: string; endpoint: string; p256dh: string | null; auth: string | null; created_at: number }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).bind(s.id, s.endpoint, s.p256dh, s.auth, s.created_at).run();
}

export async function deletePushSubscriptionByEndpoint(env: Env, endpoint: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).bind(endpoint).run();
}

export async function listPushSubscriptions(env: Env): Promise<PushSubscriptionRow[]> {
  const r = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth, created_at, last_ok_at FROM push_subscriptions ORDER BY created_at ASC`
  ).all<PushSubscriptionRow>();
  return r.results ?? [];
}

export async function markPushSubscriptionOk(env: Env, id: string, at: number): Promise<void> {
  await env.DB.prepare(`UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?`).bind(at, id).run();
}
