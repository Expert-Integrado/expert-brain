import type { Env } from '../env.js';
import { handleLoginGet, handleLoginPost, handleLogoutPost } from './login.js';
import { handleNotesList, handleNoteDetail, handleTaskDetail, handleNoteUpdatePost } from './notes.js';
import { handleGraphPage, handleContactsPage } from './graph.js';
import { handleContactsData, handleContactsMeta, handleContactsEntity, handleContactsMedia } from './contacts-data.js';
import { handleGraphData, handleGraphMeta, handleGraphLink, handleNoteGraph } from './graph-data.js';
import { handleGraphPrefsPost } from './graph-prefs.js';
import { handleConfigPage, configPageScript, handleConfigPrefsPost } from './config.js';
import { handleBackupNowPost, handleExportGet } from './backup.js';
import { handleApiKeysPage, handleApiKeyCreate, handleApiKeyRevoke } from './api-keys.js';
import { handleNoteSearch } from './search.js';
import { handleTasksPage, handleTasksData, handleTaskStatusPost, handleTaskCompletePost, handleTaskUpdatePost, handleTaskCreatePost, handleTaskMovePost, handleTaskSharePost, handleTaskUnsharePost, handleTaskCommentPost, handleTaskCommentDeletePost, handleColumnCreatePost, handleColumnUpdatePost, handleColumnReorderPost, handleColumnArchivePost, handleProjectCreatePost, handleProjectUpdatePost, handleProjectReorderPost, handleProjectArchivePost } from './tasks.js';
import { handleMediaUpload, handleMediaList, handleMediaServe, handleMediaDelete } from './media.js';
import { handleContactsSso } from './contacts-sso.js';
import { NEBULA_CSS } from './styles.js';

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

  // Edição inline de nota de conhecimento pela UI (spec 36 fase 2): patch de
  // title/body/tldr/domains/kind. Vem ANTES do noteMatch (que só casa GET) e o
  // path exato /update não colide com o regex de id (que não tem barra interna
  // depois de notes/, mas 'update' casaria como id num GET — aqui é POST).
  if (path === '/app/notes/update' && req.method === 'POST') return handleNoteUpdatePost(req, env);

  const noteMatch = path.match(/^\/app\/notes\/([A-Za-z0-9_-]+)$/);
  if (noteMatch && req.method === 'GET') return handleNoteDetail(req, env, noteMatch[1]);

  // Tasks (Kanban + API). /app/tasks/data + status + complete aceitam Bearer
  // (VPS/cron) OU sessão; a página /app/tasks exige sessão de browser.
  if (path === '/app/tasks' && req.method === 'GET') return handleTasksPage(req, env);
  if (path === '/app/tasks/data' && req.method === 'GET') return handleTasksData(req, env);
  if (path === '/app/tasks/status' && req.method === 'POST') return handleTaskStatusPost(req, env);
  if (path === '/app/tasks/complete' && req.method === 'POST') return handleTaskCompletePost(req, env);
  // Kanban colunas customizáveis (spec 51): mover card entre colunas (JSON, board)
  // e gestão de colunas via UI de config (form + redirect, sessão de browser).
  if (path === '/app/tasks/move' && req.method === 'POST') return handleTaskMovePost(req, env);
  if (path === '/app/tasks/columns/create' && req.method === 'POST') return handleColumnCreatePost(req, env);
  if (path === '/app/tasks/columns/update' && req.method === 'POST') return handleColumnUpdatePost(req, env);
  if (path === '/app/tasks/columns/reorder' && req.method === 'POST') return handleColumnReorderPost(req, env);
  if (path === '/app/tasks/columns/archive' && req.method === 'POST') return handleColumnArchivePost(req, env);
  // Projetos/pastas de task (spec 58): gestão via UI de config (form + redirect, sessão).
  if (path === '/app/tasks/projects/create' && req.method === 'POST') return handleProjectCreatePost(req, env);
  if (path === '/app/tasks/projects/update' && req.method === 'POST') return handleProjectUpdatePost(req, env);
  if (path === '/app/tasks/projects/reorder' && req.method === 'POST') return handleProjectReorderPost(req, env);
  if (path === '/app/tasks/projects/archive' && req.method === 'POST') return handleProjectArchivePost(req, env);
  // Edição inline de task pela UI (spec 36): patch de title/body/due/priority/status.
  if (path === '/app/tasks/update' && req.method === 'POST') return handleTaskUpdatePost(req, env);
  // Criação de task pela UI (spec 36 fase 2): title obrigatório + body/priority/due opcionais.
  if (path === '/app/tasks/create' && req.method === 'POST') return handleTaskCreatePost(req, env);
  // Compartilhamento público read-only de task (spec 33): gera/renova e revoga o link
  // /s/<token>. Reusa a MESMA lógica da tool share_task/unshare_task (src/web/share.ts).
  if (path === '/app/tasks/share' && req.method === 'POST') return handleTaskSharePost(req, env);
  if (path === '/app/tasks/unshare' && req.method === 'POST') return handleTaskUnsharePost(req, env);
  // Comentários em task (spec 53): dono adiciona/apaga pelo console (form + redirect,
  // sessão de browser). Vêm ANTES do taskMatch (que só casa GET) — paths exatos.
  if (path === '/app/tasks/comment' && req.method === 'POST') return handleTaskCommentPost(req, env);
  if (path === '/app/tasks/comment/delete' && req.method === 'POST') return handleTaskCommentDeletePost(req, env);

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
  if (path === '/app/contacts/entity' && req.method === 'GET') return handleContactsEntity(req, env);
  const contactsMediaMatch = path.match(/^\/app\/contacts\/media\/([0-9a-f]{64})$/i);
  if (contactsMediaMatch && req.method === 'GET') {
    return handleContactsMedia(req, env, contactsMediaMatch[1]);
  }
  if (path === '/app/contacts-sso' && req.method === 'GET') return handleContactsSso(req, env);

  if (path === '/app/graph' && req.method === 'GET') return handleGraphPage(req, env);
  // Legado: o 3D virou um MODO dentro de /app/graph (mesmo painel/URL, só o palco
  // troca). A rota antiga standalone vira 302 pra não quebrar links salvos.
  if (path === '/app/graph3d' && req.method === 'GET') {
    return new Response(null, { status: 302, headers: { location: '/app/graph?mode=3d' } });
  }
  if (path === '/app/graph/data' && req.method === 'GET') return handleGraphData(req, env);
  if (path === '/app/graph/meta' && req.method === 'GET') return handleGraphMeta(req, env);
  if (path === '/app/graph/link' && req.method === 'POST') return handleGraphLink(req, env);
  if (path === '/app/graph/prefs' && req.method === 'POST') return handleGraphPrefsPost(req, env);

  // Bundle assets — cache longo + immutable APENAS em sucesso. Seguro porque o
  // <script src> usa ?v=<hash-de-conteudo> (ver asset-version.ts): a URL muda
  // quando o bundle muda, entao o browser/SW cacheiam entre loads e bustam
  // sozinhos no deploy. Erro (404/5xx transitório de deploy) recebe no-store pra
  // NÃO ficar preso 1 ano no cache do browser numa URL versionada (spec 28).
  async function serveBundle(asset: string): Promise<Response> {
    const r = await env.ASSETS.fetch(new Request(new URL(asset, url.origin)));
    const h = new Headers(r.headers);
    if (r.ok) {
      h.set('cache-control', 'public, max-age=31536000, immutable');
    } else {
      h.set('cache-control', 'no-store');
    }
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
  if (path === '/app/notes/edit.bundle.js' && req.method === 'GET') {
    return serveBundle('/note-edit.bundle.js');
  }
  if (path === '/app/shell/bundle.js' && req.method === 'GET') {
    return serveBundle('/shell.bundle.js');
  }
  if (path === '/app/tasks/bundle.js' && req.method === 'GET') {
    return serveBundle('/tasks.bundle.js');
  }
  if (path === '/app/tasks/edit.bundle.js' && req.method === 'GET') {
    return serveBundle('/task-edit.bundle.js');
  }

  if (path === '/app/api-keys' && req.method === 'GET') return handleApiKeysPage(req, env);
  if (path === '/app/api-keys/create' && req.method === 'POST') return handleApiKeyCreate(req, env);
  if (path === '/app/api-keys/revoke' && req.method === 'POST') return handleApiKeyRevoke(req, env);

  if (path === '/app/config' && req.method === 'GET') return handleConfigPage(req, env);
  if (path === '/app/config/prefs' && req.method === 'POST') return handleConfigPrefsPost(req, env);
  // Backup (spec 67): snapshot on-demand pro R2 + export ZIP do dono. Sessão
  // obrigatória nos dois — nenhum caminho público novo.
  if (path === '/app/config/backup-now' && req.method === 'POST') return handleBackupNowPost(req, env);
  if (path === '/app/export' && req.method === 'GET') return handleExportGet(req, env);
  if (path === '/app/config/bundle.js' && req.method === 'GET') {
    return new Response(configPageScript(), {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        // Agora versionado por ?v=<hash> (config.ts) — mesmo racional dos demais
        // bundles: immutable + cache longo, a URL busta sozinha no deploy (spec 28).
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  // CSS do tema servido externo e cacheável (spec 28): antes o NEBULA_CSS (~49 KB)
  // ia inline no <style> de TODA página, re-baixado a cada clique. Agora as páginas
  // referenciam /app/styles.css?v=<hash> (immutable) e o browser cacheia entre
  // navegações. Servido direto do módulo (não do binding ASSETS) — garante que o
  // CSS é sempre o do Worker deployado, zero janela de dessincronia. Rota pública
  // (sem sessão) de propósito: a página de login também usa o tema e CSS não carrega
  // segredo. CSP das páginas já permite style-src 'self' (render/login/auth handler).
  if (path === '/app/styles.css' && req.method === 'GET') {
    return new Response(NEBULA_CSS, {
      headers: {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  return new Response('Não encontrado', { status: 404 });
}
