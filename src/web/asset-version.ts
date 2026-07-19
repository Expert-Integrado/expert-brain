// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.
// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).
export const ASSET_HASHES: Record<string, string> = {
  "graph.bundle.js": "3de658ab5846",
  "graph3d.bundle.js": "6a02e91526cf",
  "notes.bundle.js": "5a335a2cc7c2",
  "local-graph.bundle.js": "a488c9001287",
  "note-media.bundle.js": "bda870b738f5",
  "note-edit.bundle.js": "6c24ca7c428c",
  "shell.bundle.js": "dd785e27ff57",
  "tasks.bundle.js": "0ea5e4ca16ce",
  "task-edit.bundle.js": "42e04d8353c1",
  "contact-page.bundle.js": "b09d0fc031c0",
  "sim-worker.bundle.js": "2b1cd681554f",
  "home.bundle.js": "c468751218d3",
  "journal.bundle.js": "751bb6d7e745",
  "styles.css": "e50405fc739f",
  "config.bundle.js": "3154226ec876"
};

export function assetVersion(name: string): string {
  return ASSET_HASHES[name] ?? '0';
}
