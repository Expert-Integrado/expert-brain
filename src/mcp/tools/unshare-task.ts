import { z } from 'zod';
import type { Env } from '../../env.js';
import { safeToolHandler, toolError, toolSuccess } from '../helpers.js';
import { revokeShare } from '../../web/share.js';
import { getTaskById } from '../../db/queries.js';

const inputSchema = {
  id: z.string().min(1).describe('The task id whose public link you want to revoke.'),
};

const DESCRIPTION = `Revokes the PUBLIC read-only link of a TASK created with share_task. This is a REAL revocation: it clears the token from the database, so the /s/<token> link 404s on the very next request — immediate, no cache.

Only tasks (kind='task'). Errors if the id is not a task. Idempotent: if the task had no active share, it reports that nothing was revoked (not an error).

Returns { revoked: true|false }.`;

interface UnshareTaskInput { id: string; }

export function registerUnshareTask(server: any, env: Env): void {
  server.registerTool(
    'unshare_task',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'Revoke a task share link',
        resource: 'tasks.share',
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: UnshareTaskInput) => {
      const task = await getTaskById(env, input.id);
      if (!task) {
        return toolError(
          `Task '${input.id}' not found (or it is not a task). Confirm the id via list_tasks or the /app/tasks board. Do NOT retry with this id.`
        );
      }
      const revoked = await revokeShare(env, input.id);
      return toolSuccess({
        revoked,
        message: revoked
          ? 'Link público revogado. O /s/<token> passa a dar 404 no próximo request.'
          : 'Esta task não tinha link público ativo. Nada a revogar.',
      });
    }) as any
  );
}
