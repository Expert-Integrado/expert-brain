import type { Env } from '../env.js';

// Comparação de string em tempo (quase) constante — não vaza o tamanho do segredo
// nem casa por timing. Retorna false se `expected` estiver vazio.
function tokenMatches(got: string, expected?: string): boolean {
  if (!expected) return false;
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Auth Bearer ADITIVA: aceita `Authorization: Bearer <token>` quando o token bate
// com env.GRAPH_EXPORT_TOKEN (Expert Console, rotas /app/graph/*) OU com
// env.TASK_REMINDER_TOKEN (cron de lembrete de tasks na VPS, rotas /app/tasks/*).
// Dois segredos independentes pra que rotacionar um não derrube o outro. Se nenhum
// estiver setado ou o header não bater, retorna false e o chamador cai no
// requireSession normal — comportamento de browser fica intacto.
export function authorizeBearer(req: Request, env: Env): boolean {
  const header = req.headers.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const got = m[1].trim();
  return tokenMatches(got, env.GRAPH_EXPORT_TOKEN) || tokenMatches(got, env.TASK_REMINDER_TOKEN);
}
