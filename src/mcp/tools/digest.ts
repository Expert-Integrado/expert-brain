import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolSuccess, canSeePrivate } from '../helpers.js';
import { getResurfaceDigestScoped } from '../../digest/resurface.js';

const DESCRIPTION = `Returns the daily "resurfacing" digest: what the vault wants to remind the owner of TODAY, without being asked. Same content the owner already gets once a day via the Telegram cron — call this when the user asks something like "what does my brain want me to remember today?" or "what am I forgetting?".

Four capped sections (never more than a handful of items total): open_questions (kind='question' notes untouched for 30+ days — oldest first), stale_central_notes (highly-connected knowledge notes that went cold for 90+ days — a small weekly-rotating sample, so it varies week to week without being random), cooling_contacts (contacts with a category who haven't been contacted in 60+ days — degrades gracefully to empty with contacts_degraded:true if the Contacts vault is unreachable, never errors), inbox_pending_over_7d (count of capture-inbox items still untriaged after a week; null if the inbox feature isn't available).

Each note/contact item carries a url to open it directly in the console. Read-only, but intentionally NOT exposed to read-scoped credentials (fail-closed, same reasoning as list_inbox) — this is a personal, owner-facing surface.`;

export function registerDigest(server: any, env: Env, auth: AuthContext): void {
  // readOnlyHint FALSE de propósito (mesmo padrão de list_inbox, spec 63): o
  // conteúdo é pessoal (títulos/tldr de nota, nomes de contato) — suprimido num
  // PAT `read` pelo guarda de escopo do registry (spec 17). Ver critério 5 da
  // spec 64.
  server.registerTool(
    'digest',
    {
      description: DESCRIPTION,
      inputSchema: {},
      annotations: { title: 'Resurfacing digest', resource: 'notes', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async () => {
      // canSeePrivate (spec 31): PAT `full` sem o escopo `private` nunca vê o
      // cache do dono (que pode carregar nota/contato privado) — computa fresco
      // com includePrivate=false. Dono (sessão OAuth) e PAT com `private` leem o
      // cache normal (TTL 20h).
      const digest = await getResurfaceDigestScoped(env, Date.now(), canSeePrivate(auth));
      return toolSuccess(digest);
    }) as any
  );
}
