// Loader compartilhado do /app/graph/meta (spec 23). Memoiza a Promise num global
// do window pra que bundles distintos (shell, notes, graph) na MESMA página façam
// no máximo 1 fetch — o dedupe entre PÁGINAS fica por conta do ETag/max-age do
// servidor (handleGraphMeta: private, max-age=60 + 304 condicional).
//
// Usa appFetch (não fetch cru): mantém o tratamento de 401/sessão-expirada (spec 21)
// consistente com o resto dos clients — meta é rota de sessão.

import { appFetch } from './http.js';

export interface NoteMeta {
  id: string;
  title: string;
  kind: string;
  tldr: string;
  domains: string[];
  updated_at?: number;
}

export function loadMeta(): Promise<NoteMeta[]> {
  const w = window as unknown as { __ebMetaPromise?: Promise<NoteMeta[]> };
  if (!w.__ebMetaPromise) {
    w.__ebMetaPromise = appFetch('/app/graph/meta')
      .then((res) => {
        if (!res.ok) throw new Error(`meta ${res.status}`);
        return res.json() as Promise<NoteMeta[]>;
      })
      .catch((err) => {
        w.__ebMetaPromise = undefined; // permite retry na próxima chamada
        throw err;
      });
  }
  return w.__ebMetaPromise;
}
