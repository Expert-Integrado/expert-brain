# Contato com URL própria: página completa da pessoa com cartela, ações e vínculos de 1º e 2º nível

> **Status:** done · **Prioridade:** P1 · **Esforço:** L · **Repo:** ambos (`expert-brain` + `expert-contacts`)
> **Depende de:** `50-console-v2/55` (cartela/canais) · `50-console-v2/57` (timeline embutida na página) · `10-backend/21` (similar_edges pré-computadas — dependência SUAVE: sem ela, a página degrada pra só conexões explícitas)
> **Agente sugerido:** Sonnet (UI/SSR/client; o endpoint neighbors é SQL puro)

## Contexto

- Hoje um contato NÃO tem URL própria: o detalhe é `GET /app/entity?vault=contacts&id=<id>` (query param) servido pelo worker de contatos (`src/web/detail.ts:29-51`) e consumido pelo console do Brain via proxy (`expert-brain/src/web/contacts-data.ts:52-55`, `handleContactsEntity`) — o resultado abre num PAINEL lateral do grafo, não numa página. Tasks e notas JÁ têm URL própria (`/app/tasks/:id`, `/app/notes/:id`).
- Shape do detalhe (`fetchEntity`, `expert-contacts/src/vaults/contacts.ts:449-537`): `{fields[], connections[{id,otherId,otherLabel,rel,why}], events[] (só 10), img, editable}` — conexões só de 1º nível, sem similares.
- Conexões explícitas: tabela `connections` (a_id/b_id/type/strength/why≥20 — `expert-contacts/src/db/migrate.ts:102-111`). Similaridade semântica: HOJE read-path caro e pulado no modo `all=1` (`src/web/similarity.ts:18-66`, `contacts.ts:413-432`); a spec `10-backend/21` cria a tabela pré-computada `similar_edges` no contacts (mesmo padrão da migration 0005 do Brain).
- Rotas Bearer read-only pro proxy do Brain: allowlist em `expert-contacts/src/web/handler.ts:94-101` (`/app/graph/data|meta`, `/app/entity`).
- No Brain, o grafo de notas tem o padrão de vizinhança/expansão a reusar visualmente (painel de nó + edges com why); e `GET /app/contacts` já existe como página do grafo de contatos.

## Problema / Motivação

- Contato não é "linkável": o dono não consegue salvar/compartilhar internamente uma URL da pessoa, nem abrir direto do histórico do navegador — toda navegação começa do grafo (`detail.ts:29-36`).
- O painel lateral não comporta a cartela completa (spec 55), timeline (spec 57) e rede de vínculos — falta uma PÁGINA.
- Os vínculos semânticos (quem é parecido com quem) existem no vetor mas não aparecem em lugar nenhum do detalhe; e o 2º nível (rede do contato: quem ele alcança via quem) não existe nem como consulta.

## Design proposto

### 1. Endpoint de vizinhança no contacts: `GET /app/entity/neighbors?id=<id>`

Novo handler no worker de contatos (SQL puro, ZERO Vectorize em runtime):

- **1º nível**: conexões explícitas (`connections WHERE a_id=? OR b_id=?`, com `rel`, `why`, `strength`) + similares (`similar_edges WHERE from_id=?` — tabela da spec `10-backend/21`, com `score`), resolvendo `name`/`kind` dos vizinhos num único `IN (...)`.
- **2º nível**: pros ids do 1º nível (cap 25), mesma consulta em lote, excluindo o ego e o 1º nível; cada item carrega `via_id`/`via_label` (por qual contato de 1º nível ele chega). Cap total: 60 nós de 2º nível, ordenados por `strength`/`score` desc.
- Se a tabela `similar_edges` não existir ainda (spec 21 não executada), retornar só explícitas com `"similar_available": false` — a página mostra a seção com aviso "similaridade pendente de pré-computo".
- Resposta: `{ ego: {id,label,kind}, level1: [{id,label,kind,edge:'explicit'|'similar',rel?,why?,strength?,score?}], level2: [{id,label,kind,via_id,via_label,edge,...}], similar_available }`.
- Adicionar `/app/entity/neighbors` à allowlist Bearer read-only (`handler.ts:94-101`) E ao roteamento com sessão.

### 2. Proxy no Brain

`expert-brain/src/web/contacts-data.ts`: novo `handleContactsNeighbors` reusando `proxyToContacts(req, env, '/app/entity/neighbors')` + rota `GET /app/contacts/entity/neighbors` em `expert-brain/src/web/handler.ts` (sessão do Brain, mesmo padrão dos handlers vizinhos das linhas 44-55).

### 3. Página própria no console do Brain: `GET /app/contacts/:id`

- Rota nova no `expert-brain/src/web/handler.ts` (padrão de `/app/tasks/:id`); módulo novo `src/web/contact-page.ts` (SSR shell NEBULA) + bundle novo `contact-page` em `scripts/build-bundles.ts` (client hidrata via fetch dos 3 dados: entity, neighbors, events).
- Estrutura da página:
  1. **Header**: avatar (proxy `/app/contacts/media/<hash>` já existente), nome, chip de tipo (paleta de tipos de contato já shipada), categoria, última interação.
  2. **Cartela** (spec 55): canais com href (wa.me, mailto, instagram, linkedin, CRM) + campos (cargo, empresa clicável se for entidade conectada, aniversário).
  3. **Ações**: "Abrir no grafo" → `/app/contacts?focus=<id>` (o proxy repassa `focus` — `contacts-data.ts:25-27` só força `all=1` quando NÃO há focus/q), "Editar" (form da spec 55/36).
  4. **Timeline** (spec 57): eventos paginados + registrar interação.
  5. **Vínculos — 1º nível**: cards agrupados (Explícitos: rel + why visível, padrão Latticework; Similares: score em %) — cada card navega pra `/app/contacts/<otherId>`.
  6. **Rede — 2º nível**: lista compacta agrupada por `via_label` ("via Fulana: X, Y, Z"), cada item clicável.
- O painel do grafo de contatos ganha o link "Abrir contato completo" → `/app/contacts/<id>` (hoje esse slot aponta pra rota de nota, inexistente pra contato).

### 4. URL própria também no console standalone do contacts

No worker de contatos, aceitar `GET /app/entity/<id>` (path param) além do query param — resolve pro mesmo `handleEntityDetail` (`src/web/detail.ts`), permitindo link direto também pra quem usa o console standalone. (A página completa nova vive no Brain; o standalone mantém o detalhe atual, só ganha a rota bonita.)

## Fora de escopo

- Grafo em miniatura DENTRO da página (usar o link "Abrir no grafo").
- Compartilhamento PÚBLICO de contato (dados pessoais de terceiros — decisão deliberada de NÃO ter `/s/` pra contatos).
- 3º nível ou travessia arbitrária (cap fixo).
- Edição de conexões pela página (criar/editar edge continua no grafo/MCP).
- Privacidade (entidade privada fora do proxy, filtro no `/app/entity/neighbors`) — spec `50-console-v2/61`, que gateia os endpoints criados aqui.

## Critérios de aceite

- [x] `/app/contacts/<id>` abre a página completa com sessão do Brain; id inexistente → 404 amigável.
- [x] Cartela mostra os canais da spec 55 com hrefs corretos; avatar carrega via proxy same-origin.
- [x] Vínculos 1º nível: explícitas com `why` visível; similares com score — com `similar_edges` populada (spec 21). Sem a tabela: seção explícita normal + aviso de similaridade pendente (nada quebra).
- [x] 2º nível agrupado por "via", caps respeitados (≤25 sementes, ≤60 resultados), sem duplicar quem já é 1º nível.
- [x] Navegação contato→contato pelos cards funciona (URL muda, histórico do navegador funciona) — via `<a href>` real (navegação nativa do browser).
- [x] "Abrir no grafo" foca o nó certo no grafo de contatos — deep-link `?focus=<id>` lido pelo client (graph.ts) e aplicado depois do settle da simulação.
- [x] Endpoint neighbors responde pro Bearer read-only E pra sessão; caminhos fora da allowlist seguem 401 (não afrouxar a allowlist).
- [x] Zero query Vectorize em qualquer request desta página (só D1) — verificável nos testes por spy/contagem (VECTORIZE ausente do harness; teste dedicado prova que a resposta não lança).

**Nota de execução (07/2026):** "Editar" (form da spec 55/36) citado no design §3.3 NÃO foi implementado nesta spec — o Brain ainda não tem proxy de escrita `entity/update` nem UI de edição de campos de contato (spec 30-features/36 fase 3 segue `in-progress`); não é critério de aceite desta spec e fica pra quando a 36 fechar. `wrangler dev` manual (grafo → painel → página → vínculos → outra página) não foi executado nesta rodada — cobertura via testes automatizados (contacts: 227 testes; brain: 530 testes) no lugar do passo manual da seção Validação.

## Validação

- Brain: `npm run typecheck` + `npm test`; Contacts: `npx tsc --noEmit` + `npm test` — tudo verde.
- Testes novos: neighbors (fixture com explícitas+similares, caps, dedupe ego/nível1, `similar_available=false` sem tabela), rota path no contacts, proxy do Brain (auth), 404 da página.
- Manual (`wrangler dev` nos dois): navegar grafo → painel → página → vínculos → outra página; conferir focus no grafo.
- **Gate de deploy:** os DOIS workers só com OK explícito do dono da instância.

## Arquivos afetados

- expert-contacts: `src/web/handler.ts` (rota path + allowlist), `src/web/detail.ts` (aceitar path param), handler novo de neighbors (arquivo novo `src/web/neighbors.ts`), `test/`
- expert-brain: `src/web/handler.ts` (rotas `/app/contacts/:id` e proxy neighbors), `src/web/contact-page.ts` (novo), `src/web/client/contact-page.ts` (novo), `scripts/build-bundles.ts` (entry novo), `src/web/contacts-data.ts` (handleContactsNeighbors), `src/web/graph.ts` (link do painel), `test/`

## Riscos e reversão

- **Risco**: consulta de 2º nível pesada em hubs (contato com 200 conexões). Mitigação: caps no SQL (LIMIT por etapa) + 1 única roundtrip por nível (IN em lote).
- **Risco**: rota `/app/contacts/:id` colidir com a página do grafo `/app/contacts`. Mitigação: match exato primeiro (grafo), depois `:id` com validação de formato de id; teste de roteamento cobre os dois.
- **Reversão**: revert dos commits nos dois repos — nenhum estado novo no banco (endpoint é read-only).
