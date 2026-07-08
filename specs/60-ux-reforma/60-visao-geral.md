# Visão geral: Reforma UI/UX do Console

> **Status:** ready · **Prioridade:** P0 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

Pós-aula ao vivo, o dono da instância apontou bugs sérios de interface no console (`/app` do Worker `expert-brain`, repo `C:/repos/expert-brain`, PÚBLICO): o drag do Kanban "acende a tela inteira", o cartão de task não abre ao clicar, a UI de visibilidade induz erro de leitura (uma task marcada como "pública" parece exposta na internet quando na verdade só é visível às credenciais do próprio dono) e a home está quebrada. O pedido foi uma reforma completa de UI/UX, tratada como projeto de várias fases, com pesquisa profunda de referências antes de tocar em identidade visual.

Este documento é a spec-guarda-chuva do grupo `specs/60-ux-reforma/`: define as decisões já tomadas pelo dono, consolida o diagnóstico verificado no código e mapeia as 7 ondas que viram as demais specs deste grupo. Ele não implementa nada por si só — cada onda tem sua própria spec executável.

**Decisões já tomadas pelo dono da instância** (colhidas antes da criação destas specs):

1. **Referência visual:** capturas do ClickUp real dele (navegador logado) + pesquisa web de outras ferramentas de referência (kanban, task detail, dashboards).
2. **Deploy:** tudo junto no final — um pacote só, deploy único em produção ao final do programa, com OK explícito dele naquela sessão.
3. **Privacidade:** manter o comportamento e os defaults atuais (`private=0`, compartilhamento é opt-in) e redesenhar a UI como um seletor único de 3 níveis (Privado / Normal / Link público). Não inverter o default do flag `private`.
4. **Identidade visual:** repensar via pesquisa — propor 2-3 direções (paleta, tipografia, densidade, eventualmente tema claro) e ele escolhe antes de qualquer implementação de identidade.

## Problema / Motivação

Diagnóstico verificado diretamente no código-fonte do repo (paths e linhas conferidos nesta sessão de criação das specs; a numeração pode ter se deslocado poucas linhas caso o arquivo tenha sido editado entre a verificação e a execução — o agente que executar cada onda deve reconferir antes de editar):

1. **Drag do Kanban:** o highlight `.drag-over` é aplicado à `.task-col-body` INTEIRA — `zone.classList.add('drag-over')` em `src/web/client/tasks.ts:504`, dentro de `wireDropzones()` (`src/web/client/tasks.ts:497-522`); a regra CSS correspondente `.task-col-body.drag-over { background: ...; box-shadow: inset 0 0 0 2px var(--border-strong); }` vive em `src/web/tasks.ts:1226-1229` (dentro do bloco `TASKS_CSS`, não em `styles.ts` — o design system global e o CSS específico de tasks são arquivos diferentes). Colunas são largas (`grid-auto-columns: minmax(260px, 1fr)` em `src/web/tasks.ts:1194`; em mobile viram `grid-template-columns: 1fr` dentro do `@media (max-width: 760px)` em `src/web/tasks.ts:1407-1411`), então a coluna inteira "acende". Não há indicador de posição de drop. A implementação usa HTML5 Drag and Drop API (`dragstart`/`dragover`/`drop`, `DataTransfer`), que não funciona em touch.
2. **Clique no cartão:** só o `<a class="task-card-title">` (`src/web/tasks.ts:1017`) e o botão "abrir" (`src/web/tasks.ts:1021`) navegam pro detalhe. O `<div class="task-card">` inteiro tem `draggable="true"` (`src/web/tasks.ts:1015`) e recebe `cursor: grab` via CSS — parece clicável em qualquer ponto, mas não é. `mousedown`/drag competem com o clique.
3. **Seletor de visibilidade confuso:** existem hoje DUAS seções distintas na sidebar do detalhe de task, ambas renderizadas em `src/web/notes.ts:877-928` (apesar do nome do arquivo, essa função também monta o detalhe de task): "Compartilhamento público" (`src/web/notes.ts:890-913`, link `/s/<token>`, já opt-in — comportamento correto) e "Privacidade" (`src/web/notes.ts:917-928`, com o texto "Esta task é <strong>pública</strong>: qualquer credencial válida a vê" na linha 922 e o botão "Tornar privada"/`Tornar pública` na linha 926). O problema é de linguagem/IA da tela: "pública" nesse segundo bloco significa "visível às credenciais do próprio dono" (o oposto do flag `private=1`), NÃO "exposta na internet" — mas a palavra é a mesma usada no bloco de cima pro link público de verdade. Nota tem a mesma dualidade em `src/web/notes.ts:402-438` (compartilhamento) e `459-462` (toggle privada/pública).
4. **Home quebrada** (`src/web/home.ts`): o card de digest (`digestCardHtml`, atribuído em `src/web/home.ts:149` dentro do bloco try de `handleHomePage`, linhas 143-153) já é envolto num `<div class="home-card">` mas SEM a classe `.card` (só `renderDigestCard()` interno tem sua própria estrutura) — destoa visualmente dos outros cards que usam `<section class="card home-card">`. O grid `.home-grid` usa `grid-template-columns: repeat(auto-fit, minmax(300px, 1fr))` (`src/web/home.ts:27`), que transborda a viewport abaixo de ~336px. Cada card (Hoje, Inbox, digest, Últimas interações) é buscado em try/catch isolado (`src/web/home.ts:126-153`) e, na falha, o card inteiro some silenciosamente (string vazia) em vez de mostrar um estado de erro visível. O login manda pro grafo por padrão, não pra home (`src/web/login.ts:30,49,67` — três ocorrências do literal `/app/graph` como destino default).
5. **Sem ordenação manual intra-coluna:** a ordem dos cards vem só do servidor — `src/db/queries.ts:693-696`, a query `listActiveTasks` ordena por `(due_at IS NULL) ASC, due_at ASC, COALESCE(priority, 9) ASC, created_at ASC`. O drag hoje só decide "pra qual coluna a task vai", nunca a posição dentro dela; um placeholder de inserção seria enganoso e não deve ser construído nesta reforma.
6. **Design system fragmentado:** tokens de cor/raio/fonte vivem em `NEBULA_CSS` (`src/web/styles.ts:12-34`, bloco `:root { ... }`), SEM nenhum token de espaçamento (`--space-*`) ou de escala tipográfica (`--text-*`). Há um bug real de token inexistente: `color: var(--text-muted)` em `src/web/styles.ts:1653`, quando os tokens definidos são `--text-dim` e `--text-faint` (`styles.ts:19-20`) — `--text-muted` nunca foi declarado, cai pro valor herdado do browser. Existe CSS de sidebar mobile morto e contraditório: `src/web/styles.ts:1384` (`.sidebar { display: none; }`, dentro do `@media (max-width: 767px)` que começa em `styles.ts:1380`) versus um SEGUNDO bloco `.sidebar { width: 64px; padding: 20px 6px; ... }` em `src/web/styles.ts:1849-1875`, dentro de OUTRO `@media (max-width: 767px)` que começa em `styles.ts:1843` — os dois blocos têm o MESMO seletor de breakpoint mas prescrevem comportamentos opostos pra `.sidebar` (esconder vs. colapsar pra 64px), e o navegador aplica o que vier depois em ordem de cascata. Breakpoints divergem entre arquivos: 767px (`styles.ts`), 760px (`src/web/tasks.ts:1407`, board), 640px (`src/web/notes.ts:1289`, detalhe de nota/task). `src/web/share.ts` inlina o `NEBULA_CSS` inteiro 3 vezes via template string (`share.ts:230`, `share.ts:340`, `share.ts:350` concatena `SHARE_CSS`, `share.ts:557` concatena mais `NOTE_SHARE_CSS`) em vez de servir o CSS externo cacheável que o resto do app usa.
7. **Testes:** a suíte de servidor está saudável (centenas de testes, ex. `test/web/polish.test.ts:28` que asserta `expect(body).toBe(NEBULA_CSS)` contra o endpoint público de CSS). A camada de client (drag-and-drop, clique, paleta de comando) tem ZERO testes — não existe `vitest.client.config.ts` nem pasta `e2e/` no repo hoje.

## Objetivo

O dono da instância aprova, via contact sheet comparando baseline (antes) e final (depois) das ~16 telas em 2 viewports, que: (a) os 3 bugs de interação da aula (drag, clique, seletor de visibilidade) estão corrigidos e testados; (b) o design system está consolidado em tokens/componentes reutilizáveis, sem os defeitos listados no diagnóstico; (c) uma das direções de identidade visual pesquisadas foi escolhida por ele e aplicada em toda a superfície pública e logada do console; e autoriza explicitamente o deploy único de produção.

## Design proposto

### As 7 ondas (cada uma é sua própria spec neste grupo)

| # | Spec | O que entrega | Gate |
|---|---|---|---|
| 0 | `61-onda0-infra-auditoria-baseline.md` | Harness de screenshots, baseline ANTES de qualquer mudança, contatos locais, seed determinístico, infra de teste client + e2e, script `verify-wave.mjs` | nenhum (pré-requisito técnico) |
| 1 | `62-onda1-pesquisa-referencias-identidade.md` | Pesquisa ClickUp real (fora do repo) + pesquisa web + 3 protótipos de identidade em `prototypes/identity/` | **decisão do dono**: qual direção de identidade seguir |
| 2 | `63-onda2-tokens-retematizaveis.md` | `styles.ts` reestruturado em camadas de tokens re-tematizáveis, fix do bug `--text-muted` | nenhum |
| 3 | `64-onda3-biblioteca-componentes.md` | Biblioteca de componentes (`.card`, `.btn`, `.chip`, `.empty-state`, `.modal`, etc.) | nenhum |
| 4 | `65-onda4-interacoes-dnd-clique-visibilidade.md` | Os 3 bugs da aula: DnD por Pointer Events, cartão inteiro clicável, seletor de visibilidade unificado | nenhum |
| 5 | `66-onda5-fix-list-por-tela.md` | Lista de fixes tela a tela (home, board, shell, graph, notes/task detail, share) aplicando tokens e componentes | nenhum |
| 6 | `67-onda6-identidade-a11y.md` | Aplicação da identidade escolhida na Onda 1 + gate de contraste AA + responsivo/a11y transversal | nenhum |
| 7 | `68-onda7-verificacao-deploy.md` | Verificação final, checklist manual, validação do dono, deploy único | **OK explícito do dono** pra deploy de produção |

Ordem de execução: estritamente sequencial (0 → 1 → 2 → 3 → 4 → 5 → 6 → 7) — cada onda depende da anterior pelas razões declaradas no frontmatter de cada spec. A Onda 1 tem um gate de decisão do dono no meio do programa (não é opcional, bloqueia a Onda 2 em diante quanto à identidade final, embora a fundação de tokens da Onda 2 seja neutra de identidade e possa avançar em paralelo com a espera da decisão).

### Restrições invioláveis (valem para TODAS as ondas)

- Repo é PÚBLICO: zero PII em código, fixture, protótipo ou commit. Capturas do ClickUp real do dono NUNCA são commitadas (ficam em pasta local fora do repo).
- ZERO migration de banco nesta reforma inteira. O MCP (endpoints, payloads, tools `mark_private`/`share_task`/etc.) fica intocado — esta reforma é só a camada `src/web/`.
- CSP mantida (sem scripts inline novos, sem lib de terceiros nos bundles do console).
- Sem framework CSS nem lib de drag-and-drop externa — CSS puro + Pointer Events vanilla.
- Toda mudança que altera uma string asserida em teste é corrigida NO MESMO commit da mudança intencional. Lista mapeada (não exaustiva, cada onda deve buscar antes de commitar): `src/web/login.test.ts`, `test/tasks-detail-sidebar.test.ts`, `test/web/polish.test.ts`, `test/web/home.test.ts`, `test/web/inbox-web.test.ts`, `test/web/task-projects-web.test.ts`, `test/web/tasks-board-tags-share.test.ts`, `test/web/taxonomy-web.test.ts`, `test/web/notes-digest-card.test.ts`.
- Deploy de produção só na Onda 7, só com OK explícito do dono da instância, dado naquela sessão (gate de deploy da spec-zero, `specs/README.md` seção 1).

## Fora de escopo

- Implementação de código de qualquer onda — cada uma tem sua própria spec com "Design proposto" detalhado.
- Mudança de schema, migration nova, ou qualquer alteração no protocolo/contratos do MCP.
- Escolher a direção de identidade por conta própria — isso é decisão do dono na Onda 1.
- Reordenação manual de cards dentro de uma coluna (diagnóstico item 5) — fica registrada como limitação conhecida, não como bug a corrigir nesta reforma.

## Critérios de aceite

- [ ] As 4 decisões do dono (referência visual, deploy único, privacidade mantida com UI unificada, identidade a escolher) estão documentadas nesta spec tal como foram tomadas, sem reinterpretação
- [ ] O diagnóstico de 7 pontos está presente com evidência arquivo:linha e cada referência foi conferida contra o estado real do repo no momento da criação desta spec
- [ ] As 9 specs do grupo `60-ux-reforma/` existem e formam uma cadeia de dependências coerente (frontmatter `Depende de` de cada uma aponta pra anterior correta)
- [ ] O índice em `specs/README.md` (seção 7) lista as 9 specs deste grupo
- [ ] `specs/90-roadmap.md` tem uma seção descrevendo a ordem 60→61→...→68 com os 3 gates (decisão de identidade, escolha aplicada, OK de deploy)
- [ ] Nenhum nome próprio de pessoa real, telefone, e-mail pessoal, token ou ID de chat/deal aparece em nenhuma das 9 specs

## Validação

Este documento e as demais specs do grupo são só Markdown — não há código a rodar aqui. Sanidade ao commitar (nenhuma spec nova deve quebrar o repo):

```bash
cd C:/repos/expert-brain
npm run typecheck
npm test
```

Teste manual: um agente que leia SÓ esta spec deve conseguir listar as 7 ondas, as 4 decisões do dono e as 3 restrições mais importantes (zero migration, deploy só na Onda 7, repo público exige zero PII).

**Gate de deploy:** não se aplica a este documento (nenhum código de runtime). O gate de deploy real do programa inteiro vive na spec `68-onda7-verificacao-deploy.md`.

## Arquivos afetados

- `specs/60-ux-reforma/60-visao-geral.md` (novo, este arquivo)
- `specs/60-ux-reforma/61-onda0-infra-auditoria-baseline.md` até `68-onda7-verificacao-deploy.md` (novos, referenciados aqui)
- `specs/README.md` (índice, seção 7 — adiciona as 9 linhas do grupo)
- `specs/90-roadmap.md` (nova seção "Fase UX-Reforma")

## Riscos e reversão

- **Risco:** o programa ser interrompido no meio (ex. após a Onda 3) deixando o console num estado híbrido (tokens novos, telas antigas). Mitigação: cada onda é aditiva e não quebra o que já funciona — `NEBULA_CSS` continua exportado durante todo o programa (Onda 2), então mesmo parando no meio o app continua funcional.
- **Risco:** a decisão de identidade do dono (Onda 1) demorar e travar a agenda. Mitigação: as Ondas 2-5 são neutras de identidade (preparam a fundação e corrigem os bugs funcionais) e podem avançar sem a decisão; só a Onda 6 depende dela de fato.
- **Reversão:** `git rm -r specs/60-ux-reforma/` remove só a documentação; nenhuma onda chega a tocar código de produção antes de ter sua própria spec aprovada e executada. Reversão de código já implementado é tratada na seção "Riscos e reversão" de cada spec de onda individualmente.
