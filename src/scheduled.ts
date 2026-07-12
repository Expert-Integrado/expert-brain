import type { Env } from './env.js';
import { runDueReminder, sendTelegram } from './notify.js';
import { runSnapshot } from './backup/snapshot.js';
import { runTaskAutocancel } from './task-lifecycle.js';
import { REPASS_CRON, runSimilarRepass } from './graph/repass.js';
import { shouldSendHygieneDigest, buildHygieneDigest } from './digest/hygiene.js';
import { runPushDigest } from './web/push.js';
import { WATCHDOG_CRON, runFleetWatchdog } from './fleet-watchdog.js';

// Dispatch do cron por expressão (specs/50-console-v2/67-backup-export.md): o
// wrangler.toml agora tem DUAS entradas em [triggers].crons e o Worker decide
// pelo controller.cron. Vive fora de src/index.ts pra ser testável sem carregar
// o OAuth provider / Durable Object.
//
// Fail-safe deliberado: qualquer expressão desconhecida cai no fluxo diário
// original (digest de tasks) — mudar o horário do digest no toml sem tocar aqui
// não mata o lembrete; só a expressão EXATA do backup dispara o snapshot.
export const BACKUP_CRON = '0 5 * * 1'; // segunda 05:00 UTC = 02:00 BRT

// Contador de falhas consecutivas POR JOB de cron em KV (spec 70-grafo-higiene/76,
// evoluindo o antigo spec 40-ops/43 que só cobria o due-reminder): sem isso, o
// `console.error` do braço falho evapora e o dono só descobre que backup/re-pass/
// digest pararam quando sente falta deles. Sucesso zera; 2+ falhas seguidas de
// QUALQUER job alertam via Telegram (no-op seguro sem os secrets), com o nome do
// job na mensagem. Chaves por job: `cron:<job>:consecutive_failures` e
// `cron:<job>:last_error`. Compat: o job 'due-reminder' TAMBÉM escreve as chaves
// legadas sem sufixo (`cron:consecutive_failures`/`cron:last_error`) — o
// health-check externo já lê essas. O GET /status expõe os dois formatos (bloco
// `cron` legado + `cron_jobs` por job). Falha do PRÓPRIO alerting nunca propaga —
// um KV transiente não pode derrubar o cron.
const LEGACY_COMPAT_JOB = 'due-reminder';

export async function trackCronOutcome(env: Env, job: string, ok: boolean, message?: string): Promise<void> {
  try {
    const failKey = `cron:${job}:consecutive_failures`;
    const errKey = `cron:${job}:last_error`;
    const writeLegacy = job === LEGACY_COMPAT_JOB;
    if (ok) {
      await env.GRAPH_CACHE.put(failKey, '0');
      if (writeLegacy) await env.GRAPH_CACHE.put('cron:consecutive_failures', '0');
      return;
    }
    const prev = parseInt((await env.GRAPH_CACHE.get(failKey)) ?? '0', 10) || 0;
    const n = prev + 1;
    const errValue = JSON.stringify({ at: new Date().toISOString(), message: message ?? 'unknown' });
    await env.GRAPH_CACHE.put(failKey, String(n));
    await env.GRAPH_CACHE.put(errKey, errValue);
    if (writeLegacy) {
      await env.GRAPH_CACHE.put('cron:consecutive_failures', String(n));
      await env.GRAPH_CACHE.put('cron:last_error', errValue);
    }
    if (n >= 2) {
      await sendTelegram(env, `⚠️ expert-brain: cron '${job}' falhou ${n} vezes seguidas — ${message ?? 'sem detalhe'}`);
    }
  } catch (e) {
    console.error('cron alerting failed (ignorado, cron segue)', e);
  }
}

export function runScheduled(cron: string, env: Env, ctx: ExecutionContext): void {
  if (cron === BACKUP_CRON) {
    // Falha de snapshot loga e NÃO derruba o resto: runSnapshot já captura os
    // próprios erros (grava ok:false em meta.last_backup); o catch é cinto extra.
    // trackCronOutcome por job (spec 76): r.ok vindo do PRÓPRIO runSnapshot conta
    // como o resultado do job (ele já engoliu a exceção internamente); o catch
    // cobre o caso ainda mais raro de o próprio .then explodir.
    ctx.waitUntil(
      runSnapshot(env)
        .then(async (r) => {
          console.log(
            'backup',
            JSON.stringify({ ok: r.ok, date: r.date, total_rows: r.total_rows, bytes: r.bytes, error: r.error ?? null })
          );
          await trackCronOutcome(env, 'backup', r.ok, r.error);
        })
        .catch(async (e) => {
          console.error('backup failed', e);
          await trackCronOutcome(env, 'backup', false, String((e as Error)?.message ?? e));
        })
    );
    return;
  }
  // Watchdog da frota (spec 80-frota-agentes/89): braço EXATO obrigatório — se o
  // */30 caísse no fail-safe diário, o digest de tasks dispararia 48x/dia. Alertas
  // e retornos vão pro mesmo Telegram dos alertas de cron (no-op sem secrets).
  if (cron === WATCHDOG_CRON) {
    ctx.waitUntil(
      runFleetWatchdog(env, Date.now())
        .then(async (r) => {
          if (r.alerts.length || r.recovered.length) {
            console.log('fleet-watchdog', JSON.stringify({ checked: r.checked, alerts: r.alerts.length, recovered: r.recovered.length }));
          }
          for (const msg of [...r.alerts, ...r.recovered]) await sendTelegram(env, msg);
          await trackCronOutcome(env, 'fleet-watchdog', true);
        })
        .catch(async (e) => {
          console.error('fleet-watchdog failed', e);
          await trackCronOutcome(env, 'fleet-watchdog', false, String((e as Error)?.message ?? e));
        })
    );
    return;
  }
  // Re-pass das similar_edges (spec 70-grafo-higiene/72): braço próprio, ANTES
  // do fail-safe diário. Expressão tem que existir no toml no MESMO deploy.
  if (cron === REPASS_CRON) {
    ctx.waitUntil(
      runSimilarRepass(env, Date.now())
        .then(async (r) => {
          console.log('similar-repass', JSON.stringify(r));
          await trackCronOutcome(env, 'similar-repass', true);
        })
        .catch(async (e) => {
          console.error('similar-repass failed', e);
          await trackCronOutcome(env, 'similar-repass', false, String((e as Error)?.message ?? e));
        })
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
        .then(async (text) => {
          await sendTelegram(env, text);
          await trackCronOutcome(env, 'hygiene-digest', true);
        })
        .catch(async (e) => {
          console.error('hygiene-digest failed', e);
          await trackCronOutcome(env, 'hygiene-digest', false, String((e as Error)?.message ?? e));
        })
    );
  }
  // Web Push do lembrete diário (spec 68): empurra push pros dispositivos assinados
  // quando há pendência (task vencendo/atrasada ou inbox). Braço próprio — falha
  // aqui não derruba o digest do Telegram, e vice-versa. No-op sem VAPID/assinaturas.
  ctx.waitUntil(
    runPushDigest(env, Date.now())
      .then((r) => console.log('push-digest', JSON.stringify(r)))
      .catch((e) => console.error('push-digest failed', e))
  );
  ctx.waitUntil(
    runDueReminder(env, Date.now())
      .then(async (r) => {
        console.log('due-reminder', JSON.stringify(r));
        await trackCronOutcome(env, 'due-reminder', true);
      })
      .catch(async (e) => {
        console.error('due-reminder failed', e);
        await trackCronOutcome(env, 'due-reminder', false, String((e as Error)?.message ?? e));
      })
  );
}
