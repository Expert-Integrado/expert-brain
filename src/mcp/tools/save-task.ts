import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { newId } from '../../util/id.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl, writeActor, canSeePrivate } from '../helpers.js';
import { TASK_STATUSES, type TaskStatus, insertTask, insertTags, findActiveTaskByTag, findSimilarActiveTasksByTitle, getNoteById, listMentionsForNote } from '../../db/queries.js';
import { hasScope, SCOPE_NOTES_NONE, SCOPE_CONTACTS_NONE } from '../../auth/api-keys.js';
import { validateDomains } from '../../db/validation.js';
import { parseDueToMs, formatBrtDateTime } from '../../util/time.js';
import { resolveProjectForWrite } from './project-ref.js';
import { resolveAssigneeRefs, toAssigneeRef, resolveMe, resolveTaskVis } from './user-ref.js';
import { produceAssignmentMailbox } from '../../db/mailbox.js';
import { setTaskAssignees, type BrainUser } from '../../db/queries.js';
import { applyMentions } from '../mentions.js';
import { addTaskSubtasks, subtaskProgress, type TaskSubtask } from '../../db/subtasks.js';
import { logTaskActivity } from '../../db/task-activity.js';

// Título truncado no log de atividade — mesmo teto do update_subtask (spec 38).
const SUBTASK_LOG_MAX = 80;

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
  project: z.string().min(1).max(40).optional().describe(
    "Optional PROJECT (folder) — a single-valued grouping axis, distinct from tags (which are multi/transversal). Accepts a project id (proj_...) or a label (case-insensitive). A label with no match AUTO-CREATES the project; REUSE existing labels (the response echoes the resolved project). Archived projects are not assignable. To create the task WITHOUT a project, omit this."
  ),
  dedupe_key: z.string().min(1).max(120).optional().describe(
    'Optional stable idempotency key. Pass a value derived from the source (e.g. an email id, a card id) when the SAME task could be created twice across sessions or on a network retry. If an ACTIVE task with this key already exists, no duplicate is created — the existing task is returned with deduped:true.'
  ),
  private: z.boolean().optional().describe(
    'Set true to create the task PRIVATE: invisible via list_tasks / list_tasks_due_today / get_task to any credential without the `private` scope (including a `full` PAT), and it can NEVER have a public /s/<token> link. Un-marking is only possible in the logged-in owner UI. Default false (public).'
  ),
  mentions: z.array(z.string().min(1)).optional().describe(
    'Optional CONTACT entity ids this task is about (people/companies from the Contacts vault). Get the id FIRST via get_contact_by_phone / search_contacts — never a free-text name. Each mention shows the task on the contact\'s page ("Tarefas com esta pessoa") and fires a `mentioned_in_brain` event on the contact\'s timeline.'
  ),
  origin_note_id: z.string().min(1).optional().describe(
    'Optional id of the NOTE that originated this task ("create a task from this note"). Records provenance (why this task exists). When set and `mentions` is omitted, the task INHERITS the origin note\'s mentions. The note must exist.'
  ),
  assignees: z.array(z.string().min(1)).max(16).optional().describe(
    'Optional RESPONSIBLE users (assignees): refs by user id (user_...), name (case-insensitive), or "me" (the profile linked to the credential making this call). Decide per task: a manual human errand → the person; agent work → the agent; both when they share it. Users are NEVER auto-created (the owner manages them at /app/config); an unknown ref errors listing the available users. Discover them via list_users.'
  ),
  subtasks: z.array(z.string().min(1).max(200)).max(50).optional().describe(
    'Optional CHECKLIST items (subtasks), in order (1-200 chars each). MULTI-PART WORK = ONE CARD: several deliverables (specs, steps, files) become ONE task with subtasks — NEVER N sibling tasks. The board card then shows "3/8" progress. Tick items later via update_subtask.'
  ),
  allow_new_domain: z.boolean().optional(),
};

const DESCRIPTION = `Creates an actionable TASK (a to-do) in the vault.

A task is stored as a note with kind='task' plus status/due/priority — it lives in the SAME vault but is kept OUT of the knowledge graph and recall (it is operational, not an idea). Use this for "I have to X by Y", "remind me to Z", "create a task for W". For ideas/decisions/insights use save_note instead.

Behavior:
- No edges, no recall sweep, no Feynman tldr required — a task is just an action with optional due/priority.
- Default status is 'open', default domain is ['operations'].
- Optional \`project\` (folder): a single-valued grouping (id or label). A new label auto-creates the project; REUSE existing labels. Distinct from tags (multi/transversal). The response echoes the resolved project.
- Pass the due date in BRT via \`due\` (e.g. "2026-06-22 14:00"). Date-only means "by end of that day".
- Tasks do NOT get embedded — they never show up in recall(), the graph, or the notes list. Manage them on the /app/tasks board or via list_tasks_due_today / complete_task.
- Optional \`assignees\` (responsible users): refs by id/name/"me". Decide per task — human errand → the person; agent work → the agent; both when shared. The creator credential is always recorded separately (created_by audit trail), independent of assignees. Discover users via list_users.
- Optional \`subtasks\` (checklist): when the work has several parts, create ONE task with subtasks instead of N sibling tasks — the card shows "3/8" progress. Tick/adjust later via update_subtask; completing the task does NOT auto-check the list.

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
  project?: string;
  dedupe_key?: string;
  private?: boolean;
  mentions?: string[];
  origin_note_id?: string;
  assignees?: string[];
  subtasks?: string[];
  allow_new_domain?: boolean;
}

export function registerSaveTask(server: any, env: Env, auth: AuthContext): void {
  server.registerTool(
    'save_task',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Create a task',
        resource: 'tasks',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: SaveTaskInput) => {
      const domains = input.domains ?? ['operations'];
      const domainError = validateDomains(domains, { allowNewDomain: input.allow_new_domain ?? false });
      if (domainError) return toolError(domainError);

      // Superfícies restritas (spec 91), checadas ANTES de qualquer leitura/escrita:
      // - notes:none: origin_note_id é rejeitado — o param é um oráculo de nota (erro
      //   "not found" vs sucesso revela existência) e herda menções de uma nota que a
      //   credencial não pode ler.
      // - contacts:none: mentions são rejeitadas — entity ids vêm do vault de Contacts,
      //   que esta credencial não acessa.
      if (hasScope(auth.scopes, SCOPE_NOTES_NONE) && input.origin_note_id !== undefined) {
        return toolError(
          'This credential has no access to notes (scope notes:none), so `origin_note_id` is not allowed. ' +
          'Retry WITHOUT it.'
        );
      }
      if (hasScope(auth.scopes, SCOPE_CONTACTS_NONE) && (input.mentions?.length ?? 0) > 0) {
        return toolError(
          'This credential has no access to the Contacts vault (scope contacts:none), so `mentions` is not ' +
          'allowed. Retry WITHOUT it.'
        );
      }

      // Visibilidade row-level (spec 91): usada no dedupe e no aviso de duplicata —
      // colisão com task INVISÍVEL cria task nova sem ecoar a existente.
      const visR = await resolveTaskVis(env, auth);
      if (!visR.ok) return toolError(visR.error);
      const vis = visR.vis;

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
        const existing = await findActiveTaskByTag(env, dedupeTag, vis);
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
          const sims = await findSimilarActiveTasksByTitle(env, title, vis);
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

      // Projeto (spec 58): resolve o ref (id/label) num project_id, auto-criando o
      // projeto se o label for novo. Roda DEPOIS do dedupe (uma criação deduplicada
      // não deve auto-criar projeto) e ANTES do insert (erro de projeto = não cria a
      // task). project omitido → sem projeto.
      let projectId: string | null = null;
      let resolvedProject: { id: string; label: string } | null = null;
      if (input.project !== undefined) {
        const pr = await resolveProjectForWrite(env, input.project, now);
        if (!pr.ok) return toolError(pr.error);
        projectId = pr.projectId;
        resolvedProject = pr.project ? { id: pr.project.id, label: pr.project.label } : null;
      }

      // Origem (spec 62): "Criar task desta nota". Valida que a nota existe ANTES do
      // insert (a coluna origin_note_id referencia notes(id)) — erro claro em vez de
      // FK/menção órfã. Herda as menções da nota de origem quando `mentions` foi omitido.
      let originNoteId: string | null = null;
      let mentionIds: string[] = input.mentions ?? [];
      if (input.origin_note_id !== undefined) {
        const origin = await getNoteById(env, input.origin_note_id, false, canSeePrivate(auth));
        if (!origin) {
          return toolError(
            `origin_note_id '${input.origin_note_id}' not found. Pass the id of an existing note (the one this task comes from).`
          );
        }
        originNoteId = origin.id;
        if (input.mentions === undefined) {
          const inherited = await listMentionsForNote(env, origin.id);
          mentionIds = inherited.map((m) => m.entity_id);
        }
      }

      // Responsáveis (spec 37): resolve ANTES do insert — ref inválida (typo,
      // usuário arquivado, 'me' sem perfil vinculado) aborta sem criar a task.
      // NUNCA auto-cria usuário (identidade é ato deliberado do dono no console).
      let assignedUsers: BrainUser[] = [];
      if (input.assignees !== undefined && input.assignees.length > 0) {
        const ar = await resolveAssigneeRefs(env, input.assignees, auth);
        if (!ar.ok) return toolError(ar.error);
        assignedUsers = ar.users;
      }

      // Checklist (spec 38): valida ANTES do insert — item vazio aborta sem criar a task.
      const subtaskTitles = (input.subtasks ?? []).map((t) => t.trim());
      const emptySub = subtaskTitles.findIndex((t) => t.length === 0);
      if (emptySub !== -1) {
        return toolError(`subtasks[${emptySub}] is empty after trimming. Each item needs 1-200 chars.`);
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
        project_id: projectId,
        // Selo de privacidade (spec 59): nasce privada quando pedido.
        private: input.private ? 1 : 0,
        // Origem (spec 62): nota que originou a task.
        origin_note_id: originNoteId,
        created_at: now,
        updated_at: now,
      }, writeActor(auth));

      const allTags = [...(input.tags ?? [])];
      if (dedupeTag) allTags.push(dedupeTag);
      if (allTags.length > 0) await insertTags(env, id, allTags);

      // Checklist (spec 38): itens nascem com a task, na ordem passada. O cap de 100
      // é inatingível aqui (schema limita a 50 e a task é recém-criada).
      let createdSubtasks: TaskSubtask[] = [];
      if (subtaskTitles.length > 0) {
        const created = await addTaskSubtasks(env, id, subtaskTitles, writeActor(auth), now);
        if (created !== 'cap-exceeded') {
          createdSubtasks = created;
          await logTaskActivity(env, id, writeActor(auth), created.map((s) => ({
            field: 'subtask' as const, old_value: 'adicionada', new_value: s.title.slice(0, SUBTASK_LOG_MAX),
          })));
        }
      }

      // Responsáveis (spec 37): grava os vínculos resolvidos acima.
      if (assignedUsers.length > 0) {
        await setTaskAssignees(env, id, assignedUsers.map((u) => u.id), now);
        // Mailbox (spec 82): item 'assignment' pra cada atribuído ≠ ator. Best-effort
        // por construção — a task já está commitada. Ator = perfil da credencial
        // (null quando o PAT não tem vínculo: todos os atribuídos recebem).
        const actor = await resolveMe(env, auth);
        await produceAssignmentMailbox(env, {
          taskId: id, addedUserIds: assignedUsers.map((u) => u.id),
          actorUserId: actor?.id ?? null, now,
        });
      }

      // Menções (spec 62): explícitas ou herdadas da nota de origem. Tolerante a falha
      // do contacts (a menção D1 grava; o evento na timeline é eco).
      let mentionsCreated = 0;
      if (mentionIds.length > 0) {
        const r = await applyMentions(env, {
          noteId: id,
          title,
          url: noteUrl(env, id),
          add: mentionIds,
          seePrivate: canSeePrivate(auth),
          notePrivate: input.private === true,
        });
        mentionsCreated = r.created;
      }

      const out: Record<string, unknown> = {
        id,
        url: noteUrl(env, id),
        board: `${(env.WORKER_URL ?? '').replace(/\/$/, '')}/app/tasks`,
        title,
        status,
        priority: input.priority ?? null,
        due_at: dueMs,
        due_brt: dueMs !== null ? formatBrtDateTime(dueMs) : null,
        project: resolvedProject,
        private: input.private === true,
        origin_note_id: originNoteId,
        assignees: assignedUsers.map(toAssigneeRef),
        mentions_created: mentionsCreated,
        updated_at: now,
      };
      if (createdSubtasks.length > 0) {
        out.subtasks = createdSubtasks.map((s) => ({ id: s.id, title: s.title, done: false, position: s.position }));
        out.subtask_progress = subtaskProgress(createdSubtasks);
      }
      if (possibleDuplicates.length > 0) {
        out.possible_duplicates = possibleDuplicates;
        out.possible_duplicates_note =
          'A task with a similar title is already open. If one of these is the same task, delete this one and use update_task on the existing id.';
      }
      return toolSuccess(out);
    }) as any
  );
}
