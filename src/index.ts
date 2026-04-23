import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { ExpertBrainMCP } from './mcp/agent.js';
import { authHandler } from './auth/handler.js';
import { validateApiKey } from './auth/api-keys.js';
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
        const ownerEmail = await validateApiKey(env, plainKey);
        if (!ownerEmail) {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or revoked API key' }, id: null }),
            { status: 401, headers: { 'content-type': 'application/json' } }
          );
        }
        (ctx as any).props = { email: ownerEmail, loggedInAt: Date.now() };
        return (mcpHandler as any).fetch(req, env, ctx);
      }
    }
    return (oauthProvider as any).fetch(req, env, ctx);
  },
};
