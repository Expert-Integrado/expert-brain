import type { Env } from './env.js';
import { runDueReminder, sendTelegram } from './notify.js';
import { runSnapshot } from './backup/snapshot.js';
import { runTaskAutocancel } from './task-lifecycle.js';
import { REPASS_CRON, runSimilarRepass } from './graph/repass.js';
import { shouldSendHygieneDigest, buildHygieneDigest } from './digest/hygiene.js';
import { runPushDigest } from './web/push.js';
import { WATCHDOG_CRON, runFleetWatchdog } from './fleet-watchdog.js';
import { hasContactsModule, contactsEnvFrom } from './contacts-gateway.js';
import { handleMaintenanceSync, trackMaintOutcome } from './contacts/index.js';
import { drainGooglePushQueue } from './contacts/google/push.js';
import { runGoogleSync, trackGsyncOutcome } from './contacts/google/sync.js';
import { runSnapshotRecorded } from './contacts/backup/snapshot.js';

// Dispatch do cron (specs/50-console-v2/67-backup-export.md, consolidado no spec
// 80-frota-agentes/89): o Worker decide pelo controller.cron. Vive fora de
// src/index.ts pra ser testável sem carregar o OAuth provider / Durable Object.
//
// CONSOLIDAÇÃO (spec 89, incidente 12/07/2026): o plano free do Cloudflare limita
// a CONTA a 5 cron triggers somando todos os Workers (erro 10072) — o 4º cron
// deste Worker estourou o teto. O wrangler.toml agora registra UM único trigger
// ("*/30 * * * *") e o braço do watchdog despacha os jobs de horário fixo por
// relógio UTC (todos caem em minuto :00, que o */30 cobre): backup segunda 05:00,
// re-pass 08:00, fluxo diário 11:00. Os braços por expressão exata continuam
// (compat com toml antigo + testes); expressão desconhecida segue caindo no
// fluxo diário original (fail-safe).
export const BACKUP_CRON = '0 5 * * 1'; // segunda 05:00 UTC = 02:00 BRT
const DAILY_CRON = '0 11 * * *'; // 08:00 BRT — digest de tasks + resurface + hygiene (segunda)

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

// Snapshot semanal de backup pro R2 (spec 67). Falha loga e NÃO derruba o resto:
// runSnapshot já captura os próprios erros (grava ok:false em meta.last_backup);
// o catch é cinto extra. trackCronOutcome por job (spec 76): r.ok vindo do PRÓPRIO
// runSnapshot conta como o resultado do job (ele já engoliu a exceção internamente);
// o catch cobre o caso ainda mais raro de o próprio .then explodir.
function dispatchBackup(env: Env, ctx: ExecutionContext): void {
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
}

// Watchdog da frota (spec 80-frota-agentes/89): agente que provou cadência e ficou
// mudo 2h+ alerta no Telegram — mesmo canal dos alertas de cron (no-op sem secrets).
function dispatchWatchdog(env: Env, ctx: ExecutionContext, nowMs: number): void {
  ctx.waitUntil(
    runFleetWatchdog(env, nowMs)
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
}

// Re-pass das similar_edges (spec 70-grafo-higiene/72).
function dispatchRepass(env: Env, ctx: ExecutionContext, nowMs: number): void {
  ctx.waitUntil(
    runSimilarRepass(env, nowMs)
      .then(async (r) => {
        console.log('similar-repass', JSON.stringify(r));
        await trackCronOutcome(env, 'similar-repass', true);
      })
      .catch(async (e) => {
        console.error('similar-repass failed', e);
        await trackCronOutcome(env, 'similar-repass', false, String((e as Error)?.message ?? e));
      })
  );
}

// Fluxo diário original: auto-cancel + hygiene digest (gate por cron/segunda) +
// web push + lembrete de tasks. `cron` decide o gate do hygiene digest.
function dispatchDaily(cron: string, env: Env, ctx: ExecutionContext, nowMs: number): void {
  // Auto-cancel opcional (spec 30-features/32 §4): no-op sem a env var. Braço
  // próprio de waitUntil — falha aqui não derruba o lembrete, e vice-versa.
  ctx.waitUntil(
    runTaskAutocancel(env, nowMs)
      .then((r) => console.log('task-autocancel', JSON.stringify(r)))
      .catch((e) => console.error('task-autocancel failed', e))
  );
  // Digest de higiene do grafo (spec 70-grafo-higiene/73): só segunda, mensagem
  // PRÓPRIA no Telegram (sendTelegram é no-op seguro sem os secrets). Braço
  // isolado — falha aqui não derruba o lembrete de tasks nem o resurface.
  if (shouldSendHygieneDigest(cron, nowMs)) {
    ctx.waitUntil(
      buildHygieneDigest(env, nowMs)
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
    runPushDigest(env, nowMs)
      .then((r) => console.log('push-digest', JSON.stringify(r)))
      .catch((e) => console.error('push-digest failed', e))
  );
  ctx.waitUntil(
    runDueReminder(env, nowMs)
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

// ── Fusão (F3, plano joyful-petting-alpaca): crons do antigo worker de contatos ──
// Braços do dispatcher consolidado (horários UTC idênticos aos [triggers] do
// worker antigo: diário 09:00, snapshot segunda 05:30 — o */30 cobre os dois).
// Só disparam com o módulo bound (hasContactsModule); em modo dual o worker
// antigo ainda roda os próprios crons, e instalação sem contatos = no-op.
// Dupla contabilidade DELIBERADA nas falhas: os contadores internos do contacts
// (maint:*/gsync:* no KV_CONTACTS, expostos em /contacts/health) continuam como
// no worker antigo, e o trackCronOutcome do Brain soma os jobs ao /status +
// alerta Telegram (2+ falhas seguidas) de graça.
function dispatchContactsDaily(env: Env, ctx: ExecutionContext): void {
  if (!hasContactsModule(env)) return;
  const cEnv = contactsEnvFrom(env);
  // Sem PIPEDRIVE_API_KEY a integração está DESLIGADA — o braço nem conta como
  // job (o {ok:false} de secret ausente viraria alerta diário eterno pra quem
  // não usa Pipedrive). Com o secret, r.ok decide: handleMaintenanceSync engole
  // as falhas tratadas (retorna ok:false) e o catch cobre exceção inesperada.
  if (cEnv.PIPEDRIVE_API_KEY) {
    ctx.waitUntil(
      handleMaintenanceSync(cEnv)
        .then(async (r) => {
          console.log('contacts-maint', JSON.stringify(r));
          const ok = r?.ok !== false;
          await trackCronOutcome(env, 'contacts-maint', ok, ok ? undefined : String(r?.error ?? 'maint failed'));
        })
        .catch(async (e) => {
          console.error('contacts-maint failed', e);
          await trackMaintOutcome(cEnv, false, String((e as Error)?.message ?? e));
          await trackCronOutcome(env, 'contacts-maint', false, String((e as Error)?.message ?? e));
        })
    );
  }
  // SEQUENCIAL de propósito (mesma ordem do worker antigo): o drain do write-back
  // roda ANTES do pull — edição pendente na fila suspende o "Google vence" dela
  // (anti-clobber), então drenar primeiro devolve o pull ao comportamento pleno
  // na mesma rodada. Independente do maint. Google desconectado/sem grupos =
  // { ok:true, skipped } — conta como sucesso (integração opcional, não falha).
  ctx.waitUntil(
    drainGooglePushQueue(cEnv)
      .then((r) => console.log('contacts-gpush', JSON.stringify(r)))
      .catch((e) => console.error('contacts-gpush failed', e))
      .then(() => runGoogleSync(cEnv))
      .then(async (r) => {
        console.log('contacts-gsync', JSON.stringify(r));
        const ok = r?.ok !== false;
        await trackCronOutcome(env, 'contacts-gsync', ok, ok ? undefined : String((r as any)?.error ?? 'gsync failed'));
      })
      .catch(async (e) => {
        console.error('contacts-gsync failed', e);
        await trackGsyncOutcome(cEnv, false, String((e as Error)?.message ?? e));
        await trackCronOutcome(env, 'contacts-gsync', false, String((e as Error)?.message ?? e));
      })
  );
}

function dispatchContactsSnapshot(env: Env, ctx: ExecutionContext): void {
  if (!hasContactsModule(env)) return;
  const cEnv = contactsEnvFrom(env);
  // runSnapshotRecorded já grava o desfecho no KV do contacts (backup:last);
  // r.ok vindo dele conta como o resultado do job pro Brain também.
  ctx.waitUntil(
    runSnapshotRecorded(cEnv)
      .then(async (r) => {
        console.log('contacts-backup', JSON.stringify(r));
        await trackCronOutcome(env, 'contacts-backup', r.ok, r.ok ? undefined : JSON.stringify(r));
      })
      .catch(async (e) => {
        console.error('contacts-backup failed', e);
        await trackCronOutcome(env, 'contacts-backup', false, String((e as Error)?.message ?? e));
      })
  );
}

export function runScheduled(cron: string, env: Env, ctx: ExecutionContext, nowMs: number = Date.now()): void {
  if (cron === BACKUP_CRON) {
    dispatchBackup(env, ctx);
    return;
  }
  // Trigger consolidado (spec 89): watchdog a cada firing + jobs de horário fixo
  // despachados por relógio UTC quando o firing cai no minuto :00 deles. Braço
  // EXATO obrigatório — se o */30 caísse no fail-safe diário, o digest de tasks
  // dispararia 48x/dia.
  if (cron === WATCHDOG_CRON) {
    dispatchWatchdog(env, ctx, nowMs);
    const d = new Date(nowMs);
    if (d.getUTCMinutes() === 0) {
      if (d.getUTCHours() === 5 && d.getUTCDay() === 1) dispatchBackup(env, ctx);
      if (d.getUTCHours() === 8) dispatchRepass(env, ctx, nowMs);
      // Fusão (F3): fluxo diário do módulo de contatos — 09:00 UTC, mesmo
      // horário do [triggers] do worker antigo. No-op sem o módulo bound.
      if (d.getUTCHours() === 9) dispatchContactsDaily(env, ctx);
      // Passa DAILY_CRON (não o */30) pro gate do hygiene digest enxergar o
      // fluxo diário legítimo — shouldSendHygieneDigest compara com a expressão.
      if (d.getUTCHours() === 11) dispatchDaily(DAILY_CRON, env, ctx, nowMs);
    }
    // Fusão (F3): snapshot semanal do contacts — segunda 05:30 UTC (firing :30
    // do */30, por isso fora do bloco de minuto :00 acima).
    if (d.getUTCMinutes() === 30 && d.getUTCHours() === 5 && d.getUTCDay() === 1) {
      dispatchContactsSnapshot(env, ctx);
    }
    return;
  }
  // Braço por expressão exata (compat com toml antigo), ANTES do fail-safe diário.
  if (cron === REPASS_CRON) {
    dispatchRepass(env, ctx, nowMs);
    return;
  }
  dispatchDaily(cron, env, ctx, nowMs);
}
