import { describe, it, expect } from 'vitest';
import {
  validateDomains,
  suggestCanonical,
  CANONICAL_DOMAINS,
  DOMAIN_SLUG_REGEX,
} from '../../src/db/validation.js';

describe('validateDomains — canon (default behavior)', () => {
  it('accepts the 12 canonical domains', () => {
    for (const d of CANONICAL_DOMAINS) {
      expect(validateDomains([d])).toBeNull();
    }
  });

  it('accepts a mix of multiple canonical domains', () => {
    expect(validateDomains(['operations', 'ai-applied'])).toBeNull();
    expect(validateDomains(['leadership', 'management', 'product'])).toBeNull();
  });

  it('rejects a syntactically-valid slug that is not in the canon', () => {
    const err = validateDomains(['systems-thinking']);
    expect(err).not.toBeNull();
    expect(err).toContain('systems-thinking');
    expect(err).toContain('canonical');
    expect(err).toContain('allow_new_domain: true');
  });

  it('rejects a non-canonical domain even in the middle of a valid list', () => {
    const err = validateDomains(['operations', 'random-stuff', 'product']);
    expect(err).not.toBeNull();
    expect(err).toContain('random-stuff');
  });

  it('rejects an English slug like "ai" that is not the canonical "ai-applied"', () => {
    const err = validateDomains(['ai']);
    expect(err).not.toBeNull();
    expect(err).toContain("'ai'");
    expect(err).toContain('ai-applied');
  });

  it('suggests the closest canonical in the error message', () => {
    const err = validateDomains(['security']);
    expect(err).toContain("Closest match: 'operations'");
  });
});

describe('validateDomains — allowNewDomain escape hatch', () => {
  it('accepts non-canonical syntactically-valid slugs when allowNewDomain is true', () => {
    expect(validateDomains(['systems-thinking'], { allowNewDomain: true })).toBeNull();
    expect(validateDomains(['biologia-evolutiva'], { allowNewDomain: true })).toBeNull();
    expect(validateDomains(['biotech', 'quantum'], { allowNewDomain: true })).toBeNull();
  });

  it('still rejects syntactic violations when allowNewDomain is true', () => {
    expect(validateDomains(['Evolutionary-Biology'], { allowNewDomain: true })).not.toBeNull();
    expect(validateDomains(['has spaces'], { allowNewDomain: true })).not.toBeNull();
    expect(validateDomains(['accênted'], { allowNewDomain: true })).not.toBeNull();
  });
});

describe('validateDomains — syntactic checks (always on)', () => {
  it('rejects uppercase', () => {
    const err = validateDomains(['Evolutionary-Biology']);
    expect(err).not.toBeNull();
    expect(err).toContain('Evolutionary-Biology');
  });

  it('rejects accented chars', () => {
    const err = validateDomains(['biologia-evolutiva-avançada']);
    expect(err).not.toBeNull();
    expect(err).toContain('biologia-evolutiva-avançada');
  });

  it('rejects spaces', () => {
    const err = validateDomains(['evolutionary biology']);
    expect(err).not.toBeNull();
    expect(err).toContain('evolutionary biology');
  });

  it('rejects underscore', () => {
    expect(validateDomains(['evolutionary_biology'])).not.toBeNull();
  });

  it('rejects leading digit', () => {
    expect(validateDomains(['1biology'])).not.toBeNull();
  });

  it('rejects too short (single char)', () => {
    expect(validateDomains(['a'])).not.toBeNull();
  });

  it('rejects too long (>40 chars)', () => {
    const longSlug = 'a' + '-b'.repeat(25); // 51 chars
    expect(validateDomains([longSlug])).not.toBeNull();
  });

  it('DOMAIN_SLUG_REGEX is exported and correct', () => {
    expect(DOMAIN_SLUG_REGEX).toBeInstanceOf(RegExp);
    expect('evolutionary-biology').toMatch(DOMAIN_SLUG_REGEX);
    expect('INVALID').not.toMatch(DOMAIN_SLUG_REGEX);
  });
});

describe('suggestCanonical — heuristic order', () => {
  it('keyword: security/monitoring/risk/legal/infrastructure/database/financial/identity → operations', () => {
    expect(suggestCanonical('security')).toBe('operations');
    expect(suggestCanonical('monitoring')).toBe('operations');
    expect(suggestCanonical('legal-compliance')).toBe('operations');
    expect(suggestCanonical('database-ops')).toBe('operations');
    expect(suggestCanonical('financial-controls')).toBe('operations');
  });

  it('keyword: personal/finance/travel/productivity/logistics/preferences → personal-development', () => {
    expect(suggestCanonical('personal-finance')).toBe('personal-development');
    expect(suggestCanonical('travel')).toBe('personal-development');
    expect(suggestCanonical('productivity-system')).toBe('personal-development');
  });

  it('keyword: tech/software/automation/debug/mcp/ai → ai-applied', () => {
    expect(suggestCanonical('tech-stack')).toBe('ai-applied');
    expect(suggestCanonical('software-arch')).toBe('ai-applied');
    expect(suggestCanonical('mcp-server')).toBe('ai-applied');
    expect(suggestCanonical('ai')).toBe('ai-applied');
  });

  it('keyword: product-development/whatsapp/app → product', () => {
    expect(suggestCanonical('whatsapp-agent')).toBe('product');
    expect(suggestCanonical('app-architecture')).toBe('product');
    expect(suggestCanonical('product-development')).toBe('product');
  });

  it('keyword: business/venture → entrepreneurship', () => {
    expect(suggestCanonical('business-model')).toBe('entrepreneurship');
    expect(suggestCanonical('venture-capital')).toBe('entrepreneurship');
  });

  it('Levenshtein fallback for inputs that miss every keyword', () => {
    // 'manegement' is 1 edit from 'management' and doesn't match any keyword
    expect(suggestCanonical('manegement')).toBe('management');
    // 'salez' should hit 'sales' via edit distance
    expect(suggestCanonical('salez')).toBe('sales');
    // 'musik' → 'music'
    expect(suggestCanonical('musik')).toBe('music');
  });
});
