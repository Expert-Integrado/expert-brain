import type { Env } from '../env.js';

// Auth Bearer ADITIVA: aceita `Authorization: Bearer <token>` quando o token bate
// (comparação de tamanho-constante) com env.GRAPH_EXPORT_TOKEN. Mesmo token já
// usado pelas rotas /app/graph/* (Expert Console). Reusado pelas rotas de task
// (/app/tasks/*) pro lembrete da VPS ler/escrever via HTTP sem sessão de browser.
// Se o secret não estiver setado ou o header não bater, retorna false e o chamador
// cai no requireSession normal — comportamento de browser fica intacto.
export function authorizeBearer(req: Request, env: Env): boolean {
  const expected = env.GRAPH_EXPORT_TOKEN;
  if (!expected) return false;
  const header = req.headers.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const got = m[1].trim();
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
