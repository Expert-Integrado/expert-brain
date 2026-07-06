// Loader compartilhado do /app/config/taxonomy (spec 54). Memoiza a Promise num
// global do window pra os bundles distintos na MESMA página (notes, graph)
// fazerem no máximo 1 fetch — mesmo padrão de meta-cache.ts.
import { appFetch } from './http.js';
import type { TaxonomyConfig } from '../domain-colors.js';

export type { TaxonomyConfig };

const FALLBACK: TaxonomyConfig = { domains: {}, kinds: {} };

export function loadTaxonomy(): Promise<TaxonomyConfig> {
  const w = window as unknown as { __ebTaxonomyPromise?: Promise<TaxonomyConfig> };
  if (!w.__ebTaxonomyPromise) {
    w.__ebTaxonomyPromise = appFetch('/app/config/taxonomy')
      .then((res) => {
        if (!res.ok) throw new Error(`taxonomy ${res.status}`);
        return res.json() as Promise<TaxonomyConfig>;
      })
      .catch((err) => {
        console.warn('taxonomy: load failed, using compiled palette only', err);
        w.__ebTaxonomyPromise = undefined; // permite retry na próxima chamada
        return FALLBACK;
      });
  }
  return w.__ebTaxonomyPromise;
}
