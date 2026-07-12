import type { Env } from './env.js';
import { listTasksDueBefore, type TaskRow } from './db/queries.js';
import { OWNER_TASK_VIS } from './auth/visibility.js';
import { formatBrtShort, relativeDue } from './util/time.js';
import { getResurfaceDigest, isDigestEmpty, type ResurfaceDigest } from './digest/resurface.js';

// Lembrete proativo de prazo (Fase 2). Hoje o due_at só "avisa" quando o Eric abre
// sessão (pull, via list_tasks_due_today no SessionStart). Aqui o Worker vira a fonte
// PUSH: um cron diário (scheduled) monta um digest das tasks que vencem hoje + as
// atrasadas e manda pro Telegram. Cadência diária = re-avisar atrasada todo dia é
// desejável (cutuca), então sem dedup, sem coluna nova, sem migration.

// Caps do digest (spec 30-features/32): a Bot API do Telegram rejeita sendMessage
// com text > 4096 chars (HTTP 400) — sem teto, justamente o dia com MAIS atrasadas
// era o dia em que NENHUM digest chegava. Defaults conservadores; os testes passam
// valores menores.
export interface DigestOptions {
  maxPerSection?: number; // linhas de task por seção
  maxChars?: number; // teto duro do texto final
  staleAfterMs?: number; // atrasada há mais que isto vira contagem agregada
}
const DIGEST_DEFAULTS = { maxPerSection: 15, maxChars: 4000, staleAfterMs: 14 * 86_400_000 };

// Monta o texto do digest. Função PURA (testável): recebe as tasks já filtradas
// (vencendo em <=24h ou vencidas) + o "agora", devolve o texto ou null se não há nada.
// Garantia dura: retorno sempre <= maxChars (cap por seção + truncagem defensiva).
export function buildDueDigest(tasks: TaskRow[], now: number, workerUrl?: string, opts?: DigestOptions): string | null {
  if (tasks.length === 0) return null;
  const { maxPerSection, maxChars, staleAfterMs } = { ...DIGEST_DEFAULTS, ...opts };
  const base = (workerUrl ?? '').replace(/\/$/, '');
  const overdue = tasks.filter((t) => t.due_at !== null && t.due_at < now);
  const today = tasks.filter((t) => t.due_at !== null && t.due_at >= now);
  // Snooze de atrasadas antigas: 14+ dias não viram linha (re-avisar todo dia é
  // ruído puro — alert fatigue), só contagem agregada com link pro board.
  const recent = overdue.filter((t) => now - (t.due_at as number) <= staleAfterMs);
  const oldCount = overdue.length - recent.length;
  const tasksUrl = base ? `${base}/app/tasks` : '/app/tasks';

  const line = (t: TaskRow): string => {
    const due = t.due_at !== null ? `${formatBrtShort(t.due_at)} · ${relativeDue(t.due_at, now)}` : '';
    const prio = t.priority !== null ? ` [P${t.priority}]` : '';
    const link = base ? `\n  ${base}/app/tasks/${t.id}` : '';
    return `• ${t.title}${prio} (${due})${link}`;
  };

  // Contadores de cabeçalho sempre refletem o TOTAL real, não as linhas exibidas.
  const render = (nRecent: number, nToday: number): string => {
    const parts: string[] = [`📋 Tasks pra hoje — ${tasks.length}`];
    if (overdue.length) {
      parts.push('', `⚠️ Atrasadas (${overdue.length}):`, ...recent.slice(0, nRecent).map(line));
      const hidden = recent.length - nRecent;
      if (hidden > 0) parts.push(`…e mais ${hidden} — ${tasksUrl}`);
      if (oldCount > 0) parts.push(`…e mais ${oldCount} atrasada(s) há 14+ dias — revisar em ${tasksUrl}`);
    }
    if (today.length) {
      parts.push('', `Vence hoje (${today.length}):`, ...today.slice(0, nToday).map(line));
      const hidden = today.length - nToday;
      if (hidden > 0) parts.push(`…e mais ${hidden} — ${tasksUrl}`);
    }
    return parts.join('\n');
  };

  let nRecent = Math.min(recent.length, maxPerSection);
  let nToday = Math.min(today.length, maxPerSection);
  let text = render(nRecent, nToday);
  // Truncagem defensiva: remove linhas do FIM (seção "Vence hoje" primeiro, depois
  // atrasadas), nunca corta no meio de linha; o rodapé "…e mais X" recalcula sozinho.
  while (text.length > maxChars && nRecent + nToday > 0) {
    if (nToday > 0) nToday--;
    else nRecent--;
    text = render(nRecent, nToday);
  }
  return text;
}

// Bloco "Do seu cérebro" (specs/50-console-v2/64-resurfacing-digest.md): anexado
// ao digest de tasks no MESMO cron/canal (nenhum cron novo). Função PURA — recebe
// o payload já computado (getResurfaceDigest) e devolve o texto, ou null quando o
// digest está vazio (nunca manda notificação vazia, critério 3 da spec).
export function buildResurfaceBlock(digest: ResurfaceDigest): string | null {
  if (isDigestEmpty(digest)) return null;
  const parts: string[] = ['🧠 Do seu cérebro'];

  if (digest.open_questions.length) {
    parts.push('', `Perguntas em aberto (${digest.open_questions.length}):`);
    for (const q of digest.open_questions) {
      parts.push(`• ${q.title} (há ${q.age_days}d sem resposta)`, `  ${q.url}`);
    }
  }
  if (digest.stale_central_notes.length) {
    parts.push('', 'Vale revisitar:');
    for (const n of digest.stale_central_notes) {
      parts.push(`• ${n.title} (${n.degree} conexões, ${n.age_days}d sem mexer)`, `  ${n.url}`);
    }
  }
  if (digest.cooling_contacts.length) {
    parts.push('', 'Contato esfriando:');
    for (const c of digest.cooling_contacts) {
      parts.push(`• ${c.name} (sem contato há ${c.days_since}d)`, `  ${c.url}`);
    }
  }
  if (digest.inbox_pending_over_7d) {
    parts.push('', `Inbox: ${digest.inbox_pending_over_7d} item(ns) parado(s) há mais de 7 dias`, `  ${digest.inbox_url}`);
  }
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
//
// spec 64: no MESMO envio, anexa o bloco "Do seu cérebro" (resurfacing) quando o
// digest computado/cacheado (getResurfaceDigest) tiver conteúdo — nenhum cron novo,
// nenhuma notificação extra. Falha do resurfacing (proxy CONTACTS fora do ar, D1
// transiente etc.) NUNCA derruba o lembrete de tasks: cai no catch e segue só com
// o bloco de tasks (ou nada, se também não houver tasks vencendo).
export async function runDueReminder(env: Env, now: number): Promise<{ sent: boolean; count: number; reason?: string }> {
  // OWNER_TASK_VIS (specs 59 + 91): o digest vai pro próprio dono (Telegram dele) —
  // inclui tasks privadas. É superfície do dono, não credencial de terceiro.
  const tasks = await listTasksDueBefore(env, now + 24 * 3600_000, OWNER_TASK_VIS);
  const dueText = buildDueDigest(tasks, now, env.WORKER_URL);

  let resurfaceText: string | null = null;
  try {
    const digest = await getResurfaceDigest(env, now);
    resurfaceText = buildResurfaceBlock(digest);
  } catch (e) {
    console.error('resurface digest failed (due-reminder segue sem o bloco)', e);
  }

  const combined = [dueText, resurfaceText].filter((t): t is string => Boolean(t)).join('\n\n');
  if (!combined) return { sent: false, count: tasks.length, reason: 'nada vencendo e nada pra resurfacing' };
  const r = await sendTelegram(env, combined);
  return { sent: r.sent, count: tasks.length, reason: r.reason };
}
