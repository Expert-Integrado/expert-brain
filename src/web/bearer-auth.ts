import type { Env } from '../env.js';

// Escopo do bearer por ROTA (spec 10-backend/17). Antes GRAPH_EXPORT_TOKEN e
// TASK_REMINDER_TOKEN eram intercambiáveis em toda rota — o token do cron de
// lembrete conseguia deletar mídia. Agora cada rota declara seu escopo:
//  - 'graph'  → só GRAPH_EXPORT_TOKEN (Expert Console lê/escreve /app/graph/*)
//  - 'tasks'  → TASK_REMINDER_TOKEN OU GRAPH_EXPORT_TOKEN (o Console também opera tasks)
//  - 'media'  → só GRAPH_EXPORT_TOKEN (o token do cron NÃO pode mais tocar mídia)
export type BearerScope = 'graph' | 'tasks' | 'media';

async function sha256Bytes(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

// Comparação byte a byte em tempo constante de dois digests de 32 bytes. Como os
// dois lados são digests SHA-256 (tamanho FIXO), não há early-return por tamanho —
// o comprimento do input não vaza pelo timing. `expected` vazio/ausente → false.
async function digestMatches(got: string, expected?: string): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256Bytes(got), sha256Bytes(expected)]);
  // a.length === b.length === 32 sempre; loop de tamanho constante.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Auth Bearer ADITIVA e ESCOPADA POR ROTA: aceita `Authorization: Bearer <token>`
// só quando o token bate com o(s) segredo(s) permitido(s) NAQUELE escopo. Se nenhum
// segredo do escopo estiver setado ou o header não bater, retorna false e o chamador
// cai no requireSession normal — comportamento de browser fica intacto. A comparação
// é hash-then-compare em tempo constante (não vaza o tamanho do segredo).
export async function authorizeBearer(req: Request, env: Env, scope: BearerScope): Promise<boolean> {
  const header = req.headers.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const got = m[1].trim();
  // graph e media: só o GRAPH_EXPORT_TOKEN. tasks: também o TASK_REMINDER_TOKEN.
  if (await digestMatches(got, env.GRAPH_EXPORT_TOKEN)) return true;
  if (scope === 'tasks' && await digestMatches(got, env.TASK_REMINDER_TOKEN)) return true;
  return false;
}
