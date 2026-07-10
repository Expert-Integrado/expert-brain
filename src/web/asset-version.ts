// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "bfc4e6e548f6",
  "graph3d.bundle.js": "d30be7348c1c",
  "notes.bundle.js": "e85db490d332",
  "local-graph.bundle.js": "a488c9001287",
  "note-media.bundle.js": "24c52523002f",
  "note-edit.bundle.js": "3415e546670c",
  "shell.bundle.js": "75aebd3ba9af",
  "tasks.bundle.js": "d2090783b091",
  "task-edit.bundle.js": "0dd825243b66",
  "contact-page.bundle.js": "7573416f4b5c",
  "sim-worker.bundle.js": "2b1cd681554f",
  "home.bundle.js": "519965cc9ad9",
  "journal.bundle.js": "c2dded04f4a4",
  "styles.css": "e7283ae54018",
  "config.bundle.js": "2933f29d8af9"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
