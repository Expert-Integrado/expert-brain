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

Rotina de início de sessão — o aviso de tasks é a PRIMEIRA coisa da PRIMEIRA resposta:
- Rodar mcp__expert-brain__list_tasks_due_today e ABRIR a resposta com "Antes de começarmos:" + as tasks que vencem hoje ou estão atrasadas (1 linha por task). SÓ DEPOIS responder o que o usuário pediu. Nunca responder primeiro e listar as tasks depois. Se não houver nenhuma, dizer numa linha que está zerado.
- Cobrança de task vencida acontece SÓ AQUI, na abertura. Não relistar tasks pendentes no meio da sessão sem o usuário pedir.

Comportamento esperado nesta sessão:
- ANTES de perguntar contexto ao usuário, rodar mcp__expert-brain__recall
- Ao aprender algo novo (decisão, métrica, feedback, contexto relevante), rodar mcp__expert-brain__save_note — NA HORA, não espere a compactação (a maioria das sessões nunca compacta)
- Tudo que o usuário pedir pra fazer vira task ANTES de começar (mcp__expert-brain__save_task, nasce em "A fazer") — é a trilha de auditoria do trabalho. Rode list_tasks ANTES pra não duplicar. Task NÃO é nota: task tem status/prazo, nota é conhecimento
- Ciclo de vida AUTOMÁTICO: quando VOCÊ começar a executar a task → mcp__expert-brain__update_task com status in_progress ("Em execução"); quando terminar → mcp__expert-brain__complete_task ("Concluído"). Não deixe task que você executou parada em "A fazer" — o board é o retrato do que está andando; to-do do dia = task com due hoje, concluída no dia
- Ao salvar nota nova que se relaciona com outra, rodar mcp__expert-brain__link com justificativa explícita (POR QUÊ se conectam) — Latticework
- Notas atômicas: 1 ideia por nota, não bloco gigante`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: reminder },
    })
  );
  process.exit(0);
});
