// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "e3085684e6a3",
  "graph3d.bundle.js": "d30be7348c1c",
  "notes.bundle.js": "ca6128e2374f",
  "local-graph.bundle.js": "018d84c6b2ca",
  "note-media.bundle.js": "24c52523002f",
  "note-edit.bundle.js": "23df109db29c",
  "shell.bundle.js": "75aebd3ba9af",
  "tasks.bundle.js": "caffb336b020",
  "task-edit.bundle.js": "a5eb9cdfe557",
  "contact-page.bundle.js": "4d43b9fa16a3",
  "sim-worker.bundle.js": "3f1569f3df57",
  "home.bundle.js": "3e7c2a90d12b",
  "journal.bundle.js": "6741a0a12767",
  "styles.css": "89a9bd102502",
  "config.bundle.js": "0711d0d07351"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
