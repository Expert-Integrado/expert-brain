import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess, noteUrl, canSeePrivate } from '../helpers.js';
import { getTaskById, claimTask, releaseTaskClaim, claimActive, getUserByIdOrName } from '../../db/queries.js';
import { resolveMe } from './user-ref.js';
import { formatBrtDateTime } from '../../util/time.js';

// Claim/lease de task (spec 80-frota-agentes/88): posse TEMPORÁRIA pra frota não
// trabalhar a mesma task em paralelo. Lease vencido = task livre por construção —
// crash de agente nunca prende trabalho além do lease.

const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 480;

const inputSchema = {
  task_id: z.string().min(1).describe('The task id to claim or release.'),
  minutes: z.number().int().min(1).max(MAX_MINUTES).optional().describe(
    `Lease duration in minutes (default ${DEFAULT_MINUTES}, max ${MAX_MINUTES}). Claiming a task you already hold RENEWS the lease from now.`
  ),
  release: z.boolean().optional().describe(
    'Pass true to RELEASE your claim instead (stop working without finishing). Releasing an unclaimed task is a safe no-op; releasing a task held by someone else errors.'
  ),
};

const DESCRIPTION = `Claims a task for exclusive work (a temporary LEASE), or releases it.

Multi-instance safety for agent fleets: BEFORE working a task from your queue, claim it. If another agent already holds an ACTIVE claim you get an error naming the holder and when the lease expires — pick another task instead of duplicating work. Claiming is atomic: two agents racing for the same task, exactly one wins.

Lease semantics: the claim expires automatically (default ${DEFAULT_MINUTES}min) — an expired lease means the task is FREE again, so a crashed agent never blocks work. Re-claiming a task you already hold renews the lease. complete_task clears the claim; call with release:true when you stop working WITHOUT finishing.

Identity comes from the credential (spec 81, same as comment_task): a PAT with no linked user profile is rejected. Only open/in_progress tasks are claimable.

Returns { claimed:true, task_id, holder {id,name}, expires_at, expires_brt, url } on claim, { released:true } on release.`;

interface ClaimInput { task_id: string; minutes?: number; release?: boolean; }

export function registerClaimTask(server: any, env: Env, auth?: AuthContext): void {
  const seePrivate = canSeePrivate(auth);
  server.registerTool(
    'claim_task',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: { title: 'Claim/release a task lease', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safeToolHandler(async (input: ClaimInput) => {
      const task = await getTaskById(env, input.task_id, seePrivate);
      if (!task) {
        return toolError(
          `Task '${input.task_id}' not found (or it is not a task). Confirm the id via list_tasks. Do NOT retry with this id.`
        );
      }
      // Identidade fail-closed (spec 81): claim sem usuário resolvido seria posse
      // anônima — impossível de exibir, renovar ou auditar.
      const me = await resolveMe(env, auth);
      if (!me) {
        return toolError(
          'This credential has no linked user profile, so it cannot hold a claim. ' +
          'The owner links this PAT to an agent user at /app/config (Usuários). Do NOT retry until linked.'
        );
      }
      const now = Date.now();

      if (input.release === true) {
        if (!claimActive(task, now) || task.claimed_by === me.id) {
          // Livre/vencida ou minha: soltar é idempotente (changes 0 em livre = ok).
          await releaseTaskClaim(env, input.task_id, me.id);
          return toolSuccess({ released: true, task_id: input.task_id, url: noteUrl(env, input.task_id) });
        }
        const holder = await getUserByIdOrName(env, task.claimed_by!, false);
        return toolError(
          `You do not hold this claim — '${holder?.name ?? task.claimed_by}' does (lease until ${formatBrtDateTime(task.claim_expires_at!)}). Only the holder releases it; an expired lease frees itself.`
        );
      }

      if (task.status !== 'open' && task.status !== 'in_progress') {
        return toolError(
          `Task '${input.task_id}' is '${task.status}' — only open/in_progress tasks are claimable.`
        );
      }
      const leaseMs = (input.minutes ?? DEFAULT_MINUTES) * 60_000;
      const won = await claimTask(env, input.task_id, me.id, now, leaseMs);
      if (!won) {
        // O UPDATE atômico perdeu: claim ATIVO de outro usuário. Erro orientado —
        // a resposta certa do agente é pegar OUTRA task, nunca re-tentar em loop.
        const fresh = await getTaskById(env, input.task_id, seePrivate);
        const holderId = fresh?.claimed_by ?? task.claimed_by;
        const holder = holderId ? await getUserByIdOrName(env, holderId, false) : null;
        const until = fresh?.claim_expires_at ?? task.claim_expires_at;
        return toolError(
          `Task '${input.task_id}' is already claimed by '${holder?.name ?? holderId}' (lease until ${until != null ? formatBrtDateTime(until) : '?'}). ` +
          'Pick ANOTHER task from your queue (list_tasks with available:true); if the lease expires the task frees itself.'
        );
      }
      return toolSuccess({
        claimed: true,
        task_id: input.task_id,
        title: task.title,
        holder: { id: me.id, name: me.name },
        claimed_at: now,
        expires_at: now + leaseMs,
        expires_brt: formatBrtDateTime(now + leaseMs),
        minutes: input.minutes ?? DEFAULT_MINUTES,
        url: noteUrl(env, input.task_id),
      });
    }) as any
  );
}
