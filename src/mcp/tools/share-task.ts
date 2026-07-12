import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { createShare } from '../../web/share.js';

const inputSchema = {
  id: z.string().min(1).describe('The task id to share (from save_task / list_tasks / the /app/tasks board).'),
  expires_days: z.number().int().min(1).max(365).optional().describe(
    'How many days the public link stays valid. Default 30, min 1, max 365. There is NO "never expires" option — expiry is mandatory.'
  ),
  renew: z.boolean().optional().describe(
    'If the task is ALREADY shared with a live link, this call returns "already shared" instead of minting a new token (the old link keeps working). Pass renew:true to rotate: mint a fresh token + expiry and REPLACE the old link (the previously sent link stops working).'
  ),
};

const DESCRIPTION = `Creates a PUBLIC read-only link for a TASK, so you can send ONE task to someone who has no account: they open only that task, cannot edit, and see no relations, no other notes, and nothing about the owner.

The link is /s/<token> (token = 32 random bytes, url-safe). The database stores only a SHA-256 HASH of the token — the plaintext link is returned ONCE here and cannot be recovered later. Expiry is mandatory (default 30 days, max 365); after it, the link 404s. Revoke anytime with unshare_task (the link dies on the next request).

Only tasks (kind='task') can be shared here. If the id is a knowledge note or does not exist, this errors.

Idempotency: if the task already has a LIVE share, this returns { already_shared: true, expires_brt } WITHOUT changing anything (so the link you already sent keeps working). To get a fresh link (and invalidate the old one), call again with renew:true.

Returns { url, expires_at, expires_brt } on success (show the url to the owner once).`;

interface ShareTaskInput { id: string; expires_days?: number; renew?: boolean; }

export function registerShareTask(server: any, env: Env): void {
  server.registerTool(
    'share_task',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Share a task read-only',
        resource: 'tasks.share',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: ShareTaskInput) => {
      const result = await createShare(
        env,
        input.id,
        { expiresDays: input.expires_days, renew: input.renew },
        Date.now()
      );
      if (!result.ok) {
        if (result.reason === 'not-found') {
          return toolError(
            `Task '${input.id}' not found (or it is not a task). Confirm the id via list_tasks or the /app/tasks board. Do NOT retry with this id.`
          );
        }
        if (result.reason === 'private') {
          // Selo de privacidade (spec 59): task privada NUNCA tem link público.
          return toolError(
            `Task '${input.id}' is PRIVATE and cannot have a public link. Make it public first (in the logged-in owner UI at /app/tasks/${input.id}) before sharing.`
          );
        }
        // already-shared: link vivo, sem renew. Devolve a expiração atual (não é erro
        // de verdade — é a resposta idempotente; o plaintext do link antigo não pode
        // ser reconstruído porque só guardamos o hash).
        return toolSuccess({
          already_shared: true,
          expires_at: result.expires_at,
          expires_brt: result.expires_brt,
          hint: 'Esta task já tem um link público ativo. O link enviado antes continua valendo. Pra gerar um NOVO link (e invalidar o antigo), chame share_task de novo com renew:true. Pra revogar, use unshare_task.',
        });
      }
      return toolSuccess({
        url: result.url,
        expires_at: result.expires_at,
        expires_brt: result.expires_brt,
        note: 'Este link só aparece UMA vez. Guarde-o agora — o banco guarda só o hash. Read-only, sem login, expira na data acima. Revogue com unshare_task.',
      });
    }) as any
  );
}
