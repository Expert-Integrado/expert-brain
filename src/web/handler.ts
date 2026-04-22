import type { Env } from '../env.js';
import { handleLoginGet, handleLoginPost, handleLogoutPost } from './login.js';
import { handleNotesList, handleNoteDetail } from './notes.js';
import { handleGraphPage } from './graph.js';
import { handleGraphData, handleGraphMeta } from './graph-data.js';
import { handleConfigPage, configPageScript } from './config.js';

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

  const noteMatch = path.match(/^\/app\/notes\/([A-Za-z0-9_-]+)$/);
  if (noteMatch && req.method === 'GET') return handleNoteDetail(req, env, noteMatch[1]);

  if (path === '/app/graph' && req.method === 'GET') return handleGraphPage(req, env);
  if (path === '/app/graph/data' && req.method === 'GET') return handleGraphData(req, env);
  if (path === '/app/graph/meta' && req.method === 'GET') return handleGraphMeta(req, env);

  if (path === '/app/graph/bundle.js' && req.method === 'GET') {
    return env.ASSETS.fetch(new Request(new URL('/graph.bundle.js', url.origin)));
  }

  if (path === '/app/config' && req.method === 'GET') return handleConfigPage(req, env);
  if (path === '/app/config/bundle.js' && req.method === 'GET') {
    return new Response(configPageScript(), {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  }

  return new Response('Not found', { status: 404 });
}
