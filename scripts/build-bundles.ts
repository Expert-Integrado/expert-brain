// Builds all client-side bundles used by the /app UI.
// - graph.bundle.js: main graph page (/app/graph)
// - notes.bundle.js: notes list search/filter/sort (/app/notes)
// - local-graph.bundle.js: mini graph on note detail (/app/notes/:id)
// - shell.bundle.js: command palette + keyboard shortcuts (all pages)
// Served via /app/<area>/bundle.js routes, bundled with esbuild, minified.

import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const bundles: Array<{ entry: string; out: string }> = [
  { entry: 'src/web/client/graph.ts', out: 'assets/graph.bundle.js' },
  { entry: 'src/web/client/notes.ts', out: 'assets/notes.bundle.js' },
  { entry: 'src/web/client/local-graph.ts', out: 'assets/local-graph.bundle.js' },
  { entry: 'src/web/client/shell.ts', out: 'assets/shell.bundle.js' },
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
