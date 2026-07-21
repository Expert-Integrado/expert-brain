#!/usr/bin/env node
// Expert Brain — SessionStart hook (camada CLIENTE, generica).
// Injeta o lembrete de comportamento proativo do Brain no inicio de cada sessao.
// Instalado por scripts/install-claude-hooks.mjs; {{WORKER_URL}} e substituido
// pela URL real do Worker no momento da instalacao.
//
// .cjs puro (CommonJS) de proposito: funciona mesmo que a pasta tenha
// package.json "type":"module". Sem rede, sem credencial — so escreve um log local.
//
// AVISO DE TASKS COM RATE-LIMIT: o bloco "Antes de comecarmos" (list_tasks_due_today)
// so aparece 1x por PERIODO do dia (manha <12h, tarde 12-16h, noite 17h+, no fuso
// LOCAL da maquina) e NUNCA em retomada de sessao (source=resume). Sem isso, abrir
// varias sessoes no mesmo dia cobrava task o tempo todo. Estado em
// ~/.claude/state/expert-brain-task-reminder.json. Qualquer falha = fail-open (avisa).

const fs = require('fs');
const path = require('path');
const os = require('os');

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let data = {};
  try { data = input ? JSON.parse(input) : {}; } catch (_) {}
  try {
    const logDir = path.join(os.homedir(), '.claude', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'brain-hooks.log'),
      `${new Date().toISOString()} SessionStart session=${(data.session_id || '').slice(0, 8)} source=${data.source || ''} cwd=${data.cwd || ''}\n`
    );
  } catch (_) {}

  // Rate-limit do aviso de tasks: no maximo 1x por periodo do dia e nunca em retomada
  // de sessao. Periodo/data no fuso LOCAL da maquina (serve pra qualquer usuario).
  // Estado em ~/.claude/state/expert-brain-task-reminder.json. fail-open: erro = avisa.
  let avisarTasks = false;
  try {
    const source = data.source || 'startup';
    if (source !== 'resume') {
      const d = new Date();
      const hour = d.getHours();
      const periodo = hour < 12 ? 'manha' : hour < 17 ? 'tarde' : 'noite';
      const dateLocal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const chave = dateLocal + '|' + periodo;
      const stateDir = path.join(os.homedir(), '.claude', 'state');
      const stateFile = path.join(stateDir, 'expert-brain-task-reminder.json');
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')).bucketKey; } catch (_) {}
      if (prev !== chave) {
        avisarTasks = true;
        try {
          if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
          fs.writeFileSync(stateFile, JSON.stringify({ bucketKey: chave, ts: new Date().toISOString() }));
        } catch (_) { /* estado nao gravou: melhor avisar 2x que nunca */ }
      }
    }
  } catch (_) { avisarTasks = true; }

  const rotinaAbertura = avisarTasks
    ? `Rotina de início de sessão — o aviso de tasks é a PRIMEIRA coisa da PRIMEIRA resposta:
- Rodar mcp__expert-brain__list_tasks_due_today e ABRIR a resposta com "Antes de começarmos:" + as tasks que vencem hoje ou estão atrasadas (1 linha por task). SÓ DEPOIS responder o que o usuário pediu. Nunca responder primeiro e listar as tasks depois. Se não houver nenhuma, dizer numa linha que está zerado.
- Este aviso tem rate-limit: aparece no máximo 1x por período do dia (manhã/tarde/noite) e nunca em retomada de sessão. Não relistar tasks pendentes no meio da sessão sem o usuário pedir.`
    : `Abertura SILENCIOSA (rate-limit do aviso de tasks): o aviso de tasks já foi dado neste período do dia, ou esta é uma RETOMADA de sessão. NÃO rodar list_tasks_due_today na abertura nem listar pendências — responder direto o que o usuário pedir. Consulta de tasks só se ele pedir.`;

  const reminder = `Expert Brain ativo ({{WORKER_URL}}). Tools: mcp__expert-brain__{recall, save_note, update_note, get_note, expand, link, delete_note, stats, reembed, list_tasks_due_today, save_task, complete_task}.

${rotinaAbertura}

Comportamento esperado nesta sessão:
- ANTES de perguntar contexto ao usuário, rodar mcp__expert-brain__recall
- Ao aprender algo novo (decisão, métrica, feedback, contexto relevante), rodar mcp__expert-brain__save_note — NA HORA, não espere a compactação (a maioria das sessões nunca compacta)
- Pedido do usuário entra no board ANTES de começar, na GRANULARIDADE certa: pedido pontual vira task (mcp__expert-brain__save_task, nasce em "A fazer"); derivado de trabalho que JÁ TEM card vira SUBTAREFA desse card (update_subtask), nunca card novo; software/iniciativa grande = PROJETO com 1 card por módulo, nunca 1 card por ideia. Na dúvida entre card e subtask = subtask (promover depois é 1 clique). Rode list_tasks ANTES pra não duplicar. Task NÃO é nota: task tem status/prazo, nota é conhecimento
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
