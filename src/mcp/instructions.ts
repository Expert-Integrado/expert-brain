// Lista das 22 tools registradas em `registerAllTools` (src/mcp/registry.ts).
// Mantida aqui só como referência textual pras instructions abaixo — não é
// importada em runtime pra evitar acoplamento com os registradores.
const TOOL_NAMES = [
  'save_note',
  'update_note',
  'delete_note',
  'restore_note',
  'recall',
  'expand',
  'get_note',
  'link',
  'stats',
  'reembed',
  'save_task',
  'list_tasks_due_today',
  'list_tasks',
  'complete_task',
  'update_task',
  'attach_media_to_note',
  'get_note_media',
  'delete_note_media',
  'list_contacts',
  'search_contacts',
  'get_contact',
  'get_contact_by_phone',
] as const;

/**
 * Monta o texto de instructions que o servidor MCP anuncia no handshake.
 *
 * `personalizationPrompt` vem da leitura crua do meta (`readPersonalizationPrompt`,
 * src/web/config.ts) — `null` quando a instância ainda não tem prompt salvo em
 * /app/config. Nesse caso o texto fica só com o fallback genérico ("dono da
 * instância"), sem injetar o DEFAULT_PREFS_BLOCK (ele tem placeholders tipo
 * "[seu nome]" que confundiriam o agente lendo isto no handshake).
 */
export function buildServerInstructions(personalizationPrompt: string | null): string {
  const trimmedPrompt = personalizationPrompt?.trim() ?? '';

  const header = `Expert Brain — grafo de conhecimento pessoal latticework, rodando no Cloudflare D1 + Vectorize. Este vault pertence ao dono da instância.`;

  const ownerBlock = trimmedPrompt
    ? `\n\nContexto do dono (definido em /app/config):\n${trimmedPrompt}`
    : '';

  return `${header}${ownerBlock}

Quando usar:
- O usuário discute conceitos, ideias, insights, decisões ou aprendizados anteriores.
- O usuário referencia algo que "já pensou sobre" ou pergunta "o que temos sobre X".
- O usuário pede pra editar, refinar ou remover uma nota salva.
- O usuário quer um panorama do vault ("quantas notas", "quais meus top domínios").

Fluxo recomendado:
1. Antes de responder perguntas temáticas, chame \`recall\` com uma query curta. Leia TODOS os domínios retornados; o match valioso frequentemente vem do domínio inesperado.
2. Antes de chamar \`save_note\`, chame \`recall\` primeiro pra varrer analogias cross-domain.
3. Atomize: uma nota = um conceito. Se o título contém "and/e/e também", divida em chamadas separadas.
4. Cada edge (criado via \`link\`) precisa de um \`why\` substantivo explicando o MECANISMO compartilhado (mín 20 chars). Whys vagos são rejeitados.
5. Prefira \`same_mechanism_as\` sobre \`analogous_to\` quando conseguir justificar o mecanismo subjacente.
6. \`kind\` é OBRIGATÓRIO no save_note — escolha entre os 7 valores canônicos (concept | decision | insight | fact | pattern | principle | question).
7. Para editar uma nota, chame \`update_note\` com o id e só os campos que mudam. Para remover, chame \`delete_note\` com \`confirm: true\` — pergunte ao USUÁRIO antes. \`delete_note\` é SOFT delete e reversível sem limite de tempo: \`restore_note\` com o id desfaz, trazendo a nota de volta pro recall/grafo/stats com os edges.
8. Depois de um \`recall\` que achou nota relevante, \`expand\` mostra os edges dela (descobre notas conectadas); \`get_note\` traz a nota completa por id quando já se sabe o id.
9. \`reembed\` re-gera o embedding de uma nota — usar depois de editar título/corpo de forma grande, quando o recall parecer desatualizado.
10. \`stats\` dá um panorama do vault; use quando o usuário perguntar sobre composição ou crescimento.
11. Tasks (kind='task') têm fluxo próprio: \`save_task\` cria, \`list_tasks_due_today\` lista o que vence/venceu (só tasks com prazo), \`list_tasks\` lista TODAS as tasks (inclui sem prazo; filtra por status/tag — use pra ver tudo e pra checar se a task já existe ANTES de criar/dedupe), \`update_task\` edita (patch parcial) e \`complete_task\` conclui (com outcome opcional). \`update_note\` NÃO edita task — use \`update_task\`.
12. Mídia: \`attach_media_to_note\` anexa arquivo (base64 ou URL) numa nota com dedup por SHA-256 no R2 e retorna URL assinada válida por ~1h; \`get_note_media\` lista a mídia de uma nota (URLs assinadas ~1h); \`delete_note_media\` remove um anexo.
13. Contatos (read-only): \`list_contacts\`, \`search_contacts\`, \`get_contact\` e \`get_contact_by_phone\` leem o vault de contatos — use quando a pergunta é sobre UMA pessoa/empresa específica (telefone, e-mail, cargo, relações). Use \`recall\` quando a pergunta é sobre ideias/conceitos, não sobre uma entidade. \`get_contact_by_phone\` é match exato de telefone; \`search_contacts\` é busca por nome/semântica.

Domínios canônicos do vault (TRAVA, não é sugestão):
management | sales | marketing | education | ai-applied | leadership | product | operations | personal-development | entrepreneurship | music | cognitive-science

\`save_note\` e \`update_note\` rejeitam domínios fora dessa lista. Se a nota não cabe perfeitamente em nenhum dos 12, escolha o mais próximo — o canon é a unidade de recall cross-domain. A mensagem de erro sugere o canônico mais próximo, então re-tentar é barato.

Escape hatch: se o usuário GENUINAMENTE abriu uma área nova (ex: mudou de mercado, começou a estudar biotech), passe \`allow_new_domain: true\` no save_note/update_note daquela chamada. Não abuse — o canon existe pra evitar a proliferação de domínios que quebra o recall cross-domain.`;
}

export { TOOL_NAMES };
