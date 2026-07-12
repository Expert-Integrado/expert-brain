// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "28971ed25f66",
  "graph3d.bundle.js": "d30be7348c1c",
  "notes.bundle.js": "e85db490d332",
  "local-graph.bundle.js": "a488c9001287",
  "note-media.bundle.js": "ebedbf78f620",
  "note-edit.bundle.js": "a8b6a7f739cf",
  "shell.bundle.js": "6be8d72df3fe",
  "tasks.bundle.js": "8ce4ca4c8c3a",
  "task-edit.bundle.js": "fdf0bafa7b43",
  "contact-page.bundle.js": "7573416f4b5c",
  "sim-worker.bundle.js": "2b1cd681554f",
  "home.bundle.js": "c468751218d3",
  "journal.bundle.js": "751bb6d7e745",
  "styles.css": "be58370cb1f1",
  "config.bundle.js": "ccd439d5943b"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
