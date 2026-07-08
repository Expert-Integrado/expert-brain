# Onda 1 — Pesquisa de referências + opções de identidade visual

> **Status:** ready · **Prioridade:** P0 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `60-ux-reforma/61-onda0-infra-auditoria-baseline.md`

## Contexto

O dono da instância decidiu (decisão registrada em `60-ux-reforma/60-visao-geral.md`, seção "Decisões já tomadas") que a identidade visual do console deve ser repensada via pesquisa, não improvisada: capturas do ClickUp real dele (ferramenta que ele usa no dia a dia, referência de densidade e hierarquia) + pesquisa web de outras ferramentas (Linear, Todoist, Notion, Trello e afins), culminando em 2-3 protótipos de direção que ele escolhe antes de qualquer implementação definitiva de cor/tipografia.

Hoje a identidade visual do console é "Midnight Nebula": paleta escura roxo/lavanda definida em `NEBULA_CSS` (`src/web/styles.ts:12-34`), fonte de display Poppins + corpo Manrope (`src/web/styles.ts:1-8` documenta a troca — substituiu Fraunces em 01/05/2026). Essa identidade não muda nesta onda; esta onda só produz as OPÇÕES e o comparador. A aplicação da direção escolhida acontece na Onda 6 (`67-onda6-identidade-a11y.md`).

## Problema / Motivação

- Sem pesquisa de referência estruturada, a reforma corre o risco de "achismo de identidade" — trocar cor sem critério de legibilidade, hierarquia ou personalidade, repetindo o problema que gerou o pedido original.
- O ClickUp real do dono contém dados de clientes (nomes, valores, cartões com informação de negócio) — capturas dele NÃO PODEM ir para o repo público `expert-brain`. Não existe hoje nenhuma convenção no repo pra separar "pesquisa com dado sensível" de "protótipo com dado fictício commitável" — esta onda estabelece essa fronteira fisicamente (pasta local vs. pasta do repo).
- Não existe hoje uma pasta `prototypes/` nem um contrato de custom properties CSS que garanta que as 3 direções propostas sejam intercambiáveis sem reescrever markup — sem esse contrato, a escolha do dono na Onda 1 obrigaria retrabalho na Onda 6.

## Objetivo

O dono abre um comparador HTML local com 3 direções de identidade lado a lado (mesmo markup, tokens diferentes) e escolhe uma delas — ou pede um mix — registrando a decisão nesta spec antes da Onda 6 aplicar a direção escolhida no console real.

## Design proposto

### 1. Pesquisa do ClickUp real (fora do repo)

- Usar o navegador já logado do dono (sessão existente, sem novo login) pra capturar: board view (Kanban), card aberto, task detail completo, home/inbox dele, list view.
- Observar e anotar (não é sobre "copiar", é sobre entender o mecanismo): densidade de informação por card, hierarquia visual (o que salta primeiro aos olhos: título? prazo? prioridade?), paleta de cores de status/prioridade, microinterações (hover, transições, feedback de ação).
- **Onde fica:** pasta local fora do repo (`C:/tmp/` ou a pasta de Workspace do dono — NUNCA dentro de `C:/repos/expert-brain/`), com um arquivo `.md` de observações por tela. Este arquivo de observações NÃO é commitado; ele serve só de insumo pra escrever os 3 `tokens.css` da seção 3.
- **Regra dura:** nenhuma captura de tela do ClickUp real, nem trecho de texto extraído dela, entra em qualquer commit deste repo. Se o agente que executar esta onda precisar citar algo do ClickUp real nos protótipos, deve GENERALIZAR o padrão observado (ex. "cards com badge de prioridade colorido no canto superior esquerdo") em vez de reproduzir dado real.

### 2. Pesquisa web (pode ser paralelizada em sub-agentes)

Padrões a levantar, com foco em screenshots/descrições PÚBLICAS (material de marketing das próprias ferramentas, não capturas de conta logada de terceiros):

- Padrões de kanban: ClickUp, Linear, Trello — como cada um resolve card, coluna, drag affordance.
- Task detail: layout de sidebar de metadados vs. corpo principal.
- Home/dashboard: o que aparece "acima da dobra" em produtos de produtividade.
- Seletores de visibilidade/compartilhamento: como Notion, Linear e afins comunicam "privado vs. compartilhado" sem ambiguidade — é diretamente relevante pro problema de linguagem do diagnóstico item 3 (`60-visao-geral.md`).
- Dark themes de qualidade: contraste, uso de cor de destaque, como evitar o "roxo genérico de IA".

### 3. Protótipos de identidade (`prototypes/identity/`, novo — 100% público, dados fictícios)

- `prototypes/identity/shared/base.css`: espelho simplificado da futura biblioteca de componentes (a que a Onda 3 vai construir de verdade em `COMPONENTS_CSS`) — só o suficiente pra renderizar os 2 markups de exemplo abaixo.
- `prototypes/identity/shared/home.html` e `prototypes/identity/shared/board.html`: markup copiado da estrutura SSR real (`src/web/home.ts` e `src/web/tasks.ts`), com dados 100% fictícios (nomes de task/nota inventados, sem qualquer relação com dado real do dono ou de clientes).
- **3 direções**, cada uma um arquivo `tokens.css` isolado:
  - **A — "Midnight Nebula evoluída":** mantém a identidade escura atual, mas corrige os tokens pra contraste AA (nenhum texto abaixo de 4.5:1).
  - **B — "Grafite denso"**, estilo Linear: paleta mais neutra, menos saturada, densidade de informação maior.
  - **C — "Claro-default"**, estilo ClickUp: prova o mecanismo `[data-theme="light"]` funcionando de verdade (não é só "inverter cor de fundo" — testa se a arquitetura de tokens semânticos aguenta).
- **Regra de ouro (contrato):** os 3 `tokens.css` declaram EXATAMENTE o mesmo conjunto de custom properties (`--bg`, `--text`, `--surface-0..3`, `--accent`, `--danger`, etc.) que a Onda 2 vai formalizar em `TOKENS_CSS`. Isso garante que trocar de direção seja só trocar QUAL `tokens.css` é servido, sem tocar `base.css` nem os markups.
- `prototypes/identity/index.html`: comparador com 3 `<iframe>` lado a lado, um por direção, carregando o mesmo `board.html`/`home.html` com o `tokens.css` correspondente.
- README dentro de `prototypes/identity/` com os critérios de avaliação: legibilidade (tabela de contraste WCAG por par texto/fundo), hierarquia ("ache a task mais urgente em 3 segundos" — critério de teste informal), personalidade (foge do "roxo genérico de app de IA"?), densidade, viabilidade de tema claro (a direção C funciona ou expõe limitação da arquitetura de tokens?), fadiga visual em uso prolongado.

### 4. Gate — decisão do dono

O dono abre `prototypes/identity/index.html` localmente (ex. `python -m http.server` na pasta, ou file://) e escolhe: uma das 3 direções, tal como está, OU um mix explícito (ex. "paleta da B com densidade da A"). A decisão é registrada como atualização nesta spec (seção "Critérios de aceite" abaixo) antes de prosseguir pra Onda 2 em diante — embora, como a Onda 2 é neutra de identidade, ela pode COMEÇAR em paralelo com a espera dessa decisão; só a Onda 6 fica de fato bloqueada sem ela.

## Fora de escopo

- Aplicar qualquer direção de identidade no console real (`src/web/styles.ts`) — isso é só a Onda 6, depois da decisão do dono.
- Levar qualquer captura ou dado do ClickUp real do dono para dentro do repo, mesmo generalizado em imagem (só texto de observação genérica, fora do repo).
- Pesquisar ou prototipar identidade além de cor/tipografia/densidade (ex. não é objetivo desta onda desenhar um novo sistema de ícones do zero).

## Critérios de aceite

- [ ] Observações do ClickUp real capturadas em pasta LOCAL fora do repo, com nota explícita de "não commitar"
- [ ] Pesquisa web das 5 categorias de padrão documentada (pode ser um arquivo de notas dentro de `prototypes/identity/README.md`, sem dado sensível)
- [ ] `prototypes/identity/shared/base.css`, `home.html`, `board.html` criados com dados 100% fictícios
- [ ] 3 arquivos `tokens.css` (direções A, B, C) criados, todos declarando o MESMO conjunto de custom properties
- [ ] `prototypes/identity/index.html` (comparador com 3 iframes) funcional localmente
- [ ] Tabela de contraste WCAG calculada para os tokens de texto de cada direção, incluída no README do protótipo
- [ ] **Decisão do dono registrada nesta spec:** qual direção (A, B, C ou mix) foi escolhida — preencher aqui antes de a Onda 6 rodar: `[A PREENCHER PELO DONO]`
- [ ] Varredura de PII: nenhum arquivo em `prototypes/identity/` contém nome de cliente, dado do ClickUp real ou qualquer identificador pessoal

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck
npm test
```

(Esta onda não adiciona lógica de aplicação em produção — os protótipos são HTML/CSS estático, sem teste automatizado próprio necessário. A validação real é visual/humana via o comparador.)

Teste manual: o dono abre `prototypes/identity/index.html`, compara as 3 direções e responde objetivamente aos critérios do README (legibilidade, hierarquia, personalidade, densidade, tema claro, fadiga).

**Gate de deploy:** não se aplica — protótipos nunca são deployados, existem só como referência local/repo pra orientar a Onda 6.

## Arquivos afetados

- `prototypes/identity/shared/base.css`, `home.html`, `board.html` (novos)
- `prototypes/identity/tokens-a.css`, `tokens-b.css`, `tokens-c.css` (novos)
- `prototypes/identity/index.html` (novo)
- `prototypes/identity/README.md` (novo — critérios de avaliação + tabela de contraste + registro da decisão do dono)

## Riscos e reversão

- **Risco:** vazamento acidental de dado do ClickUp real pro repo público, mesmo que generalizado demais e ainda reconhecível. Mitigação: varredura de PII (critério de aceite acima) ANTES de qualquer commit desta onda, seguindo a regra anti-vazamento da spec-zero (`specs/README.md` seção 4).
- **Risco:** as 3 direções não convergirem no mesmo contrato de custom properties, obrigando retrabalho na Onda 6. Mitigação: "regra de ouro" declarada explicitamente no design proposto — checar os 3 `tokens.css` lado a lado antes de considerar a onda concluída.
- **Reversão:** `git rm -r prototypes/identity/` remove toda a onda sem efeito em código de produção — nada aqui é importado por `src/`.
