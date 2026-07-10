import type { Env } from '../env.js';
import { DEDUP_MIN_SCORE, explicitPairKey } from '../web/similarity.js';

// Digest de higiene do grafo (specs/70-grafo-higiene/73): radar PASSIVO semanal
// do que degradou — órfãs novas, pares suspeitos, volume por conta, whys rasos.
// SQL puro, zero Vectorize/AI (mesma filosofia do resurface digest). Vai numa
// mensagem PRÓPRIA de Telegram na segunda-feira, junto do cron diário.
//
// Privacidade: o destino é o Telegram do DONO (mesmo canal do lembrete de
// tasks) — notas privadas ENTRAM por design; nenhuma superfície de credencial
// terceira é tocada.

export const HYGIENE_MAX_CHARS = 1200; // mensagem própria, folga ampla sob o teto de 4096

const WEEK_MS = 7 * 86_400_000;
const DAILY_CRON = '0 11 * * *';

// Gate puro e testável: só o cron DIÁRIO, e só quando o dia UTC é segunda.
// (As outras expressões — backup, re-pass — nunca disparam o digest.)
export function shouldSendHygieneDigest(cron: string, nowMs: number): boolean {
  return cron === DAILY_CRON && new Date(nowMs).getUTCDay() === 1;
}

export async function buildHygieneDigest(env: Env, nowMs: number): Promise<string> {
  const since = nowMs - WEEK_MS;
  const sections: string[] = [];

  // 1. Órfãs novas — conhecimento criado na janela com ZERO edges reais em
  // qualquer direção (similar_edges não conta: é automática, não é curadoria).
  const orphans = await env.DB.prepare(
    `SELECT n.title
     FROM notes n
     WHERE n.deleted_at IS NULL AND (n.kind IS NULL OR n.kind <> 'task')
       AND n.created_at >= ? AND n.created_at <= ?
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_id = n.id OR e.to_id = n.id)
     ORDER BY n.created_at DESC
     LIMIT 100`
  ).bind(since, nowMs).all<{ title: string }>();
  const orphanRows = orphans.results ?? [];
  if (orphanRows.length > 0) {
    const shown = orphanRows.slice(0, 5).map((o) => `- ${o.title}`).join('\n');
    const more = orphanRows.length > 5 ? `\n… e mais ${orphanRows.length - 5}` : '';
    sections.push(`Órfãs novas (${orphanRows.length} sem nenhum edge):\n${shown}${more}`);
  }

  // 2. Pares suspeitos — similar_edges >= banda de duplicata entre notas vivas
  // SEM edge real entre si. As edges existem nas duas direções (A→B e B→A);
  // dedupe simétrico em JS pela chave ordenada.
  const pairs = await env.DB.prepare(
    `SELECT s.from_id, s.to_id, s.score, a.title AS from_title, b.title AS to_title
     FROM similar_edges s
     JOIN notes a ON a.id = s.from_id AND a.deleted_at IS NULL
       AND (a.kind IS NULL OR a.kind <> 'task')
     JOIN notes b ON b.id = s.to_id AND b.deleted_at IS NULL
       AND (b.kind IS NULL OR b.kind <> 'task')
     WHERE s.score >= ?
       AND NOT EXISTS (
         SELECT 1 FROM edges e
         WHERE (e.from_id = s.from_id AND e.to_id = s.to_id)
            OR (e.from_id = s.to_id AND e.to_id = s.from_id)
       )
     ORDER BY s.score DESC
     LIMIT 40`
  ).bind(DEDUP_MIN_SCORE).all<{
    from_id: string; to_id: string; score: number; from_title: string; to_title: string;
  }>();
  const seenPair = new Set<string>();
  const uniquePairs: Array<{ score: number; from_title: string; to_title: string }> = [];
  for (const p of pairs.results ?? []) {
    const key = explicitPairKey(p.from_id, p.to_id);
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    uniquePairs.push(p);
    if (uniquePairs.length >= 5) break;
  }
  if (uniquePairs.length > 0) {
    const lines = uniquePairs
      .map((p) => `- "${p.from_title}" ~ "${p.to_title}" (${p.score.toFixed(2)})`)
      .join('\n');
    sections.push(`Possíveis duplicatas (score >= ${DEDUP_MIN_SCORE}, sem edge real):\n${lines}`);
  }

  // 3. Volume por conta — identifica quem está importando sem higiene.
  const volume = await env.DB.prepare(
    `SELECT COALESCE(created_by, 'sessão do dono') AS who, COUNT(*) AS n
     FROM notes
     WHERE deleted_at IS NULL AND (kind IS NULL OR kind <> 'task')
       AND created_at >= ? AND created_at <= ?
     GROUP BY COALESCE(created_by, 'sessão do dono')
     ORDER BY n DESC
     LIMIT 8`
  ).bind(since, nowMs).all<{ who: string; n: number }>();
  const volumeRows = volume.results ?? [];
  if (volumeRows.length > 0) {
    sections.push(
      `Notas novas por conta:\n` + volumeRows.map((v) => `- ${v.who}: ${v.n}`).join('\n')
    );
  }

  // 4. Whys preguiçosos — edges da semana com why < 30 chars (passaram na régua
  // de 20 do write path mas continuam rasos; a blocklist só pega os genéricos).
  const whys = await env.DB.prepare(
    `SELECT why FROM edges
     WHERE created_at >= ? AND created_at <= ? AND LENGTH(why) < 30
     ORDER BY created_at DESC
     LIMIT 20`
  ).bind(since, nowMs).all<{ why: string }>();
  const whyRows = whys.results ?? [];
  if (whyRows.length > 0) {
    const examples = whyRows.slice(0, 3).map((w) => `- "${w.why}"`).join('\n');
    sections.push(`Whys curtos da semana (${whyRows.length} com menos de 30 chars):\n${examples}`);
  }

  if (sections.length === 0) {
    return 'Higiene do grafo: semana limpa — sem órfãs novas, duplicatas suspeitas ou whys rasos.';
  }
  let text = `Higiene do grafo — últimos 7 dias\n\n${sections.join('\n\n')}`;
  if (text.length > HYGIENE_MAX_CHARS) {
    text = `${text.slice(0, HYGIENE_MAX_CHARS - 1)}…`;
  }
  return text;
}
