import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import type { Env, AuthContext } from '../env.js';
import { buildServerInstructions } from './instructions.js';
import { registerAllTools } from './registry.js';
import { readPersonalizationPrompt } from '../db/meta.js';

export class ExpertBrainMCP extends McpAgent<Env, Record<string, never>, AuthContext> {
  server!: McpServer;

  async init(): Promise<void> {
    const auth = (this as any).props as AuthContext | undefined;
    if (!auth) throw new Error('ExpertBrainMCP: missing auth props');

    // Leitura do prompt de personalização (tabela `meta`) roda 1x por instância
    // do Durable Object — init() só executa uma vez (initRun guard na lib
    // agents/mcp), então o texto montado fica cacheado naturalmente aqui.
    // Prompt editado em /app/config só passa a valer quando o DO reciclar
    // (aceitável — ver specs/10-backend/11-instructions-parametrizadas.md).
    let prompt: string | null = null;
    try {
      prompt = await readPersonalizationPrompt(this.env);
    } catch (err) {
      // Falha suave: instructions nunca podem derrubar o handshake MCP.
      console.error('ExpertBrainMCP: falha ao ler personalization_prompt, usando fallback genérico', err);
      prompt = null;
    }

    this.server = new McpServer(
      { name: 'expert-brain', version: '0.1.0' },
      {
        instructions: buildServerInstructions(prompt, {
          hasMedia: Boolean(this.env.MEDIA),
          hasContacts: Boolean(this.env.CONTACTS && this.env.CONTACTS_PROXY_TOKEN),
        }),
      }
    );
    registerAllTools(this.server, this.env);
  }
}
