// Builds all client-side bundles used by the /app UI.
// - graph.bundle.js: main graph page (/app/graph)
// - notes.bundle.js: notes list search/filter/sort (/app/notes)
// - local-graph.bundle.js: mini graph on note detail (/app/notes/:id)
// - shell.bundle.js: command palette + keyboard shortcuts (all pages)
// Served via /app/<area>/bundle.js routes, bundled with esbuild, minified.

import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const bundles: Array<{ entry: string; out: string }> = [
  { entry: 'src/web/client/graph.ts', out: 'assets/graph.bundle.js' },
  { entry: 'src/web/client/notes.ts', out: 'assets/notes.bundle.js' },
  { entry: 'src/web/client/local-graph.ts', out: 'assets/local-graph.bundle.js' },
  { entry: 'src/web/client/shell.ts', out: 'assets/shell.bundle.js' },
  // A.24 — Web Worker dedicado pra D3-force simulation
  { entry: 'src/web/client/sim-worker.ts', out: 'assets/sim-worker.bundle.js' },
];

for (const b of bundles) {
  await build({
    entryPoints: [path.join(root, b.entry)],
    outfile: path.join(root, b.out),
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    sourcemap: false,
    loader: { '.ts': 'ts' },
  });
  console.log(`built ${b.out}`);
}

// Hash de conteúdo por bundle → src/web/asset-version.ts. Usado como `?v=` nas
// tags <script>: estável dentro de um deploy (browser/SW cacheiam entre loads),
// muda quando o conteúdo muda (busta sozinho no próximo deploy). Substitui o
// antigo `?v=Date.now()`, que furava o cache a cada page load (rebaixava 210KB+).
const hashes: Record<string, string> = {};
for (const b of bundles) {
  const name = path.basename(b.out);
  const bytes = readFileSync(path.join(root, b.out));
  hashes[name] = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}
const generated =
  `// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.\n` +
  `// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).\n` +
  `export const ASSET_HASHES: Record<string, string> = ${JSON.stringify(hashes, null, 2)};\n\n` +
  `export function assetVersion(name: string): string {\n` +
  `  return ASSET_HASHES[name] ?? '0';\n` +
  `}\n`;
writeFileSync(path.join(root, 'src/web/asset-version.ts'), generated);
console.log('wrote src/web/asset-version.ts', hashes);
