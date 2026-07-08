# Convenções da árvore specs/ e protocolo de execução por agente

> **Status:** draft · **Prioridade:** P0 · **Esforço:** S · **Repo:** ops
> **Depende de:** nenhuma

## Contexto

O repositório `expert-brain` é open-source e compartilhado publicamente (usado por alunos e pela comunidade). O desenvolvimento passa a ser **spec-driven**: cada mudança relevante nasce como uma spec em `specs/`, escrita de forma que **um agente de IA consiga executá-la sem nenhum contexto externo** (sem acesso a conversas anteriores, memória do dono ou outros repositórios além dos citados).

Estado atual do repo relevante pra este documento:

- `package.json` define os comandos canônicos de validação: `npm run typecheck` (roda `tsc --noEmit` na raiz e em `src/web/client/tsconfig.json`) e `npm test` (roda `vitest run` + `vitest run --config vitest.auth.config.ts`).
- Código-fonte em `src/` (`src/index.ts`, `src/mcp/`, `src/db/`, `src/web/`, `src/vector/`, `src/auth/`), testes em `test/`, migrações em `scripts/`/D1.
- Documentação de arquitetura em `docs/ARCHITECTURE.md`; processo de release em `RELEASING.md`.
- Algumas specs desta árvore referenciam um segundo repositório, `expert-contacts` (mesmo padrão Cloudflare Workers + D1), que vive em caminho próprio fora deste repo.

Este arquivo (`specs/README.md`) é a spec-zero: define o formato, os status e o protocolo que TODAS as demais specs da árvore seguem.

## Problema / Motivação

- Sem um protocolo escrito, cada agente executa specs de um jeito: uns leem só a spec, outros implementam sem rodar os testes (`package.json:18-21` define `test` e `typecheck`, mas nada obriga o uso), e não existe rastreio de qual spec está em andamento ou concluída.
- O repo é público. Sem uma regra anti-vazamento explícita, uma spec redigida a partir de contexto operacional privado pode carregar telefone, nome de cliente, token ou ID de chat pra dentro do histórico Git — e histórico Git público é irreversível na prática.
- Specs que tocam dois repositórios (`expert-brain` e `expert-contacts`) precisam declarar SEM ambiguidade onde o código é alterado, senão o agente edita o repo errado.

## Objetivo

Qualquer agente de IA, recebendo apenas o caminho de uma spec desta árvore, consegue executá-la fim a fim (implementar, validar, atualizar status, commitar) seguindo exclusivamente este documento — e nenhuma spec commitada contém dado pessoal.

## Design proposto

### 1. Protocolo de execução (ordem obrigatória)

Ao executar uma spec, o agente segue esta sequência, sem pular etapas:

1. **Ler a spec inteira** antes de tocar em qualquer arquivo.
2. **Atualizar o status** da spec para `in-progress` (editar a linha de frontmatter) — primeiro commit ou parte do commit inicial.
3. **Ler TODOS os arquivos citados em "Arquivos afetados"** (e os vizinhos necessários pra entender o contexto). Nunca implementar contra um arquivo não lido.
4. **Implementar** seguindo o "Design proposto" da spec. Migrations de banco são SEMPRE aditivas — nunca `DROP`, nunca `ALTER` destrutivo, nunca reescrever dados existentes sem backup declarado na spec.
5. **Validar cada critério de aceite**, um a um, marcando os checkboxes na spec.
6. **Rodar typecheck + testes do repo alvo** (comandos na seção Validação abaixo). Falhou = não está pronto.
7. **Commit pequeno** referenciando o path da spec na mensagem (ex.: `feat: X (specs/10-backend/12-nome.md)`). Uma spec pode gerar vários commits pequenos; todos referenciam o path.
8. **Atualizar o status** para `done` (ou `blocked`, com o motivo anotado na própria spec) no commit final.

**Gate de deploy (regra dura):** deploy de produção (`npm run deploy` / `wrangler deploy`), `git push` para o remoto de produção e release npm acontecem **SOMENTE com OK explícito do dono da instância**, dado naquela sessão. Implementar e commitar localmente é livre; publicar não é.

**Ordem de execução:** qual spec pegar a seguir é definido pela sequência de fases e gates de `specs/90-roadmap.md`, NÃO pela coluna `Prioridade` do índice (seção 7) nem pela ordem numérica dos arquivos. Prioridade expressa severidade/importância; o roadmap expressa a sequência real de execução (dependências entre specs, gates de validação entre fases).

### 2. Status possíveis (frontmatter de cada spec)

Toda spec tem a linha `> **Status:** {status}` no topo. Valores válidos:

| Status | Significado |
|---|---|
| `draft` | Escrita, ainda não revisada/aprovada pra execução |
| `ready` | Aprovada — qualquer agente pode pegar e executar |
| `in-progress` | Um agente está executando (atualizar AO COMEÇAR) |
| `done` | Critérios de aceite todos verificados (atualizar AO TERMINAR) |
| `blocked` | Travada — anotar o motivo e a dependência na própria spec |

O agente é responsável por atualizar o status ao começar (`in-progress`) e ao terminar (`done`/`blocked`). Spec `draft` não deve ser executada sem virar `ready`.

### 3. Template de spec

Toda spec nova segue este esqueleto (mesmo formato deste arquivo):

```markdown
# {Título}

> **Status:** draft · **Prioridade:** {P0|P1|P2} · **Esforço:** {S|M|L} · **Repo:** {expert-brain|expert-contacts|ops}
> **Depende de:** {paths de outras specs, ou "nenhuma"}

## Contexto
(o que existe hoje, com caminhos de arquivo reais)

## Problema / Motivação
(evidência concreta, com referência arquivo:linha)

## Objetivo
(uma frase mensurável)

## Design proposto
(passos técnicos concretos; schema/SQL quando houver; migrations sempre aditivas)

## Fora de escopo
(o que NÃO fazer nesta spec)

## Critérios de aceite
- [ ] (verificáveis um a um)

## Validação
(testes exigidos: typecheck, vitest, teste manual; gate de deploy)

## Arquivos afetados
(lista de paths)

## Riscos e reversão
(rollback concreto)
```

Seções obrigatórias que nenhuma spec pode omitir: **Contexto**, **Problema** (com evidência arquivo:linha), **Design proposto**, **Fora de escopo**, **Arquivos afetados**, **Critérios de aceite**, **Testes exigidos** (dentro de Validação), **Dependências** (frontmatter) e **Gate de deploy** (dentro de Validação).

### 4. Regra anti-vazamento (repo público)

O `expert-brain` é open-source e usado por alunos. **Nenhuma spec pode conter:**

- Número de telefone, e-mail pessoal ou nome de cliente/lead/pessoa real
- Token, API key, secret, PAT ou credencial de qualquer tipo
- ID de chat, ID de deal/CRM, URL de instância privada ou qualquer identificador que aponte pra dados de uma pessoa
- Conteúdo de notas/mensagens reais do vault de alguém

Referir-se sempre a **"o dono da instância"** (nunca a um nome próprio). Exemplos em specs usam dados fictícios óbvios (`+55 11 90000-0000`, "Cliente Exemplo"). Antes de commitar qualquer spec, o agente varre o texto procurando esses padrões; encontrou, remove ANTES do commit — histórico Git público não se limpa depois.

### 5. Convenção de numeração e grupos

Specs vivem em subpastas por grupo, com prefixo numérico `NN-` indicando prioridade **dentro do grupo** (menor = mais prioritário):

```
specs/
  README.md                 ← este arquivo (spec-zero)
  10-backend/               ← Worker, D1, Vectorize, MCP tools
    11-exemplo.md
    12-exemplo.md
  20-frontend/              ← dashboard web (src/web/)
  30-features/              ← features novas fim-a-fim
  40-ops/                   ← processo, CI, release, tooling
  50-console-v2/            ← pacote Console v2+v3: Kanban, comentários, taxonomia, contatos, menções, inbox, digest, home, backup (Fases 5 e 6 do roadmap)
```

Renumerar só quando a prioridade mudar de fato; buracos na numeração são aceitáveis e esperados.

### 6. Specs cross-repo (expert-contacts)

Specs com `Repo: expert-contacts` no frontmatter **vivem nesta árvore** (`expert-brain/specs/`) por centralização do backlog, mas **executam no working tree de `C:/repos/expert-contacts`**. O agente:

1. Lê a spec aqui.
2. Faz `git pull` e implementa em `C:/repos/expert-contacts`.
3. Valida com os comandos daquele repo (`npx tsc --noEmit` se houver tsconfig; testes que o repo definir; `wrangler deploy` só com OK do dono).
4. Commita a implementação no `expert-contacts` (mensagem referencia o path da spec neste repo) e o update de status da spec aqui.

### 7. Índice de specs

Todas as specs da árvore, com prioridade, esforço e dependências. **Manutenção:** spec nova entra aqui no mesmo commit que a cria; mudança de prioridade/dependência atualiza a linha. A ordem de execução global (fases e gates) vive em `specs/90-roadmap.md`.

| Path | Título | Prioridade | Esforço | Repo | Depende de |
|---|---|---|---|---|---|
| `README.md` | Convenções da árvore specs/ e protocolo de execução por agente | P0 | S | ops | nenhuma |
| `00-sistema/01-mapa-do-sistema.md` | Mapa do sistema: 2 Workers + MCP + Console + dados | P0 | S | ambos | nenhuma |
| `00-sistema/02-inventario-de-falhas.md` | Inventário consolidado de falhas (95 findings + 17 backlog) | P0 | S | ambos | nenhuma |
| `10-backend/11-instructions-parametrizadas.md` | Parametrizar SERVER_INSTRUCTIONS: remover identidade do mantenedor e cobrir as 22 tools | P0 | S | expert-brain | nenhuma |
| `10-backend/12-recall-isolamento-tasks-e-limites.md` | Recall: fechar vazamento de tasks via domains_filter, binds do D1 e semântica de limite | P0 | M | expert-brain | nenhuma |
| `10-backend/13-migrations-idempotentes-e-deploy.md` | Migrations idempotentes + provision no deploy + espelho .sql saneado | P0 | M | expert-brain | nenhuma |
| `10-backend/14-tasks-concorrencia-idempotencia-dedupe.md` | Tasks: versionamento otimista, dedupe na criação e idempotência do complete | P1 | M | expert-brain | nenhuma |
| `10-backend/15-tasks-busca-e-superficie-de-consulta.md` | Tasks: busca textual, get_task, filtros corretos e parse de prazo em BRT | P1 | M | expert-brain | nenhuma |
| `10-backend/16-edges-integridade-e-delete-link.md` | Edges: bloquear task como extremo, tool delete_link e resposta honesta em duplicata | P1 | S | expert-brain | nenhuma |
| `10-backend/17-credenciais-escopos-pat-e-bearer.md` | Escopos de credencial: PAT com scopes, AuthContext propagado, bearer por rota e revogação lógica | P1 | L | expert-brain | nenhuma |
| `10-backend/18-setup-endpoints-auth-e-login-rate-limit.md` | Autenticar /setup/backfill-similar e rate-limit no /authorize | P1 | M | expert-brain | nenhuma |
| `10-backend/19-contacts-write-path-e-canon-unico.md` | Contacts: dedupe por phoneVariants no upsert, proveniência preservada e canon único | P1 | M | expert-contacts | `40-ops/42` |
| `10-backend/20-contacts-recall-raw-e-metadata-vectorize.md` | Contacts: recall não pode voltar vazio por imports crus + metadata Vectorize consistente | P1 | S | expert-contacts | `40-ops/42` |
| `10-backend/21-contacts-prevencao-1102-similaridade-e-layout.md` | Contacts: portar as defesas do incidente 1102 (similar_edges, guard de escala, connections) | P1 | L | expert-contacts | `20-frontend/22`, `40-ops/44` |
| `10-backend/22-contacts-cron-pipedrive-robusto.md` | Contacts: cron Pipedrive com checkpoint incremental, falha visível e janela sem buraco | P1 | M | expert-contacts | `40-ops/42` |
| `10-backend/23-mcp-robustez-erros-e-midia.md` | Brain MCP: mensagens de erro honestas, proxy de contatos com diagnóstico correto e mídia com teto real | P2 | M | expert-brain | nenhuma |
| `10-backend/24-contacts-tokens-api-escopo.md` | Contacts: allowlist de paths pro proxy token, comparação constante e runbook de rotação | P2 | S | expert-contacts | nenhuma |
| `20-frontend/21-csp-botoes-mortos-e-sessao-expirada.md` | Brain web: reviver botões bloqueados pela CSP e erro visível quando a sessão expira | P0 | S | expert-brain | nenhuma |
| `20-frontend/22-grafo-seed-clusterizado-e-layout-persistente.md` | Grafo: seed clusterizado por domínio + posições persistentes entre saves | P1 | M | expert-brain | nenhuma |
| `20-frontend/23-notes-paginacao-e-meta-com-cache.md` | Brain web: paginação em /app/notes e cache no /app/graph/meta | P1 | M | expert-brain | nenhuma |
| `20-frontend/24-console-contacts-avatar-e-cache-do-vault-brain.md` | Console contacts: consertar avatares 401 e cache do meta/grafo do vault brain | P1 | S | expert-contacts | nenhuma |
| `20-frontend/25-grafo-client-interacao-e-render.md` | Grafo client: overlay que não sequestra o mouse, física consistente, culling e modal alinhado | P2 | M | expert-brain | nenhuma |
| `20-frontend/26-grafo-payload-escala-servidor.md` | Grafo servidor: orçamento de payload, cap de similar edges, sourceHash em 1 query e TTL no KV | P2 | M | expert-brain | nenhuma |
| `20-frontend/27-console-contacts-sessao-sso-e-rate-limit.md` | Console contacts: rate-limit no login, SSO single-use e revogação de sessão | P2 | M | expert-contacts | `40-ops/42` |
| `20-frontend/28-web-polish-cache-e-consistencia.md` | Brain web polish: CSS externo cacheável, bundle versionado, 404 não-immutable, links canônicos, filtro "hoje" em BRT | P2 | S | expert-brain | nenhuma |
| `30-features/31-selo-de-privacidade.md` | Selo de privacidade: flag private nas notas + acesso gated por escopo de PAT | P1 | L | expert-brain | `10-backend/17` |
| `30-features/32-task-lifecycle-e-digest-saudavel.md` | Lifecycle de tasks + digest Telegram com teto e snooze (anti alert-fatigue) | P2 | M | expert-brain | nenhuma |
| `30-features/33-compartilhamento-publico-read-only.md` | Compartilhamento público read-only de nota por token (/s/<token>) | P2 | M | expert-brain | `30-features/31` |
| `30-features/34-contacts-delete-e-merge-de-entidades.md` | Contacts: DELETE de entidade/connection e merge de duplicatas | P2 | M | expert-contacts | `40-ops/42`, `10-backend/19` |
| `30-features/35-whatsapp-hub-integracao-contatos.md` | Hub WhatsApp <-> contatos: spec de INTERFACE (links cruzados + sync de categoria por telefone) | P2 | M | ops | `40-ops/45`, `10-backend/19` |
| `30-features/36-edicao-inline-na-ui.md` | Edição inline na UI: tasks, notas e contatos editáveis direto na interface | P2 | L | ambos | nenhuma |
| `40-ops/41-ci-typecheck-e-testes-criticos-brain.md` | Brain: CI com gate de test/typecheck, fix do typecheck do client e testes do fluxo OAuth/PAT | P1 | M | expert-brain | nenhuma |
| `40-ops/42-contacts-testes-typecheck-ci.md` | Contacts: suíte de testes do zero + typecheck + CI (hoje: nada) | P1 | M | expert-contacts | nenhuma |
| `40-ops/43-observabilidade-e-alerting.md` | Observabilidade mínima nos 2 Workers: logs persistidos + alerta de erro + health-check externo | P1 | S | ambos | nenhuma |
| `40-ops/44-contacts-migrations-tracking.md` | Contacts: migrations com tracking (portar runMigrations do Brain) e desarmar o footgun do migrations_dir | P1 | M | expert-contacts | `40-ops/42` |
| `40-ops/45-contacts-category-seeds-e-4a-fonte.md` | Contacts: aplicar seeds de categoria completos com overwrite + 4ª fonte (categoria de chat por telefone) | P1 | M | expert-contacts | `10-backend/19`, `40-ops/44` |
| `40-ops/46-reativacao-lembrete-telegram.md` | Reativação do lembrete diário de tasks no Telegram (gated) | P2 | S | ops | `30-features/32`, `40-ops/43` |
| `50-console-v2/51-tasks-kanban-colunas-customizaveis.md` | Kanban: colunas/estágios customizáveis pela UI, persistidos no banco | P1 | L | expert-brain | nenhuma |
| `50-console-v2/52-tasks-cards-clickup-e-share-ui.md` | Cards e detalhe de task estilo ClickUp + UI de compartilhamento | P1 | M | expert-brain | `50-console-v2/51` (suave: `53`) |
| `50-console-v2/53-tasks-comentarios.md` | Comentários em tasks: console, MCP e convidado no link público | P1 | M | expert-brain | nenhuma |
| `50-console-v2/54-taxonomia-configuravel-areas-e-kinds.md` | Taxonomia configurável: cor/label de áreas e kinds + criar área pela UI | P1 | M | expert-brain | nenhuma |
| `50-console-v2/55-contacts-cartela-completa.md` | Contacts: canais múltiplos (e-mails, sociais, CRM, ManyChat) | P1 | L | expert-contacts | nenhuma (coordenação: `10-backend/19`) |
| `50-console-v2/56-contact-pagina-propria-e-conexoes.md` | Contato com URL própria + vínculos 1º/2º nível | P1 | L | ambos | `50-console-v2/55`, `50-console-v2/57` (suave: `10-backend/21`) |
| `50-console-v2/57-contacts-timeline-interacoes.md` | Contacts: timeline paginada de interações + registro manual no console | P1 | M | ambos | nenhuma |
| `50-console-v2/58-tasks-projetos-pastas.md` | Tasks: projetos (pastas) — agrupamento first-class com filtro no board e no MCP | P1 | L | expert-brain | `50-console-v2/51` (suave: `52`) |
| `50-console-v2/59-tasks-privacidade.md` | Tasks privadas: gate de escopo nos read paths de task + bloqueio de share público | P1 | M | expert-brain | `10-backend/17`, `30-features/31` |
| `50-console-v2/60-contacts-observacoes-semanticas.md` | Contacts: observações alimentam o embedding + busca textual em contexts | P1 | M | expert-contacts | `50-console-v2/57` |
| `50-console-v2/61-contacts-privacidade.md` | Contacts: entidade/evento privados, fail-closed no proxy, escopo propagado pelo Brain | P1 | L | ambos | `10-backend/17`, `30-features/31` (rodar após a onda C2; coordena `60`) |
| `50-console-v2/62-mencoes-tecido-conectivo.md` | Menções: vínculo first-class nota↔task↔contato + task nascida de nota | P1 | L | ambos | `50-console-v2/56`, `50-console-v2/57` (coordena `61`) |
| `50-console-v2/63-captura-inbox-triagem.md` | Captura sem fricção: tool capture + inbox de triagem no console | P1 | M | expert-brain | nenhuma |
| `50-console-v2/64-resurfacing-digest.md` | Resurfacing: digest diário que devolve perguntas abertas, notas frias e contatos esfriando | P1 | M | expert-brain | suaves: `63`, `57` |
| `50-console-v2/65-home-hoje-e-journal.md` | Home "Hoje" + journal cronológico cross-módulo | P1 | M | ambos | `63`, `64` (coordena `61`) |
| `50-console-v2/66-busca-unificada-cmdk.md` | Estender a paleta Ctrl+K existente: tasks e contatos nos resultados + ações rápidas | P1 | M | expert-brain | nenhuma dura |
| `50-console-v2/67-backup-export.md` | Backup: snapshot semanal D1→R2 + export manual + runbook de restore | P1 | M | ambos | nenhuma (adiantável) |
| `50-console-v2/68-pwa-instalavel.md` | PWA (base já existe): share target de captura + shortcuts no manifest | P2 | S | expert-brain | `63` (suave: `65`) |
| `50-console-v2/69-backup-offsite.md` | Backup off-site: rotina externa copia snapshots pra fora da Cloudflare (Drive + servidor) | P1 | M | ops | `50-console-v2/67` (deployada; dono no loop) |
| `50-console-v2/70-instrucoes-do-dono.md` | Instruções do dono ("CLAUDE.md do Brain"): campo no console servido no handshake MCP | P1 | S | expert-brain | `10-backend/11` (done) |
| `60-ux-reforma/60-visao-geral.md` | Visão geral do programa de reforma UI/UX do console: decisões, diagnóstico e mapa das 7 ondas | P0 | S | expert-brain | nenhuma |
| `60-ux-reforma/61-onda0-infra-auditoria-baseline.md` | Onda 0: harness de screenshots, baseline, seed determinístico, infra de teste client/e2e | P0 | M | expert-brain | `60-ux-reforma/60` |
| `60-ux-reforma/62-onda1-pesquisa-referencias-identidade.md` | Onda 1: pesquisa de referências (ClickUp real + web) e 3 protótipos de identidade visual | P0 | M | expert-brain | `60-ux-reforma/61` |
| `60-ux-reforma/63-onda2-tokens-retematizaveis.md` | Onda 2: reestruturação de `styles.ts` em camadas de tokens re-tematizáveis + fix `--text-muted` | P0 | M | expert-brain | `60-ux-reforma/62` |
| `60-ux-reforma/64-onda3-biblioteca-componentes.md` | Onda 3: biblioteca de componentes (`.card`, `.btn`, `.chip`, `.empty-state`, `.modal`, etc.) | P1 | M | expert-brain | `60-ux-reforma/63` |
| `60-ux-reforma/65-onda4-interacoes-dnd-clique-visibilidade.md` | Onda 4: os 3 bugs da aula — drag por Pointer Events, cartão clicável, seletor de visibilidade unificado | P0 | L | expert-brain | `60-ux-reforma/64` |
| `60-ux-reforma/66-onda5-fix-list-por-tela.md` | Onda 5: fix list aplicando tokens e componentes tela a tela (home, board, shell, graph, notes, share) | P1 | L | expert-brain | `60-ux-reforma/65` |
| `60-ux-reforma/67-onda6-identidade-a11y.md` | Onda 6: aplicação da identidade escolhida + gate de contraste AA + acessibilidade/responsivo | P1 | M | expert-brain | `60-ux-reforma/62`, `60-ux-reforma/66` |
| `60-ux-reforma/68-onda7-verificacao-deploy.md` | Onda 7: verificação final, checklist manual, validação do dono e deploy único de produção | P0 | S | expert-brain | `60-ux-reforma/67` |
| `90-roadmap.md` | Roadmap de execução com fases, dependências e gates | P0 | S | ambos | nenhuma |

## Fora de escopo

- Escrever as specs individuais (cada uma é sua própria entrega nesta árvore).
- Criar tooling/CI de validação automática de specs (lint de template, checagem de PII) — pode virar spec futura em `40-ops/`.
- Migrar issues/backlog antigos pra este formato.
- Definir processo de release npm (já coberto por `RELEASING.md`).

## Critérios de aceite

- [ ] `specs/README.md` existe na raiz de `specs/` e contém: protocolo de execução em 8 passos, tabela dos 5 status, template completo de spec, regra anti-vazamento, convenção de numeração `NN-` com os 4 grupos, regra cross-repo do `expert-contacts` e o índice completo de specs
- [ ] O índice (seção 7) lista TODAS as specs presentes na árvore, com path, título, prioridade, esforço, repo e dependências — nenhum arquivo `.md` da árvore fica de fora
- [ ] O gate de deploy (deploy/push de produção e release npm só com OK explícito do dono da instância) está declarado como regra dura
- [ ] A regra de migrations sempre aditivas está declarada no protocolo
- [ ] O documento não contém nenhum telefone, nome de cliente, token, ID de chat ou dado pessoal real
- [ ] Todo o texto está em PT-BR com acentuação correta
- [ ] Uma spec futura pode ser executada por um agente lendo APENAS este README + a spec em questão

## Validação

Este documento é só Markdown — não há código a validar. Ainda assim, ao commitá-lo:

```bash
# sanidade do repo (nada deve quebrar por adicionar um .md)
cd C:/repos/expert-brain
npm run typecheck
npm test
```

Teste manual: pedir a um agente sem contexto que leia apenas `specs/README.md` e explique o protocolo de execução; se ele reproduzir os 8 passos, os 5 status e o gate de deploy, o documento cumpre a função.

Deploy: não se aplica (documento). Push pro remoto segue o gate padrão — SÓ com OK do dono da instância.

## Arquivos afetados

- `specs/README.md` (novo)

## Riscos e reversão

- **Risco:** specs futuras ignorarem o protocolo por o README estar `draft`. Mitigação: promover a `ready` assim que o dono aprovar, e toda spec nova linkar este arquivo na seção Dependências quando fizer sentido.
- **Risco:** vazamento de dado pessoal em spec futura (irreversível em repo público). Mitigação: regra anti-vazamento da seção 4 + varredura antes de cada commit.
- **Reversão:** `git revert` do commit que adicionou este arquivo (ou `git rm specs/README.md`). Nenhum dado ou código de runtime é afetado — rollback é trivial e sem efeito colateral.
