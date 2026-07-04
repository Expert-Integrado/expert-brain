import { z } from 'zod';
import type { Env } from '../../env.js';
import { newId } from '../../util/id.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl } from '../helpers.js';
import { TASK_STATUSES, type TaskStatus, insertTask, insertTags, findActiveTaskByTag, findSimilarActiveTasksByTitle } from '../../db/queries.js';
import { validateDomains } from '../../db/validation.js';
import { parseDueToMs, formatBrtDateTime } from '../../util/time.js';

const inputSchema = {
  title: z.string().min(1).max(200).describe('What needs to be done — short, action-first. Becomes the task card title.'),
  details: z.string().optional().describe('Optional longer description / context (markdown).'),
  due: z.string().optional().describe(
    'Optional due date/time in BRT (America/Sao_Paulo). Accepts ISO ("2026-06-22T14:00"), "2026-06-22 14:00", or date-only "2026-06-22" (treated as end of that day). Prefer passing this OVER due_at. Cannot be passed together with due_at.'
  ),
  due_at: z.number().int().optional().describe('Optional due timestamp as unix epoch MILLISECONDS. Only use if you already have the exact epoch; otherwise pass `due`. Cannot be passed together with due.'),
  priority: z.number().int().min(1).max(4).optional().describe('Optional priority 1 (highest) to 4 (lowest).'),
  status: z.enum(TASK_STATUSES).optional().describe("Initial status. Default 'open'."),
  domains: z.array(z.string().min(1)).min(1).max(3).optional().describe("Canonical English slugs (1-3). Default ['operations']."),
  tags: z.array(z.string()).optional().describe('Optional tags (e.g. contact/company names mentioned).'),
  dedupe_key: z.string().min(1).max(120).optional().describe(
    'Optional stable idempotency key. Pass a value derived from the source (e.g. an email id, a card id) when the SAME task could be created twice across sessions or on a network retry. If an ACTIVE task with this key already exists, no duplicate is created — the existing task is returned with deduped:true.'
  ),
  allow_new_domain: z.boolean().optional(),
};

const DESCRIPTION = `Creates an actionable TASK (a to-do) in the vault.

A task is stored as a note with kind='task' plus status/due/priority — it lives in the SAME vault but is kept OUT of the knowledge graph and recall (it is operational, not an idea). Use this for "I have to X by Y", "remind me to Z", "create a task for W". For ideas/decisions/insights use save_note instead.

Behavior:
- No edges, no recall sweep, no Feynman tldr required — a task is just an action with optional due/priority.
- Default status is 'open', default domain is ['operations'].
- Pass the due date in BRT via \`due\` (e.g. "2026-06-22 14:00"). Date-only means "by end of that day".
- Tasks do NOT get embedded — they never show up in recall(), the graph, or the notes list. Manage them on the /app/tasks board or via list_tasks_due_today / complete_task.

DEDUPE:
- Pass a stable \`dedupe_key\` (derived from the source, e.g. an email/card id) when the same task could be created twice (across sessions or on retries). If an ACTIVE task with that key exists, save_task returns it with deduped:true instead of creating a duplicate. The key is stored as a reserved dedupe: tag and survives update_task retags.
- WITHOUT a dedupe_key, save_task still runs a cheap title check against open tasks and returns \`possible_duplicates\` (id/title/status/due) when it finds near-matches — it does NOT block; you decide whether to delete this one and update_task the existing id.

Returns the task id, its board url, the parsed due (BRT), and updated_at (use it as expected_updated_at for later optimistic edits).`;

interface SaveTaskInput {
  title: string;
  details?: string;
  due?: string;
  due_at?: number;
  priority?: number;
  status?: TaskStatus;
  domains?: string[];
  tags?: string[];
  dedupe_key?: string;
  allow_new_domain?: boolean;
}

export function registerSaveTask(server: any, env: Env): void {
  server.registerTool(
    'save_task',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Create a task',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: SaveTaskInput) => {
      const domains = input.domains ?? ['operations'];
      const domainError = validateDomains(domains, { allowNewDomain: input.allow_new_domain ?? false });
      if (domainError) return toolError(domainError);

      // due + due_at simultâneos: erro em vez de reconciliar silenciosamente (o
      // agente acharia que gravou um e gravou o outro). Ver spec 15.
      if (typeof input.due_at === 'number' && input.due !== undefined) {
        return toolError('Pass either due (BRT string) or due_at (unix ms), not both.');
      }

      let dueMs: number | null = null;
      if (typeof input.due_at === 'number') {
        dueMs = input.due_at;
      } else if (input.due) {
        dueMs = parseDueToMs(input.due);
        if (dueMs === null) {
          return toolError(
            `Could not parse due "${input.due}". Use BRT formats like "2026-06-22T14:00", "2026-06-22 14:00", or "2026-06-22" (date only). Or pass due_at as unix ms.`
          );
        }
      }

      const now = Date.now();
      const status = input.status ?? 'open';
      const title = input.title.trim();
      const body = (input.details ?? '').trim() || title;

      // DEDUPE forte por dedupe_key (tag reservada dedupe:<key>). Se já existe uma
      // task ATIVA com essa key, não cria: devolve a existente com deduped:true.
      // Retry da mesma chamada vira no-op seguro. Check-then-insert não é atômico
      // sem UNIQUE (janela residual de ms, aceitável — o alvo é retry/convenção,
      // não corrida adversarial). Ver spec 14.
      // Tag normalizada em lowercase pra bater com a normalização de insertTags
      // (spec 15): senão o lookup por dedupe:Card-ABC não acharia dedupe:card-abc.
      const dedupeTag = input.dedupe_key ? `dedupe:${input.dedupe_key}`.trim().toLowerCase() : null;
      if (dedupeTag) {
        const existing = await findActiveTaskByTag(env, dedupeTag);
        if (existing) {
          return toolSuccess({
            deduped: true,
            id: existing.id,
            url: noteUrl(env, existing.id),
            board: `${(env.WORKER_URL ?? '').replace(/\/$/, '')}/app/tasks`,
            title: existing.title,
            status: existing.status,
            priority: existing.priority,
            due_at: existing.due_at,
            due_brt: existing.due_at !== null ? formatBrtDateTime(existing.due_at) : null,
            updated_at: existing.updated_at,
          });
        }
      }

      // Aviso barato por título (SEM dedupe_key): não bloqueia, só sinaliza. Em
      // try/catch de propósito: a checagem de duplicata é um "nice to have" — se
      // ela falhar por qualquer motivo (D1 momentaneamente instável, título com
      // só pontuação/sem token indexável, etc.), a criação da task é MAIS
      // importante que o aviso, então a exceção é engolida e logada em vez de
      // derrubar o save_task inteiro (que cairia no catch genérico do
      // safeToolHandler e devolveria "Internal error" sem nada ser salvo).
      let possibleDuplicates: Array<{ id: string; title: string; status: string | null; due_brt: string | null }> = [];
      if (!dedupeTag) {
        try {
          const sims = await findSimilarActiveTasksByTitle(env, title);
          possibleDuplicates = sims.map((s) => ({
            id: s.id,
            title: s.title,
            status: s.status,
            due_brt: s.due_at !== null ? formatBrtDateTime(s.due_at) : null,
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('save_task: findSimilarActiveTasksByTitle failed, continuing without duplicate check:', msg);
        }
      }

      const id = newId();
      // Task nascendo fechada (done/canceled) stampa completed_at — preserva o
      // invariante "fechada ⇒ completed_at preenchido". Ver spec 14 item 4 (opção A).
      const closing = status === 'done' || status === 'canceled';

      await insertTask(env, {
        id,
        title,
        body,
        tldr: title.slice(0, 280),
        domains: JSON.stringify(domains),
        status,
        due_at: dueMs,
        priority: input.priority ?? null,
        completed_at: closing ? now : null,
        created_at: now,
        updated_at: now,
      });

      const allTags = [...(input.tags ?? [])];
      if (dedupeTag) allTags.push(dedupeTag);
      if (allTags.length > 0) await insertTags(env, id, allTags);

      const out: Record<string, unknown> = {
        id,
        url: noteUrl(env, id),
        board: `${(env.WORKER_URL ?? '').replace(/\/$/, '')}/app/tasks`,
        title,
        status,
        priority: input.priority ?? null,
        due_at: dueMs,
        due_brt: dueMs !== null ? formatBrtDateTime(dueMs) : null,
        updated_at: now,
      };
      if (possibleDuplicates.length > 0) {
        out.possible_duplicates = possibleDuplicates;
        out.possible_duplicates_note =
          'A task with a similar title is already open. If one of these is the same task, delete this one and use update_task on the existing id.';
      }
      return toolSuccess(out);
    }) as any
  );
}
