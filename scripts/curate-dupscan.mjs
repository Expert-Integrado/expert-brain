#!/usr/bin/env node
// Scan LOCAL de duplicatas no vault, sem custo de API. Lê um dump JSON das notas
// (saída do `wrangler d1 execute ... --json`) e acha pares de título/tldr quase
// idênticos por similaridade de Jaccard de tokens. Complementa a busca semântica
// (recall), que não enumera a cauda — aqui o passe é exaustivo e offline.
//
// Como gerar o dump:
//   wrangler d1 execute <DB> --remote --json \
//     --command "SELECT id,title,domains,kind,tldr,created_at,updated_at \
//                FROM notes WHERE deleted_at IS NULL AND (kind IS NULL OR kind<>'task')" \
//     > notes-dump.json
//
// Uso:
//   node scripts/curate-dupscan.mjs <dump.json> [limiar]
//   (limiar de similaridade de 0 a 1, default 0.6)

import fs from 'node:fs';

const path = process.argv[2];
const threshold = Number(process.argv[3] ?? 0.6);
if (!path) {
  console.error('Faltou o caminho do dump. Uso: node scripts/curate-dupscan.mjs <dump.json> [limiar]');
  process.exit(1);
}

// O dump do wrangler é um array [{ results: [...] }]; aceitamos também um array puro de notas.
const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
const rows = Array.isArray(parsed) ? (parsed[0]?.results ?? parsed) : (parsed.results ?? []);

const STOP = new Set('de da do que com pra para em no na uma dos das the of to for and as via por sem pro a o e'.split(' '));
function tokens(s) {
  return new Set(
    (s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

const items = rows.map((r) => ({
  id: r.id,
  title: r.title,
  t: tokens(r.title),
  d: tokens(`${r.title || ''} ${r.tldr || ''}`),
}));

const pairs = [];
for (let i = 0; i < items.length; i++) {
  if (items[i].t.size < 2) continue;
  for (let j = i + 1; j < items.length; j++) {
    if (items[j].t.size < 2) continue;
    // título pesa mais; tldr entra com leve desconto pra não inflar falso-positivo.
    const score = Math.max(jaccard(items[i].t, items[j].t), jaccard(items[i].d, items[j].d) * 0.95);
    if (score >= threshold) {
      pairs.push([Number(score.toFixed(2)), items[i].id, items[j].id, items[i].title, items[j].title]);
    }
  }
}
pairs.sort((a, b) => b[0] - a[0]);

console.log(`${rows.length} notas | ${pairs.length} pares com similaridade >= ${threshold}`);
for (const [score, idA, idB, titleA, titleB] of pairs) {
  console.log(`${score}  ${idA}  ${idB}  |  ${titleA}  ||  ${titleB}`);
}
