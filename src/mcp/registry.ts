import type { Env, AuthContext } from '../env.js';
import { hasScope, SCOPE_NOTES_NONE, SCOPE_CONTACTS_NONE, SCOPE_TASKS_ASSIGNED } from '../auth/api-keys.js';
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
import { registerUpdateSubtask } from './tools/update-subtask.js';
import { registerUpdateTaskDeps } from './tools/update-task-deps.js';
import { registerClaimTask } from './tools/claim-task.js';
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
import { registerListUsers } from './tools/list-users.js';
import { registerCheckMailbox } from './tools/check-mailbox.js';
import { registerAckMailbox } from './tools/ack-mailbox.js';

// Gate de escopo em tempo de REGISTRO (specs 17 + 91): envolve o server num Proxy
// que decide por annotation da própria tool — nunca por lista paralela que sairia
// do sincronismo. Tool não permitida NEM É REGISTRADA: o cliente não a vê no
// tools/list e não há como chamá-la (não-permitido = invisível, não "erro 403").
// Duas dimensões:
//  - readOnlyHint (spec 17): escopo base 'read' suprime toda tool de escrita.
//  - resource (spec 91): tokens subtrativos removem famílias inteiras —
//    notes:none derruba 'notes' e 'notes.*' (mídia junto: mídia herda a
//    visibilidade da nota dona); contacts:none derruba 'contacts';
//    tasks:assigned derruba 'tasks.share' (link público /s/ = exfiltração,
//    capacidade de dono/frota confiável, nunca de robô row-restrito).
// FAIL-CLOSED: sob credencial restrita, tool SEM annotations.resource é
// suprimida com warning — tool nova que esquecer de declarar o recurso não
// vaza pra credencial restrita (o snapshot em test/registry-scope.test.ts
// quebra e aponta o esquecimento).
// Exportado só pro teste direto do fail-closed (test/registry-scope.test.ts) —
// produção entra sempre por registerAllTools.
export function scopeGuard(server: any, scopes: string | undefined): any {
  const readOnly = hasScope(scopes, 'read');
  const noNotes = hasScope(scopes, SCOPE_NOTES_NONE);
  const noContacts = hasScope(scopes, SCOPE_CONTACTS_NONE);
  const assignedOnly = hasScope(scopes, SCOPE_TASKS_ASSIGNED);
  const restricted = noNotes || noContacts || assignedOnly;
  if (!readOnly && !restricted) return server; // fast path: credencial sem restrição = server cru (comportamento histórico)
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, config: any, handler: any) => {
          if (readOnly && config?.annotations?.readOnlyHint !== true) {
            return undefined; // tool de escrita suprimida no escopo read (spec 17, intocado)
          }
          if (restricted) {
            const res: string | undefined = config?.annotations?.resource;
            if (res === undefined) {
              console.warn(`scopeGuard: tool '${name}' sem annotations.resource — suprimida (fail-closed) pra credencial restrita`);
              return undefined;
            }
            if (noNotes && (res === 'notes' || res.startsWith('notes.'))) return undefined;
            if (noContacts && (res === 'contacts' || res.startsWith('contacts.'))) return undefined;
            if (assignedOnly && res === 'tasks.share') return undefined;
          }
          return server.registerTool(name, config, handler);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

export function registerAllTools(server: any, env: Env, auth: AuthContext): void {
  // Escopo é um CSV (specs 31 + 91): base 'full'|'read' + aditivo 'private' +
  // subtrativos 'notes:none'/'contacts:none'/'tasks:assigned'. Ausente (sessões
  // OAuth) = 'full'. Decisões sempre via hasScope(...) — NUNCA igualdade de string
  // (quebraria com CSV composto). `reg` é o alvo dos register*: o scopeGuard decide
  // por annotation (readOnlyHint + resource) o que cada credencial enxerga. Tools de
  // escrita recebem `auth` pra gravar autoria; tools de LEITURA recebem `auth` pra
  // computar canSeePrivate (selo de privacidade) e a visibilidade row-level de task.
  const reg = scopeGuard(server, auth.scopes);

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
  // Usuários/responsáveis (spec 37): lista os perfis atribuíveis (pessoa e agente).
  // readOnlyHint:true — passa pelo guarda de escopo read. Recebe `auth` pro is_me.
  registerListUsers(reg, env, auth);
  // Comentários em task (thread): agente anota progresso sem sobrescrever o body.
  // Recebe `auth` (spec 81): a autoria é assinada pela credencial via resolveMe —
  // PAT sem perfil vinculado é rejeitado fail-closed no call.
  registerCommentTask(reg, env, auth);
  // Checklist de task (spec 38): trabalho multi-parte = UM card com subtarefas
  // tickáveis ("3/8" no board), nunca N cards irmãos. Escrita — suprimida no read.
  registerUpdateSubtask(reg, env, auth);
  // Dependências entre tasks (spec 93): "task X bloqueada por task Y" — cards
  // separados que precisam de ordem, distinto do checklist (uma task só). Escrita —
  // suprimida no escopo read.
  registerUpdateTaskDeps(reg, env, auth);
  // Claim/lease de task (spec 88): posse temporária pra frota — atômico, expira
  // sozinho. Escrita (readOnlyHint:false) — suprimida no escopo read pelo guarda.
  registerClaimTask(reg, env, auth);
  // Mailbox por agente (spec 82): fila de menções/atribuições endereçadas ao perfil
  // da credencial. Registradas SEMPRE (PAT sem vínculo recebe erro instrutivo no call
  // — descoberta > sumiço silencioso). check_mailbox passa no escopo read
  // (readOnlyHint:true); ack_mailbox é escrita e o guarda a suprime no read.
  registerCheckMailbox(reg, env, auth);
  registerAckMailbox(reg, env, auth);
  // Compartilhamento público read-only de task (/s/<token>) — cria/revoga o link.
  // Recebem `auth` (spec 91): pre-check de kind='task' + visibilidade do caller.
  registerShareTask(reg, env, auth);
  registerUnshareTask(reg, env, auth);
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
