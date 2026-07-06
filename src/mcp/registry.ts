import type { Env } from '../env.js';
import { registerSaveNote } from './tools/save-note.js';
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
import { registerAttachMedia } from './tools/attach-media.js';
import { registerGetNoteMedia } from './tools/get-note-media.js';
import { registerDeleteNoteMedia } from './tools/delete-note-media.js';
import { registerContactsTools } from './tools/contacts.js';

export function registerAllTools(server: any, env: Env): void {
  registerSaveNote(server, env);
  registerUpdateNote(server, env);
  registerDeleteNote(server, env);
  registerRestoreNote(server, env);
  registerRecall(server, env);
  registerExpand(server, env);
  registerGetNote(server, env);
  registerLink(server, env);
  registerDeleteLink(server, env);
  registerStats(server, env);
  registerReembed(server, env);
  // Tasks (migração ClickUp → Brain native): mesmo vault, kind='task'.
  registerSaveTask(server, env);
  registerListTasksDueToday(server, env);
  registerListTasks(server, env);
  registerCompleteTask(server, env);
  registerUpdateTask(server, env);
  registerGetTask(server, env);
  // Comentários em task (thread): agente anota progresso sem sobrescrever o body.
  registerCommentTask(server, env);
  // Compartilhamento público read-only de task (/s/<token>) — cria/revoga o link.
  registerShareTask(server, env);
  registerUnshareTask(server, env);
  // Mídia das notas (R2 + dedup SHA-256). Binding opcional: instalação sem R2
  // habilitado (conta free sem billing) sobe sem as tools de mídia — o setup
  // remove o [[r2_buckets]] do wrangler.toml nesse caso.
  if (env.MEDIA) {
    registerAttachMedia(server, env);
    registerGetNoteMedia(server, env);
    registerDeleteNoteMedia(server, env);
  }
  // Contatos (leitura) — mesmo MCP do Brain lê o vault de Contacts via service binding.
  registerContactsTools(server, env);
}
