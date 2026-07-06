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
  // Grafo 3D (/app/graph3d) — "globo que gira" via 3d-force-graph (three incluso).
  { entry: 'src/web/client/graph3d.ts', out: 'assets/graph3d.bundle.js' },
  { entry: 'src/web/client/notes.ts', out: 'assets/notes.bundle.js' },
  { entry: 'src/web/client/local-graph.ts', out: 'assets/local-graph.bundle.js' },
  { entry: 'src/web/client/note-media.ts', out: 'assets/note-media.bundle.js' },
  // Editor inline no detalhe de nota (/app/notes/:id): título/corpo/tldr/domínios/kind
  { entry: 'src/web/client/note-edit.ts', out: 'assets/note-edit.bundle.js' },
  { entry: 'src/web/client/shell.ts', out: 'assets/shell.bundle.js' },
  // Kanban de tarefas (/app/tasks): filtros + drag-drop + concluir
  { entry: 'src/web/client/tasks.ts', out: 'assets/tasks.bundle.js' },
  // Editor inline no detalhe de task (/app/tasks/:id): título/corpo/status/prio/prazo
  { entry: 'src/web/client/task-edit.ts', out: 'assets/task-edit.bundle.js' },
  // Página própria do contato (/app/contacts/:id): cartela + vínculos 1º/2º nível
  // + timeline (spec 50-console-v2/56)
  { entry: 'src/web/client/contact-page.ts', out: 'assets/contact-page.bundle.js' },
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

// Recursos servidos direto do módulo do Worker (não via esbuild): versionados
// pelo mesmo esquema de ?v=<hash> (spec 28). O CSS do tema (/app/styles.css) e o
// bundle inline da página de config (/app/config/bundle.js). Imports resolvidos
// pelo tsx a partir do .ts. Determinísticos — rodar 2x produz o mesmo hash.
const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const { NEBULA_CSS } = await import('../src/web/styles.js');
hashes['styles.css'] = sha12(NEBULA_CSS);
const { configPageScript } = await import('../src/web/config-script.js');
hashes['config.bundle.js'] = sha12(configPageScript());
const generated =
  `// AUTO-GERADO por scripts/build-bundles.ts — não editar à mão.\n` +
  `// Hash de conteúdo de cada bundle pra cache-busting estável (?v=).\n` +
  `export const ASSET_HASHES: Record<string, string> = ${JSON.stringify(hashes, null, 2)};\n\n` +
  `export function assetVersion(name: string): string {\n` +
  `  return ASSET_HASHES[name] ?? '0';\n` +
  `}\n`;
writeFileSync(path.join(root, 'src/web/asset-version.ts'), generated);
console.log('wrote src/web/asset-version.ts', hashes);
