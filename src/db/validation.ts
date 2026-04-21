// Canonical domain slug format: lowercase ASCII kebab-case, 2-40 chars.
// This is a SYNTACTIC check. Semantic language enforcement (e.g. rejecting
// 'biologia-evolutiva' because it's a Portuguese translation) lives in the
// tool description of save_note — Claude is instructed to always use English
// canonical slugs, and the tool description makes that load-bearing. The
// validator here just stops obvious syntax violations (accents, uppercase,
// spaces, etc) from getting into the taxonomy.
export const DOMAIN_SLUG_REGEX = /^[a-z][a-z0-9-]{1,39}$/;

export function validateDomains(domains: string[]): string | null {
  for (const d of domains) {
    if (typeof d !== 'string' || !DOMAIN_SLUG_REGEX.test(d)) {
      return buildDomainError(d);
    }
  }
  return null;
}

function buildDomainError(offender: unknown): string {
  const shown = typeof offender === 'string' ? offender : String(offender);
  return (
    `Domain '${shown}' is not a valid canonical slug. Use English kebab-case lowercase ` +
    `(e.g. 'evolutionary-biology', 'behavioral-economics', 'systems-thinking', ` +
    `'competitive-strategy', 'game-theory'). Domains are vault schema — they need to be ` +
    `stable identifiers that do not drift between conversation languages. Do NOT use ` +
    `accented characters, spaces, uppercase, or translations to other languages. ` +
    `If the conversation is in Portuguese and you were going to use 'biologia-evolutiva', ` +
    `use 'evolutionary-biology' instead.`
  );
}
