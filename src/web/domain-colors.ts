// Curated domain palette — 12 distinguishable colors tested against the dark
// Midnight Nebula background and ColorBrewer-style colorblind considerations.
// Replaces the old FNV-1a hash → HSL approach which produced unstable / clashing
// hues (e.g. two domains landing 5° apart on the color wheel).
//
// Canonical domain slugs live in kebab-case English (see save_note validator in
// the MCP layer). `fallback` covers legacy rows, typos, and any new domain
// slug that ships before the palette is extended here.

export const DOMAIN_COLORS: Record<string, string> = {
  'management': '#f59e0b',
  'sales': '#22c55e',
  'marketing': '#ec4899',
  'education': '#8b5cf6',
  'ai-applied': '#06b6d4',
  'leadership': '#f97316',
  'product': '#3b82f6',
  'operations': '#94a3b8',
  'personal-development': '#14b8a6',
  'entrepreneurship': '#ef4444',
  'cognitive-science': '#a78bfa',
  'music': '#fbbf24',
};

// Tipos de entidade do vault de CONTATOS (person/company/place/event/other) —
// paridade de cor com o Expert Console standalone. As chaves não colidem com os
// 12 domínios do Brain, então entram na MESMA resolução de domainColor(): o grafo
// de contatos (embutido em /app/contacts) ganha cor por tipo sem plumbing de vault
// em cada call site (legenda, muted, alpha e painel herdam automaticamente).
export const CONTACT_KIND_COLORS: Record<string, string> = {
  'person': '#22c55e',
  'company': '#3b82f6',
  'place': '#f59e0b',
  'event': '#ec4899',
  'other': '#64748b',
};

export const DOMAIN_FALLBACK = '#64748b';

export function domainColor(domain: string): string {
  return DOMAIN_COLORS[domain] ?? CONTACT_KIND_COLORS[domain] ?? DOMAIN_FALLBACK;
}

// Same color with adjustable alpha, used for dimmed / hovered-out states.
export function domainColorAlpha(domain: string, alpha: number): string {
  const hex = domainColor(domain);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Muted version: blends 55% with neutral gray so domain colors are present
// as a tint instead of pure saturated hues. Closer to Obsidian's default
// monochrome look while preserving the per-domain dimension as a hint.
export function domainColorMuted(domain: string): string {
  const hex = domainColor(domain);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Blend with neutral cool gray (180,180,200) — slight cool cast keeps the
  // graph feeling like a knowledge surface, not pure greyscale.
  const mix = 0.45; // 0 = pure original, 1 = pure gray
  const mr = Math.round(r * (1 - mix) + 180 * mix);
  const mg = Math.round(g * (1 - mix) + 180 * mix);
  const mb = Math.round(b * (1 - mix) + 200 * mix);
  return `rgb(${mr}, ${mg}, ${mb})`;
}
