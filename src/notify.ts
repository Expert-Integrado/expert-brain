import type { Env } from './env.js';
import { listTasksDueBefore, type TaskRow } from './db/queries.js';
import { formatBrtShort, relativeDue } from './util/time.js';

// Lembrete proativo de prazo (Fase 2). Hoje o due_at só "avisa" quando o Eric abre
// sessão (pull, via list_tasks_due_today no SessionStart). Aqui o Worker vira a fonte
// PUSH: um cron diário (scheduled) monta um digest das tasks que vencem hoje + as
// atrasadas e manda pro Telegram. Cadência diária = re-avisar atrasada todo dia é
// desejável (cutuca), então sem dedup, sem coluna nova, sem migration.

// Monta o texto do digest. Função PURA (testável): recebe as tasks já filtradas
// (vencendo em <=24h ou vencidas) + o "agora", devolve o texto ou null se não há nada.
export function buildDueDigest(tasks: TaskRow[], now: number, workerUrl?: string): string | null {
  if (tasks.length === 0) return null;
  const base = (workerUrl ?? '').replace(/\/$/, '');
  const overdue = tasks.filter((t) => t.due_at !== null && t.due_at < now);
  const today = tasks.filter((t) => t.due_at !== null && t.due_at >= now);

  const line = (t: TaskRow): string => {
    const due = t.due_at !== null ? `${formatBrtShort(t.due_at)} · ${relativeDue(t.due_at, now)}` : '';
    const prio = t.priority !== null ? ` [P${t.priority}]` : '';
    const link = base ? `\n  ${base}/app/tasks/${t.id}` : '';
    return `• ${t.title}${prio} (${due})${link}`;
  };

  const parts: string[] = [`📋 Tasks pra hoje — ${tasks.length}`];
  if (overdue.length) parts.push('', `⚠️ Atrasadas (${overdue.length}):`, ...overdue.map(line));
  if (today.length) parts.push('', `Vence hoje (${today.length}):`, ...today.map(line));
  return parts.join('\n');
}

// Envia texto pro Telegram via Bot API. No-op seguro se faltar token/chat — o cron
// fica dormente até os secrets serem setados (wrangler secret put). Devolve o
// resultado pra logging.
export async function sendTelegram(env: Env, text: string): Promise<{ sent: boolean; reason?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return { sent: false, reason: 'telegram não configurado (TELEGRAM_BOT_TOKEN/CHAT_ID ausentes)' };
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!res.ok) return { sent: false, reason: `telegram http ${res.status}` };
  return { sent: true };
}

// Orquestra o lembrete: lista tasks vencendo em <=24h (inclui atrasadas), monta o
// digest e envia. Chamado pelo scheduled() do Worker. Idempotente por cadência
// (uma vez por dia), então rodar de novo não duplica nada além do esperado.
export async function runDueReminder(env: Env, now: number): Promise<{ sent: boolean; count: number; reason?: string }> {
  const tasks = await listTasksDueBefore(env, now + 24 * 3600_000);
  const digest = buildDueDigest(tasks, now, env.WORKER_URL);
  if (!digest) return { sent: false, count: 0, reason: 'nada vencendo' };
  const r = await sendTelegram(env, digest);
  return { sent: r.sent, count: tasks.length, reason: r.reason };
}
