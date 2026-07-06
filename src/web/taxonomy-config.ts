// Taxonomia configurável (spec 54): cor + label de exibição de ÁREAS (domains) e
// TIPOS (kinds), guardados na tabela `meta` (padrão já usado por `graph_prefs` —
// ver src/web/graph-prefs.ts). Config é SPARSE: só entra aqui o que o dono
// customizou; qualquer área/kind sem entrada cai no fallback (paleta compilada
// de domain-colors.ts). Zero mudança em `notes` — isto NUNCA faz UPDATE em nota,
// só lê/escreve uma chave de preferência.
import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { KNOWLEDGE_KINDS } from '../db/queries.js';
import { CANONICAL_DOMAINS, DOMAIN_SLUG_REGEX } from '../db/validation.js';
import { EMPTY_TAXONOMY_CONFIG, type TaxonomyConfig, type TaxonomyEntry } from './domain-colors.js';

export const TAXONOMY_META_KEY = 'taxonomy_config';

// Teto generoso (não é o número de domínios canônicos, é o cap de abuso — ver
// spec 54 "Riscos": payload injetado no client tem que caber num orçamento
// pequeno). Kinds são travados nos 7 canônicos de qualquer forma; o cap aqui é
// só defesa em profundidade contra um POST malformado.
const MAX_DOMAINS = 64;
const MAX_KINDS = 16;
const LABEL_MAX_LEN = 40;
const COLOR_REGEX = /^#[0-9a-f]{6}$/i;

export type SanitizeResult =
  | { ok: true; config: TaxonomyConfig }
  | { ok: false; error: string };

function sanitizeEntry(
  raw: unknown,
  ctx: string
): { ok: true; entry: TaxonomyEntry } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `${ctx}: entrada inválida (esperado objeto {label, color})` };
  }
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === 'string' ? r.label.trim() : '';
  if (!label || label.length > LABEL_MAX_LEN) {
    return { ok: false, error: `${ctx}: label deve ter 1-${LABEL_MAX_LEN} caracteres` };
  }
  const color = typeof r.color === 'string' ? r.color.trim() : '';
  if (!COLOR_REGEX.test(color)) {
    return { ok: false, error: `${ctx}: cor '${color}' inválida — use o formato #rrggbb` };
  }
  return { ok: true, entry: { label, color: color.toLowerCase() } };
}

// Valida e normaliza um payload arbitrário (POST do cliente OU valor lido do
// meta) pro shape canônico de TaxonomyConfig. AO CONTRÁRIO de sanitizeGraphPrefs
// (que clampa em silêncio), aqui qualquer violação REJEITA o payload inteiro —
// critério de aceite da spec 54: "nada é persistido parcialmente".
export function sanitizeTaxonomyConfig(raw: unknown): SanitizeResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'config inválida: esperado objeto {domains, kinds}' };
  }
  const r = raw as Record<string, unknown>;
  const domainsRaw = r.domains && typeof r.domains === 'object' ? (r.domains as Record<string, unknown>) : {};
  const kindsRaw = r.kinds && typeof r.kinds === 'object' ? (r.kinds as Record<string, unknown>) : {};

  const domainKeys = Object.keys(domainsRaw);
  if (domainKeys.length > MAX_DOMAINS) {
    return { ok: false, error: `máximo de ${MAX_DOMAINS} áreas customizadas` };
  }
  const kindKeys = Object.keys(kindsRaw);
  if (kindKeys.length > MAX_KINDS) {
    return { ok: false, error: `máximo de ${MAX_KINDS} tipos customizados` };
  }

  const domains: Record<string, TaxonomyEntry> = {};
  for (const slug of domainKeys) {
    if (!DOMAIN_SLUG_REGEX.test(slug)) {
      return {
        ok: false,
        error: `área '${slug}' não é um slug válido (kebab-case minúsculo, sem acento, 2-40 chars)`,
      };
    }
    const res = sanitizeEntry(domainsRaw[slug], `área '${slug}'`);
    if (!res.ok) return res;
    domains[slug] = res.entry;
  }

  const kindSet = new Set<string>(KNOWLEDGE_KINDS as readonly string[]);
  const kinds: Record<string, TaxonomyEntry> = {};
  for (const kind of kindKeys) {
    if (!kindSet.has(kind)) {
      return {
        ok: false,
        error: `tipo '${kind}' não é um dos 7 tipos canônicos (${KNOWLEDGE_KINDS.join(', ')})`,
      };
    }
    const res = sanitizeEntry(kindsRaw[kind], `tipo '${kind}'`);
    if (!res.ok) return res;
    kinds[kind] = res.entry;
  }

  return { ok: true, config: { domains, kinds } };
}

// Lê a config salva; nunca lança — payload corrompido ou ausente cai no vazio
// (tudo no fallback da paleta compilada).
export async function getTaxonomyConfig(env: Env): Promise<TaxonomyConfig> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(TAXONOMY_META_KEY).first<{ value: string }>();
  if (!row?.value) return EMPTY_TAXONOMY_CONFIG;
  try {
    const parsed = JSON.parse(row.value);
    const res = sanitizeTaxonomyConfig(parsed);
    return res.ok ? res.config : EMPTY_TAXONOMY_CONFIG;
  } catch {
    return EMPTY_TAXONOMY_CONFIG;
  }
}

// União de slugs "conhecidos": os 12 canônicos + os pré-criados na config +
// quaisquer outros passados em `extra` (ex.: domínios em uso nas notas, ou os
// domínios ATUAIS de uma nota específica — necessário pra um domínio legado/
// fora do canon não desaparecer da lista de checkboxes e ser perdido no save).
// Canônicos primeiro (ordem fixa), depois o resto em ordem alfabética.
export function mergedDomainSlugs(
  config: TaxonomyConfig,
  extra: Iterable<string> = []
): string[] {
  const canonicalSet = new Set<string>(CANONICAL_DOMAINS);
  const rest = new Set<string>();
  for (const d of Object.keys(config.domains)) if (!canonicalSet.has(d)) rest.add(d);
  for (const d of extra) if (d && !canonicalSet.has(d)) rest.add(d);
  return [...CANONICAL_DOMAINS, ...[...rest].sort((a, b) => a.localeCompare(b))];
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// GET /app/config/taxonomy — consumido pelos bundles client (graph.ts, notes.ts)
// pra resolver cor/label sem precisar embutir a config no HTML de cada página.
export async function handleTaxonomyGet(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const config = await getTaxonomyConfig(env);
  return jsonResponse(config);
}

// POST /app/config/taxonomy — substitui a config inteira (atomic: sanitiza TUDO
// antes de qualquer escrita; inválido = 400, zero persistência parcial).
export async function handleTaxonomyPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  let body: unknown;
  try { body = await req.json(); } catch {
    return jsonResponse({ error: 'invalid json' }, 400);
  }
  const result = sanitizeTaxonomyConfig(body);
  if (!result.ok) return jsonResponse({ error: result.error }, 400);
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(TAXONOMY_META_KEY, JSON.stringify(result.config)).run();
  return jsonResponse({ ok: true, config: result.config });
}

// POST /app/config/taxonomy/reset — "Restaurar padrão": apaga a chave inteira,
// tudo volta ao fallback (paleta compilada + slug cru como label).
export async function handleTaxonomyResetPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  await env.DB.prepare(`DELETE FROM meta WHERE key = ?`).bind(TAXONOMY_META_KEY).run();
  return jsonResponse({ ok: true });
}
