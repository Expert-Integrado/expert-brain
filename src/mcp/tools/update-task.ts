import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl, writeActor, canSeePrivate } from '../helpers.js';
import { TASK_STATUSES, type TaskStatus, type TaskPatch, type TaskRow, updateTask, getTaskById, getProjectById, setTaskPrivate, listKanbanColumns, moveTaskToColumn } from '../../db/queries.js';
import { OWNER_TASK_VIS } from '../../auth/visibility.js';
import { hasScope, SCOPE_CONTACTS_NONE } from '../../auth/api-keys.js';
import { validateDomains } from '../../db/validation.js';
import { parseDueToMs, formatBrtDateTime } from '../../util/time.js';
import { resolveProjectForWrite } from './project-ref.js';
import { resolveAssigneeRefs, toAssigneeRef, resolveMe, resolveTaskVis } from './user-ref.js';
import { produceAssignmentMailbox } from '../../db/mailbox.js';
import { setTaskAssignees, listAssigneesForTask, type BrainUser } from '../../db/queries.js';
import { applyMentions } from '../mentions.js';

const inputSchema = {
  id: z.string().min(1).describe('The task id to edit (from save_task / list_tasks_due_today / the /app/tasks board).'),
  title: z.string().min(1).max(200).optional().describe('New title. Also updates the task tldr (which mirrors the title).'),
  details: z.string().optional().describe('New body/details (markdown). REPLACES the existing body — to append context, pass the full new body.'),
  due: z.string().optional().describe(
    'New due date/time in BRT. Accepts ISO ("2026-06-22T14:00"), "2026-06-22 14:00", or date-only "2026-06-22" (end of that day). Pass "none" (or "clear") to REMOVE the due date. Prefer this OVER due_at. Cannot be passed together with due_at.'
  ),
  due_at: z.number().int().optional().describe('New due timestamp as unix epoch MILLISECONDS. Only use if you already have the exact epoch; otherwise pass `due`. Cannot be passed together with due.'),
  priority: z.union([z.number().int().min(1).max(4), z.null()]).optional().describe('New priority 1 (highest) to 4 (lowest). Pass null to REMOVE the priority.'),
  status: z.enum(TASK_STATUSES).optional().describe("New status. done/canceled stamp completed_at=now; reopening (open/in_progress) clears it. To finish a task with an outcome note, prefer complete_task. Cannot be combined with `stage` (the stage's column already defines the status)."),
  stage: z.string().min(1).max(80).optional().describe(
    'Move the task to a BOARD COLUMN (visual stage) by column id (col_...) or label (case-insensitive), e.g. "Validação humana". The status is aligned to the column\'s category automatically (same as dragging on the /app/tasks board) — so do NOT pass status together with stage. Use this to hand agent-finished work to the human-validation column instead of completing it.'
  ),
  domains: z.array(z.string().min(1)).min(1).max(3).optional().describe('New canonical English slugs (1-3).'),
  tags: z.array(z.string()).optional().describe('New tags — REPLACES all existing tags. Pass [] to clear. Reserved dedupe: tags are preserved automatically unless you pass a new dedupe: tag explicitly.'),
  project: z.string().max(40).optional().describe(
    "Move the task to a PROJECT (folder). Accepts a project id (proj_...) or label (case-insensitive); a new label AUTO-CREATES the project. Pass an EMPTY string \"\" to remove the task from its project. Archived projects are not assignable. Distinct from tags (multi/transversal)."
  ),
  expected_updated_at: z.number().int().optional().describe(
    'Optimistic concurrency (optional): pass the `updated_at` you last read (from list_tasks / get_task / a prior write). The edit is applied only if the task has NOT changed since; if it changed, the call fails with a conflict error so you can re-read and reapply. Omit for last-write-wins.'
  ),
  private: z.boolean().optional().describe(
    'Set true to MARK the task private (invisible via list_tasks / list_tasks_due_today / get_task to any credential without the `private` scope; also revokes any public /s/<token> link in the same write). Passing false is REJECTED — un-marking is only possible in the logged-in owner UI. One-way from tools.'
  ),
  mentions: z.array(z.string().min(1)).optional().describe(
    'CONTACT entity ids to ADD as mentions (people/companies from the Contacts vault). Get the id FIRST via get_contact_by_phone / search_contacts — never a free-text name. Additive (does NOT remove absent ones — use mentions_remove). A new mention shows the task on the contact\'s page and fires a `mentioned_in_brain` event.'
  ),
  mentions_remove: z.array(z.string().min(1)).optional().describe(
    'CONTACT entity ids to REMOVE from this task\'s mentions. Does NOT delete the timeline event already fired on the contact.'
  ),
  assignees: z.array(z.string().min(1)).max(16).optional().describe(
    'New RESPONSIBLE users — REPLACES the whole set (pass [] to clear). Refs by user id (user_...), name (case-insensitive), or "me" (the profile linked to this credential). Users are never auto-created; unknown ref errors listing the available users (see list_users).'
  ),
  allow_new_domain: z.boolean().optional(),
};

const DESCRIPTION = `Edits fields of an existing TASK (kind='task'). Partial patch — only the fields you pass change; the rest stay untouched.

Use this to reopen a task to attach context, reschedule, reprioritize, rename, change status, or retag — the equivalent of update_note, but for tasks (update_note rejects kind='task' on purpose). Errors if the id is not a task.

Behavior:
- At least one editable field besides id must be provided.
- \`details\` REPLACES the body (not append). \`tags\` REPLACES all tags ([] clears them). \`assignees\` REPLACES the responsible users ([] clears; refs by id/name/"me"; never auto-creates — see list_users).
- Move to a project with \`project\` (id or label; a new label auto-creates it); remove from its project with \`project: ""\`. Projects are single-valued, distinct from tags.
- Remove a due date with \`due: "none"\` (or "clear"); remove a priority with \`priority: null\`.
- Pass either \`due\` (BRT string) or \`due_at\` (unix ms), never both — passing both errors.
- Changing \`title\` also updates the tldr (a task's tldr mirrors its title).
- status done/canceled stamps completed_at; reopening clears it. For finishing WITH an outcome note, prefer complete_task.
- \`stage\` moves the task to a board COLUMN (id col_... or label, case-insensitive; active columns only) and aligns the status to the column's category — exactly like dragging the card on /app/tasks. Never pass status together with stage. Work finished by an agent that requires the owner's sign-off goes to the "Validação humana" stage, NOT to complete_task.
- Tasks are NOT embedded — editing one never touches recall/the graph. Cheap edit.
- Optimistic concurrency (optional): pass \`expected_updated_at\` (the updated_at you last read) to guard against concurrent writes — if the task changed since, the edit fails with a conflict error instead of silently overwriting. Omit for last-write-wins.
- Reserved \`dedupe:\` tags are preserved automatically when you pass \`tags\` (so a dedupe key survives a retag), unless the new array explicitly includes a \`dedupe:\` tag.

Returns the updated task fields (id, title, status, priority, due in BRT, url, updated_at). Use the returned updated_at as the next expected_updated_at.`;

interface UpdateTaskInput {
  id: string;
  title?: string;
  details?: string;
  due?: string;
  due_at?: number;
  priority?: number | null;
  status?: TaskStatus;
  stage?: string;
  domains?: string[];
  tags?: string[];
  project?: string;
  expected_updated_at?: number;
  private?: boolean;
  mentions?: string[];
  mentions_remove?: string[];
  assignees?: string[];
  allow_new_domain?: boolean;
}

export function registerUpdateTask(server: any, env: Env, auth: AuthContext): void {
  server.registerTool(
    'update_task',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Edit a task',
        resource: 'tasks',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: UpdateTaskInput) => {
      const notFoundMsg = () =>
        `Task '${input.id}' not found (or it is not a task). Confirm the id via list_tasks_due_today or the /app/tasks board. Do NOT retry with this id.`;

      // Visibilidade row-level (spec 91): resolvida por chamada e usada nas pré-leituras
      // dos DOIS caminhos (field-edit via updateTask e o caminho sem field-edit abaixo)
      // — task invisível = 'not-found' idêntico a inexistente.
      const visR = await resolveTaskVis(env, auth);
      if (!visR.ok) return toolError(visR.error);
      const vis = visR.vis;

      // Superfície de contatos (spec 91): sob contacts:none, menções são rejeitadas —
      // o param aceita entity ids do vault de Contacts, que esta credencial não acessa.
      if (hasScope(auth?.scopes, SCOPE_CONTACTS_NONE) &&
          ((input.mentions?.length ?? 0) > 0 || (input.mentions_remove?.length ?? 0) > 0)) {
        return toolError(
          'This credential has no access to the Contacts vault (scope contacts:none), so `mentions`/' +
          '`mentions_remove` are not allowed. Retry WITHOUT these params.'
        );
      }

      // Selo de privacidade (spec 59): desmarcar (private:false) é PROIBIDO via tool —
      // só a UI logada do dono torna pública, pra um agente comprometido não
      // des-privatizar em massa. Marcar (true) é ok e revoga share vivo (setTaskPrivate).
      if (input.private === false) {
        return toolError(
          `Cannot set a task back to public via update_task. Un-marking is only possible in the ` +
          `logged-in owner UI at /app/tasks/${input.id}. update_task can only MARK a task private (private: true).`
        );
      }
      const wantsPrivate = input.private === true;

      const touchesMentions = (input.mentions?.length ?? 0) > 0 || (input.mentions_remove?.length ?? 0) > 0;
      // Responsáveis (spec 37): replace-set. `[]` limpa; undefined não toca.
      const touchesAssignees = input.assignees !== undefined;
      const wantsStage = input.stage !== undefined;
      const hasFieldEdit =
        input.title !== undefined || input.details !== undefined ||
        input.due !== undefined || input.due_at !== undefined ||
        input.priority !== undefined || input.status !== undefined ||
        input.domains !== undefined || input.tags !== undefined ||
        input.project !== undefined;
      if (!hasFieldEdit && !wantsPrivate && !touchesMentions && !touchesAssignees && !wantsStage) {
        return toolError('Nothing to update. Pass at least one of: title, details, due/due_at, priority, status, stage, domains, tags, project, assignees, private (true only), mentions, mentions_remove.');
      }

      // Stage (coluna do board): resolve ANTES de qualquer escrita — stage inválido
      // aborta o update inteiro. Só colunas ATIVAS resolvem (arquivada não é destino
      // válido, igual ao board). status junto é ambíguo: a coluna JÁ define o status.
      let stageCol: { id: string; label: string } | null = null;
      if (wantsStage) {
        if (input.status !== undefined) {
          return toolError('Pass either `stage` or `status`, not both — the stage\'s column already defines the status (invariant of the board).');
        }
        const ref = input.stage!.trim().toLowerCase();
        const cols = await listKanbanColumns(env, false);
        const found = cols.find((c) => c.id === input.stage!.trim() || c.label.toLowerCase() === ref);
        if (!found) {
          const available = cols.map((c) => `"${c.label}" (${c.id})`).join(', ');
          return toolError(`Stage "${input.stage}" not found among the ACTIVE board columns. Available: ${available}.`);
        }
        stageCol = { id: found.id, label: found.label };
      }

      // Resolve os responsáveis ANTES de qualquer escrita — ref inválida aborta
      // o update inteiro (nunca aplica metade). Nunca auto-cria usuário.
      let newAssignees: BrainUser[] | null = null;
      if (touchesAssignees) {
        const ar = await resolveAssigneeRefs(env, input.assignees ?? [], auth);
        if (!ar.ok) return toolError(ar.error);
        newAssignees = ar.users;
      }

      // Reatribuição sob tasks:assigned (spec 91): PROIBIDA — o replace-set era a
      // escalada clássica (robô se auto-atribui e REMOVE os outros). O máximo permitido
      // é REMOVER A SI MESMO (abrir mão do próprio vínculo): nenhuma adição, e toda
      // remoção tem que ser o próprio user. Delegação nova = task [pedido] via
      // save_task, ou pedir ao dono no thread. Checado ANTES de qualquer escrita
      // (nunca aplica metade) e DEPOIS do gate de visibilidade (anti-oráculo: task
      // invisível responde not-found, nunca "cannot reassign").
      if (newAssignees !== null && vis.assignedOnlyUserId !== null) {
        const visible = await getTaskById(env, input.id, vis);
        if (!visible) return toolError(notFoundMsg());
        const current = new Set((await listAssigneesForTask(env, input.id)).map((a) => a.id));
        const newSet = new Set(newAssignees.map((u) => u.id));
        const added = [...newSet].filter((uid) => !current.has(uid));
        const removedOthers = [...current].filter((uid) => !newSet.has(uid) && uid !== vis.assignedOnlyUserId);
        if (added.length > 0 || removedOthers.length > 0) {
          return toolError(
            'This credential is restricted to assigned tasks (tasks:assigned) and cannot REASSIGN a task: ' +
            'the only allowed assignee change is removing YOURSELF. To delegate, create a new [pedido] task ' +
            'via save_task, or ask the owner in the task thread (comment_task).'
          );
        }
      }

      const patch: TaskPatch = {};
      if (input.title !== undefined) patch.title = input.title.trim();
      if (input.details !== undefined) patch.body = input.details.trim();
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.status !== undefined) patch.status = input.status;
      // updateTask aplica a preservação da tag reservada dedupe: (replaceTaskTagsPreservingDedupe) —
      // mesma lógica compartilhada com /app/tasks/update (spec 52).
      if (input.tags !== undefined) patch.tags = input.tags;

      // Projeto (spec 58): resolve id/label (auto-create em label novo); "" desvincula.
      // Resolvido ANTES do updateTask pra um erro de projeto (arquivado/cap) não gravar
      // nada. O now é usado tanto no auto-create do projeto quanto no updateTask.
      const now = Date.now();
      if (input.project !== undefined) {
        const pr = await resolveProjectForWrite(env, input.project, now);
        if (!pr.ok) return toolError(pr.error);
        patch.project_id = pr.projectId;
      }

      if (input.domains !== undefined) {
        const domainError = validateDomains(input.domains, { allowNewDomain: input.allow_new_domain ?? false });
        if (domainError) return toolError(domainError);
        patch.domains = JSON.stringify(input.domains);
      }

      // due + due_at simultâneos: erro em vez de deixar um vencer em silêncio (spec 15 item 6).
      if (typeof input.due_at === 'number' && input.due !== undefined) {
        return toolError('Pass either due (BRT string) or due_at (unix ms), not both.');
      }

      if (typeof input.due_at === 'number') {
        patch.due_at = input.due_at;
      } else if (input.due !== undefined) {
        // Sentinela pra LIMPAR o prazo (spec 15 item 4). 'none'/'clear' → due_at = null.
        const sentinel = input.due.trim().toLowerCase();
        if (sentinel === 'none' || sentinel === 'clear') {
          patch.due_at = null;
        } else {
          const dueMs = parseDueToMs(input.due);
          if (dueMs === null) {
            return toolError(
              `Could not parse due "${input.due}". Use BRT formats like "2026-06-22T14:00", "2026-06-22 14:00", or "2026-06-22" (date only). Pass "none" to remove the due date. Or pass due_at as unix ms.`
            );
          }
          patch.due_at = dueMs;
        }
      }

      // Se não há edição de campo (só private:true, menções, responsáveis e/ou stage),
      // valida existência/visibilidade aqui (espelha mark_private de nota): caller sem
      // visão da task (privada sem escopo / alheia sob tasks:assigned) → "not found",
      // e nunca mexe numa task que não pode ver.
      let task: TaskRow | undefined;
      if (!hasFieldEdit && (wantsPrivate || touchesMentions || touchesAssignees || wantsStage)) {
        const visible = await getTaskById(env, input.id, vis);
        if (!visible) return toolError(notFoundMsg());
        // updateTask não roda neste caminho, então o guard otimista é checado aqui —
        // um move de stage com leitura defasada conflita igual a um patch de campo.
        if (input.expected_updated_at !== undefined && visible.updated_at !== input.expected_updated_at) {
          return toolError(
            `Task '${input.id}' changed since you read it (current updated_at: ${visible.updated_at}). ` +
            `Your edit was NOT applied. Re-read the task via list_tasks / get_task and reapply your patch with the fresh expected_updated_at.`
          );
        }
        task = visible;
      }

      if (hasFieldEdit) {
        const result = await updateTask(env, input.id, patch, vis, now, input.expected_updated_at, writeActor(auth));
        if (result === 'not-found') return toolError(notFoundMsg());
        if (result === 'conflict') {
          // Reler pra devolver o updated_at atual + campos, evitando um round-trip.
          // OWNER_TASK_VIS ok: 'conflict' só ocorre em task que o gate acima já viu.
          const current = await getTaskById(env, input.id, OWNER_TASK_VIS);
          const currentUpdated = current?.updated_at ?? null;
          return toolError(
            `Task '${input.id}' changed since you read it (current updated_at: ${currentUpdated}). ` +
            `Your edit was NOT applied. Re-read the task via list_tasks / get_task and reapply your patch with the fresh expected_updated_at.`
          );
        }
        task = result;
      }

      // Stage: move DEPOIS do patch de campos (conflito otimista do updateTask já
      // abortou antes de chegar aqui). Mesmo caminho do drag do board: column_id +
      // status = category + completed_at quando a coluna fecha, com log de atividade.
      if (stageCol) {
        const moved = await moveTaskToColumn(env, input.id, stageCol.id, now, writeActor(auth));
        if (moved === 'column-not-found' || moved === 'not-found') return toolError(notFoundMsg());
        task = moved;
      }

      // Marcar privada (spec 59): one-way via MCP, revoga share vivo na mesma escrita.
      // Roda DEPOIS do patch de campos (se houve) — o retorno reflete o estado final.
      let shareRevoked = false;
      if (wantsPrivate) {
        const r = await setTaskPrivate(env, input.id, 1, now, writeActor(auth));
        if (!r.ok) return toolError(notFoundMsg());
        shareRevoked = r.shareRevoked;
        // OWNER_TASK_VIS de propósito: a task acabou de ficar privada — o eco final
        // é da escrita que o próprio caller fez, não uma leitura nova.
        task = (await getTaskById(env, input.id, OWNER_TASK_VIS)) ?? task;
      }

      if (!task) return toolError(notFoundMsg());

      // Responsáveis (spec 37): replace-set DEPOIS do patch (task já validada/atualizada).
      if (newAssignees !== null) {
        // Mailbox (spec 82): item 'assignment' só pra quem foi ADICIONADO agora
        // (set novo menos set atual, lido ANTES do replace). Remoção não gera item.
        const before = new Set((await listAssigneesForTask(env, task.id)).map((a) => a.id));
        await setTaskAssignees(env, task.id, newAssignees.map((u) => u.id), now);
        const added = newAssignees.map((u) => u.id).filter((uid) => !before.has(uid));
        if (added.length > 0) {
          const actor = await resolveMe(env, auth);
          await produceAssignmentMailbox(env, {
            taskId: task.id, addedUserIds: added, actorUserId: actor?.id ?? null, now,
          });
        }
      }

      // Menções (spec 62): add/remove. DEPOIS do patch/privacidade — o retorno reflete o
      // estado final. Tolerante a falha do contacts. Usa o título final da task no contexto.
      let mentionsChanged: { created: number; removed: number } | undefined;
      if (touchesMentions) {
        mentionsChanged = await applyMentions(env, {
          noteId: task.id,
          title: task.title,
          url: noteUrl(env, task.id),
          add: input.mentions,
          remove: input.mentions_remove,
          seePrivate: canSeePrivate(auth),
          // `task` é o estado FINAL (relido após setTaskPrivate quando marcada agora).
          notePrivate: task.private === 1,
        });
      }

      const proj = task.project_id ? await getProjectById(env, task.project_id) : null;
      // Eco do estado FINAL dos responsáveis (novo set quando trocado; atual quando não).
      const assigneesOut = newAssignees !== null
        ? newAssignees.map(toAssigneeRef)
        : await listAssigneesForTask(env, task.id);

      const out: Record<string, unknown> = {
        id: task.id,
        url: noteUrl(env, task.id),
        title: task.title,
        status: task.status,
        priority: task.priority,
        due_at: task.due_at,
        due_brt: task.due_at !== null ? formatBrtDateTime(task.due_at) : null,
        project: proj ? { id: proj.id, label: proj.label } : null,
        private: task.private === 1,
        assignees: assigneesOut,
        ...(stageCol ? { column: stageCol } : {}),
        updated_at: task.updated_at,
        ...(mentionsChanged ? { mentions_created: mentionsChanged.created, mentions_removed: mentionsChanged.removed } : {}),
      };
      if (shareRevoked) {
        out.share_revoked = true;
        out.share_revoked_note = 'A task ficou privada — o link público que existia foi revogado.';
      }
      return toolSuccess(out);
    }) as any
  );
}
