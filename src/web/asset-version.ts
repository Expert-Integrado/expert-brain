// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "135edf03508d",
  "notes.bundle.js": "a2ad7840cbd3",
  "local-graph.bundle.js": "14e89514f5c5",
  "shell.bundle.js": "0acea1a0485b",
  "sim-worker.bundle.js": "1e518275bbd8"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
