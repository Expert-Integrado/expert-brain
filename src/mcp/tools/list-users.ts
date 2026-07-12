import { z } from 'zod';
import type { Env, AuthContext } from '../../env.js';
import { safeToolHandler, toolSuccess } from '../helpers.js';
import { listUsers } from '../../db/queries.js';
import { hasScope, SCOPE_NOTES_NONE } from '../../auth/api-keys.js';
import { resolveMe } from './user-ref.js';

const inputSchema = {
  include_archived: z.boolean().optional().describe('Also include archived users (default false).'),
};

const DESCRIPTION = `Lists the USERS of this vault — the assignable profiles for tasks (spec 37).

A user is an assignment profile (name, photo, type), NOT a login. Two types: 'person' (the human owner) and 'agent' (an agent INSTANCE — a machine/container running an agent, identified by its own PAT). Use this to discover who exists BEFORE assigning a task (save_task/update_task \`assignees\`) or filtering (\`list_tasks\` \`assignee\`).

Each user returns {id, name, type, bio, is_me}. \`is_me\` is true on the profile linked to the credential making THIS call (PAT → agent profile; owner OAuth session → owner person profile) — that's the profile to use as "my" identity. Users are managed by the owner at /app/config (Usuários); they are never auto-created by tools. Read-only.`;

interface ListUsersInput {
  include_archived?: boolean;
}

export function registerListUsers(server: any, env: Env, auth: AuthContext): void {
  server.registerTool(
    'list_users',
    {
      description: DESCRIPTION,
      inputSchema,
      annotations: {
        title: 'List assignable users',
        resource: 'users',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safeToolHandler(async (input: ListUsersInput) => {
      const [users, me] = await Promise.all([
        listUsers(env, input.include_archived === true),
        resolveMe(env, auth),
      ]);
      // Credencial restrita (spec 91, notes:none): a lista vem SEM `bio` — o campo
      // descreve papel/contexto de cada perfil (estrutura organizacional), acima do
      // que um robô de frota precisa pra endereçar uma task (id/name/type bastam).
      const omitBio = hasScope(auth.scopes, SCOPE_NOTES_NONE);
      return toolSuccess({
        count: users.length,
        users: users.map((u) => ({
          id: u.id,
          name: u.name,
          type: u.type,
          ...(omitBio ? {} : { bio: u.bio }),
          is_me: me !== null && me.id === u.id,
          ...(u.archived_at !== null ? { archived: true } : {}),
        })),
      });
    }) as any
  );
}
