import type { Env } from '../env.js';
import { handleLoginGet, handleLoginPost, handleLogoutPost } from './login.js';
import { handleNotesList, handleNoteDetail, handleTaskDetail } from './notes.js';
import { handleGraphPage, handleContactsPage, handleGraph3DPage } from './graph.js';
import { handleContactsData, handleContactsMeta } from './contacts-data.js';
import { handleGraphData, handleGraphMeta, handleGraphLink, handleNoteGraph } from './graph-data.js';
import { handleGraphPrefsPost } from './graph-prefs.js';
import { handleConfigPage, configPageScript, handleConfigPrefsPost } from './config.js';
import { handleApiKeysPage, handleApiKeyCreate, handleApiKeyRevoke } from './api-keys.js';
import { handleNoteSearch } from './search.js';
import { handleTasksPage, handleTasksData, handleTaskStatusPost, handleTaskCompletePost } from './tasks.js';
import { handleMediaUpload, handleMediaList, handleMediaServe, handleMediaDelete } from './media.js';
import { handleContactsSso } from './contacts-sso.js';

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

  const noteGraphMatch = path.match(/^\/app\/notes\/([A-Za-z0-9_-]+)\/graph$/);
  if (noteGraphMatch && req.method === 'GET') return handleNoteGraph(req, env, noteGraphMatch[1]);

  // Mídia de uma nota (imagens/vídeos/docs/áudio no R2). Auth Bearer OU sessão.
  const noteMediaMatch = path.match(/^\/app\/notes\/([A-Za-z0-9_-]+)\/media$/);
  if (noteMediaMatch && req.method === 'POST') return handleMediaUpload(req, env, noteMediaMatch[1]);
  if (noteMediaMatch && req.method === 'GET') return handleMediaList(req, env, noteMediaMatch[1]);

  // Blob individual: GET serve (signed token OU sessão), DELETE remove.
  const mediaMatch = path.match(/^\/app\/media\/([A-Za-z0-9_-]+)$/);
  if (mediaMatch && req.method === 'GET') return handleMediaServe(req, env, mediaMatch[1]);
  if (mediaMatch && req.method === 'DELETE') return handleMediaDelete(req, env, mediaMatch[1]);

  const noteMatch = path.match(/^\/app\/notes\/([A-Za-z0-9_-]+)$/);
  if (noteMatch && req.method === 'GET') return handleNoteDetail(req, env, noteMatch[1]);

  // Tasks (Kanban + API). /app/tasks/data + status + complete aceitam Bearer
  // (VPS/cron) OU sessão; a página /app/tasks exige sessão de browser.
  if (path === '/app/tasks' && req.method === 'GET') return handleTasksPage(req, env);
  if (path === '/app/tasks/data' && req.method === 'GET') return handleTasksData(req, env);
  if (path === '/app/tasks/status' && req.method === 'POST') return handleTaskStatusPost(req, env);
  if (path === '/app/tasks/complete' && req.method === 'POST') return handleTaskCompletePost(req, env);

  // Detalhe de uma task (superfície própria — NÃO o editor de nota). Vem DEPOIS dos
  // paths exatos acima pra não capturar /data /status /complete. /bundle.js tem ponto,
  // então o regex (sem '.') não casa com ele.
  const taskMatch = path.match(/^\/app\/tasks\/([A-Za-z0-9_-]+)$/);
  if (taskMatch && req.method === 'GET') return handleTaskDetail(req, env, taskMatch[1]);

  // Contatos embutido NO Brain: mesma sidebar/URL, painel direito = grafo de contatos
  // (dados puxados do Worker do Contacts via binding). /app/contacts-sso fica como
  // fallback legado (não é mais usado pelo nav).
  if (path === '/app/contacts' && req.method === 'GET') return handleContactsPage(req, env);
  if (path === '/app/contacts/data' && req.method === 'GET') return handleContactsData(req, env);
  if (path === '/app/contacts/meta' && req.method === 'GET') return handleContactsMeta(req, env);
  if (path === '/app/contacts-sso' && req.method === 'GET') return handleContactsSso(req, env);

  if (path === '/app/graph' && req.method === 'GET') return handleGraphPage(req, env);
  // Grafo 3D — "globo que gira" (mesmo payload /app/graph/data do 2D).
  if (path === '/app/graph3d' && req.method === 'GET') return handleGraph3DPage(req, env);
  if (path === '/app/graph/data' && req.method === 'GET') return handleGraphData(req, env);
  if (path === '/app/graph/meta' && req.method === 'GET') return handleGraphMeta(req, env);
  if (path === '/app/graph/link' && req.method === 'POST') return handleGraphLink(req, env);
  if (path === '/app/graph/prefs' && req.method === 'POST') return handleGraphPrefsPost(req, env);

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
  if (path === '/app/graph3d/bundle.js' && req.method === 'GET') {
    return serveBundle('/graph3d.bundle.js');
  }
  if (path === '/app/notes/bundle.js' && req.method === 'GET') {
    return serveBundle('/notes.bundle.js');
  }
  if (path === '/app/notes/local-graph.bundle.js' && req.method === 'GET') {
    return serveBundle('/local-graph.bundle.js');
  }
  if (path === '/app/notes/media.bundle.js' && req.method === 'GET') {
    return serveBundle('/note-media.bundle.js');
  }
  if (path === '/app/shell/bundle.js' && req.method === 'GET') {
    return serveBundle('/shell.bundle.js');
  }
  if (path === '/app/tasks/bundle.js' && req.method === 'GET') {
    return serveBundle('/tasks.bundle.js');
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
