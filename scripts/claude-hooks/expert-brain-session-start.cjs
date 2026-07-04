#!/usr/bin/env node
// Expert Brain — SessionStart hook (camada CLIENTE, generica).
// Injeta o lembrete de comportamento proativo do Brain no inicio de cada sessao.
// Instalado por scripts/install-claude-hooks.mjs; {{WORKER_URL}} e substituido
// pela URL real do Worker no momento da instalacao.
//
// .cjs puro (CommonJS) de proposito: funciona mesmo que a pasta tenha
// package.json "type":"module". Sem rede, sem credencial — so escreve um log local.

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
      `${new Date().toISOString()} SessionStart session=${(data.session_id || '').slice(0, 8)} cwd=${data.cwd || ''}\n`
    );
  } catch (_) {}

  const reminder = `Expert Brain ativo ({{WORKER_URL}}). Tools: mcp__expert-brain__{recall, save_note, update_note, get_note, expand, link, delete_note, stats, reembed, list_tasks_due_today, save_task, complete_task}.

Rotina de início de sessão:
- Rodar mcp__expert-brain__list_tasks_due_today e mostrar em bullets curtos as tasks que vencem hoje (ou atrasadas). Se não houver nenhuma, dizer numa linha que está zerado.

Comportamento esperado nesta sessão:
- ANTES de perguntar contexto ao usuário, rodar mcp__expert-brain__recall
- Ao aprender algo novo (decisão, métrica, feedback, contexto relevante), rodar mcp__expert-brain__save_note — NA HORA, não espere a compactação (a maioria das sessões nunca compacta)
- Ação acionável (tarefa, com ou sem prazo) → mcp__expert-brain__save_task; to-do do dia = task com due hoje, concluída no dia. Rode list_tasks ANTES pra não duplicar. Task NÃO é nota: task tem status/prazo, nota é conhecimento
- Ao salvar nota nova que se relaciona com outra, rodar mcp__expert-brain__link com justificativa explícita (POR QUÊ se conectam) — Latticework
- Notas atômicas: 1 ideia por nota, não bloco gigante`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reminder },
    })
  );
  process.exit(0);
});
