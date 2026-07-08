// Verificação de fim de onda da reforma UI/UX (specs/60-ux-reforma/61).
//
// Roda a bateria completa na ordem: typecheck → testes (server + client) →
// build de bundles (com gate de diff em assets/) → e2e → harness visual da
// fase → contact sheet vs baseline. Para no primeiro passo que falhar.
//
// Uso:
//   node scripts/verify-wave.mjs --phase wave-2
//   node scripts/verify-wave.mjs --phase wave-2 --skip e2e,audit
//
// O harness visual exige o wrangler dev de pé (npm run dev:full) e as envs
// UX_AUDIT_EMAIL / UX_AUDIT_PASSWORD. PYTHON aponta o interpretador com
// playwright instalado (default: python no PATH).

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
const phaseIx = args.indexOf('--phase');
const phase = phaseIx >= 0 ? args[phaseIx + 1] : null;
const skipIx = args.indexOf('--skip');
const skip = new Set(skipIx >= 0 ? args[skipIx + 1].split(',') : []);
const PYTHON = process.env.PYTHON || 'python';

if (!phase) {
  console.error('uso: node scripts/verify-wave.mjs --phase <nome> [--skip passo,passo]');
  console.error('passos: typecheck, test, test-client, bundles, e2e, audit, sheet');
  process.exit(1);
}

const steps = [
  { name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
  { name: 'test', cmd: 'npm', args: ['test'] },
  { name: 'test-client', cmd: 'npm', args: ['run', 'test:client'] },
  { name: 'bundles', cmd: 'npm', args: ['run', 'build:bundles'] },
  // bundles commitados têm que bater com o fonte — diff sujo = esqueceu de rebuildar
  { name: 'bundles-diff', cmd: 'git', args: ['diff', '--exit-code', '--stat', 'assets/'] },
  { name: 'e2e', cmd: 'npm', args: ['run', 'e2e'] },
  { name: 'audit', cmd: PYTHON, args: ['scripts/ux-audit/audit.py', '--phase', phase] },
  { name: 'sheet', cmd: PYTHON, args: ['scripts/ux-audit/contact_sheet.py', '--phase', phase, '--against', 'baseline'] },
];

for (const step of steps) {
  if (skip.has(step.name) || (skip.has('audit') && step.name === 'sheet')) {
    console.log(`\n== ${step.name}: PULADO ==`);
    continue;
  }
  console.log(`\n== ${step.name} ==`);
  const r = spawnSync(step.cmd, step.args, { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`\nFALHOU no passo "${step.name}" (exit ${r.status}). Corrija antes de fechar a onda.`);
    process.exit(r.status ?? 1);
  }
}

console.log(`\nOnda "${phase}" verificada: todos os passos passaram.`);
console.log('Falta o checklist manual: docs/ux-reform-verificacao.md');
