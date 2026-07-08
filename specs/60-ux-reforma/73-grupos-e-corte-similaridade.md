# Spec 73 — Grupos no grafo de contatos + corte de exibição de similaridade

- **Status:** implementado (aguardando deploy)
- **Repos:** expert-brain (grafo/painel) + expert-contacts (payload/vizinhos)
- **Origem:** feedback do dono — "fica criando muitos vínculos só por sobrenome" + "grupo teria que ser de outra cor, clicar no grupo e ver quem está dentro"

## Problema

1. **Ruído de similaridade:** o embedding de contato abre com o nome (`embeddingTextFor`), então sobrenome comum gera pares 0.5-0.65 sem relação real. Esses pares apareciam como vínculos semânticos no grafo e nos vizinhos.
2. **Grupos invisíveis:** o kind `group` já existia no canon do expert-contacts, mas não tinha cor própria no grafo, não tinha label PT e o painel não distinguia membros de outras conexões.
3. **Labels de relação em inglês** no painel do grafo (`member_of`, `friend`...).

## Solução

### Corte de exibição (expert-contacts)

- `SIMILARITY_DISPLAY_MIN = 0.65` em `src/web/similarity.ts` — **só no read path**:
  - `assemblePayload` (grafo): pula linha com `score < 0.65`.
  - `neighbors.ts` (1º e 2º nível): `AND score >= ?` no SQL.
- Write path intocado (`SIMILARITY_TOP_K=4`, `SIMILARITY_MIN_SCORE=0.5`): a tabela `similar_edges` segue completa — baixar o corte no futuro devolve as arestas **sem reembed/backfill**.

### Grupos (expert-brain + expert-contacts)

- Cor própria `#a855f7` (roxo) para kind `group`:
  - Brain: `CONTACT_KIND_COLORS` em `src/web/domain-colors.ts`.
  - Contacts: `KIND_COLORS`/`KIND_LABELS` em `src/vaults/contacts.ts` (a legenda itera `KIND_LABELS`, então o chip "Grupo" aparece e filtra por clique, mecanismo existente).
- Painel do grafo (`client/graph.ts`): nó `group` separa conexões `member_of` num bloco **"Membros (N)"** (cap 30) das demais; demais nós seguem no bloco "Conexões".
- Labels PT compartilhados: novo módulo folha `src/util/contact-labels.ts` (`CONTACT_TYPE_LABELS` com os 6 kinds + `CONTACT_REL_LABELS` com os 21 tipos de conexão espelhando `REL_OPTIONS_CONTACTS` do expert-contacts) — importado por `graph.ts` e `contact-page.ts` (precedente: `event-kind-labels.ts`).
- SSR do grafo de contatos (`src/web/graph.ts`): seção de similaridade agora visível ("Contatos parecidos"); slider de coloração e sugeridas continuam ocultos (sugeridas criam edges de NOTA — vault errado). Linha de status mostra "N semânticas" quando há arestas similares.

## Fora de escopo (próxima etapa)

Integração **opcional** com o WhatsApp Agent para importar/mapear grupos reais (espelho do padrão Google sync: engine no expert-contacts, estado em KV, painel em `/app/config`). Design em decisão com o dono.

## Verificação

- expert-contacts: 345 testes verdes (novos: corte no payload do grafo + corte nos vizinhos nível 1/2), typecheck ok.
- expert-brain: 810 server + 38 client verdes, typecheck ok.
- QA em browser (dev local, fixtures fictícias `seed-grp-*`): legenda com chip roxo "Grupo", painel do grupo com "Membros (3)", painel de pessoa com rels PT ("Membro de", "Amigo(a)"), knob "Contatos parecidos" visível com coloração/sugeridas ocultas.
