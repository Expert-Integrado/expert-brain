// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "281766200fa4",
  "graph3d.bundle.js": "8efd10248e06",
  "notes.bundle.js": "ca6128e2374f",
  "local-graph.bundle.js": "3cdb5aa70cae",
  "note-media.bundle.js": "24c52523002f",
  "note-edit.bundle.js": "99e74995e864",
  "shell.bundle.js": "1f37422a38bc",
  "tasks.bundle.js": "2d2b4de4d1b5",
  "task-edit.bundle.js": "452e70d500ae",
  "sim-worker.bundle.js": "3f1569f3df57",
  "styles.css": "f99b2479d412",
  "config.bundle.js": "87488142d537"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
