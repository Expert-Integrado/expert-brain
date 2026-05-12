#!/usr/bin/env node
// Copia scripts/git-hooks/* pra .git/hooks/. Idempotente — sobrescreve sem perguntar.
// Roda automático via `npm install` (script `prepare`) e manual via `npm run install-hooks`.

import { readdirSync, copyFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_SRC = path.join(__dirname, 'git-hooks');
const HOOKS_DST = path.join(REPO_ROOT, '.git', 'hooks');

if (!existsSync(path.join(REPO_ROOT, '.git'))) {
  // Sem .git (clone shallow via npm pack, npx, ou similar) — nada a fazer.
  process.exit(0);
}

if (!existsSync(HOOKS_DST)) mkdirSync(HOOKS_DST, { recursive: true });

const hooks = readdirSync(HOOKS_SRC).filter((f) => !f.startsWith('.'));
for (const name of hooks) {
  const src = path.join(HOOKS_SRC, name);
  const dst = path.join(HOOKS_DST, name);
  copyFileSync(src, dst);
  try {
    // chmod no Windows é silencioso, mas no macOS/Linux precisa ser +x.
    chmodSync(dst, 0o755);
  } catch {
    /* ignore */
  }
  console.log(`hook instalado: ${name}`);
}
