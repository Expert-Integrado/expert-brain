// GET /api/mailbox/summary (spec 80-frota-agentes/83) — heartbeat barato da frota.
// Endpoint HTTP mínimo pra pergunta binária "tem algo pra mim?": o cron dos containers
// da VPS e o hook SessionStart do PC batem aqui com o PAT do dispositivo; unread == 0
// sai em ms sem abrir sessão MCP. Identidade = credencial (getUserByApiKeyId, mesma
// resolução das specs 81/86); capacidade = escopo private da chave (task privada fica
// fora do summary pra chave sem o escopo, fail-closed). SEM side-effect: read_at é
// intocado — ack é ato explícito da instância depois de AGIR (ack_mailbox).

import type { Env } from '../env.js';
import { validateApiKey } from '../auth/api-keys.js';
import { presetForScopes } from '../auth/presets.js';
import { scopesSeePrivate, scopesAssignedOnly, type TaskVisibility } from '../auth/visibility.js';
import { getUserByApiKeyId, taskVisFilter } from '../db/queries.js';
import { countMailboxUnread } from '../db/mailbox.js';
import type { MailboxKind } from '../db/mailbox.js';
import { formatBrtDateTime } from '../util/time.js';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// Visibilidade de task da CREDENCIAL (spec 91) nas superfícies bearer do mailbox:
// mesmo predicado row-level das tools MCP (private + tasks:assigned). O user já foi
// resolvido pelo caller — sem vínculo esses endpoints respondem 403 antes de chegar aqui.
function keyTaskVis(scopes: string | undefined, userId: string): TaskVisibility {
  return {
    includePrivate: scopesSeePrivate(scopes, false),
    assignedOnlyUserId: scopesAssignedOnly(scopes) ? userId : null,
  };
}

// PAT do header Authorization validado → ValidatedApiKey, ou uma Response 401 pronta.
async function bearerPat(req: Request, env: Env): Promise<{ v: Awaited<ReturnType<typeof validateApiKey>> } | { err: Response }> {
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m || !m[1].trim().startsWith('eb_pat_')) {
    return { err: json({ error: 'Bearer PAT (eb_pat_...) required' }, 401) };
  }
  const v = await validateApiKey(env, m[1].trim());
  if (!v) return { err: json({ error: 'invalid or revoked API key' }, 401) };
  return { v };
}

// GET /api/whoami (spec 87) — "quem sou eu com ESTA credencial?". Um curl e a máquina
// confere a própria identidade antes de assinar qualquer coisa (o bug do PC assinando
// como Claude VPS teria morrido aqui). Chave sem dono → 200 com user null: é
// DIAGNÓSTICO ("sua chave está órfã, vincule em /app/config"), não erro de acesso.
export async function handleWhoami(req: Request, env: Env): Promise<Response> {
  const auth = await bearerPat(req, env);
  if ('err' in auth) return auth.err;
  const v = auth.v!;
  const key = await env.DB.prepare(`SELECT name, system FROM api_keys WHERE id = ?`)
    .bind(v.keyId).first<{ name: string; system: string | null }>();
  const user = await getUserByApiKeyId(env, v.keyId);
  // Papel da credencial (spec 91): reverse-map do CSV → preset. null = CSV fora dos
  // presets ("Personalizado" na UI) — o campo `scopes` cru continua sendo a verdade.
  const preset = presetForScopes(v.scopes);
  return json({
    key_name: key?.name ?? null,
    system: key?.system ?? null,
    scopes: v.scopes,
    preset: preset ? preset.id : null,
    user: user ? { id: user.id, name: user.name, type: user.type } : null,
    hint: user ? undefined : 'Chave sem usuário vinculado — o dono vincula em /app/config (Usuários). Sem vínculo, escritas não assinam e não há mailbox.',
  });
}

// Long-poll do wake (spec 80-frota-agentes/90) — fast-path de latência da frota.
// O dispositivo segura este GET aberto (~25s); nascendo item não-lido, a resposta
// sai em ≤WAIT_POLL_MS em vez de esperar a próxima batida do polling */30 (que
// continua como reconciliador). Long-poll em vez de webhook de propósito: o PC
// está atrás de NAT, a VPS não precisa abrir porta nem receber secret HMAC, e o
// PAT existente já autentica. SEM side-effect (read_at intocado, igual summary).
export const WAIT_POLL_MS = 3000;
export const WAIT_MAX_TIMEOUT_S = 25;

// Núcleo puro do loop, testável sem relógio real. O teto de iterações é dobrado
// de segurança: encerra mesmo se o clock congelar (Workers só avança Date.now()
// em I/O) e limita o número de subrequests D1 por request (cap de 50 do free tier).
export async function waitForUnread(
  check: () => Promise<number>,
  timeoutMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ unread: number; waitedMs: number }> {
  const start = Date.now();
  let unread = await check();
  const maxIters = Math.ceil(timeoutMs / Math.max(pollMs, 1)) + 1;
  for (let i = 0; unread === 0 && i < maxIters; i++) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) break;
    await sleep(Math.min(pollMs, timeoutMs - elapsed));
    unread = await check();
  }
  return { unread, waitedMs: Date.now() - start };
}

export async function handleMailboxWait(req: Request, env: Env): Promise<Response> {
  const auth = await bearerPat(req, env);
  if ('err' in auth) return auth.err;
  const v = auth.v!;

  const user = await getUserByApiKeyId(env, v.keyId);
  if (!user) {
    return json({
      error: 'This credential has no linked user profile, so it has no mailbox. ' +
        'The owner links this PAT to an agent user at /app/config (Usuários).',
    }, 403);
  }

  // ?timeout=<s> clampado 0–25; ausente = 25. timeout=0 vira check único imediato.
  const raw = new URL(req.url).searchParams.get('timeout');
  const timeoutS = raw === null ? WAIT_MAX_TIMEOUT_S : Math.min(Math.max(Number(raw) || 0, 0), WAIT_MAX_TIMEOUT_S);
  const vis = keyTaskVis(v.scopes, user.id);
  const { unread, waitedMs } = await waitForUnread(
    () => countMailboxUnread(env, user.id, vis),
    timeoutS * 1000,
    WAIT_POLL_MS,
  );
  return json({ user: { id: user.id, name: user.name }, wake: unread > 0, unread, waited_ms: waitedMs });
}

export async function handleMailboxSummary(req: Request, env: Env): Promise<Response> {
  const auth = await bearerPat(req, env);
  if ('err' in auth) return auth.err;
  const v = auth.v!;

  const user = await getUserByApiKeyId(env, v.keyId);
  if (!user) {
    return json({
      error: 'This credential has no linked user profile, so it has no mailbox. ' +
        'The owner links this PAT to an agent user at /app/config (Usuários).',
    }, 403);
  }

  // 1 query no índice idx_mailbox_unread: top 5 + total via window function (o
  // count(*) OVER () é computado ANTES do LIMIT — total de não-lidos, não 5).
  // taskVisFilter (spec 91): task privada sem escopo E task fora da visão assigned-only
  // ficam fora do summary — item órfão de desatribuição vazaria o título ao vivo.
  const f = taskVisFilter(keyTaskVis(v.scopes, user.id), 'n.');
  const r = await env.DB.prepare(
    `SELECT m.kind, m.task_id, m.created_at, n.title AS task_title, count(*) OVER () AS unread_total
     FROM mailbox_items m
     JOIN notes n ON n.id = m.task_id AND n.deleted_at IS NULL
     WHERE m.user_id = ? AND m.read_at IS NULL${f.sql}
     ORDER BY m.created_at ASC, m.id ASC
     LIMIT 5`
  ).bind(user.id, ...f.binds).all<{ kind: MailboxKind; task_id: string; created_at: number; task_title: string; unread_total: number }>();
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
