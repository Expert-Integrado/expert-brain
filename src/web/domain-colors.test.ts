import { describe, it, expect } from 'vitest';
import {
  resolveDomainMeta,
  resolveKindMeta,
  domainColor,
  DOMAIN_FALLBACK,
  KIND_COLOR_FALLBACK,
  EMPTY_TAXONOMY_CONFIG,
  type TaxonomyConfig,
} from './domain-colors.js';

// spec 54 — resolvedor: customização do dono > paleta compilada > cinza+slug.

describe('resolveDomainMeta', () => {
  it('sem config (undefined/null/vazia): cai na paleta compilada, label = slug', () => {
    expect(resolveDomainMeta('management')).toEqual({ label: 'management', color: domainColor('management') });
    expect(resolveDomainMeta('management', null)).toEqual({ label: 'management', color: domainColor('management') });
    expect(resolveDomainMeta('management', EMPTY_TAXONOMY_CONFIG)).toEqual({ label: 'management', color: domainColor('management') });
  });

  it('slug totalmente desconhecido (fora do canon, sem config): cinza + slug como label', () => {
    const meta = resolveDomainMeta('area-nunca-vista');
    expect(meta.label).toBe('area-nunca-vista');
    expect(meta.color).toBe(DOMAIN_FALLBACK);
  });

  it('config customiza label e cor de uma área canônica: sobrepõe a paleta', () => {
    const config: TaxonomyConfig = { domains: { management: { label: 'Gestão', color: '#123456' } }, kinds: {} };
    expect(resolveDomainMeta('management', config)).toEqual({ label: 'Gestão', color: '#123456' });
  });

  it('área pré-criada só na config (0 notas): resolve normalmente pela config', () => {
    const config: TaxonomyConfig = { domains: { 'vida-pessoal': { label: 'Vida Pessoal', color: '#22c55e' } }, kinds: {} };
    expect(resolveDomainMeta('vida-pessoal', config)).toEqual({ label: 'Vida Pessoal', color: '#22c55e' });
  });

  it('config não afeta uma área DIFERENTE da customizada', () => {
    const config: TaxonomyConfig = { domains: { management: { label: 'Gestão', color: '#123456' } }, kinds: {} };
    expect(resolveDomainMeta('sales', config)).toEqual({ label: 'sales', color: domainColor('sales') });
  });
});

describe('resolveKindMeta', () => {
  it('sem config: label = kind cru, cor = paleta fixa de kinds', () => {
    for (const k of Object.keys(KIND_COLOR_FALLBACK)) {
      expect(resolveKindMeta(k)).toEqual({ label: k, color: KIND_COLOR_FALLBACK[k] });
    }
  });

  it('kind desconhecido (fora dos 7): label = kind, cor cinza', () => {
    expect(resolveKindMeta('nao-e-um-kind')).toEqual({ label: 'nao-e-um-kind', color: DOMAIN_FALLBACK });
  });

  it('config customiza label e cor de um kind: sobrepõe a paleta fixa', () => {
    const config: TaxonomyConfig = { domains: {}, kinds: { decision: { label: 'Decisão', color: '#f59e0b' } } };
    expect(resolveKindMeta('decision', config)).toEqual({ label: 'Decisão', color: '#f59e0b' });
  });

  it('config não afeta um kind DIFERENTE do customizado', () => {
    const config: TaxonomyConfig = { domains: {}, kinds: { decision: { label: 'Decisão', color: '#f59e0b' } } };
    expect(resolveKindMeta('concept', config)).toEqual({ label: 'concept', color: KIND_COLOR_FALLBACK.concept });
  });
});
