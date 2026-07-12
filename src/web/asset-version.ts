// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "21568650e013",
  "graph3d.bundle.js": "c456d0df54e0",
  "notes.bundle.js": "e85db490d332",
  "local-graph.bundle.js": "a488c9001287",
  "note-media.bundle.js": "ebedbf78f620",
  "note-edit.bundle.js": "a8b6a7f739cf",
  "shell.bundle.js": "e3d9b0a84e07",
  "tasks.bundle.js": "0ea5e4ca16ce",
  "task-edit.bundle.js": "8697b5f5b8c7",
  "contact-page.bundle.js": "7573416f4b5c",
  "sim-worker.bundle.js": "2b1cd681554f",
  "home.bundle.js": "c468751218d3",
  "journal.bundle.js": "751bb6d7e745",
  "styles.css": "40207296052e",
  "config.bundle.js": "12702943ad71"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
