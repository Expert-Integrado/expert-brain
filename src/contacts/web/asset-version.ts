// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "console.bundle.js": "942841ae39b3",
  "graph.bundle.js": "87c3688995a4",
  "sim-worker.bundle.js": "8669f048a0e9",
  "detail.bundle.js": "6dc6c8747cb4"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
