import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { ExpertBrainMCP } from './mcp/agent.js';
import { authHandler } from './auth/handler.js';

export { ExpertBrainMCP };

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: ExpertBrainMCP.serve('/mcp') as any,
  defaultHandler: authHandler as any,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  accessTokenTTL: 86400,
});
