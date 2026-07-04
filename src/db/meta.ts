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
