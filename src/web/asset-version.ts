// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "3de658ab5846",
  "graph3d.bundle.js": "6a02e91526cf",
  "notes.bundle.js": "5a335a2cc7c2",
  "local-graph.bundle.js": "a488c9001287",
  "note-media.bundle.js": "bda870b738f5",
  "note-edit.bundle.js": "6c24ca7c428c",
  "shell.bundle.js": "24ad12c455e7",
  "tasks.bundle.js": "461e61649b96",
  "task-edit.bundle.js": "dea71dd21189",
  "contact-page.bundle.js": "b09d0fc031c0",
  "sim-worker.bundle.js": "2b1cd681554f",
  "home.bundle.js": "0751b0ca9158",
  "journal.bundle.js": "751bb6d7e745",
  "styles.css": "e16eb5ca7d4f",
  "config.bundle.js": "b3d6c40b3ce9"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
