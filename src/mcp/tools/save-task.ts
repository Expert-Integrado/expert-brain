import { z } from 'zod';
import type { Env } from '../../env.js';
import { newId } from '../../util/id.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl } from '../helpers.js';
import { TASK_STATUSES, type TaskStatus, insertTask, insertTags } from '../../db/queries.js';
import { validateDomains } from '../../db/validation.js';
import { parseDueToMs, formatBrtDateTime } from '../../util/time.js';

const inputSchema = {
  title: z.string().min(1).max(200).describe('What needs to be done — short, action-first. Becomes the task card title.'),
  details: z.string().optional().describe('Optional longer description / context (markdown).'),
  due: z.string().optional().describe(
    'Optional due date/time in BRT (America/Sao_Paulo). Accepts ISO ("2026-06-22T14:00"), "2026-06-22 14:00", or date-only "2026-06-22" (treated as end of that day). Prefer passing this OVER due_at.'
  ),
  due_at: z.number().int().optional().describe('Optional due timestamp as unix epoch MILLISECONDS. Only use if you already have the exact epoch; otherwise pass `due`.'),
  priority: z.number().int().min(1).max(4).optional().describe('Optional priority 1 (highest) to 4 (lowest).'),
  status: z.enum(TASK_STATUSES).optional().describe("Initial status. Default 'open'."),
  domains: z.array(z.string().min(1)).min(1).max(3).optional().describe("Canonical English slugs (1-3). Default ['operations']."),
  tags: z.array(z.string()).optional().describe('Optional tags (e.g. contact/company names mentioned).'),
  allow_new_domain: z.boolean().optional(),
};

const DESCRIPTION = `Creates an actionable TASK (a to-do) in the vault.

A task is stored as a note with kind='task' plus status/due/priority — it lives in the SAME vault but is kept OUT of the knowledge graph and recall (it is operational, not an idea). Use this for "I have to X by Y", "remind me to Z", "create a task for W". For ideas/decisions/insights use save_note instead.

Behavior:
- No edges, no recall sweep, no Feynman tldr required — a task is just an action with optional due/priority.
- Default status is 'open', default domain is ['operations'].
- Pass the due date in BRT via \`due\` (e.g. "2026-06-22 14:00"). Date-only means "by end of that day".
- Tasks do NOT get embedded — they never show up in recall(), the graph, or the notes list. Manage them on the /app/tasks board or via list_tasks_due_today / complete_task.

Returns the task id, its board url, and the parsed due (BRT) so you can confirm to the user.`;

interface SaveTaskInput {
  title: string;
  details?: string;
  due?: string;
  due_at?: number;
  priority?: number;
  status?: TaskStatus;
  domains?: string[];
  tags?: string[];
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
      const id = newId();
      const title = input.title.trim();
      const body = (input.details ?? '').trim() || title;

      await insertTask(env, {
        id,
        title,
        body,
        tldr: title.slice(0, 280),
        domains: JSON.stringify(domains),
        status: input.status ?? 'open',
        due_at: dueMs,
        priority: input.priority ?? null,
        created_at: now,
        updated_at: now,
      });

      if (input.tags && input.tags.length > 0) await insertTags(env, id, input.tags);

      return toolSuccess({
        id,
        url: noteUrl(env, id),
        board: `${(env.WORKER_URL ?? '').replace(/\/$/, '')}/app/tasks`,
        title,
        status: input.status ?? 'open',
        priority: input.priority ?? null,
        due_at: dueMs,
        due_brt: dueMs !== null ? formatBrtDateTime(dueMs) : null,
      });
    }) as any
  );
}
