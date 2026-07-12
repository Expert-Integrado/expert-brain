import type { Env } from './env.js';
import { listUsers, lastSeenByUser } from './db/queries.js';
import { formatBrtShort } from './util/time.js';

// Watchdog da frota (specs/80-frota-agentes/89): detecta agente MUDO — dispositivo
// que batia de 30 em 30min e parou. Antes disto a frota falhava em silêncio (o cron
// do PC ficou 2h morto e o OpenClaw perdeu 2 ciclos em 11/07 sem ninguém notar).
//
// Zero config e zero falso-positivo pra agente esporádico (Alexa, notebook), usando
// só o last_used_at que api_keys já mantém:
// - STREAK em KV: a cada rodada (cron */30), agente com atividade recente soma 1.
//   streak >= 4 (2h de cadência provada) = MONITORADO. Uso esporádico nunca chega
//   a 4 seguidos → nunca alerta.
// - Monitorado em silêncio >= 2h → alerta (uma vez — flag `alerted`), streak zera.
// - Silêncio de 35min-2h = zona neutra: streak congela (beat perdido por /compact
//   do tmux não desarma nem dispara nada).
// - Voltou a bater depois de alertado → aviso de retorno + flag limpa. Re-arma só.
//
// Retorna as mensagens em vez de enviá-las — o glue do scheduled manda pro Telegram
// (testável sem secrets; sendTelegram já é no-op seguro sem eles).

export const WATCHDOG_CRON = '*/30 * * * *';

const ACTIVE_WINDOW_MS = 35 * 60_000; // atividade "desta rodada" (30min + folga)
const SILENT_MS = 2 * 3600_000;       // mudo além disto = incidente
const MONITOR_STREAK = 4;             // 4 rodadas seguidas = cadência provada

export interface WatchdogResult {
  checked: number;
  alerts: string[];
  recovered: string[];
}

export async function runFleetWatchdog(env: Env, nowMs: number): Promise<WatchdogResult> {
  const agents = (await listUsers(env, false)).filter((u) => u.type === 'agent');
  const seenBy = await lastSeenByUser(env);
  const alerts: string[] = [];
  const recovered: string[] = [];
  let checked = 0;

  for (const u of agents) {
    const seen = seenBy.get(u.id);
    if (seen === undefined) continue; // sem chave viva/uso — fora do radar
    checked++;
    const streakKey = `watchdog:${u.id}:streak`;
    const alertedKey = `watchdog:${u.id}:alerted`;
    const silence = nowMs - seen;

    if (silence <= ACTIVE_WINDOW_MS) {
      // Ativo nesta rodada: streak sobe; se estava em incidente, anuncia o retorno.
      const streak = parseInt((await env.GRAPH_CACHE.get(streakKey)) ?? '0', 10) || 0;
      await env.GRAPH_CACHE.put(streakKey, String(Math.min(streak + 1, 999)));
      if (await env.GRAPH_CACHE.get(alertedKey)) {
        await env.GRAPH_CACHE.delete(alertedKey);
        recovered.push(`✅ frota: ${u.name} voltou a bater (último beat ${formatBrtShort(seen)}).`);
      }
      continue;
    }

    if (silence >= SILENT_MS) {
      const streak = parseInt((await env.GRAPH_CACHE.get(streakKey)) ?? '0', 10) || 0;
      const alreadyAlerted = await env.GRAPH_CACHE.get(alertedKey);
      if (streak >= MONITOR_STREAK && !alreadyAlerted) {
        const hours = Math.floor(silence / 3600_000);
        alerts.push(
          `⚠️ frota: ${u.name} está MUDO há ${hours}h (último beat ${formatBrtShort(seen)}). ` +
          `Heartbeat esperado a cada 30min — verificar o dispositivo.`
        );
        await env.GRAPH_CACHE.put(alertedKey, String(nowMs));
        await env.GRAPH_CACHE.put(streakKey, '0');
      }
    }
    // Zona neutra (35min-2h): streak congelado, nada a fazer.
  }
  return { checked, alerts, recovered };
}
