export const SERVER_INSTRUCTIONS = `Expert Brain — grafo de conhecimento pessoal latticework, rodando no Cloudflare D1 + Vectorize. Pertence a Eric Luciano (CEO da Expert Integrado, educador, empreendedor — trabalha nos domínios de gestão, vendas, educação, IA aplicada, liderança, produto e empreendedorismo).

Quando usar:
- O usuário discute conceitos, ideias, insights, decisões ou aprendizados anteriores.
- O usuário referencia algo que "já pensou sobre" ou pergunta "o que temos sobre X".
- O usuário pede pra editar, refinar ou remover uma nota salva.
- O usuário quer um panorama do vault ("quantas notas", "quais meus top domínios").

Fluxo recomendado:
1. Antes de responder perguntas temáticas, chame \`recall\` com uma query curta. Leia TODOS os domínios retornados; o match valioso frequentemente vem do domínio inesperado.
2. Antes de chamar \`save_note\`, chame \`recall\` primeiro pra varrer analogias cross-domain.
3. Atomize: uma nota = um conceito. Se o título contém "and/e/e também", divida em chamadas separadas.
4. Cada edge precisa de um \`why\` substantivo explicando o MECANISMO compartilhado (mín 20 chars). Whys vagos são rejeitados.
5. Prefira \`same_mechanism_as\` sobre \`analogous_to\` quando conseguir justificar o mecanismo subjacente.
6. \`kind\` é OBRIGATÓRIO no save_note — escolha entre os 7 valores canônicos (concept | decision | insight | fact | pattern | principle | question).
7. Para editar uma nota, chame \`update_note\` com o id e só os campos que mudam. Para remover, chame \`delete_note\` com \`confirm: true\` — pergunte ao USUÁRIO antes.
8. \`stats\` dá um panorama do vault; use quando o usuário perguntar sobre composição ou crescimento.
9. Tasks (kind='task') têm fluxo próprio: \`save_task\` cria, \`list_tasks_due_today\` lista o que vence/venceu (só tasks com prazo), \`list_tasks\` lista TODAS as tasks (inclui sem prazo; filtra por status/tag — use pra ver tudo e pra checar se a task já existe ANTES de criar/dedupe), \`update_task\` edita (patch parcial) e \`complete_task\` conclui (com outcome opcional). \`update_note\` NÃO edita task — use \`update_task\`.

Domínios canônicos do vault (TRAVA, não é sugestão):
management | sales | marketing | education | ai-applied | leadership | product | operations | personal-development | entrepreneurship | music | cognitive-science

\`save_note\` e \`update_note\` rejeitam domínios fora dessa lista. Se a nota não cabe perfeitamente em nenhum dos 12, escolha o mais próximo — o canon é a unidade de recall cross-domain. A mensagem de erro sugere o canônico mais próximo, então re-tentar é barato.

Escape hatch: se o usuário GENUINAMENTE abriu uma área nova (ex: mudou de mercado, começou a estudar biotech), passe \`allow_new_domain: true\` no save_note/update_note daquela chamada. Não abuse — o canon existe pra evitar a proliferação que aconteceu em 12/05/2026 (46 domínios espalhados em 378 notas, limpeza manual em 27 notas).`;
