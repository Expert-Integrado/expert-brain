import type { Env } from './env.js';
import { runDueReminder } from './notify.js';
import { runSnapshot } from './backup/snapshot.js';

// Dispatch do cron por expressão (specs/50-console-v2/67-backup-export.md): o
// wrangler.toml agora tem DUAS entradas em [triggers].crons e o Worker decide
// pelo controller.cron. Vive fora de src/index.ts pra ser testável sem carregar
// o OAuth provider / Durable Object.
//
// Fail-safe deliberado: qualquer expressão desconhecida cai no fluxo diário
// original (digest de tasks) — mudar o horário do digest no toml sem tocar aqui
// não mata o lembrete; só a expressão EXATA do backup dispara o snapshot.
export const BACKUP_CRON = '0 5 * * 1'; // segunda 05:00 UTC = 02:00 BRT

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
  ctx.waitUntil(
    runDueReminder(env, Date.now())
      .then((r) => console.log('due-reminder', JSON.stringify(r)))
      .catch((e) => console.error('due-reminder failed', e))
  );
}
