import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { ftsSearch } from '../db/queries.js';

// GET /app/search?q=... — busca full-text (FTS5) em titulo + resumo (tldr) +
// corpo da nota, com matching por prefixo (qualquer pedaco digitado casa). Os
// clients (pagina de Notas, e futuramente grafo/paleta) ja tem os metadados das
// notas em memoria, entao aqui devolvemos so os ids ranqueados pelo rank do FTS
// — sem reenviar o corpo das notas pro browser (mantem o payload leve).
export async function handleNoteSearch(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return jsonResponse([]);

  const rows = await ftsSearch(env, q, 80, /* prefix */ true);
  return jsonResponse(rows.map((r) => r.id));
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
