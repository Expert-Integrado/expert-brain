import type { Env } from '../env.js';

// Chave da tabela `meta` que guarda o prompt de personalização editado em
// /app/config (src/web/config.ts). Módulo neutro pra leitura crua — evita
// que src/mcp importe de src/web (que puxa session/render/auth junto).
const PREFS_META_KEY = 'personalization_prompt';

/**
 * Leitura crua do prompt de personalização. Retorna `null` quando a instância
 * ainda não tem nada salvo — sem fallback pro template com placeholders
 * (esse fallback é responsabilidade da camada web, não deste módulo).
 */
export async function readPersonalizationPrompt(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(PREFS_META_KEY)
    .first<{ value: string }>();
  return row?.value ?? null;
}

// ─────────── "Instruções do dono" — CLAUDE.md do Brain (spec 50-console-v2/70) ───────────
// Bloco de instruções que o dono edita em /app/config e que o servidor MCP anexa
// ao handshake (src/mcp/instructions.ts + src/mcp/agent.ts). Chave própria na
// `meta`, separada do `personalization_prompt` (que é o prompt de copy-paste pro
// cliente): esta aqui vai DIRETO pro handshake de todo agente conectado.
const OWNER_INSTRUCTIONS_META_KEY = 'owner_instructions';
export const OWNER_INSTRUCTIONS_MAX_LEN = 4000;

// Códigos de controle preservados por serem conteúdo legítimo de texto/markdown:
// TAB (0x09), LF (0x0A) e CR (0x0D). Todo o resto do bloco C0 (0x00–0x1F) e o
// DEL (0x7F) são removidos antes de persistir.
const KEEP_CONTROL_CODES = new Set<number>([0x09, 0x0a, 0x0d]);

/**
 * Sanitiza o texto de instruções do dono antes de persistir: remove caracteres
 * de controle (menos TAB/CR/LF, que são conteúdo legítimo de markdown leve),
 * faz trim e aplica o cap de 4000 chars. Retorna string vazia quando não sobra
 * conteúdo — o caller usa isso pra REMOVER a chave (não é HTML: vai pro handshake
 * como texto puro, então não há escaping, só o strip de controle).
 */
export function sanitizeOwnerInstructions(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = (code < 0x20 || code === 0x7f) && !KEEP_CONTROL_CODES.has(code);
    if (!isControl) out += ch;
  }
  return out.trim().slice(0, OWNER_INSTRUCTIONS_MAX_LEN);
}

/**
 * Leitura crua das instruções do dono. `null` quando a chave não existe — nesse
 * caso o handshake fica byte-a-byte idêntico ao atual (sem bloco extra).
 */
export async function readOwnerInstructions(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(OWNER_INSTRUCTIONS_META_KEY)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Persiste as instruções do dono (sanitizadas). Texto vazio (após sanitize)
 * REMOVE a chave — volta o handshake pro comportamento default. Retorna o valor
 * efetivamente gravado (string vazia quando removeu).
 */
export async function writeOwnerInstructions(env: Env, raw: string): Promise<string> {
  const value = sanitizeOwnerInstructions(raw);
  if (!value) {
    await env.DB.prepare(`DELETE FROM meta WHERE key = ?`)
      .bind(OWNER_INSTRUCTIONS_META_KEY)
      .run();
    return '';
  }
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(OWNER_INSTRUCTIONS_META_KEY, value)
    .run();
  return value;
}
