import type { Env } from '../env.js';
import { requireSession } from './session.js';

// Proxy server-side: o Brain puxa o grafo de contatos do Worker do Expert Contacts
// via service binding (CONTACTS) + Bearer (CONTACTS_PROXY_TOKEN). O browser fala só
// com o Brain (mesma origem) — a credencial nunca sai pro cliente, e o /app/contacts
// renderiza o grafo de contatos DENTRO do shell do Brain.
async function proxyToContacts(req: Request, env: Env, consolePath: string): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  if (!env.CONTACTS || !env.CONTACTS_PROXY_TOKEN) {
    return new Response(JSON.stringify({ error: 'contacts binding/token not configured' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  }

  // Preserva a query do cliente (?q=, ?focus=, ?depth=...) e força vault=contacts.
  const inUrl = new URL(req.url);
  const out = new URL(`https://contacts${consolePath}`);
  inUrl.searchParams.forEach((v, k) => { if (k !== 'vault') out.searchParams.set(k, v); });
  out.searchParams.set('vault', 'contacts');
  // all=1: traz TODOS os contatos (inclui os ~6,5k isolados), não só os conectados.
  // O modo "all" do adapter pula a similaridade, então é leve mesmo com milhares.
  if (consolePath.endsWith('/data') && !inUrl.searchParams.has('focus') && !inUrl.searchParams.get('q')) {
    out.searchParams.set('all', '1');
  }

  // Privacidade (spec 50-console-v2/61): estas rotas são protegidas por requireSession
  // (= o dono logado no console do Brain), então propaga o escopo `private` downstream
  // via header X-Include-Private — o dono vê o grafo/detalhe/timeline COMPLETO, com
  // marcação visual de privado. O contacts só honra o header com o proxy token válido.
  const res = await env.CONTACTS.fetch(new Request(out.toString(), {
    method: 'GET',
    headers: { authorization: `Bearer ${env.CONTACTS_PROXY_TOKEN}`, 'x-include-private': '1' },
  }));

  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function handleContactsData(req: Request, env: Env): Promise<Response> {
  return proxyToContacts(req, env, '/app/graph/data');
}

export function handleContactsMeta(req: Request, env: Env): Promise<Response> {
  return proxyToContacts(req, env, '/app/graph/meta');
}

// Detalhe de um contato (?id=) — alimenta o painel contato-mode do grafo.
export function handleContactsEntity(req: Request, env: Env): Promise<Response> {
  return proxyToContacts(req, env, '/app/entity');
}

// Timeline paginada de interações (?id=&offset=&limit=) — spec 50-console-v2/57 §2.
// Mesmo proxy read-only (CONTACTS_PROXY_TOKEN) que o detalhe/grafo — o contacts
// aceita GET /app/entity/events nessa MESMA allowlist.
export function handleContactsEntityEvents(req: Request, env: Env): Promise<Response> {
  return proxyToContacts(req, env, '/app/entity/events');
}

// Vizinhança de 1º/2º nível (?id=) — spec 50-console-v2/56 §2. Mesmo proxy
// read-only que o detalhe/timeline — o contacts aceita GET /app/entity/neighbors
// nessa MESMA allowlist (handler.ts do contacts). SQL puro do lado de lá, zero
// Vectorize em runtime.
export function handleContactsEntityNeighbors(req: Request, env: Env): Promise<Response> {
  return proxyToContacts(req, env, '/app/entity/neighbors');
}

// Busca DIRETA do detalhe de um contato (sem passar por Request/sessão) — usada
// no SSR de /app/contacts/<id> (spec 50-console-v2/56 §3) pra decidir 404 ANTES
// de renderizar o shell. O client hidrata de novo via GET /app/contacts/entity
// (pequena duplicação de fetch aceita em troca de manter o proxy request-based
// acima intocado pros demais consumidores — painel do grafo, etc.).
export async function fetchContactEntityServerSide(
  env: Env,
  id: string,
): Promise<{ status: number; body: any }> {
  if (!env.CONTACTS || !env.CONTACTS_PROXY_TOKEN) {
    return { status: 503, body: { ok: false, error: 'contacts binding/token not configured' } };
  }
  const out = new URL('https://contacts/app/entity');
  out.searchParams.set('vault', 'contacts');
  out.searchParams.set('id', id);
  // SSR de /app/contacts/<id>: quem chega aqui é o dono logado (handleContactPage já
  // rodou requireSession) — propaga o escopo `private` pra checar existência de contato
  // privado sem 404 falso (spec 61).
  const res = await env.CONTACTS.fetch(new Request(out.toString(), {
    method: 'GET',
    headers: { authorization: `Bearer ${env.CONTACTS_PROXY_TOKEN}`, 'x-include-private': '1' },
  }));
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// POST /app/contacts/entity/event — registra interação pela página do Brain
// (sessão do Brain). Repassa pro contacts via service binding com Bearer
// CONTACTS_WRITE_TOKEN — token de ESCRITA escopado, NUNCA o CONTACTS_PROXY_TOKEN
// read-only. O contacts autoriza esse token SOMENTE em POST /app/entity/event
// (allowlist de 1 path do lado de lá, spec 50-console-v2/57 §3).
export async function handleContactsEntityEventCreate(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;

  if (!env.CONTACTS || !env.CONTACTS_WRITE_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'contacts write binding/token not configured' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  }

  let bodyText: string;
  try { bodyText = await req.text(); } catch { bodyText = ''; }

  const res = await env.CONTACTS.fetch(new Request('https://contacts/app/entity/event', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CONTACTS_WRITE_TOKEN}`,
      'content-type': 'application/json',
    },
    body: bodyText,
  }));

  const resBody = await res.text();
  return new Response(resBody, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

// Avatar/mídia do contato — streaming passthrough pro /media/<hash> do Expert
// Console (rota pública lá; proxiar aqui mantém same-origin no browser). O hash
// é validado (sha256 hex) pra rota não virar proxy arbitrário, e a resposta é
// cacheável forte: o conteúdo é endereçado pelo próprio hash (imutável).
export async function handleContactsMedia(req: Request, env: Env, hash: string): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  if (!env.CONTACTS) return new Response('contacts binding not configured', { status: 503 });
  if (!/^[0-9a-f]{64}$/i.test(hash)) return new Response('bad hash', { status: 400 });

  const res = await env.CONTACTS.fetch(new Request(`https://contacts/media/${hash}`, { method: 'GET' }));
  if (!res.ok) return new Response('not found', { status: res.status === 404 ? 404 : 502 });
  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': res.headers.get('content-type') || 'application/octet-stream',
      'cache-control': 'private, max-age=604800, immutable',
    },
  });
}
