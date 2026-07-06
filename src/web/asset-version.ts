// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "a24a940e94ee",
  "graph3d.bundle.js": "8efd10248e06",
  "notes.bundle.js": "7444121e26d4",
  "local-graph.bundle.js": "133a395664c0",
  "note-media.bundle.js": "24c52523002f",
  "note-edit.bundle.js": "99e74995e864",
  "shell.bundle.js": "1f37422a38bc",
  "tasks.bundle.js": "2d2b4de4d1b5",
  "task-edit.bundle.js": "452e70d500ae",
  "sim-worker.bundle.js": "3f1569f3df57",
  "styles.css": "5a749bafab70",
  "config.bundle.js": "f433d50caa9f"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
