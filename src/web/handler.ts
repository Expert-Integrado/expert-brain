import type { Env } from '../env.js';
import { handleLoginGet, handleLoginPost, handleLogoutPost } from './login.js';
import { handleNotesList, handleNoteDetail } from './notes.js';
import { handleGraphPage } from './graph.js';
import { handleGraphData, handleGraphMeta, handleGraphLink } from './graph-data.js';
import { handleConfigPage, configPageScript, handleConfigPrefsPost } from './config.js';
import { handleApiKeysPage, handleApiKeyCreate, handleApiKeyRevoke } from './api-keys.js';
import { handleNoteSearch } from './search.js';

export async function handleApp(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith('/app')) return null;

  if (path === '/app' || path === '/app/') {
    return new Response(null, { status: 302, headers: { location: '/app/graph' } });
  }
  if (path === '/app/login' && req.method === 'GET') return handleLoginGet(req);
  if (path === '/app/login' && req.method === 'POST') return handleLoginPost(req, env);
  if (path === '/app/logout' && req.method === 'POST') return handleLogoutPost(req);
  if (path === '/app/notes' && req.method === 'GET') return handleNotesList(req, env);
  if (path === '/app/search' && req.method === 'GET') return handleNoteSearch(req, env);

  const noteMatch = path.match(/^\/app\/notes\/([A-Za-z0-9_-]+)$/);
  if (noteMatch && req.method === 'GET') return handleNoteDetail(req, env, noteMatch[1]);

  if (path === '/app/graph' && req.method === 'GET') return handleGraphPage(req, env);
  if (path === '/app/graph/data' && req.method === 'GET') return handleGraphData(req, env);
  if (path === '/app/graph/meta' && req.method === 'GET') return handleGraphMeta(req, env);
  if (path === '/app/graph/link' && req.method === 'POST') return handleGraphLink(req, env);

  // Bundle assets — cache longo + immutable. Seguro porque o <script src> usa
  // ?v=<hash-de-conteudo> (ver asset-version.ts): a URL muda quando o bundle
  // muda, entao o browser/SW cacheiam entre loads e bustam sozinhos no deploy.
  const bundleHeaders = { 'cache-control': 'public, max-age=31536000, immutable' };
  async function serveBundle(asset: string): Promise<Response> {
    const r = await env.ASSETS.fetch(new Request(new URL(asset, url.origin)));
    const h = new Headers(r.headers);
    Object.entries(bundleHeaders).forEach(([k, v]) => h.set(k, v));
    return new Response(r.body, { status: r.status, headers: h });
  }

  if (path === '/app/graph/bundle.js' && req.method === 'GET') {
    return serveBundle('/graph.bundle.js');
  }
  if (path === '/app/graph/sim-worker.bundle.js' && req.method === 'GET') {
    return serveBundle('/sim-worker.bundle.js');
  }
  if (path === '/app/notes/bundle.js' && req.method === 'GET') {
    return serveBundle('/notes.bundle.js');
  }
  if (path === '/app/notes/local-graph.bundle.js' && req.method === 'GET') {
    return serveBundle('/local-graph.bundle.js');
  }
  if (path === '/app/shell/bundle.js' && req.method === 'GET') {
    return serveBundle('/shell.bundle.js');
  }

  if (path === '/app/api-keys' && req.method === 'GET') return handleApiKeysPage(req, env);
  if (path === '/app/api-keys/create' && req.method === 'POST') return handleApiKeyCreate(req, env);
  if (path === '/app/api-keys/revoke' && req.method === 'POST') return handleApiKeyRevoke(req, env);

  if (path === '/app/config' && req.method === 'GET') return handleConfigPage(req, env);
  if (path === '/app/config/prefs' && req.method === 'POST') return handleConfigPrefsPost(req, env);
  if (path === '/app/config/bundle.js' && req.method === 'GET') {
    return new Response(configPageScript(), {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  }

  return new Response('Não encontrado', { status: 404 });
}
