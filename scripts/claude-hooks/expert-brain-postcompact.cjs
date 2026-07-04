#!/usr/bin/env node
// Expert Brain — PostCompact hook (camada CLIENTE, generica).
// Logo apos a compactacao: lembra de salvar o que sobrou de aprendizado e de
// reancorar as tasks do dia. .cjs puro (CommonJS) — funciona em "type":"module".

const fs = require('fs');
const path = require('path');
const os = require('os');

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  try {
    const data = input ? JSON.parse(input) : {};
    const logDir = path.join(os.homedir(), '.claude', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'brain-hooks.log'),
      `${new Date().toISOString()} PostCompact session=${(data.session_id || '').slice(0, 8)}\n`
    );
  } catch (_) {}

  const reminder = `Sessão acabou de ser compactada. Duas coisas antes de prosseguir:

1. SALVAR: avalie se houve aprendizados/decisões/dados não triviais nesta sessão que ainda não foram salvos no Expert Brain. Se sim, rode mcp__expert-brain__save_note pra cada um (nota atômica) e mcp__expert-brain__link pra conectar com notas existentes relevantes. Se não houve nada relevante, ignore.

2. TASKS: rode mcp__expert-brain__list_tasks_due_today e relembre em bullets curtos as tasks que vencem hoje (ou atrasadas), pra reancorar a prioridade pós-compactação. Se estiver zerado, diga numa linha.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostCompact', additionalContext: reminder },
    })
  );
  process.exit(0);
});
