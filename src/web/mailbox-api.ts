// GET /api/mailbox/summary (spec 80-frota-agentes/83) — heartbeat barato da frota.
// Endpoint HTTP mínimo pra pergunta binária "tem algo pra mim?": o cron dos containers
// da VPS e o hook SessionStart do PC batem aqui com o PAT do dispositivo; unread == 0
// sai em ms sem abrir sessão MCP. Identidade = credencial (getUserByApiKeyId, mesma
// resolução das specs 81/86); capacidade = escopo private da chave (task privada fica
// fora do summary pra chave sem o escopo, fail-closed). SEM side-effect: read_at é
// intocado — ack é ato explícito da instância depois de AGIR (ack_mailbox).

import type { Env } from '../env.js';
import { validateApiKey, hasScope } from '../auth/api-keys.js';
import { getUserByApiKeyId } from '../db/queries.js';
import type { MailboxKind } from '../db/mailbox.js';
import { formatBrtDateTime } from '../util/time.js';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function handleMailboxSummary(req: Request, env: Env): Promise<Response> {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m || !m[1].trim().startsWith('eb_pat_')) {
    return json({ error: 'Bearer PAT (eb_pat_...) required' }, 401);
  }
  const v = await validateApiKey(env, m[1].trim());
  if (!v) return json({ error: 'invalid or revoked API key' }, 401);

  const user = await getUserByApiKeyId(env, v.keyId);
  if (!user) {
    return json({
      error: 'This credential has no linked user profile, so it has no mailbox. ' +
        'The owner links this PAT to an agent user at /app/config (Usuários).',
    }, 403);
  }

  // 1 query no índice idx_mailbox_unread: top 5 + total via window function (o
  // count(*) OVER () é computado ANTES do LIMIT — total de não-lidos, não 5).
  const priv = hasScope(v.scopes, 'private') ? '' : ' AND n.private = 0';
  const r = await env.DB.prepare(
    `SELECT m.kind, m.task_id, m.created_at, n.title AS task_title, count(*) OVER () AS unread_total
     FROM mailbox_items m
     JOIN notes n ON n.id = m.task_id AND n.deleted_at IS NULL
     WHERE m.user_id = ? AND m.read_at IS NULL${priv}
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT 5`
  ).bind(user.id).all<{ kind: MailboxKind; task_id: string; created_at: number; task_title: string; unread_total: number }>();
  const rows = r.results ?? [];
  const base = (env.WORKER_URL ?? '').replace(/\/$/, '');

  return json({
    user: { id: user.id, name: user.name },
    unread: rows[0]?.unread_total ?? 0,
    oldest_brt: rows.length > 0 ? formatBrtDateTime(rows[0].created_at) : null,
    top: rows.map((row) => ({
      kind: row.kind,
      task_title: row.task_title,
      task_url: `${base}/app/notes/${row.task_id}`,
      created_brt: formatBrtDateTime(row.created_at),
    })),
  });
}
