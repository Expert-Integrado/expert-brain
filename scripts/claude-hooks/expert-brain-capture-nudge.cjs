#!/usr/bin/env node
// Expert Brain — UserPromptSubmit hook (camada CLIENTE, generica): capture-nudge.
//
// Sucessor do task-nudge: alem de linguagem de PRAZO (-> save_task), detecta
// familias de sinal de CONHECIMENTO DURAVEL (-> save_note) e de CONTATO
// (-> save_person/log_event, so se o MCP expert-contacts estiver configurado).
// Motivo: a maioria das sessoes nunca compacta — sem nudge por sinal, o
// conhecimento de sessao curta evapora.
//
// Anti-spam: familia de prazo dispara sempre (acionavel e urgente); familias de
// nota/contato tem cooldown (10 min) via state file local. Soft enforcement:
// NUNCA salva sozinho. Zero credencial, zero rede. .cjs puro (blinda ESM).
//
// Personalizacao opcional: o instalador pode embutir palavras/temas do usuario
// (pergunta do setup) em USER_KEYWORDS — viram uma familia extra com cooldown.

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- familias de sinal -----------------------------------------------------
// FORTES: linguagem inequivoca de pendencia — disparam sempre, sem cooldown.
// `ate` exige contexto de data ("ate dia 10", "ate 10/07", "ate sexta") pra nao
// casar com "ate 3 opcoes".
const TASK_STRONG = [
  { k: 'prazo-data', re: /\bat[eé]\s+((o\s+)?dia\s+\d{1,2}|\d{1,2}[\/.\-]\d{1,2}|(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo))\b/i },
  { k: 'amanha', re: /\bamanh[aã]\b/i },
  { k: 'semana-que-vem', re: /\b(semana que vem|pr[oó]xima semana)\b/i },
  { k: 'prazo-palavra', re: /\b(prazo|deadline)\b/i },
  { k: 'lembra', re: /\b(me lembra|lembra de|n[aã]o (me )?esque[cç])/i },
  { k: 'agendar', re: /\b(agendar|marcar (uma )?(reuni[aã]o|call|conversa)|cobrar|follow.?up)\b/i },
];
// FRACOS: "preciso/tenho que" aparece em conversa normal o tempo todo — entra em
// cooldown (mesma janela das notas) pra nao virar spam.
const TASK_WEAK = [
  { k: 'preciso', re: /\b(preciso|tenho que|tenho de)\b/i },
];

const NOTA_PATTERNS = [
  { k: 'decisao', re: /\b(decidi(mos)?|aprovad[oa]|aprovamos|fechamos (com|que)|bateu o martelo|escolh(i|emos)|vamos fechar com)\b/i },
  { k: 'insight', re: /\b(descobri(mos)?|percebi|aprendi|entendi (que|o)|a causa (raiz|real)|o problema era|sacada)\b/i },
  { k: 'metrica', re: /\b(r\$ ?[\d.,]+|[\d.,]+ ?%|\bmrr\b|faturamento|\bchurn\b|\bcac\b|\bltv\b)\b/i },
  { k: 'regra', re: /\b(sempre (fa[çc]a|use|prefira)|nunca (mais )?(fa[çc]a|use)|prefiro que|a partir de agora|regra nova)\b/i },
];

const CONTATO_PATTERNS = [
  { k: 'contato', re: /\b(falei com|conversei com|conheci (o |a )?[A-ZÀ-Ú]|reuni[aã]o com|call com|me apresentou|novo contato)\b/ },
  { k: 'telefone', re: /\b55\d{10,11}\b/ },
];

// Preenchido pelo instalador (pergunta opcional do setup). Se o placeholder nao
// foi substituido, o JSON.parse falha e a lista fica vazia — sem erro.
let USER_KEYWORDS = [];
try { USER_KEYWORDS = JSON.parse('{{USER_KEYWORDS_JSON}}'); } catch { USER_KEYWORDS = []; }
if (!Array.isArray(USER_KEYWORDS)) USER_KEYWORDS = [];

const NOTA_COOLDOWN_MS = 10 * 60 * 1000;
const STATE_PATH = path.join(os.homedir(), '.claude', 'logs', 'capture-nudge-state.json');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  } catch { /* best-effort */ }
}

function hasExpertContacts() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8');
    return raw.includes('"expert-contacts"');
  } catch { return false; }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Fronteira unicode-aware: \b falha com acentos ("IA" casaria com "dIA", "famílIA").
function keywordRe(kw) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(String(kw))}([^\\p{L}\\p{N}]|$)`, 'iu');
}

function main() {
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { input = {}; }
  const prompt = String(input.prompt || input.user_prompt || '');
  if (!prompt.trim()) { process.exit(0); }

  const now = Date.now();
  const state = loadState();

  let task = TASK_STRONG.filter((p) => p.re.test(prompt)).map((p) => p.k);
  const taskWeak = TASK_WEAK.filter((p) => p.re.test(prompt)).map((p) => p.k);
  let nota = NOTA_PATTERNS.filter((p) => p.re.test(prompt)).map((p) => p.k);
  for (const kw of USER_KEYWORDS) {
    if (kw && String(kw).length >= 3 && keywordRe(kw).test(prompt)) nota.push(`tema:${kw}`);
  }
  let contato = hasExpertContacts()
    ? CONTATO_PATTERNS.filter((p) => p.re.test(prompt)).map((p) => p.k)
    : [];

  // cooldown: sinais fracos/frequentes so cutucam de novo apos a janela
  if (!task.length && taskWeak.length && !(state.task_weak_ts && now - state.task_weak_ts < NOTA_COOLDOWN_MS)) {
    task = taskWeak;
    state.task_weak_ts = now;
  }
  if (nota.length && state.nota_ts && now - state.nota_ts < NOTA_COOLDOWN_MS) nota = [];
  if (contato.length && state.contato_ts && now - state.contato_ts < NOTA_COOLDOWN_MS) contato = [];

  if (!task.length && !nota.length && !contato.length) { process.exit(0); } // silencio

  if (nota.length) state.nota_ts = now;
  if (contato.length) state.contato_ts = now;
  saveState(state);

  // log de medicao (falso-negativo = match aqui sem save_* correspondente)
  try {
    const logDir = path.join(os.homedir(), '.claude', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'capture-nudge.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), session_id: input.session_id || null, task, nota, contato, snippet: prompt.slice(0, 240) }) + '\n'
    );
  } catch { /* best-effort */ }

  const parts = [];
  if (task.length) {
    parts.push(`ação/pendência com prazo (${task.join(', ')}) → considere mcp__expert-brain__save_task OU, se deriva de trabalho que JÁ TEM card no board, subtarefa desse card via update_subtask — derivado nunca vira card novo (rode list_tasks ANTES pra não duplicar; to-do do dia = due hoje)`);
  }
  if (nota.length) {
    parts.push(`conhecimento durável (${nota.join(', ')}) → considere mcp__expert-brain__save_note (atômica, kind correto: decision/insight/fact/principle) — não espere a compactação`);
  }
  if (contato.length) {
    parts.push(`pessoa/empresa (${contato.join(', ')}) → considere save_person/save_company/log_event no expert-contacts`);
  }

  const nudge = 'Captura: ' + parts.join('; ') + '. Se não for material durável, siga — não salve por salvar.';

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: nudge },
  }));
  process.exit(0);
}

main();
