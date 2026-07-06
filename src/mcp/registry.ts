import type { Env, AuthContext } from '../env.js';
import { hasScope } from '../auth/api-keys.js';
import { registerSaveNote } from './tools/save-note.js';
import { registerMarkPrivate } from './tools/mark-private.js';
import { registerRecall } from './tools/recall.js';
import { registerExpand } from './tools/expand.js';
import { registerGetNote } from './tools/get-note.js';
import { registerLink } from './tools/link.js';
import { registerDeleteLink } from './tools/delete-link.js';
import { registerReembed } from './tools/reembed.js';
import { registerUpdateNote } from './tools/update-note.js';
import { registerDeleteNote } from './tools/delete-note.js';
import { registerRestoreNote } from './tools/restore-note.js';
import { registerStats } from './tools/stats.js';
import { registerSaveTask } from './tools/save-task.js';
import { registerListTasksDueToday } from './tools/list-tasks-due-today.js';
import { registerListTasks } from './tools/list-tasks.js';
import { registerCompleteTask } from './tools/complete-task.js';
import { registerUpdateTask } from './tools/update-task.js';
import { registerGetTask } from './tools/get-task.js';
import { registerCommentTask } from './tools/comment-task.js';
import { registerShareTask } from './tools/share-task.js';
import { registerUnshareTask } from './tools/unshare-task.js';
import { registerCapture } from './tools/capture.js';
import { registerListInbox } from './tools/list-inbox.js';
import { registerResolveInbox } from './tools/resolve-inbox.js';
import { registerAttachMedia } from './tools/attach-media.js';
import { registerGetNoteMedia } from './tools/get-note-media.js';
import { registerDeleteNoteMedia } from './tools/delete-note-media.js';
import { registerContactsTools } from './tools/contacts.js';
import { registerDigest } from './tools/digest.js';

// Gate de escopo (spec 17): num PAT com scopes='read', envolve o server num Proxy
// que só deixa passar `registerTool` de tools com `annotations.readOnlyHint === true`.
// As tools de escrita nem chegam a ser registradas — o cliente não as vê no
// tools/list e não há como chamá-las. Robusto: a decisão vem da annotation da própria
// tool (readOnlyHint), não de uma lista paralela que sairia do sincronismo.
function readOnlyGuard(server: any): any {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, config: any, handler: any) => {
          if (config?.annotations?.readOnlyHint === true) {
            return server.registerTool(name, config, handler);
          }
          return undefined; // tool de escrita suprimida no escopo read
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export function registerAllTools(server: any, env: Env, auth: AuthContext): void {
  // Escopo é um CSV (spec 31): 'full' | 'read' | 'full,private' | 'read,private'.
  // Ausente (sessões OAuth) = 'full'. A decisão read-only vem de hasScope(...,'read')
  // — NÃO de igualdade `=== 'read'` (que quebraria com 'read,private'). `reg` é o alvo
  // dos register*: no escopo read é o guarda que dropa as tools de escrita; no full é o
  // próprio server. Tools de escrita recebem `auth` pra gravar autoria; tools de LEITURA
  // recebem `auth` pra computar canSeePrivate (selo de privacidade).
  const readOnly = hasScope(auth.scopes, 'read');
  const reg = readOnly ? readOnlyGuard(server) : server;

  registerSaveNote(reg, env, auth);
  registerUpdateNote(reg, env, auth);
  registerMarkPrivate(reg, env, auth);
  registerDeleteNote(reg, env, auth);
  registerRestoreNote(reg, env, auth);
  registerRecall(reg, env, auth);
  registerExpand(reg, env, auth);
  registerGetNote(reg, env, auth);
  registerLink(reg, env);
  registerDeleteLink(reg, env);
  registerStats(reg, env, auth);
  registerReembed(reg, env);
  // Tasks (migração ClickUp → Brain native): mesmo vault, kind='task'.
  registerSaveTask(reg, env, auth);
  // Read paths de task (spec 59): recebem `auth` pra computar canSeePrivate — task
  // privada some pra credencial sem escopo `private`, igual às notas (spec 31).
  registerListTasksDueToday(reg, env, auth);
  registerListTasks(reg, env, auth);
  registerCompleteTask(reg, env, auth);
  registerUpdateTask(reg, env, auth);
  registerGetTask(reg, env, auth);
  // Comentários em task (thread): agente anota progresso sem sobrescrever o body.
  registerCommentTask(reg, env);
  // Compartilhamento público read-only de task (/s/<token>) — cria/revoga o link.
  registerShareTask(reg, env);
  registerUnshareTask(reg, env);
  // Captura sem fricção + inbox de triagem (spec 50-console-v2/63). As TRÊS são
  // registradas via `reg`: como todas têm readOnlyHint:false (inclusive list_inbox, de
  // propósito — o inbox é superfície pré-triagem do dono), o guarda de escopo `read`
  // SUPRIME as três (fail-closed: só PAT full/dono enxerga/captura no inbox).
  registerCapture(reg, env);
  registerListInbox(reg, env);
  registerResolveInbox(reg, env);
  // Resurfacing digest (spec 50-console-v2/64): mesma razão de list_inbox — conteúdo
  // pessoal, readOnlyHint:false de propósito pra ser suprimido no escopo `read`.
  registerDigest(reg, env, auth);
  // Mídia das notas (R2 + dedup SHA-256). Binding opcional: instalação sem R2
  // habilitado (conta free sem billing) sobe sem as tools de mídia — o setup
  // remove o [[r2_buckets]] do wrangler.toml nesse caso.
  if (env.MEDIA) {
    registerAttachMedia(reg, env);
    registerGetNoteMedia(reg, env);
    registerDeleteNoteMedia(reg, env);
  }
  // Contatos (leitura, todas readOnlyHint:true) — o MCP do Brain lê o vault de
  // Contacts via service binding. Passam pelo guarda read sem serem suprimidas.
  // Recebem `auth` pra propagar o escopo `private` do caller downstream (spec 61).
  registerContactsTools(reg, env, auth);
}
