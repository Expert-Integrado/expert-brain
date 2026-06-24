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

  const res = await env.CONTACTS.fetch(new Request(out.toString(), {
    method: 'GET',
    headers: { authorization: `Bearer ${env.CONTACTS_PROXY_TOKEN}` },
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
