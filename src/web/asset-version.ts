// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "db5b7aa7163d",
  "graph3d.bundle.js": "8efd10248e06",
  "notes.bundle.js": "ca6128e2374f",
  "local-graph.bundle.js": "3cdb5aa70cae",
  "note-media.bundle.js": "24c52523002f",
  "note-edit.bundle.js": "b4d2ad648e44",
  "shell.bundle.js": "1f37422a38bc",
  "tasks.bundle.js": "580e76b9ccfc",
  "task-edit.bundle.js": "452e70d500ae",
  "contact-page.bundle.js": "4545bd89b42b",
  "sim-worker.bundle.js": "3f1569f3df57",
  "home.bundle.js": "3e7c2a90d12b",
  "journal.bundle.js": "6741a0a12767",
  "styles.css": "832258a1189a",
  "config.bundle.js": "87488142d537"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
