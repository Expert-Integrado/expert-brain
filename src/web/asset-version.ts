// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "495d3fb07cb4",
  "graph3d.bundle.js": "d30be7348c1c",
  "notes.bundle.js": "692da89103fb",
  "local-graph.bundle.js": "a488c9001287",
  "note-media.bundle.js": "24c52523002f",
  "note-edit.bundle.js": "2adc231224e4",
  "shell.bundle.js": "75aebd3ba9af",
  "tasks.bundle.js": "96f8daf36e54",
  "task-edit.bundle.js": "2eb9aa0b7beb",
  "contact-page.bundle.js": "264fb56c9197",
  "sim-worker.bundle.js": "2b1cd681554f",
  "home.bundle.js": "519965cc9ad9",
  "journal.bundle.js": "c2dded04f4a4",
  "styles.css": "e7283ae54018",
  "config.bundle.js": "ac0825b9e441"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
