#!/usr/bin/env node
// Expert Brain — UserPromptSubmit hook (camada CLIENTE, generica): overdue-nudge.
//
// Sessao ABERTA HA MUITAS HORAS perde a ancora da abertura (que e onde a cobranca
// de task vencida acontece). Este hook e o unico lembrete de atraso DENTRO da
// sessao — e so dispara quando as duas condicoes valem:
//   1. a sessao esta aberta ha 5h+ (idade medida por session_id em state local);
//   2. faz 2h+ desde o ultimo lembrete desta sessao (cooldown anti-spam).
//
// O nudge instrui o agente a avisar APENAS task VENCIDA (overdue) — task que
// vence hoje mas ainda nao passou do horario NAO entra (cobranca "pro dia" e
// exclusiva da abertura da sessao). Zero credencial, zero rede: quem consulta o
// Brain e o agente via MCP. .cjs puro (blinda ESM).

const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_AGE_MS = 5 * 60 * 60 * 1000; // sessao "longa" = 5h+
const COOLDOWN_MS = 2 * 60 * 60 * 1000;    // no maximo 1 lembrete a cada 2h
const MAX_SESSIONS = 20;                    // prune do state (sessoes antigas saem)
const STATE_PATH = path.join(os.homedir(), '.claude', 'logs', 'overdue-nudge-state.json');

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return s && typeof s === 'object' && s.sessions ? s : { sessions: {} };
  } catch { return { sessions: {} }; }
}

function saveState(state) {
  try {
    // prune: mantem so as MAX_SESSIONS sessoes mais recentes (por first_seen)
    const ids = Object.keys(state.sessions);
    if (ids.length > MAX_SESSIONS) {
      ids.sort((a, b) => (state.sessions[b].first_seen || 0) - (state.sessions[a].first_seen || 0));
      for (const id of ids.slice(MAX_SESSIONS)) delete state.sessions[id];
    }
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch { /* best-effort */ }
}

function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { input = {}; }
  const sessionId = String(input.session_id || '');
  if (!sessionId) { process.exit(0); }

  const now = Date.now();
  const state = loadState();
  const s = state.sessions[sessionId] || (state.sessions[sessionId] = { first_seen: now });

  const age = now - (s.first_seen || now);
  const sinceNudge = now - (s.last_nudge || 0);
  if (age < SESSION_AGE_MS || sinceNudge < COOLDOWN_MS) {
    saveState(state); // registra first_seen da sessao nova / mantem prune em dia
    process.exit(0);
  }

  s.last_nudge = now;
  saveState(state);

  try {
    const logDir = path.join(os.homedir(), '.claude', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'brain-hooks.log'),
      `${new Date().toISOString()} OverdueNudge session=${sessionId.slice(0, 8)} ageH=${(age / 3600000).toFixed(1)}\n`
    );
  } catch { /* best-effort */ }

  const hours = Math.floor(age / 3600000);
  const nudge = `Sessão aberta há ${hours}h+. Rode mcp__expert-brain__list_tasks_due_today e avise o dono APENAS do que está VENCIDO (overdue: true) — 1 linha por task, no INÍCIO da resposta, antes de responder o pedido. Task que vence hoje mas ainda não passou do horário NÃO entra (isso é assunto da abertura da sessão). Se nada estiver vencido, não fale de tasks — siga direto com o pedido.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: nudge },
  }));
  process.exit(0);
}

main();
