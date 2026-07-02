// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "2a661025407f",
  "graph3d.bundle.js": "182258b8e451",
  "notes.bundle.js": "8cc8afd00b45",
  "local-graph.bundle.js": "f00f8b707a5f",
  "note-media.bundle.js": "24c52523002f",
  "shell.bundle.js": "42596dae57a3",
  "tasks.bundle.js": "e1450f79eb4c",
  "sim-worker.bundle.js": "3f1569f3df57"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
