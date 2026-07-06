import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { ExpertBrainMCP } from './mcp/agent.js';
import { authHandler } from './auth/handler.js';
import { validateApiKey } from './auth/api-keys.js';
import { runScheduled } from './scheduled.js';
import type { Env } from './env.js';

export { ExpertBrainMCP };

const mcpHandler = ExpertBrainMCP.serve('/mcp');

const oauthProvider = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: ExpertBrainMCP.serve('/mcp') as any,
  defaultHandler: authHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  accessTokenTTL: 86400,
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/mcp') {
      const auth = req.headers.get('Authorization') || '';
      if (auth.startsWith('Bearer eb_pat_')) {
        const plainKey = auth.slice('Bearer '.length).trim();
        // ctx repassado pra o last_used_at ir por ctx.waitUntil (sem promise
        // flutuante). validated traz email + escopo + id do PAT (spec 17).
        const validated = await validateApiKey(env, plainKey, ctx);
        if (!validated) {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or revoked API key' }, id: null }),
            { status: 401, headers: { 'content-type': 'application/json' } }
          );
        }
        (ctx as any).props = {
          email: validated.email,
          loggedInAt: Date.now(),
          scopes: validated.scopes,
          keyId: validated.keyId,
        };
        return (mcpHandler as any).fetch(req, env, ctx);
      }
    }
    return (oauthProvider as any).fetch(req, env, ctx);
  },

  // Crons (ver [triggers] no wrangler.toml): "0 11 * * *" = digest diário de tasks
  // pro Telegram (08:00 BRT, no-op seguro sem os secrets) e "0 5 * * 1" = snapshot
  // semanal de backup D1→R2 (segunda 02:00 BRT, spec 67). O dispatch por
  // controller.cron vive em src/scheduled.ts — testável sem o OAuth provider.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    runScheduled(controller.cron, env, ctx);
  },
};
