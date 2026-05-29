// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "58cd238b75a1",
  "notes.bundle.js": "44e75a045829",
  "local-graph.bundle.js": "f00f8b707a5f",
  "shell.bundle.js": "5380044ee5d5",
  "sim-worker.bundle.js": "670aeb4a708f"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
