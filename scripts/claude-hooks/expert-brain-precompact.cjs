#!/usr/bin/env node
// Expert Brain — PreCompact hook (camada CLIENTE, generica).
// Dispara com o contexto INTEIRO ainda carregado: ultima chance de salvar
// conhecimento atomico no Brain antes da compactacao comprimir a sessao.
// .cjs puro (CommonJS) — funciona mesmo em pasta "type":"module".

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
      `${new Date().toISOString()} PreCompact session=${(data.session_id || '').slice(0, 8)}\n`
    );
  } catch (_) {}

  const reminder = `Compactação iminente — contexto ainda inteiro. ÚLTIMA chance de extrair conhecimento atômico antes de comprimir.

AÇÃO: percorra mentalmente esta sessão e identifique até 5 itens de valor durável que se perderiam pós-compactação:
- Decisões com motivação (alternativas consideradas + por que essa ganhou)
- Insights cross-domain (algo aprendido aqui que ilumina outra área)
- Padrões recorrentes (algo que apareceu hoje e provavelmente vai reaparecer)
- Métricas com data e fonte
- Feedback do usuário (correções, preferências validadas)

Pra cada item: mcp__expert-brain__save_note (atômico, com domain canônico) + mcp__expert-brain__link pra notas existentes relacionadas (justificativa POR QUE conectam — Latticework).

Se nada se qualifica, ignore — não invente conteúdo só por causa do hook.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreCompact', additionalContext: reminder },
    })
  );
  process.exit(0);
});
