#!/usr/bin/env node
// Expert Brain — Stop hook (camada CLIENTE, generica): varredura de silencio.
//
// O buraco que este hook fecha: a maioria das sessoes NUNCA compacta, entao os
// hooks de Pre/PostCompact nunca disparam — e o conhecimento que nasce no
// TRABALHO do agente (conclusoes, diagnosticos, decisoes tomadas em conjunto)
// nao passa pelo regex do capture-nudge (que so ve o prompt do usuario).
//
// Mecanismo: a cada fim de turno conta os turnos da sessao. Se a sessao ja tem
// >= MIN_TURNS e NADA foi salvo ha SAVE_STALE_MS (via state do expert-brain-audit),
// injeta UMA linha lembrando de avaliar se ha material duravel. No maximo 1 nudge
// a cada NUDGE_COOLDOWN_MS. Silencio total fora disso. Nunca salva sozinho.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN_TURNS = 10;
const SAVE_STALE_MS = 45 * 60 * 1000;
const NUDGE_COOLDOWN_MS = 30 * 60 * 1000;

const LOG_DIR = path.join(os.homedir(), '.claude', 'logs');
const STATE_PATH = path.join(LOG_DIR, 'capture-sweep-state.json');
const SAVES_STATE_PATH = path.join(LOG_DIR, 'brain-saves-state.json');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function main() {
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { input = {}; }
  const sid = String(input.session_id || 'unknown');
  const now = Date.now();

  const state = loadJson(STATE_PATH, {});
  if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};
  state.sessions[sid] = (state.sessions[sid] || 0) + 1;

  // poda: mantem so as 50 sessoes mais recentes no state (mapa nao cresce infinito)
  const keys = Object.keys(state.sessions);
  if (keys.length > 50) {
    for (const k of keys.slice(0, keys.length - 50)) delete state.sessions[k];
  }

  const turns = state.sessions[sid];
  const lastSave = loadJson(SAVES_STATE_PATH, {}).last_save_ts || 0;
  const lastNudge = state.last_nudge_ts || 0;

  const quiet = now - lastSave > SAVE_STALE_MS;
  const cooled = now - lastNudge > NUDGE_COOLDOWN_MS;

  if (turns < MIN_TURNS || !quiet || !cooled) {
    try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(state)); } catch { /* */ }
    process.exit(0);
  }

  state.last_nudge_ts = now;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(state)); } catch { /* */ }

  const reminder = `Varredura de captura: esta sessão já tem ${turns}+ turnos e nada foi salvo no Brain há um bom tempo. Avalie AGORA se surgiu material durável (decisão com motivação, insight, métrica com data, regra/feedback, pessoa nova) — se sim, salve atômico via mcp__expert-brain__save_note / save_task (ou save_person no expert-contacts). Se não houver nada durável, siga normalmente — não salve por salvar.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reminder },
  }));
  process.exit(0);
}

main();
