import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { ftsSearch, ftsSearchTasks } from '../db/queries.js';
import { OWNER_TASK_VIS } from '../auth/visibility.js';
import { firstDomain } from './graph-data.js';
import { fetchContactsSearchServerSide } from './contacts-data.js';
import { formatBrtDateTime } from '../util/time.js';

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

  // includePrivate=true: é a sessão de cookie do dono (requireSession acima) — ela vê
  // notas privadas normalmente, com o badge no client. Selo de privacidade (spec 31).
  const rows = await ftsSearch(env, q, 80, /* prefix */ true, /* includePrivate */ true);
  return jsonResponse(rows.map((r) => r.id));
}

const SEARCH_ALL_CAP = 6;

export interface SearchAllNoteHit { id: string; title: string; kind: string | null; domain: string; }
export interface SearchAllTaskHit { id: string; title: string; status: string | null; due_brt: string | null; }
export interface SearchAllContactHit { id: string; name: string; category: string | null; }
export interface SearchAllResult {
  notes: SearchAllNoteHit[];
  tasks: SearchAllTaskHit[];
  contacts: SearchAllContactHit[];
  degraded?: string[];
}

// GET /app/search/all?q=<termo> — agregador da paleta de comando (spec 66): 3
// fontes em PARALELO (notas via ftsSearch, tasks via ftsSearchTasks, contatos via
// proxy pro Worker Contacts), cap de 6 cada. Sessão é o dono → includePrivate=true
// nas duas buscas locais (mesma regra do /app/search acima). Contatos fora do ar
// (binding/token ausente, erro de rede, resposta não-ok) NUNCA derruba a resposta
// inteira: vira grupo vazio + `degraded: ['contacts']` — notas/tasks continuam.
// NÃO reaproveita/muda o /app/search antigo (página de Notas + fallback da paleta
// continuam nele) — rota nova e aditiva.
export async function handleSearchAll(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return jsonResponse({ notes: [], tasks: [], contacts: [] } satisfies SearchAllResult);

  const [notesResult, tasksResult, contactsResult] = await Promise.allSettled([
    ftsSearch(env, q, SEARCH_ALL_CAP, /* prefix */ true, /* includePrivate */ true),
    ftsSearchTasks(env, q, SEARCH_ALL_CAP, OWNER_TASK_VIS),
    fetchContactsSearchServerSide(env, q, SEARCH_ALL_CAP),
  ]);

  const notes: SearchAllNoteHit[] = notesResult.status === 'fulfilled'
    ? notesResult.value.map((n) => ({ id: n.id, title: n.title, kind: n.kind, domain: firstDomain(n.domains) }))
    : [];

  const tasks: SearchAllTaskHit[] = tasksResult.status === 'fulfilled'
    ? tasksResult.value.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        due_brt: t.due_at !== null ? formatBrtDateTime(t.due_at) : null,
      }))
    : [];

  let contacts: SearchAllContactHit[] = [];
  const degraded: string[] = [];
  if (contactsResult.status === 'fulfilled' && contactsResult.value.ok) {
    contacts = contactsResult.value.results;
  } else {
    degraded.push('contacts');
  }

  const result: SearchAllResult = { notes, tasks, contacts };
  if (degraded.length > 0) result.degraded = degraded;
  return jsonResponse(result);
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
