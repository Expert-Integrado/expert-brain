import type { Env } from '../env.js';
import { registerSaveNote } from './tools/save-note.js';
import { registerRecall } from './tools/recall.js';
import { registerExpand } from './tools/expand.js';
import { registerGetNote } from './tools/get-note.js';
import { registerLink } from './tools/link.js';
import { registerReembed } from './tools/reembed.js';
import { registerUpdateNote } from './tools/update-note.js';
import { registerDeleteNote } from './tools/delete-note.js';
import { registerStats } from './tools/stats.js';

export function registerAllTools(server: any, env: Env): void {
  registerSaveNote(server, env);
  registerUpdateNote(server, env);
  registerDeleteNote(server, env);
  registerRecall(server, env);
  registerExpand(server, env);
  registerGetNote(server, env);
  registerLink(server, env);
  registerStats(server, env);
  registerReembed(server, env);
}
