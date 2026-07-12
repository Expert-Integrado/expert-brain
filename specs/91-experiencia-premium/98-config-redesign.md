# Config redesign: de acordeão de 1.000 linhas pra abas com cards

> **Status:** draft · **Prioridade:** P1 · **Esforço:** L · **Repo:** expert-brain
> **Depende de:** `91-experiencia-premium/94` (erros inline — os forms daqui herdam o padrão) · suave: `80-frota-agentes/87` (config UX de credenciais)

## Contexto

`/app/config` é a tela mais densa e menos premium do console: `src/web/config.ts` tem
1.048 linhas gerando UMA página com ~10 seções empilhadas em
`<details class="disclosure-advanced conn-section">` — board (`config.ts:127`), board
compartilhado (`:251`), projetos (`:274`), tags (`:332`), taxonomia (`:387`), instruções
do dono (`:427`), chaves revogadas (`:699`) — mais usuários (`src/web/users.ts`),
chaves de API (`src/web/api-keys.ts`), integração Google e push. O comportamento de
"seção aberta" depende de query param (`?saved=...`) e âncora.

É também a tela que o dono mais visita (chaves, agentes, taxonomia) e a primeira parada
do onboarding (spec `92` aponta pra cá no passo "conecte seu primeiro agente").

## Problema / Motivação

- Uma página só com ~10 `<details>` = scroll infinito, zero hierarquia de frequência de
  uso; achar "criar chave" exige conhecer a página.
- Estados de integração (Google conectado? push ativo? backup rodando?) estão espalhados
  como texto dentro de seções, não como estado visível de relance.
- Os forms daqui são os principais clientes do problema da spec `94` (página 400 de
  texto puro).

## Objetivo

Config navegável por abas, onde qualquer tarefa administrativa comum (criar chave, criar
usuário, editar taxonomia, ver estado das integrações) se resolve em até 2 cliques a
partir de `/app/config`, sem scroll de descoberta.

## Design proposto

1. **4 abas** (roteadas por sub-path, com redirect das âncoras antigas):
   - **Agentes & Chaves** (`/app/config/agentes`) — default, é o coração do produto:
     usuários (perfis person/agent) + chaves de API. Cada AGENTE vira um card (avatar,
     nome, chave vinculada, último uso via `api_keys.last_used_at`, botão de ações) — o
     padrão `<details>`-como-card já prototipado nas seções atuais evolui pra card real.
   - **Workspace** (`/app/config/workspace`) — board (colunas), projetos, tags, taxonomia.
   - **Integrações** (`/app/config/integracoes`) — Google, push/notificações, board
     compartilhado/link externo, backup: cada uma como CARD DE CONECTOR com estado
     visual (conectado/desconectado/erro), descrição de 1 linha e ação primária única.
   - **Instância** (`/app/config/instancia`) — instruções do dono (`config.ts:427`),
     preferências gerais, tema (toggle da spec `96`), chaves revogadas/auditoria.
2. **Preservar deep links**: `/app/config?saved=users#users` e âncoras existentes (há
   link em `src/web/notes.ts:1244`) redirecionam pra aba certa — inventariar TODOS os
   links internos pra `/app/config` durante a execução e mapear 1 a 1.
3. **Decompor `config.ts`**: um módulo por aba (`config/agentes.ts` etc.) com o
   `config.ts` atual virando roteador — nenhuma lógica de negócio muda nesta spec, é
   REORGANIZAÇÃO de superfície; os handlers POST continuam onde estão (só herdam o
   `formError` da spec `94`).
4. **Mobile**: abas viram segmented control rolável no topo; cards empilham 1 coluna.

## Fora de escopo

- Mudar regras de negócio de chaves/usuários/taxonomia (zero mudança de backend além de
  rota GET das abas).
- Painel operacional da frota (é o `80-frota-agentes/89` — o card de agente daqui LINKA
  pra lá quando existir).
- Novas integrações.

## Critérios de aceite

- [ ] `/app/config` abre a aba Agentes & Chaves com cards de agente (avatar, chave, último uso) e ação "Nova chave" visível sem scroll em 1366x768.
- [ ] As 4 abas carregam com URL própria; refresh mantém a aba; navegação registra histórico.
- [ ] Todos os links internos antigos pra `/app/config` (com `?saved=` ou âncora) caem na aba e seção corretas.
- [ ] Aba Integrações mostra estado real de relance: Google (conectado/não), push (ativo/não), backup (última execução), link externo do board (ativo/não).
- [ ] Nenhum fluxo POST regride: criar/editar/arquivar usuário, chave, coluna, projeto, tag, taxonomia e instruções do dono funcionam idênticos (suite atual verde).
- [ ] Mobile 390px: abas acessíveis e cards legíveis sem scroll horizontal.

## Validação

- Typecheck + vitest verdes (incluindo `config.test.ts` e `taxonomy-config.test.ts`
  existentes, adaptados às rotas novas).
- Teste manual das 4 abas + todos os deep links inventariados, desktop e mobile.
- Screenshot diff antes/depois (harness da onda 0) pra revisão do dono.
- Gate de deploy: OK explícito do dono.

## Arquivos afetados

- `src/web/config.ts` (vira roteador) + novos `src/web/config/agentes.ts`,
  `workspace.ts`, `integracoes.ts`, `instancia.ts`
- `src/web/config-script.ts`, `src/web/config-icons.ts` (divididos por aba)
- `src/web/users.ts`, `src/web/api-keys.ts` (render dos cards; handlers intactos)
- `src/web/render.ts` (nav), `src/web/styles.ts` (abas + cards de conector)
- Call sites de links pra `/app/config` (ex.: `src/web/notes.ts:1244`)

## Riscos e reversão

É a spec mais invasiva da série — mitigar fazendo a decomposição em commits por aba,
com a página antiga funcionando até a última aba migrar (feature flag simples por rota).
Reversão: o roteador volta a servir a página monolítica (mantê-la até o fim da migração).
