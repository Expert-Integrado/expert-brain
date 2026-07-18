import type { Env } from '../env.js';
import { handleLoginGet, handleLoginPost, handleLogoutPost, handleTwoFactorGet, handleTwoFactorPost } from './login.js';
import { handleNotesList, handleNoteDetail, handleTaskDetail, handleNoteUpdatePost, handleNoteCreatePost, handleNotePrivatePost, handleTaskFromNotePost, handleNoteDeletePost, handleNoteRestorePost } from './notes.js';
import { handleGraphPage, handleContactsPage } from './graph.js';
import { handleContactsData, handleContactsMeta, handleContactsEntity, handleContactsMedia, handleContactsEntityEvents, handleContactsEntityEventCreate, handleContactsEntityNeighbors, handleContactsEntityGroupGraph, handleContactMentions, handleContactsSearch, handleContactsEventsRecent, handleContactsGoogleGet, handleContactsGooglePost, handleContactsWhatsappStatus, handleContactsWhatsappAllowlist, handleContactsWhatsappCreateMembers, handleContactsInstagramStatus, handleContactsInstagramAllowlist, handleContactsPipedriveStatus, handleContactsPipedriveSync } from './contacts-data.js';
import { handleHomePage } from './home.js';
import { handleHomePrefsPost, handleStartDismissPost } from './home-prefs.js';
import { handleJournalPage } from './journal.js';
import { handleInsightsPage } from './insights.js';
import { handleContactPage } from './contact-page.js';
import { handleGraphData, handleGraphMeta, handleGraphLink, handleNoteGraph } from './graph-data.js';
import { handleGraphPrefsPost } from './graph-prefs.js';
import { handleConfigPage, configPageScript, handleConfigPrefsPost, handleConfigOwnerInstructionsPost } from './config.js';
import { handleTaxonomyGet, handleTaxonomyPost, handleTaxonomyResetPost } from './taxonomy-config.js';
import { handleBackupNowPost, handleExportGet } from './backup.js';
import {
  handleTwoFactorStartPost,
  handleTwoFactorConfirmPost,
  handleTwoFactorCancelPost,
  handleTwoFactorDisablePost,
} from './twofactor-config.js';
import { handleRecoverGet, handleRecoverPost } from './recover.js';
import { handlePasswordChangePost, handleRecoveryCodePost } from './password-config.js';
import { handleFleetPage, handleFleetTaskActionPost, fleetPageScript } from './fleet.js';
import { handleApiKeysPage, handleApiKeyCreate, handleApiKeyOwner, handleApiKeyRevoke, handleApiKeySystem } from './api-keys.js';
import { handleProjectShareCreate, handleProjectShareRevoke } from './project-share.js';
import { handleNoteSearch, handleSearchAll } from './search.js';
import { handleTasksPage, handleTasksData, handleTaskStatusPost, handleTaskCompletePost, handleTaskUpdatePost, handleTaskCreatePost, handleTaskMovePost, handleTaskSharePost, handleTaskUnsharePost, handleTaskPrivatePost, handleTaskCommentPost, handleTaskCommentDeletePost, handleSubtaskAddPost, handleSubtaskTogglePost, handleSubtaskUpdatePost, handleSubtaskDeletePost, handleColumnCreatePost, handleColumnUpdatePost, handleColumnReorderPost, handleColumnArchivePost, handleProjectCreatePost, handleProjectUpdatePost, handleProjectReorderPost, handleProjectArchivePost, handleTagRenamePost, handleTagDeletePost } from './tasks.js';
import { handleMediaUpload, handleMediaList, handleMediaServe, handleMediaDelete } from './media.js';
import { handleInboxPage, handleInboxAddPost, handleInboxResolvePost, handleInboxToNotePost, handleInboxToTaskPost, handleInboxSharePost, handleInboxShareUploadPost, handleInboxMediaServe } from './inbox.js';
import { handlePushVapidKeyGet, handlePushSubscribePost, handlePushUnsubscribePost, handlePushPendingGet, handlePushTestPost } from './push.js';
import { handleContactsSso } from './contacts-sso.js';
import { handleReleasesPage } from './releases.js';
import { handleUserCreatePost, handleUserUpdatePost, handleUserArchivePost, handleUserAvatarPost, handleUserAvatarGet, handleTaskAssigneesPost } from './users.js';
import { NEBULA_CSS, THEME_BOOT_JS } from './styles.js';
import { notFoundResponse } from './error-pages.js';

export async function handleApp(req: Request, env: Env): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith('/app')) return null;

  // Home "Hoje" (spec 50-console-v2/65): raiz do console logado. Antes redirecionava
  // pro grafo — /app/graph continua existindo como antes, só deixou de ser o destino
  // default. Nenhuma rota existente muda de comportamento (critério de aceite).
  if ((path === '/app' || path === '/app/') && req.method === 'GET') return handleHomePage(req, env);
  // Alturas das caixas da home (Onda 9, spec 71) — persistidas por dono na meta.
  if (path === '/app/home/prefs' && req.method === 'POST') return handleHomePrefsPost(req, env);
  // Dismiss do card 'Comece aqui' (spec 92) — form nativo, CSP-safe.
  if (path === '/app/home/start-dismiss' && req.method === 'POST') return handleStartDismissPost(req, env);
  if (path === '/app/login' && req.method === 'GET') return handleLoginGet(req);
  if (path === '/app/login' && req.method === 'POST') return handleLoginPost(req, env);
  // Segundo passo do login com 2FA ligado (spec 100-seguranca-conta/102).
  if (path === '/app/login/2fa' && req.method === 'GET') return handleTwoFactorGet(req, env);
  if (path === '/app/login/2fa' && req.method === 'POST') return handleTwoFactorPost(req, env);
  // "Esqueci a senha" por código de recuperação (spec 103) — público, rate-limited.
  if (path === '/app/login/recover' && req.method === 'GET') return handleRecoverGet(req, env);
  if (path === '/app/login/recover' && req.method === 'POST') return handleRecoverPost(req, env);
  if (path === '/app/logout' && req.method === 'POST') return handleLogoutPost(req);
  // Journal cronológico unificado (spec 65 §3): notas + tasks + interações de contato.
  if (path === '/app/journal' && req.method === 'GET') return handleJournalPage(req, env);
  // Dashboard mensal "Seu cérebro" (spec 91-experiencia-premium/99).
  if (path === '/app/insights' && req.method === 'GET') return handleInsightsPage(req, env);
  // Fleet view — painel operacional da frota de agentes (spec 80-frota-agentes/92).
  if (path === '/app/fleet' && req.method === 'GET') return handleFleetPage(req, env);
  if (path === '/app/fleet/task' && req.method === 'POST') return handleFleetTaskActionPost(req, env);
  if (path === '/app/fleet/bundle.js' && req.method === 'GET') {
    // Filtros da fila de validação (CSP script-src 'self' proíbe inline) —
    // mesmo contrato do bundle da config: immutable, ?v=<hash> busta no deploy.
    return new Response(fleetPageScript(), {
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }
  if (path === '/app/notes' && req.method === 'GET') return handleNotesList(req, env);
  if (path === '/app/search' && req.method === 'GET') return handleNoteSearch(req, env);
  // Busca unificada da paleta de comando (spec 66): notas + tasks + contatos num
  // request só. Rota NOVA — não substitui o /app/search acima (página de Notas e
  // fallback Fuse da paleta continuam nele).
  if (path === '/app/search/all' && req.method === 'GET') return handleSearchAll(req, env);

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

  // "+ Nova nota" da lista (audit ui-audit/RELATORIO.md item N2): título+corpo mínimo,
  // espelha /app/tasks/create. Path exato, mesma posição que /update acima (ANTES do
  // noteMatch, que só casa GET — 'create' casaria como id num GET).
  if (path === '/app/notes/create' && req.method === 'POST') return handleNoteCreatePost(req, env);

  // Criar task a partir de uma nota (spec 62 §2): task com origin_note_id + menções
  // herdadas. Path exato, vem ANTES do noteMatch (que só casa GET, mas 'task-from-note'
  // casaria como id num GET — aqui é POST). Sessão de browser (o handler valida).
  if (path === '/app/notes/task-from-note' && req.method === 'POST') return handleTaskFromNotePost(req, env);

  // Toggle do selo de privacidade (spec 31): ÚNICA superfície que desmarca. Sessão de
  // browser só (o handler exige requireSession). Vem ANTES do noteMatch (GET) — path
  // com sufixo /private não colide com o regex de id de 1 segmento.
  const notePrivateMatch = path.match(/^\/app\/notes\/([A-Za-z0-9_-]+)\/private$/);
  if (notePrivateMatch && req.method === 'POST') return handleNotePrivatePost(req, env, notePrivateMatch[1]);

  // Soft-delete + undo pela web (spec 95). Sessão de browser só, mesmo racional
  // do /private acima. Delete espelha o delete_note do MCP; restore, o restore_note.
  const noteDeleteMatch = path.match(/^\/app\/notes\/([A-Za-z0-9_-]+)\/delete$/);
  if (noteDeleteMatch && req.method === 'POST') return handleNoteDeletePost(req, env, noteDeleteMatch[1]);
  const noteRestoreMatch = path.match(/^\/app\/notes\/([A-Za-z0-9_-]+)\/restore$/);
  if (noteRestoreMatch && req.method === 'POST') return handleNoteRestorePost(req, env, noteRestoreMatch[1]);

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
  // Gestão global de tags (pedido 10/07): renomear em massa e apagar, via seção Tags de /app/config.
  if (path === '/app/tasks/tags/rename' && req.method === 'POST') return handleTagRenamePost(req, env);
  if (path === '/app/tasks/tags/delete' && req.method === 'POST') return handleTagDeletePost(req, env);
  // Edição inline de task pela UI (spec 36): patch de title/body/due/priority/status.
  if (path === '/app/tasks/update' && req.method === 'POST') return handleTaskUpdatePost(req, env);
  // Criação de task pela UI (spec 36 fase 2): title obrigatório + body/priority/due opcionais.
  if (path === '/app/tasks/create' && req.method === 'POST') return handleTaskCreatePost(req, env);
  // Compartilhamento público read-only (spec 33): gera/renova e revoga o link
  // /s/<token>. Reusa a MESMA lógica da tool share_task/unshare_task (src/web/share.ts).
  // /app/notes/share|unshare são ALIASES dos mesmos handlers — desde a reconciliação
  // da spec 33 o createShare/revokeShare aceitam qualquer nota viva (task ou conhecimento).
  if (path === '/app/tasks/share' && req.method === 'POST') return handleTaskSharePost(req, env);
  if (path === '/app/tasks/unshare' && req.method === 'POST') return handleTaskUnsharePost(req, env);
  if (path === '/app/notes/share' && req.method === 'POST') return handleTaskSharePost(req, env);
  if (path === '/app/notes/unshare' && req.method === 'POST') return handleTaskUnsharePost(req, env);
  // Selo de privacidade de task (spec 59): toggle privada/pública. ÚNICA superfície que
  // desmarca; sessão de browser só (requireSession no handler). Marcar privada revoga o
  // link público na mesma escrita. Path exato, vem ANTES do taskMatch (GET).
  if (path === '/app/tasks/private' && req.method === 'POST') return handleTaskPrivatePost(req, env);
  // Comentários em task (spec 53): dono adiciona/apaga pelo console (form + redirect,
  // sessão de browser). Vêm ANTES do taskMatch (que só casa GET) — paths exatos.
  if (path === '/app/tasks/comment' && req.method === 'POST') return handleTaskCommentPost(req, env);
  if (path === '/app/tasks/comment/delete' && req.method === 'POST') return handleTaskCommentDeletePost(req, env);
  // Responsáveis da task (spec 37): replace-set via checkboxes da sidebar do detalhe.
  if (path === '/app/tasks/assignees' && req.method === 'POST') return handleTaskAssigneesPost(req, env);
  // Subtarefas/checklist (spec 38): endpoints JSON do detalhe. Paths exatos, ANTES
  // do taskMatch (que só casa GET de 1 segmento) — mesmo racional dos comentários.
  if (path === '/app/tasks/subtask/add' && req.method === 'POST') return handleSubtaskAddPost(req, env);
  if (path === '/app/tasks/subtask/toggle' && req.method === 'POST') return handleSubtaskTogglePost(req, env);
  if (path === '/app/tasks/subtask/update' && req.method === 'POST') return handleSubtaskUpdatePost(req, env);
  if (path === '/app/tasks/subtask/delete' && req.method === 'POST') return handleSubtaskDeletePost(req, env);

  // Detalhe de uma task (superfície própria — NÃO o editor de nota). Vem DEPOIS dos
  // paths exatos acima pra não capturar /data /status /complete. /bundle.js tem ponto,
  // então o regex (sem '.') não casa com ele.
  const taskMatch = path.match(/^\/app\/tasks\/([A-Za-z0-9_-]+)$/);
  if (taskMatch && req.method === 'GET') return handleTaskDetail(req, env, taskMatch[1]);

  // Inbox de captura + triagem (spec 50-console-v2/63). Página + quick-add + 3 ações
  // (virar nota / virar task / descartar), todas por <form> nativo (sessão + redirect,
  // padrão CSRF dos demais POSTs). Paths exatos — sem regex, sem conflito.
  if (path === '/app/inbox' && req.method === 'GET') return handleInboxPage(req, env);
  if (path === '/app/inbox/add' && req.method === 'POST') return handleInboxAddPost(req, env);
  if (path === '/app/inbox/resolve' && req.method === 'POST') return handleInboxResolvePost(req, env);
  if (path === '/app/inbox/to-note' && req.method === 'POST') return handleInboxToNotePost(req, env);
  if (path === '/app/inbox/to-task' && req.method === 'POST') return handleInboxToTaskPost(req, env);
  // Web Share Target nível 2 (spec 68): /share é o action do manifest (o SW intercepta
  // e redireciona; a rota é fallback), /share-upload é a subida com sessão feita pelo
  // client, e /media/:id serve o anexo do item (sessão).
  if (path === '/app/inbox/share' && req.method === 'POST') return handleInboxSharePost(req, env);
  if (path === '/app/inbox/share-upload' && req.method === 'POST') return handleInboxShareUploadPost(req, env);
  const inboxMediaMatch = path.match(/^\/app\/inbox\/media\/([A-Za-z0-9_-]+)$/);
  if (inboxMediaMatch && req.method === 'GET') return handleInboxMediaServe(req, env, inboxMediaMatch[1]);

  // Web Push (spec 68): assinatura/gestão pelo card "Notificações" da config +
  // /pending consumido pelo service worker ao receber um push. Sessão em todos.
  if (path === '/app/push/vapid-key' && req.method === 'GET') return handlePushVapidKeyGet(req, env);
  if (path === '/app/push/subscribe' && req.method === 'POST') return handlePushSubscribePost(req, env);
  if (path === '/app/push/unsubscribe' && req.method === 'POST') return handlePushUnsubscribePost(req, env);
  if (path === '/app/push/pending' && req.method === 'GET') return handlePushPendingGet(req, env);
  if (path === '/app/push/test' && req.method === 'POST') return handlePushTestPost(req, env);

  // Contatos embutido NO Brain: mesma sidebar/URL, painel direito = grafo de contatos
  // (dados puxados do Worker do Contacts via binding). /app/contacts-sso fica como
  // fallback legado (não é mais usado pelo nav).
  if (path === '/app/contacts' && req.method === 'GET') return handleContactsPage(req, env);
  if (path === '/app/contacts/data' && req.method === 'GET') return handleContactsData(req, env);
  if (path === '/app/contacts/meta' && req.method === 'GET') return handleContactsMeta(req, env);
  if (path === '/app/contacts/entity' && req.method === 'GET') return handleContactsEntity(req, env);
  // Timeline paginada de interações + registro manual (spec 50-console-v2/57).
  // GET via proxy read-only (mesmo CONTACTS_PROXY_TOKEN do detalhe/grafo); POST
  // via proxy de ESCRITA escopado (CONTACTS_WRITE_TOKEN, allowlist de 1 path do
  // lado do contacts) — cada handler valida a própria sessão do Brain.
  if (path === '/app/contacts/entity/events' && req.method === 'GET') return handleContactsEntityEvents(req, env);
  if (path === '/app/contacts/entity/event' && req.method === 'POST') return handleContactsEntityEventCreate(req, env);
  // Vizinhança de 1º/2º nível (spec 50-console-v2/56 §2) — mesmo proxy read-only.
  if (path === '/app/contacts/entity/neighbors' && req.method === 'GET') return handleContactsEntityNeighbors(req, env);
  // Grafo interno de grupo (membros + arestas) — mesmo proxy read-only.
  if (path === '/app/contacts/entity/group-graph' && req.method === 'GET') return handleContactsEntityGroupGraph(req, env);
  // Seções reversas da página do contato (spec 62 §4): notas e tasks que MENCIONAM o
  // contato. Brain-LOCAL (tabela mentions), sem proxy — sessão do dono.
  if (path === '/app/contacts/entity/mentions' && req.method === 'GET') return handleContactMentions(req, env);
  // Busca de contatos pro @autocomplete do editor de nota (spec 62 §2) — proxy read-only.
  if (path === '/app/contacts/search' && req.method === 'GET') return handleContactsSearch(req, env);
  // Feed global de interações (spec 65 §1) — consumido pelo client da home (card
  // "Últimas interações", async) e pelo journal (fonte "interações", SSR).
  if (path === '/app/contacts/events/recent' && req.method === 'GET') return handleContactsEventsRecent(req, env);
  const contactsMediaMatch = path.match(/^\/app\/contacts\/media\/([0-9a-f]{64})$/i);
  if (contactsMediaMatch && req.method === 'GET') {
    return handleContactsMedia(req, env, contactsMediaMatch[1]);
  }
  if (path === '/app/contacts-sso' && req.method === 'GET') return handleContactsSso(req, env);

  // Página própria do contato (spec 50-console-v2/56 §3) — regex checado por
  // ÚLTIMO dentre as rotas /app/contacts/* pra não engolir os paths exatos acima
  // (data/meta/entity/entity+subpaths). Bundles (.js, tem ponto) e /app/contacts/
  // media/<hash> (2 segmentos) também não casam este regex de 1 segmento só.
  const contactIdMatch = path.match(/^\/app\/contacts\/([A-Za-z0-9_-]+)$/);
  if (contactIdMatch && req.method === 'GET') return handleContactPage(req, env, contactIdMatch[1]);

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
  if (path === '/app/contacts/contact-page.bundle.js' && req.method === 'GET') {
    return serveBundle('/contact-page.bundle.js');
  }
  if (path === '/app/home/bundle.js' && req.method === 'GET') {
    return serveBundle('/home.bundle.js');
  }
  if (path === '/app/journal/bundle.js' && req.method === 'GET') {
    return serveBundle('/journal.bundle.js');
  }

  if (path === '/app/api-keys' && req.method === 'GET') return handleApiKeysPage(req, env);
  if (path === '/app/api-keys/create' && req.method === 'POST') return handleApiKeyCreate(req, env);
  if (path === '/app/api-keys/revoke' && req.method === 'POST') return handleApiKeyRevoke(req, env);
  if (path === '/app/api-keys/owner' && req.method === 'POST') return handleApiKeyOwner(req, env);
  if (path === '/app/api-keys/system' && req.method === 'POST') return handleApiKeySystem(req, env);

  // Share de board por projeto (spec 80-frota-agentes/85): gestão no console.
  if (path === '/app/project-shares/create' && req.method === 'POST') return handleProjectShareCreate(req, env);
  if (path === '/app/project-shares/revoke' && req.method === 'POST') return handleProjectShareRevoke(req, env);

  // Foto de perfil de usuário (spec 37): servida do R2, sessão obrigatória.
  const userAvatarMatch = path.match(/^\/app\/users\/([A-Za-z0-9_-]+)\/avatar$/);
  if (userAvatarMatch && req.method === 'GET') return handleUserAvatarGet(req, env, userAvatarMatch[1]);

  // Novidades / release notes (spec 50-console-v2/71): visitar marca como vista.
  if (path === '/app/novidades' && req.method === 'GET') return handleReleasesPage(req, env);
  if (path === '/app/config' && req.method === 'GET') return handleConfigPage(req, env);
  if (path === '/app/config/prefs' && req.method === 'POST') return handleConfigPrefsPost(req, env);
  // "Instruções do dono" (spec 50-console-v2/70): bloco livre anexado ao handshake
  // MCP. Sessão obrigatória; nenhum caminho público novo.
  if (path === '/app/config/owner-instructions' && req.method === 'POST') return handleConfigOwnerInstructionsPost(req, env);
  // Taxonomia configurável (spec 54): cor/label de áreas e kinds. GET é consumido
  // pelos bundles client (graph.ts, notes.ts) pra resolver cor/label sem embutir
  // a config em cada página; POST/reset vêm da seção "Áreas e tipos" de /app/config.
  if (path === '/app/config/taxonomy' && req.method === 'GET') return handleTaxonomyGet(req, env);
  if (path === '/app/config/taxonomy' && req.method === 'POST') return handleTaxonomyPost(req, env);
  if (path === '/app/config/taxonomy/reset' && req.method === 'POST') return handleTaxonomyResetPost(req, env);
  // Google Contacts sync (painel em /app/config#google-contatos): proxy pro
  // expert-contacts com o token certo por verbo (leitura = proxy token; mutação
  // de estado do sync = write token). Sessão obrigatória em todos.
  if (path === '/app/config/google/status' && req.method === 'GET') return handleContactsGoogleGet(req, env, 'status');
  if (path === '/app/config/google/labels' && req.method === 'GET') return handleContactsGoogleGet(req, env, 'labels');
  if (path === '/app/config/google/connect' && req.method === 'POST') return handleContactsGooglePost(req, env, 'connect');
  if (path === '/app/config/google/config' && req.method === 'POST') return handleContactsGooglePost(req, env, 'config');
  if (path === '/app/config/google/client' && req.method === 'POST') return handleContactsGooglePost(req, env, 'client');
  if (path === '/app/config/google/sync' && req.method === 'POST') return handleContactsGooglePost(req, env, 'sync');
  if (path === '/app/config/google/disconnect' && req.method === 'POST') return handleContactsGooglePost(req, env, 'disconnect');
  // WhatsApp Agent grupos (painel em /app/config#whatsapp-grupos): mesmo desenho
  // do Google — leitura de estado via proxy token, allowlist via write token.
  if (path === '/app/config/whatsapp/status' && req.method === 'GET') return handleContactsWhatsappStatus(req, env);
  if (path === '/app/config/whatsapp/allowlist' && req.method === 'POST') return handleContactsWhatsappAllowlist(req, env);
  if (path === '/app/config/whatsapp/create-members' && req.method === 'POST') return handleContactsWhatsappCreateMembers(req, env);
  // Instagram Agent conversas (painel em /app/config#instagram-contatos): mesmo desenho.
  if (path === '/app/config/instagram/status' && req.method === 'GET') return handleContactsInstagramStatus(req, env);
  if (path === '/app/config/instagram/allowlist' && req.method === 'POST') return handleContactsInstagramAllowlist(req, env);
  // Pipedrive (painel em /app/config#pipedrive-crm): mesmo desenho.
  if (path === '/app/config/pipedrive/status' && req.method === 'GET') return handleContactsPipedriveStatus(req, env);
  if (path === '/app/config/pipedrive/sync' && req.method === 'POST') return handleContactsPipedriveSync(req, env);
  // Usuários/responsáveis (spec 37): CRUD dos perfis de atribuição (seção "Usuários"
  // de /app/config, aba Organização) + foto no R2. Sessão obrigatória em todos.
  if (path === '/app/config/users/create' && req.method === 'POST') return handleUserCreatePost(req, env);
  if (path === '/app/config/users/update' && req.method === 'POST') return handleUserUpdatePost(req, env);
  if (path === '/app/config/users/archive' && req.method === 'POST') return handleUserArchivePost(req, env);
  if (path === '/app/config/users/avatar' && req.method === 'POST') return handleUserAvatarPost(req, env);
  // Verificação em duas etapas — liga/desliga no card Segurança (spec 102).
  if (path === '/app/config/2fa/start' && req.method === 'POST') return handleTwoFactorStartPost(req, env);
  if (path === '/app/config/2fa/confirm' && req.method === 'POST') return handleTwoFactorConfirmPost(req, env);
  if (path === '/app/config/2fa/cancel' && req.method === 'POST') return handleTwoFactorCancelPost(req, env);
  if (path === '/app/config/2fa/disable' && req.method === 'POST') return handleTwoFactorDisablePost(req, env);
  // Senha e recuperação — card da aba Sistema (spec 103).
  if (path === '/app/config/password' && req.method === 'POST') return handlePasswordChangePost(req, env);
  if (path === '/app/config/recovery-code' && req.method === 'POST') return handleRecoveryCodePost(req, env);
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

  // Boot anti-flash do tema (spec 96): script bloqueante minúsculo carregado no
  // <head> antes do stylesheet (a CSP proíbe inline). Público como o styles.css
  // (a página de login também tematiza); ?v= literal em render.ts — bump manual
  // se o THEME_BOOT_JS mudar.
  if (path === '/app/theme-boot.js' && req.method === 'GET') {
    return new Response(THEME_BOOT_JS, {
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  }

  // 404 com marca pra navegação HTML; texto puro pra API/fetch (spec 97).
  return notFoundResponse(req);
}
