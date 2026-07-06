#!/usr/bin/env node
// Restore manual de um snapshot do Expert Brain (specs/50-console-v2/67-backup-export.md).
// Lê manifest.json + <tabela>.jsonl de um diretório (export descompactado ou
// download do R2) e gera lotes .sql pra importar num D1 NOVO E VAZIO via
// `wrangler d1 execute`. Restore NUNCA é endpoint do Worker — é operação
// deliberada do dono. Runbook completo: docs/restore.md.
//
// Uso:
//   node scripts/restore-from-snapshot.mjs <dir-do-snapshot> [opções]
//
// Opções:
//   --db <nome>     nome do banco D1 alvo (default: expert-brain)
//   --out <dir>     diretório dos .sql gerados (default: <dir-do-snapshot>/restore-sql)
//   --run           executa os lotes na ordem, via `npx wrangler d1 execute`
//   --remote        com --run: executa no D1 remoto (sem isso, --local)
//   --verify        com --run: confere as contagens finais contra o manifest
//   --batch <n>     linhas por INSERT (default: 50)
//   --or-replace    INSERT OR REPLACE em vez de INSERT (re-execução deliberada;
//                   CUIDADO: REPLACE em `notes` pode deixar entrada órfã no FTS)

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { jsonlToInsertStatements, sortTablesForRestore } from './lib/jsonl-to-sql.mjs';

const STATEMENTS_PER_FILE = 10; // 10 statements x 50 linhas = 500 linhas por arquivo

function fail(msg) {
  console.error(`ERRO: ${msg}`);
  process.exit(1);
}

// --- parse de argumentos -----------------------------------------------------
const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('--')) {
  fail('uso: node scripts/restore-from-snapshot.mjs <dir-do-snapshot> [--db nome] [--out dir] [--run] [--remote] [--verify] [--batch n] [--or-replace]');
}
const snapshotDir = resolve(args[0]);
const opt = { db: 'expert-brain', out: null, run: false, remote: false, verify: false, batch: 50, orReplace: false };
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--db') opt.db = args[++i];
  else if (a === '--out') opt.out = resolve(args[++i]);
  else if (a === '--run') opt.run = true;
  else if (a === '--remote') opt.remote = true;
  else if (a === '--verify') opt.verify = true;
  else if (a === '--batch') opt.batch = Number(args[++i]) || 50;
  else if (a === '--or-replace') opt.orReplace = true;
  else fail(`opção desconhecida: ${a}`);
}
const outDir = opt.out ?? join(snapshotDir, 'restore-sql');

// --- carrega manifest + JSONLs -----------------------------------------------
if (!existsSync(snapshotDir)) fail(`diretório não existe: ${snapshotDir}`);
const manifestPath = join(snapshotDir, 'manifest.json');
if (!existsSync(manifestPath)) fail(`manifest.json não encontrado em ${snapshotDir} — snapshot incompleto?`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const jsonlFiles = readdirSync(snapshotDir).filter((f) => f.endsWith('.jsonl'));
if (jsonlFiles.length === 0) fail(`nenhum .jsonl em ${snapshotDir}`);
const tablesInDir = jsonlFiles.map((f) => basename(f, '.jsonl'));

// _migrations NÃO é importada: o schema vem do POST /setup/provision (runMigrations),
// que já popula a tabela. Só conferimos a versão (abaixo, e no --verify).
const importTables = sortTablesForRestore(tablesInDir.filter((t) => t !== '_migrations'));

console.log(`Snapshot:  ${snapshotDir}`);
console.log(`Manifest:  criado em ${manifest.created_at_iso ?? '?'} · schema ${manifest.schema_version ?? '?'}`);
console.log(`Tabelas a importar (${importTables.length}): ${importTables.join(', ')}`);
if (manifest.schema_version) {
  console.log(`ATENÇÃO: o banco alvo precisa estar provisionado com a migration '${manifest.schema_version}' (ou mais nova) ANTES do import.`);
}

// --- gera os lotes .sql --------------------------------------------------------
mkdirSync(outDir, { recursive: true });
const sqlFiles = [];
let seq = 0;
for (const table of importTables) {
  const jsonl = readFileSync(join(snapshotDir, `${table}.jsonl`), 'utf8');
  const stmts = jsonlToInsertStatements(table, jsonl, { rowsPerStatement: opt.batch, orReplace: opt.orReplace });
  if (stmts.length === 0) {
    console.log(`  ${table}: 0 linhas — pulando`);
    continue;
  }
  for (let i = 0; i < stmts.length; i += STATEMENTS_PER_FILE) {
    const part = stmts.slice(i, i + STATEMENTS_PER_FILE).join('\n\n') + '\n';
    seq++;
    const name = `${String(seq).padStart(3, '0')}-${table}-${Math.floor(i / STATEMENTS_PER_FILE) + 1}.sql`;
    writeFileSync(join(outDir, name), part, 'utf8');
    sqlFiles.push(name);
  }
  const expected = manifest.tables?.[table];
  console.log(`  ${table}: ${jsonl.split('\n').filter((l) => l.trim()).length} linhas` + (expected !== undefined ? ` (manifest: ${expected})` : ''));
}
console.log(`\n${sqlFiles.length} lotes .sql gerados em ${outDir}`);

// --- execução opcional ----------------------------------------------------------
const wranglerTarget = opt.remote ? '--remote' : '--local';
function wrangler(argv) {
  return spawnSync('npx', ['wrangler', ...argv], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}

if (!opt.run) {
  console.log(`\nPra importar, rode na ordem (ou repita com --run):`);
  for (const f of sqlFiles) console.log(`  npx wrangler d1 execute ${opt.db} ${wranglerTarget} --file "${join(outDir, f)}"`);
  process.exit(0);
}

console.log(`\nImportando em ${opt.db} (${wranglerTarget})...`);
for (const f of sqlFiles) {
  process.stdout.write(`  ${f} ... `);
  const r = wrangler(['d1', 'execute', opt.db, wranglerTarget, '--file', join(outDir, f)]);
  if (r.status !== 0) {
    console.log('FALHOU');
    fail(`import abortado em ${f}. Banco possivelmente parcial — recomece num banco vazio (docs/restore.md).`);
  }
  console.log('ok');
}
console.log('Import concluído.');

// --- verificação opcional de contagens ------------------------------------------
if (opt.verify) {
  console.log('\nVerificando contagens contra o manifest...');
  let mismatches = 0;
  for (const table of importTables) {
    const r = wrangler(['d1', 'execute', opt.db, wranglerTarget, '--json', '--command', `SELECT COUNT(*) AS n FROM "${table}"`]);
    if (r.status !== 0) fail(`falha ao contar ${table}`);
    let n = NaN;
    try {
      const parsed = JSON.parse(r.stdout);
      n = parsed?.[0]?.results?.[0]?.n;
    } catch {
      fail(`saída inesperada do wrangler ao contar ${table}`);
    }
    const expected = manifest.tables?.[table];
    const ok = expected === undefined || n === expected;
    if (!ok) mismatches++;
    console.log(`  ${table}: ${n}${expected !== undefined ? ` / manifest ${expected}` : ''} ${ok ? 'OK' : 'DIVERGENTE'}`);
  }
  if (manifest.schema_version) {
    const r = wrangler(['d1', 'execute', opt.db, wranglerTarget, '--json', '--command', `SELECT COUNT(*) AS n FROM "_migrations" WHERE id = '${String(manifest.schema_version).replace(/'/g, "''")}'`]);
    const found = r.status === 0 && (() => { try { return JSON.parse(r.stdout)?.[0]?.results?.[0]?.n === 1; } catch { return false; } })();
    console.log(`  schema ${manifest.schema_version}: ${found ? 'presente' : 'AUSENTE — rode o provision!'}`);
    if (!found) mismatches++;
  }
  if (mismatches > 0) fail(`${mismatches} divergência(s) — restore NÃO validado.`);
  console.log('Contagens batem com o manifest. Restante do runbook: reembed + mídia (docs/restore.md).');
}
