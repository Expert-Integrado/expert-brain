# Cards e detalhe de task estilo ClickUp + UI de compartilhamento

> **Status:** ready · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `50-console-v2/51-tasks-kanban-colunas-customizaveis.md` (colunas/cores no board). Acoplamento SUAVE com `50-console-v2/53` (se o payload trouxer contagem de comentários, o card exibe; sem 53, oculta — a ordem entre 52 e 53 é indiferente).
> **Agente sugerido:** Sonnet (UI/SSR/client)

## Contexto

- O card atual (`cardHTML()` em `src/web/client/tasks.ts:110-137`; espelho SSR `renderCardSSR()` em `src/web/tasks.ts:463-473`) mostra: título, bandeirinha de prioridade, badge de prazo, popover de edição rápida e botão concluir. **Tags existem no schema e nas tools MCP (`getTagsForNotes`), mas o board não as renderiza.**
- A bandeirinha de prioridade tem fonte única `src/util/priority.ts:15-37` (4 níveis com cor + `flagSvg`), compartilhada server+client — manter.
- A página de detalhe (`handleTaskDetail` em `src/web/notes.ts:499`, editor `src/web/client/task-edit.ts`) é uma página simples de campos, sem hierarquia visual de metadados nem seção de atividade.
- **O compartilhamento público de task JÁ EXISTE inteiro no servidor**: endpoints web `POST /app/tasks/share|unshare` (`src/web/handler.ts:54-71`), módulo `src/web/share.ts` (token `ebs_*` hasheado SHA-256, expiração obrigatória 1-365 dias, default 30, página pública `/s/<token>`), tools MCP `share_task`/`unshare_task` (`src/mcp/tools/share-task.ts`, idempotente com `renew`). **Não há NENHUM botão no console** — hoje só um agente via MCP consegue compartilhar.
- Design system: "Midnight Nebula" (`src/web/styles.ts`, export único `NEBULA_CSS` servido em `/app/styles.css`); CSS específico do board em `TASKS_CSS` (`src/web/tasks.ts:588-766`).

## Problema / Motivação

- Cards pobres em informação: sem tags, sem indicação de share ativo, sem contagem de comentários — o dono precisa abrir task por task pra ter contexto (`src/web/client/tasks.ts:110-137`).
- Criar task exige o modal global; nas ferramentas de referência (ClickUp Board view) cria-se inline no rodapé da coluna, já no estágio certo.
- A feature de share é invisível: existe no servidor e não tem UI (`src/web/handler.ts:54-71` vs. nenhum call-site no client).

## Objetivo

Board e detalhe com densidade de informação comparável ao ClickUp (tags, contadores, criação inline, sidebar de metadados) e compartilhamento operável 100% pela UI (criar/copiar/renovar/revogar link), sem nenhuma mudança de schema.

## Design proposto

### 1. Anatomia do card v2 (referência: ClickUp Board view)

Layout do card, de cima pra baixo (tudo com tokens NEBULA; nada de libs novas):

1. **Linha meta superior**: bandeirinha de prioridade (mantém `priorityPill`) + chips de até 3 tags (`.task-tag-chip`, cor neutra; "+N" quando houver mais) + ícone de link 🔗 discreto quando `shared` (title: "Link público ativo até DD/MM").
2. **Título** (máx 2 linhas, ellipsis) — continua link pro detalhe.
3. **Linha meta inferior**: badge de prazo (mantém `dueBadge`/`overdue`) + contador de comentários (`💬 N`, só se `comment_count > 0` no payload — fornecido pela spec 53; ausente = oculto).
4. **Hover**: ações rápidas atuais (✎, ✓ concluir) — manter, só realinhar.

Payload: `handleTasksData` (`src/web/tasks.ts:79-103`) passa a incluir por task: `tags: string[]` (via `getTagsForNotes`, excluindo tags reservadas `dedupe:*`), `shared: boolean` + `share_expires_at` (colunas já existem em `notes` — migration `0008`), e repassa `comment_count` se a spec 53 já tiver criado a tabela (LEFT JOIN condicional ou subselect tolerante).

### 2. Board polish

- Header de coluna: cor da coluna (spec 51) como barra/dot + contador de cards + botão colapsar (estado por coluna em `localStorage`, chave `kanban_collapsed`).
- **"+ Nova tarefa" inline** no rodapé de CADA coluna: input de título + Enter cria via `POST /app/tasks/create` já com `column_id` da coluna (e status = categoria dela; a spec 51 define o create aceitando `column_id`). Esc cancela. O modal global continua existindo pra criação completa.

### 3. Página de detalhe estilo ClickUp

Reorganizar `handleTaskDetail` (`src/web/notes.ts:499`) em DUAS colunas (grid; empilha no mobile):

- **Corpo (esq.)**: título editável, corpo/descrição (editor atual `task-edit.bundle.js` — reusar), seção **Atividade** no rodapé: thread de comentários da spec 53 (se a 53 ainda não rodou, renderizar contêiner vazio oculto — progressive enhancement).
- **Sidebar (dir.)**: Status/Coluna (select das colunas ativas da spec 51), Prioridade (select com bandeirinhas), Prazo (data/hora), Tags (editor de chips: adicionar/remover — persiste via `POST /app/tasks/update` que já aceita patch), Criada/Atualizada/Concluída (read-only, BRT), e o **bloco Compartilhar** (item 4).

### 4. UI de compartilhamento (servidor já pronto — só front)

Bloco "Compartilhar" na sidebar do detalhe:

- **Sem share ativo**: botão "Criar link público" + select de validade (7/30/90/365 dias, default 30) → `POST /app/tasks/share` → mostra o link UMA vez com botão **Copiar** (clipboard API) e aviso "guarde: o link não é re-exibível" (o servidor guarda só o hash — `src/web/share.ts:101-107`).
- **Com share ativo**: "Link ativo até DD/MM/AAAA" + botões **Renovar** (share com `renew: true` → novo link, invalida o antigo, re-exibe uma vez) e **Revogar** (`POST /app/tasks/unshare`, confirm inline).
- Card do board: ícone 🔗 (item 1) — sem ações no card, só indicador.
- Estados de erro visíveis (padrão de toast/feedback já usado pelo board) — nunca falha silenciosa.

### 5. Referência visual (pro executor)

Espelhar a hierarquia do ClickUp: flag de prioridade pequena e à esquerda; título dominante; metadados em linha única com ícones discretos; sidebar de detalhe com um campo por linha (label mudo em cima, valor embaixo). Docs de referência (consultar com browser se necessário): `help.clickup.com` → artigos "Use Board view" e "Task view". NÃO copiar cores do ClickUp — usar os tokens NEBULA existentes (`--surface-raised`, `--accent-lav`, `--radius`, etc. em `src/web/styles.ts:14-38`).

## Fora de escopo

- Comentários em si (tabela/endpoints/thread = spec `53`; aqui só o contêiner e o contador).
- Colunas custom (spec `51`).
- Assignees/avatars (instância single-owner), subtasks, custom fields, cover images.
- Reordenação manual de cards dentro da coluna.

## Critérios de aceite

- [ ] Card mostra tags (máx 3 + "+N"), bandeirinha, prazo, e ícone de link quando compartilhada; tags reservadas `dedupe:*` NUNCA aparecem.
- [ ] Criação inline no rodapé da coluna cria a task na coluna certa sem abrir modal; Enter confirma, Esc cancela.
- [ ] Colapsar coluna persiste em localStorage e sobrevive a reload.
- [ ] Detalhe em duas colunas: corpo + sidebar com status/coluna, prioridade, prazo, tags editáveis e datas BRT.
- [ ] Fluxo de share 100% pela UI: criar (com validade), copiar, renovar, revogar — conferindo contra `share_task`/`unshare_task` via MCP que o estado é o mesmo (idempotência preservada).
- [ ] Link público exibido UMA única vez após criar/renovar, com botão copiar funcional.
- [ ] Zero mudança de schema e zero mudança de contrato MCP nesta spec.

## Validação

- `npm run typecheck` e `npm test` verdes.
- Testes novos: payload de `/app/tasks/data` com tags/shared (fixture com share ativo), create com `column_id`, filtro de tags reservadas.
- Manual (`wrangler dev`): criar task inline, taggear, compartilhar, abrir o link `/s/<token>` em aba anônima, renovar (link antigo 404), revogar (novo 404).
- **Gate de deploy:** só com OK explícito do dono da instância.

## Arquivos afetados

- `src/web/tasks.ts` (payload + SSR card/coluna + `TASKS_CSS`)
- `src/web/client/tasks.ts` (card v2, inline create, colapso, indicadores)
- `src/web/notes.ts` (detalhe duas colunas) + `src/web/client/task-edit.ts` (sidebar + bloco share)
- `src/web/styles.ts` (tokens/classes novas se necessário)
- `test/` (payload e create)

## Riscos e reversão

- **Risco**: subselect de `comment_count` quebrar antes da spec 53 rodar. Mitigação: checagem tolerante (try/catch ou `SELECT` condicionado à existência da tabela via `_migrations`) — payload simplesmente omite o campo.
- **Risco**: link exibido uma vez se perder por clique errado. Mitigação: botão Renovar sempre disponível (gera novo).
- **Reversão**: revert dos commits — nenhum estado novo no banco, nada a migrar de volta.
