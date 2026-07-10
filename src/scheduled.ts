import type { Env } from './env.js';
import { runDueReminder, sendTelegram } from './notify.js';
import { runSnapshot } from './backup/snapshot.js';
import { runTaskAutocancel } from './task-lifecycle.js';
import { REPASS_CRON, runSimilarRepass } from './graph/repass.js';
import { shouldSendHygieneDigest, buildHygieneDigest } from './digest/hygiene.js';

// Dispatch do cron por expressão (specs/50-console-v2/67-backup-export.md): o
// wrangler.toml agora tem DUAS entradas em [triggers].crons e o Worker decide
// pelo controller.cron. Vive fora de src/index.ts pra ser testável sem carregar
// o OAuth provider / Durable Object.
//
// Fail-safe deliberado: qualquer expressão desconhecida cai no fluxo diário
// original (digest de tasks) — mudar o horário do digest no toml sem tocar aqui
// não mata o lembrete; só a expressão EXATA do backup dispara o snapshot.
export const BACKUP_CRON = '0 5 * * 1'; // segunda 05:00 UTC = 02:00 BRT

// Contador de falhas consecutivas do cron diário em KV (spec 40-ops/43): sem
// isso, o `console.error` do scheduled evapora e o dono só descobre que o
// digest parou quando sente falta dele. Sucesso zera; 2+ falhas seguidas
// alertam via Telegram (no-op seguro sem os secrets). O GET /status expõe os
// mesmos valores pro health-check externo. Falha do PRÓPRIO alerting nunca
// propaga — um KV transiente não pode derrubar o cron.
export async function trackCronOutcome(env: Env, ok: boolean, message?: string): Promise<void> {
  try {
    if (ok) {
      await env.GRAPH_CACHE.put('cron:consecutive_failures', '0');
      return;
    }
    const prev = parseInt((await env.GRAPH_CACHE.get('cron:consecutive_failures')) ?? '0', 10) || 0;
    const n = prev + 1;
    await env.GRAPH_CACHE.put('cron:consecutive_failures', String(n));
    await env.GRAPH_CACHE.put(
      'cron:last_error',
      JSON.stringify({ at: new Date().toISOString(), message: message ?? 'unknown' })
    );
    if (n >= 2) {
      await sendTelegram(env, `⚠️ expert-brain: cron do digest falhou ${n} vezes seguidas — ${message ?? 'sem detalhe'}`);
    }
  } catch (e) {
    console.error('cron alerting failed (ignorado, cron segue)', e);
  }
}

export function runScheduled(cron: string, env: Env, ctx: ExecutionContext): void {
  if (cron === BACKUP_CRON) {
    // Falha de snapshot loga e NÃO derruba o resto: runSnapshot já captura os
    // próprios erros (grava ok:false em meta.last_backup); o catch é cinto extra.
    ctx.waitUntil(
      runSnapshot(env)
        .then((r) =>
          console.log(
            'backup',
            JSON.stringify({ ok: r.ok, date: r.date, total_rows: r.total_rows, bytes: r.bytes, error: r.error ?? null })
          )
        )
        .catch((e) => console.error('backup failed', e))
    );
    return;
  }
  // Re-pass das similar_edges (spec 70-grafo-higiene/72): braço próprio, ANTES
  // do fail-safe diário. Expressão tem que existir no toml no MESMO deploy.
  if (cron === REPASS_CRON) {
    ctx.waitUntil(
      runSimilarRepass(env, Date.now())
        .then((r) => console.log('similar-repass', JSON.stringify(r)))
        .catch((e) => console.error('similar-repass failed', e))
    );
    return;
  }
  // Auto-cancel opcional (spec 30-features/32 §4): no-op sem a env var. Braço
  // próprio de waitUntil — falha aqui não derruba o lembrete, e vice-versa.
  ctx.waitUntil(
    runTaskAutocancel(env, Date.now())
      .then((r) => console.log('task-autocancel', JSON.stringify(r)))
      .catch((e) => console.error('task-autocancel failed', e))
  );
  // Digest de higiene do grafo (spec 70-grafo-higiene/73): só segunda, mensagem
  // PRÓPRIA no Telegram (sendTelegram é no-op seguro sem os secrets). Braço
  // isolado — falha aqui não derruba o lembrete de tasks nem o resurface.
  if (shouldSendHygieneDigest(cron, Date.now())) {
    ctx.waitUntil(
      buildHygieneDigest(env, Date.now())
        .then((text) => sendTelegram(env, text))
        .catch((e) => console.error('hygiene-digest failed', e))
    );
  }
  ctx.waitUntil(
    runDueReminder(env, Date.now())
      .then(async (r) => {
        console.log('due-reminder', JSON.stringify(r));
        await trackCronOutcome(env, true);
      })
      .catch(async (e) => {
        console.error('due-reminder failed', e);
        await trackCronOutcome(env, false, String((e as Error)?.message ?? e));
      })
  );
}
