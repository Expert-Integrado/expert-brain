import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
// Versão real no handshake MCP (spec 10-backend/23): com forks de alunos e múltiplos
// deploys, o initialize revela QUAL código responde. esbuild resolve JSON nativamente.
import pkg from '../../package.json';
import type { Env, AuthContext } from '../env.js';
import { buildServerInstructions } from './instructions.js';
import { registerAllTools } from './registry.js';
import { readPersonalizationPrompt, readOwnerInstructions } from '../db/meta.js';
import { ensureContactsBinding } from '../contacts-gateway.js';

export class ExpertBrainMCP extends McpAgent<Env, Record<string, never>, AuthContext> {
  server!: McpServer;

  async init(): Promise<void> {
    const auth = (this as any).props as AuthContext | undefined;
    if (!auth) throw new Error('ExpertBrainMCP: missing auth props');

    // Fusão (F2): o Durable Object recebe env PRÓPRIO do runtime — a costura do
    // entry (src/index.ts) não alcança aqui. Injeta o módulo de contatos
    // in-process ANTES do handshake, pra hasContacts e as tools enxergarem.
    ensureContactsBinding(this.env);

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

    // "Instruções do dono" (spec 50-console-v2/70): mesmo padrão de leitura suave.
    // Falha na meta nunca derruba o handshake — cai pro comportamento sem o bloco.
    let ownerInstructions: string | null = null;
    try {
      ownerInstructions = await readOwnerInstructions(this.env);
    } catch (err) {
      console.error('ExpertBrainMCP: falha ao ler owner_instructions, seguindo sem o bloco', err);
      ownerInstructions = null;
    }

    this.server = new McpServer(
      { name: 'expert-brain', version: pkg.version },
      {
        instructions: buildServerInstructions(prompt, {
          hasMedia: Boolean(this.env.MEDIA),
          hasContacts: Boolean(this.env.CONTACTS && this.env.CONTACTS_PROXY_TOKEN),
          ownerInstructions,
        }),
      }
    );
    // Repassa o AuthContext (spec 17): o registry gateia por escopo (read → só
    // tools readOnlyHint:true) e as tools de escrita gravam autoria.
    registerAllTools(this.server, this.env, auth);
  }
}
