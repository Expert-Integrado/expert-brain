// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "eac3e4957677",
  "notes.bundle.js": "44e75a045829",
  "local-graph.bundle.js": "f00f8b707a5f",
  "shell.bundle.js": "89161156f02e",
  "tasks.bundle.js": "af8f869c698f",
  "sim-worker.bundle.js": "aba9c68a922b"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
