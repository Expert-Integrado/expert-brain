// Canonical domain slug format: lowercase ASCII kebab-case, 2-40 chars.
// This is a SYNTACTIC check used by both layers below.
export const DOMAIN_SLUG_REGEX = /^[a-z][a-z0-9-]{1,39}$/;

// The 12 canonical domains of the Expert Brain vault. By default save_note and
// update_note reject anything outside this list — the canon is a hard rail to
// prevent drift (back when the validator was only syntactic, 46 domains piled
// up and required a manual cleanup pass). Callers can opt out per call by
// passing `allowNewDomain: true` when a genuinely new area shows up.
export const CANONICAL_DOMAINS = [
  'management',
  'sales',
  'marketing',
  'education',
  'ai-applied',
  'leadership',
  'product',
  'operations',
  'personal-development',
  'entrepreneurship',
  'music',
  'cognitive-science',
] as const;

export type CanonicalDomain = (typeof CANONICAL_DOMAINS)[number];

const CANONICAL_SET = new Set<string>(CANONICAL_DOMAINS);

export interface ValidateDomainsOptions {
  /**
   * Skip the "must be one of the 12 canonical domains" check. Syntactic
   * validation (kebab-case ASCII) still applies. Default false. Pass true
   * only when the caller genuinely needs a domain outside the canon — the
   * MCP tools expose this as `allow_new_domain`.
   */
  allowNewDomain?: boolean;
}

export function validateDomains(
  domains: string[],
  opts: ValidateDomainsOptions = {}
): string | null {
  const { allowNewDomain = false } = opts;

  for (const d of domains) {
    if (typeof d !== 'string' || !DOMAIN_SLUG_REGEX.test(d)) {
      return buildSyntaxError(d);
    }
    if (!allowNewDomain && !CANONICAL_SET.has(d)) {
      return buildCanonError(d);
    }
  }
  return null;
}

function buildSyntaxError(offender: unknown): string {
  const shown = typeof offender === 'string' ? offender : String(offender);
  return (
    `Domain '${shown}' is not a valid slug. Use English kebab-case lowercase ` +
    `(letters, digits, hyphens), 2-40 chars, starting with a letter. ` +
    `No accents, spaces, uppercase, or underscores. ` +
    `If the conversation is in Portuguese and you were going to use 'biologia-evolutiva', ` +
    `use 'evolutionary-biology' instead.`
  );
}

function buildCanonError(offender: string): string {
  const suggested = suggestCanonical(offender);
  return (
    `Domain '${offender}' is not in the canonical list. The vault has 12 canonical domains: ` +
    `${CANONICAL_DOMAINS.join(', ')}. ` +
    `Closest match: '${suggested}'. ` +
    `If you really need a new domain (e.g. the user moved to a new market), ` +
    `pass allow_new_domain: true on this tool call to bypass the canon check. ` +
    `Otherwise rewrite the domain to one of the 12 canonical slugs above.`
  );
}

/**
 * Suggest the closest canonical domain for a non-canonical input.
 *
 * Tries keyword heuristics first (cheap, semantically aware), then falls back
 * to Levenshtein distance against the 12 canonical slugs. The keyword rules
 * mirror common drift patterns Eric saw in the 46→12 cleanup of 12/05/2026.
 */
export function suggestCanonical(input: string): CanonicalDomain {
  const s = input.toLowerCase();

  // Keyword heuristics — first match wins, order is intentional.
  if (/(security|monitoring|risk|legal|infrastructure|database|financial|identity)/.test(s)) {
    return 'operations';
  }
  if (/(personal|finance|travel|productivity|logistics|preferences)/.test(s)) {
    return 'personal-development';
  }
  if (/(tech|software|automation|debug|mcp|\bai\b)/.test(s)) {
    return 'ai-applied';
  }
  if (/(product-development|whatsapp|app)/.test(s)) {
    return 'product';
  }
  if (/(business|venture)/.test(s)) {
    return 'entrepreneurship';
  }

  // Fallback: Levenshtein against the canon, return the closest.
  let best: CanonicalDomain = CANONICAL_DOMAINS[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const candidate of CANONICAL_DOMAINS) {
    const dist = levenshtein(s, candidate);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Classic Levenshtein edit distance. Two-row rolling buffer to avoid the full
 * O(m*n) matrix. Fine for our use case: domain strings are <= 40 chars and the
 * canon has 12 entries, so the total work per suggestion is trivial.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,      // insertion
        prev[j] + 1,          // deletion
        prev[j - 1] + cost,   // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}
