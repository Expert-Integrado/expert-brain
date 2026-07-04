#!/usr/bin/env node
// Expert Brain — PostToolUse hook (camada CLIENTE, generica): audit de captura.
//
// Dispara (via matcher no settings.json) sempre que o agente SALVA algo no Brain
// ou no expert-contacts. Registra: (a) linha em ~/.claude/logs/brain-saves.jsonl
// (trilha pra medir a taxa de captura), (b) last_save_ts em um state file que o
// hook de Stop (expert-brain-stop-sweep.cjs) le pra saber se a sessao esta
// "em silencio" ha muito tempo.
//
// Zero rede, zero credencial. Nunca bloqueia o tool call (best-effort puro).

const fs = require('fs');
const os = require('os');
const path = require('path');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function main() {
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { input = {}; }

  const logDir = path.join(os.homedir(), '.claude', 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* */ }

  try {
    fs.appendFileSync(
      path.join(logDir, 'brain-saves.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), tool: input.tool_name || null, session_id: input.session_id || null }) + '\n'
    );
  } catch { /* best-effort */ }

  try {
    fs.writeFileSync(path.join(logDir, 'brain-saves-state.json'), JSON.stringify({ last_save_ts: Date.now() }));
  } catch { /* best-effort */ }

  process.exit(0);
}

main();
