import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import type { Env, AuthContext } from '../env.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { registerAllTools } from './registry.js';

export class ExpertBrainMCP extends McpAgent<Env, Record<string, never>, AuthContext> {
  server = new McpServer(
    { name: 'expert-brain', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS }
  );

  async init(): Promise<void> {
    const auth = (this as any).props as AuthContext | undefined;
    if (!auth) throw new Error('ExpertBrainMCP: missing auth props');
    registerAllTools(this.server, this.env);
  }
}
