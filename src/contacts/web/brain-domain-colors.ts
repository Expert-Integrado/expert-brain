// Paleta de domínios do Brain — espelho de src/web/domain-colors.ts do repo
// expert-brain. Os 12 domínios canônicos (kebab-case inglês) com as mesmas cores
// testadas contra o fundo escuro do grafo. Mantido como cópia local porque o
// Console é outro repo/Worker — não dá pra importar do Brain. Se a paleta mudar
// lá, sincronizar aqui.
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

export const DOMAIN_FALLBACK = '#64748b';
