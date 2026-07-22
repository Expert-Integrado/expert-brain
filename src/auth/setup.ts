import type { Env } from '../env.js';
import { runMigrations } from '../db/migrate.js';
import { provisionContacts } from '../contacts-gateway.js';
import { renderNotConfigured } from '../static/wizard.js';
import { refreshSimilarEdges, SIMILARITY_TOP_K, SIMILARITY_MIN_SCORE } from '../web/similarity.js';
import { isAuthorizedForSetup } from './setup-auth.js';

export function isSetup(env: Env): boolean {
  return Boolean(env.OWNER_EMAIL && env.OWNER_PASSWORD_HASH && env.SESSION_SECRET);
}

async function countKvPrefix(env: Env, prefix: string): Promise<number> {
  try {
    let cursor: string | undefined;
    let total = 0;
    // Paginate through up to ~1000 keys (single-user, should never get close)
    for (let i = 0; i < 10; i++) {
      const res = await env.OAUTH_KV.list({ prefix, cursor, limit: 1000 });
      total += res.keys.length;
      if (res.list_complete) break;
      cursor = res.cursor;
    }
    return total;
  } catch {
    return 0;
  }
}

export async function getVaultStatus(env: Env): Promise<{
  notes: number;
  edges: number;
  lastWrite: number | null;
  clients: number;
  tokens: number;
  connected: boolean;
}> {
  const [n, e, lw, clients, tokens] = await Promise.all([
    env.DB.prepare(`SELECT count(*) c FROM notes WHERE deleted_at IS NULL`).first<{ c: number }>(),
    env.DB.prepare(
      `SELECT count(*) c FROM edges e
       JOIN notes f ON f.id = e.from_id JOIN notes t ON t.id = e.to_id
       WHERE f.deleted_at IS NULL AND t.deleted_at IS NULL`
    ).first<{ c: number }>(),
    env.DB.prepare(`SELECT max(updated_at) m FROM notes WHERE deleted_at IS NULL`).first<{ m: number | null }>(),
    countKvPrefix(env, 'client:'),
    countKvPrefix(env, 'token:'),
  ]);
  return {
    notes: n?.c ?? 0,
    edges: e?.c ?? 0,
    lastWrite: lw?.m ?? null,
    clients,
    tokens,
    connected: tokens > 0,
  };
}

export async function handleRoot(_req: Request, env: Env): Promise<Response> {
  if (!isSetup(env)) {
    return new Response(renderNotConfigured(), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  // Root now funnels configured vaults into the dashboard login. The old
  // landing page (status + MCP URL + skill + personalization) moved to
  // /app/config, accessible only after login.
  return new Response(null, { status: 302, headers: { location: '/app/login' } });
}

// Jobs observados por trackCronOutcome (spec 70-grafo-higiene/76) — mesma lista
// dos braços wireados em src/scheduled.ts (task-autocancel fica de fora, é
// no-op opcional sem instrumentação). fleet-watchdog = spec 80-frota-agentes/89.
const CRON_JOBS = ['backup', 'similar-repass', 'hygiene-digest', 'due-reminder', 'fleet-watchdog'] as const;

interface CronJobStatus { consecutive_failures: number; last_error: string | null; }

export async function handleStatus(env: Env): Promise<Response> {
  if (!isSetup(env)) {
    return new Response(JSON.stringify({ configured: false }), {
      headers: { 'content-type': 'application/json' },
    });
  }
  const status = await getVaultStatus(env);
  // Bloco cron LEGADO (spec 40-ops/43): espelho do due-reminder, mantido pro
  // health-check externo que já lê estas chaves sem sufixo. Aditivo — nenhum
  // campo existente muda; falha de KV degrada pro default em vez de derrubar
  // o /status.
  let cron: CronJobStatus = { consecutive_failures: 0, last_error: null };
  try {
    const [cf, le] = await Promise.all([
      env.GRAPH_CACHE.get('cron:consecutive_failures'),
      env.GRAPH_CACHE.get('cron:last_error'),
    ]);
    cron = { consecutive_failures: parseInt(cf ?? '0', 10) || 0, last_error: le };
  } catch {
    // KV transiente: /status responde mesmo assim, com o default.
  }
  // Bloco cron_jobs (spec 76): um por job instrumentado, cada um com sua PRÓPRIA
  // chave `cron:<job>:*` (ver trackCronOutcome). Cada job degrada pro default
  // isoladamente — uma falha de KV lendo o job X não derruba os demais.
  const cronJobs: Record<string, CronJobStatus> = Object.fromEntries(
    await Promise.all(
      CRON_JOBS.map(async (job): Promise<[string, CronJobStatus]> => {
        try {
          const [cf, le] = await Promise.all([
            env.GRAPH_CACHE.get(`cron:${job}:consecutive_failures`),
            env.GRAPH_CACHE.get(`cron:${job}:last_error`),
          ]);
          return [job, { consecutive_failures: parseInt(cf ?? '0', 10) || 0, last_error: le }];
        } catch {
          return [job, { consecutive_failures: 0, last_error: null }];
        }
      })
    )
  );
  return new Response(JSON.stringify({ configured: true, ...status, cron, cron_jobs: cronJobs }), {
    headers: { 'content-type': 'application/json' },
  });
}

// Backfill das similar edges das notas que já existiam ANTES desta feature. Roda
// UM lote por chamada (cursor por id) pra caber no cap de subrequests do Cloudflare
// — o cliente chama em loop passando ?after=<cursor> até receber done:true.
// Idempotente: refreshSimilarEdges sobrescreve; re-rodar do zero é seguro.
// Budget por lote: 1 getByIds + N×(1 query Vectorize + 1 batch D1) = 1 + 2N. O limit
// é teto-clampeado em 20 → no MÁXIMO 41 subrequests, com folga sob os 50 do free tier.
// (Não relaxar o teto sem refazer essa conta: o bug original era justamente estouro
// do cap de subrequests.)
export async function handleBackfillSimilar(req: Request, env: Env): Promise<Response> {
  if (!isSetup(env)) {
    return new Response(JSON.stringify({ error: 'not configured' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  }
  // Gate (spec 10-backend/18): cada lote custa até 41 subrequests + writes reais
  // em similar_edges — sem auth, qualquer IP queimava a quota Vectorize/D1 do dono.
  if (!(await isAuthorizedForSetup(req, env))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }
  const url = new URL(req.url);
  const after = url.searchParams.get('after') ?? '';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 20);

  // Próximas notas vivas após o cursor, ordenadas por id (PK estável e resumível).
  const rows = await env.DB.prepare(
    `SELECT id FROM notes WHERE deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?`
  ).bind(after, limit).all<{ id: string }>();
  const ids = (rows.results ?? []).map((r) => r.id);
  if (ids.length === 0) {
    return new Response(JSON.stringify({ done: true, processed: 0, cursor: after }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // Busca os vetores já indexados (getByIds tem cap de 20 ids/call).
  const vecById = new Map<string, number[]>();
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const vs = await env.VECTORIZE.getByIds(chunk);
    for (const v of vs) if (v.values) vecById.set(v.id, Array.from(v.values));
  }

  let processed = 0, edges = 0, missing = 0, failed = 0;
  for (const id of ids) {
    const vec = vecById.get(id);
    if (!vec) { missing++; continue; } // vetor ainda não indexado — próxima passada pega
    // try/catch CRÍTICO: se refreshSimilarEdges lançar (ex: um vizinho retornado pelo
    // Vectorize aponta pra uma nota hard-deletada do D1 — vetor órfão no índice — o
    // INSERT viola a FK e o batch aborta), NÃO deixamos o handler dar 500. Sem isso, o
    // cursor novo nunca seria emitido, o cliente repetiria o mesmo ?after e o backfill
    // TRAVARIA pra sempre. Aqui a nota problemática é só contada e pulada; o sweep segue.
    try {
      edges += await refreshSimilarEdges(env, id, vec, { topK: SIMILARITY_TOP_K, minScore: SIMILARITY_MIN_SCORE });
      processed++;
    } catch (err) {
      failed++;
      console.error('backfill: refreshSimilarEdges failed for', id, err);
    }
  }

  return new Response(JSON.stringify({
    done: false, processed, edges, missing, failed, cursor: ids[ids.length - 1],
  }), { headers: { 'content-type': 'application/json' } });
}

export async function handleProvision(req: Request, env: Env): Promise<Response> {
  // Gate (spec 10-backend/18): vault NÃO configurado → aberto (bootstrap de
  // instalação nova — o aluno ainda não tem secrets e não há nada de valor no
  // banco). Vault configurado → exige Bearer (SETUP_TOKEN/GRAPH_EXPORT_TOKEN/
  // TASK_REMINDER_TOKEN) ou sessão do dono; o wizard e o scripts/deploy.mjs
  // enviam o header.
  if (isSetup(env) && !(await isAuthorizedForSetup(req, env))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  // SEMPRE roda as migrations. Elas são idempotentes — runMigrations registra
  // cada uma em _migrations e pula as já aplicadas, então rodar de novo é no-op.
  // Isto é CRÍTICO pro caminho de ATUALIZAÇÃO: uma instalação já existente que
  // sobe uma versão nova aplica as migrations novas (ex: 0004 soft-delete) por
  // aqui. O gate anterior ("Already provisioned" 409 quando _migrations tinha
  // linhas) pulava as migrations num update e quebrava o código novo (coluna
  // deleted_at inexistente). Re-rodar é inofensivo (no máximo alguns SELECTs em
  // _migrations).
  await runMigrations(env);
  // Fusão (F2): com o módulo de contatos bound, o MESMO provision aplica também
  // o schema do vault de contatos — cada runner na sua tabela _migrations, em
  // D1s separados. Sem o módulo, no-op.
  await provisionContacts(env);
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
}
