# Roadmap de execução com fases, dependências e gates

> **Status:** draft · **Prioridade:** P0 · **Esforço:** S · **Repo:** ambos (`expert-brain` e `expert-contacts`)
> **Depende de:** nenhuma

## Contexto

A árvore `specs/` contém o backlog spec-driven completo dos dois Workers (`expert-brain` e `expert-contacts`): 33 specs de trabalho + 4 documentos-base (`README.md`, `00-sistema/01`, `00-sistema/02` e este arquivo). O índice completo (path, título, prioridade, esforço, dependências) vive em `specs/README.md`, seção 7; a rastreabilidade finding → spec vive em `specs/00-sistema/02-inventario-de-falhas.md`.

O que nenhuma spec individual declara é a **ordem global de execução**: qual fase vem antes de qual, e o que precisa estar comprovadamente pronto (gate) antes de avançar. Este arquivo é essa camada.

**Regra transversal (vale pra toda spec):** o agente executa a spec → typecheck + testes verdes → commit referenciando o path da spec. Deploy de produção, push com side-effect, release npm pros alunos e rotação de tokens SEMPRE com OK explícito do dono da instância. Specs de `expert-contacts` executam no working tree de `C:/repos/expert-contacts`, embora vivam nesta árvore.

## Problema / Motivação

- Várias specs têm dependências cruzadas declaradas apenas no próprio frontmatter — um agente que abra a árvore sem ordem definida pode executá-las na sequência errada. Exemplos: `10-backend/19`, `20`, `22` e `20-frontend/27` dependem de `40-ops/42` (o `expert-contacts` hoje não tem script `test` nem `typecheck`); `10-backend/21` depende de `20-frontend/22` (implementação de referência do seed clusterizado) e de `40-ops/44` (trilho de migrations antes de criar migration nova no contacts).
- Sem gates escritos, "fase concluída" vira opinião: nada obriga typecheck/testes verdes nem o OK do dono antes de avançar, contrariando o protocolo da spec-zero (`specs/README.md`, seção 1).
- Sem um registro central, duas sessões de agente em máquinas diferentes podem pegar specs conflitantes (mesmos arquivos em "Arquivos afetados") sem perceber.

## Objetivo

Qualquer agente, lendo apenas este arquivo + a spec-zero, sabe exatamente qual spec executar em seguida, quais estão bloqueadas por dependência ou gate, e qual evidência precisa registrar aqui antes de declarar uma fase concluída.

## Design proposto

### 0. Pré-fase (concluída) — documentos-base

`specs/README.md`, `00-sistema/01-mapa-do-sistema.md`, `00-sistema/02-inventario-de-falhas.md` e este `90-roadmap.md` commitados e revisados pelo dono. Nenhuma spec de código executa antes de os 4 existirem.

### Fase 0 — Rede de proteção (paralelizável, ANTES de mexer em código de produto)

| Spec | Repo | Prioridade · Esforço |
|---|---|---|
| `40-ops/41-ci-typecheck-e-testes-criticos-brain.md` | expert-brain | P1 · M |
| `40-ops/42-contacts-testes-typecheck-ci.md` | expert-contacts | P1 · M |
| `40-ops/43-observabilidade-e-alerting.md` | ambos | P1 · S |

**GATE G0:** `npm run typecheck` e `npm test` verdes nos 2 repos em CI; alertas de erro ativos nos 2 Workers. **Nenhuma spec de código avança sem G0 no repo correspondente.**

### Fase 1 — P0: quebrado ou risco ativo em produção

| Spec | Repo | Prioridade · Esforço |
|---|---|---|
| `10-backend/11-instructions-parametrizadas.md` | expert-brain | P0 · S |
| `10-backend/12-recall-isolamento-tasks-e-limites.md` | expert-brain | P0 · M |
| `10-backend/13-migrations-idempotentes-e-deploy.md` | expert-brain | P0 · M |
| `20-frontend/21-csp-botoes-mortos-e-sessao-expirada.md` | expert-brain | P0 · S |

**GATE G1:** teste de regressão pra cada fix; release nova do pacote de alunos (seguir `RELEASING.md`) agrupando as specs 11+12+13, publicada SÓ com OK do dono; provision idempotente validado em preview antes da release.

### Fase 2 — P1: correções núcleo (paralelizável por repo)

**Trilha expert-brain:**

| Spec | Prioridade · Esforço |
|---|---|
| `10-backend/14-tasks-concorrencia-idempotencia-dedupe.md` | P1 · M |
| `10-backend/15-tasks-busca-e-superficie-de-consulta.md` | P1 · M |
| `10-backend/16-edges-integridade-e-delete-link.md` | P1 · S |
| `10-backend/18-setup-endpoints-auth-e-login-rate-limit.md` | P1 · M |
| `20-frontend/22-grafo-seed-clusterizado-e-layout-persistente.md` | P1 · M |
| `20-frontend/23-notes-paginacao-e-meta-com-cache.md` | P1 · M |

**Trilha expert-contacts** (ordem interna obrigatória: `40-ops/44` ANTES de qualquer schema novo):

| Spec | Prioridade · Esforço | Depende de |
|---|---|---|
| `40-ops/44-contacts-migrations-tracking.md` | P1 · M | `40-ops/42` (G0) |
| `10-backend/19-contacts-write-path-e-canon-unico.md` | P1 · M | `40-ops/42` (G0) |
| `10-backend/20-contacts-recall-raw-e-metadata-vectorize.md` | P1 · S | `40-ops/42` (G0) |
| `10-backend/22-contacts-cron-pipedrive-robusto.md` | P1 · M | `40-ops/42` (G0) |
| `20-frontend/24-console-contacts-avatar-e-cache-do-vault-brain.md` | P1 · S | nenhuma |

**GATE G2:** write path do contacts coberto por teste (pré-requisito do apply de seeds da Fase 3); regressão do guard 1102 testada no brain (spec `20-frontend/22`); validação visual do grafo pelo dono no vault real.

### Fase 3 — P1 estruturante (dependências fortes)

| Spec | Repo | Depende de |
|---|---|---|
| `10-backend/17-credenciais-escopos-pat-e-bearer.md` | expert-brain | — |
| `30-features/31-selo-de-privacidade.md` | expert-brain | `10-backend/17` |
| `10-backend/21-contacts-prevencao-1102-similaridade-e-layout.md` | expert-contacts | `20-frontend/22` (Fase 2) + `40-ops/44` (Fase 2) |
| `40-ops/45-contacts-category-seeds-e-4a-fonte.md` | expert-contacts | `10-backend/19` + `40-ops/44` (Fase 2) |

**GATE G3:** após os escopos (17), rotacionar os PATs de TODAS as instâncias do dono (com OK dele); o selo de privacidade (31) só é `done` após teste de vazamento em TODOS os read paths (recall com/sem filtro, FTS, expand, get_note, grafo, stats) + validação manual do dono; seeds (45) aplicados com dry-run revisado pelo dono antes do apply real.

### Fase 4 — P2: valor e polish (oportunístico, qualquer ordem salvo dependências)

| Spec | Repo | Depende de |
|---|---|---|
| `30-features/32-task-lifecycle-e-digest-saudavel.md` | expert-brain | — |
| `40-ops/46-reativacao-lembrete-telegram.md` | ops | `30-features/32` + `40-ops/43` — canal dedicado, OK do dono, rollback por remoção de secret |
| `30-features/33-compartilhamento-publico-read-only.md` | expert-brain | `30-features/31` — só deploya com checklist de segurança completo e revisão dedicada |
| `30-features/34-contacts-delete-e-merge-de-entidades.md` | expert-contacts | `40-ops/42` + `10-backend/19` — backup do D1 antes do primeiro uso |
| `30-features/35-whatsapp-hub-integracao-contatos.md` | ops | `40-ops/45` + `10-backend/19` — spec de interface; implementação no repo externo do dono |
| `10-backend/23-mcp-robustez-erros-e-midia.md` | expert-brain | — |
| `10-backend/24-contacts-tokens-api-escopo.md` | expert-contacts | — |
| `20-frontend/25-grafo-client-interacao-e-render.md` | expert-brain | — |
| `20-frontend/26-grafo-payload-escala-servidor.md` | expert-brain | — |
| `20-frontend/27-console-contacts-sessao-sso-e-rate-limit.md` | expert-contacts | `40-ops/42` (G0) |
| `20-frontend/28-web-polish-cache-e-consistencia.md` | expert-brain | — |

**GATE G4:** cada feature nova entra com testes; o share público (33) exige 2 semanas de rodagem na instância do dono antes de ir pra release de alunos.

### Fase 5 — Console v2 (grupo `50-console-v2/`, pacote aprovado pelo dono em 04/07/2026)

Pacote fim-a-fim pedido pelo dono da instância: Kanban com colunas customizáveis, cards/detalhe estilo ClickUp, comentários (inclusive de convidado no link público), taxonomia configurável, cartela completa de contatos, página própria por contato com vínculos de 1º/2º nível e timeline de interações. Ampliado em 05/07/2026 com: projetos de task (pastas, spec `58`), privacidade de tasks (`59`), observações semânticas de contatos (`60`) e privacidade de contatos (`61`). As specs nasceram `ready` (aprovadas na criação). Pode iniciar após G1 (não depende de G2-G4); a onda C0 só precisa de G0 no contacts.

**Regra transversal de numeração de migrations:** o número de migration citado em QUALQUER spec pendente é INDICATIVO (specs concorrem pelo mesmo trilho — ex.: `10-backend/21` e `50-console-v2/55` no contacts; `10-backend/17`/`30-features/31` citam números que o `0008_share_task` já ocupou no brain). O executor usa o próximo número livre do array `MIGRATIONS` no momento da execução e atualiza a spec no mesmo commit.

**Roteamento de agente (economia + adequação):** coluna "Agente" abaixo — Opus pra schema/migrations/contratos MCP/superfície pública; Sonnet pra UI/SSR/client. Como invocar: abrir Claude Code no repo alvo com o modelo indicado e o prompt "Leia specs/README.md (spec-zero) e execute specs/50-console-v2/<arquivo> seguindo o protocolo". Uma spec por sessão.

**Modo autônomo (sessão rodando sozinha — alternativa ao modo 1-spec-por-sessão):** abrir a sessão com Opus no repo `expert-brain` (branch `spec/console-v2`; no `expert-contacts` trabalhar na branch `feat/console-v2` a partir de `master`) e colar:

> Leia specs/README.md (spec-zero) e specs/90-roadmap.md (Fases 5 e 6). Execute EM SEQUÊNCIA os itens DESMARCADOS do checklist "Sequência canônica de execução", um por vez: implemente a spec, rode typecheck+testes até verdes, commit+push na branch de trabalho, marque o checkbox e o status da spec no MESMO commit. Nas specs marcadas ultrathink, pense com esforço máximo. PROIBIDO: `wrangler deploy`, release, mexer em produção — nos gates de fim de onda (G5-*/G6-*), PARE e peça OK ao dono antes de continuar. Se uma spec falhar validação após 2 tentativas de correção, PARE e reporte o estado. Ao esgotar o contexto, finalize a spec atual, faça commit e encerre com resumo — a próxima sessão retoma pelo checklist.

Rodando tudo com Opus no modo autônomo é aceitável (a marcação Sonnet do checklist é otimização de custo do modo manual).

**Onda C0 — fundação de dados (contacts):**

| Spec | Repo | Agente | Nota |
|---|---|---|---|
| `10-backend/21-contacts-prevencao-1102-similaridade-e-layout.md` | expert-contacts | Opus | DESBLOQUEADA (deps `20-frontend/22` e `40-ops/44` = done). Ao executar: o trilho de migrations descrito nela mudou — schema real vive em `src/db/migrate.ts` (a 44 portou o runMigrations); aplicar a regra transversal acima. Destrava os vínculos semânticos da 56. |

**Onda C1 — tasks (expert-brain), em sequência (compartilham arquivos):**

| Spec | Agente |
|---|---|
| `50-console-v2/51-tasks-kanban-colunas-customizaveis.md` | Opus |
| `50-console-v2/53-tasks-comentarios.md` | Opus |
| `50-console-v2/52-tasks-cards-clickup-e-share-ui.md` | Sonnet |
| `50-console-v2/58-tasks-projetos-pastas.md` | Opus |
| `50-console-v2/54-taxonomia-configuravel-areas-e-kinds.md` | Sonnet |

(53 antes da 52 rende a contagem de comentários pronta pro card; a 58 vem depois da 52 porque adiciona o chip de projeto ao card desenhado lá; a 54 é independente e pode rodar em paralelo NOUTRO working tree, se houver.)

**Onda C2 — contatos:**

| Spec | Repo | Agente |
|---|---|---|
| `50-console-v2/55-contacts-cartela-completa.md` | expert-contacts | Opus |
| `50-console-v2/57-contacts-timeline-interacoes.md` | ambos | Sonnet |
| `50-console-v2/56-contact-pagina-propria-e-conexoes.md` | ambos | Sonnet |
| `50-console-v2/60-contacts-observacoes-semanticas.md` | expert-contacts | Opus |

**Onda C3 — privacidade ("banco privado" / dois acessos MCP):**

| Spec | Agente | Nota |
|---|---|---|
| `10-backend/17-credenciais-escopos-pat-e-bearer.md` | Opus | Pré-requisito estrutural da 31, 59 e 61. |
| `30-features/31-selo-de-privacidade.md` | Opus | Nota `private` invisível pra credencial sem escopo em TODOS os read paths de NOTA. NÃO rodar em paralelo com C1 no mesmo working tree (tocam read paths/web em comum). |
| `50-console-v2/59-tasks-privacidade.md` | Opus | Fecha os read paths de TASK que a 31 não cobre + bloqueia share público de task privada. Depois da 31. |
| `50-console-v2/61-contacts-privacidade.md` | Opus | Entidade/evento privados no contacts, fail-closed no proxy, escopo propagado pelo Brain. Depois da 17 E da onda C2 (gateia endpoints da 56/57); coordena com a 60 (embedding). |

**Sequência canônica de execução (checklist — 22 sessões, 1 spec por sessão):**

> **LOCK DE EXECUÇÃO (atualizado 06/07/2026):** ondas C1-C2 (itens 1,2,3,7,10 — specs `21`, `51`, `53`, `55`, `60`) foram executadas com sucesso em 05-06/07/2026 pelo workflow `wf_a1e5eac3` (sessão `54a7cc4e` no PC do dono), commits em `feat/console-v2` dos dois repos. As specs `52` (cards + share UI) e `60`'s vizinha de onda `58`/`54` (itens 4-6) ficaram pendentes — a `52-tasks-cards-clickup-e-share-ui.md` falhou/não rodou nesta rodada e segue `ready`. Lock reduzido: continua valendo SÓ para os itens ainda `[ ]` (4-22) — **NÃO inicie executor pra esses itens sem checar primeiro se outra sessão já está rodando**. Lock expira se a branch ficar 24h sem commits novos.

Coluna Esforço: `ultrathink` = incluir a palavra "ultrathink" no prompt da sessão (specs de segurança/integridade de dados); `padrão` = prompt normal.

- [x] 1. `10-backend/21` — similaridade pré-computada (contacts, Opus, padrão) — C0 (impl `feat/console-v2` `fceecf3`, tsc+145 testes verdes; **gate G5-C0 pendente: validação do dono + provision/backfill/deploy**)
- [x] 2. `50-console-v2/51` — kanban colunas (brain, Opus, padrão) — C1
- [x] 3. `50-console-v2/53` — comentários (brain, Opus, padrão)
- [x] 4. `50-console-v2/52` — cards + share UI (brain, Sonnet, padrão) — impl `feat/console-v2` (retomada de working tree herdada, sem commit anterior), tsc+436 testes verdes (55 arquivos + auth.test.ts)
- [x] 5. `50-console-v2/58` — projetos/pastas (brain, Opus, padrão) — impl `feat/console-v2`, tsc + suíte verdes (58 arquivos, 465 testes + auth)
- [x] 6. `50-console-v2/54` — taxonomia (brain, Sonnet, padrão) — fecha C1: registrar G5-C1 — impl `feat/console-v2`, tsc + suíte verdes (61 arquivos, 517 testes + auth)
- [x] 7. `50-console-v2/55` — cartela completa (contacts, Opus, padrão) — C2
- [ ] 8. `50-console-v2/57` — timeline (ambos, Sonnet, padrão)
- [ ] 9. `50-console-v2/56` — página própria (ambos, Sonnet, padrão)
- [ ] 10. `50-console-v2/60` — observações semânticas (contacts, Opus, padrão) — fecha C2: registrar G5-C2 (**parcial**: tree do contacts tem write-path/embedding editados sem commit; retomar por herança, não refazer)
- [ ] 11. `10-backend/17` — escopos de credencial (brain, Opus, ultrathink) — C3
- [ ] 12. `30-features/31` — selo de privacidade em notas (brain, Opus, ultrathink)
- [ ] 13. `50-console-v2/59` — tasks privadas (brain, Opus, ultrathink)
- [ ] 14. `50-console-v2/61` — contacts privados (ambos, Opus, ultrathink) — fecha C3: registrar G5-C3
- [ ] 15. `50-console-v2/63` — captura + inbox (brain, Opus, padrão) — C4
- [ ] 16. `50-console-v2/62` — menções/tecido conectivo (ambos, Opus, ultrathink)
- [ ] 17. `50-console-v2/64` — resurfacing/digest (brain, Opus, padrão) — fecha C4: registrar G6-C4
- [ ] 18. `50-console-v2/65` — home Hoje + journal (ambos, Sonnet, padrão) — C5
- [ ] 19. `50-console-v2/66` — paleta Ctrl+K (brain, Sonnet, padrão)
- [ ] 20. `50-console-v2/68` — PWA instalável (brain, Sonnet, padrão) — fecha C5: registrar G6-C5
- [ ] 21. `50-console-v2/67` — backup/export (ambos, Opus, ultrathink) — C6. **IMPLEMENTADA em 05/07/2026** (branches `feat/67-backup` nos dois repos: brain `21ec142` 357 testes, contacts `ac9923d` 125 testes) — falta validação manual do dono + cron no wrangler.toml local do brain + merge + deploy (detalhes no topo da spec). NÃO reimplementar.
- [ ] 22. `50-console-v2/69` — backup off-site (ops, Opus, padrão) — C6: cópia dos snapshots pra fora da Cloudflare (Google Drive + servidor externo). Depois da 67 em produção; exige o dono no loop. Fecha C6: registrar G6-C6.

Quem executa marca o checkbox no MESMO commit que promove a spec pra `done`. A ordem é a canônica; desvio só se a dependência formal permitir (grafo abaixo) e sem compartilhar arquivos com spec em andamento.

**GATE G5 (por onda, antes de avançar):** typecheck + testes verdes no(s) repo(s) da onda + validação manual do dono — C0: grafo de contatos com arestas semânticas sem query Vectorize no load; C1: criar coluna custom, mover card, comentar como convidado pelo link público, compartilhar/revogar pela UI, recolorir e criar área, criar projeto e filtrar o board por ele (incl. `list_tasks project:` via MCP); C2: abrir `/app/contacts/<id>`, canais clicáveis, registrar interação, vínculos 1º/2º nível, recall/busca encontrando contato por termo que só existe numa observação; C3: PAT sem escopo `private` não vê nota privada em recall/get_note/expand/stats NEM task privada em list_tasks/get_task NEM contato/evento privado nas tools de contatos (teste de vazamento por superfície nas três frentes) + share de task privada bloqueado/revogado. Deploy de produção e release de alunos SÓ com OK explícito do dono.

### Fase 6 — Console v3: tecido conectivo, captura, resurfacing, interface unificada e resiliência (aprovado pelo dono em 05/07/2026)

Objetivo declarado do dono: "o Brain cuidando de TODO o processo — tarefa, contato e memória, tudo integrado". A Fase 5 deixa cada módulo forte por dentro; a Fase 6 constrói o que liga os módulos e o que faz o sistema trabalhar sem ser perguntado. Mapa completo dos gaps na nota `xn8lpwuuq9kj` do vault. Specs nasceram `ready`.

**Onda C4 — o cérebro integrado (após C2 e C3):**

| Spec | Repo | Agente | Esforço | Nota |
|---|---|---|---|---|
| `50-console-v2/63-captura-inbox-triagem.md` | expert-brain | Opus | padrão | Independente — pode adiantar pra depois de C1. |
| `50-console-v2/62-mencoes-tecido-conectivo.md` | ambos | Opus | ultrathink | O item mais crítico da fase (pedido explícito do dono). Após 56/57 (endpoints) e 61 (privacidade). |
| `50-console-v2/64-resurfacing-digest.md` | expert-brain | Opus | padrão | Estende o cron/notify existente; consome inbox (63) e last_contacted (57). |

**Onda C5 — interface unificada:**

| Spec | Repo | Agente | Esforço | Nota |
|---|---|---|---|---|
| `50-console-v2/65-home-hoje-e-journal.md` | ambos | Sonnet | padrão | Home consome 63/64; journal usa endpoint novo no contacts. |
| `50-console-v2/66-busca-unificada-cmdk.md` | expert-brain | Sonnet | padrão | A paleta Ctrl+K JÁ existe (`src/web/client/shell.ts`) — a spec é EXTENSÃO (tasks+contatos+ações). |
| `50-console-v2/68-pwa-instalavel.md` | expert-brain | Sonnet | padrão | O PWA base JÁ existe (manifest/SW/ícones) — a spec adiciona share target + shortcuts. Depois da 63. |

**Onda C6 — resiliência:**

| Spec | Repo | Agente | Esforço | Nota |
|---|---|---|---|---|
| `50-console-v2/67-backup-export.md` | ambos | Opus | ultrathink | SEM dependências — recomendado ADIANTAR (é a rede de segurança de todo o resto). IMPLEMENTADA 05/07 (ver nota no checklist). |
| `50-console-v2/69-backup-offsite.md` | ops (servidor externo) | Opus | padrão | Copia os snapshots pra FORA da Cloudflare (rclone → disco externo + Google Drive). Exige o dono no loop (token R2 + OAuth do Drive). Depois da 67 deployada. |

**GATE G6 (por onda):** typecheck + testes verdes + validação manual do dono — C4: capturar pelo bot e triar pela UI; mencionar contato numa nota e ver a nota na página do contato + evento na timeline + task nascida da nota com origem; digest diário chegando com as 4 seções. C5: home responde "o que tem pra hoje" em 1 tela; Ctrl+K acha nota/task/contato e cria task; PWA instalada capturando por share. C6: export baixado + restore validado num banco limpo (contagens = manifest) + off-site: simulação de desastre com a Cloudflare "indisponível" — restaurar só a partir da cópia no Google Drive/servidor externo. Deploy SÓ com OK explícito do dono.

**Backlog C7 — padrões a absorver do benchmark `codebase-memory-mcp` (github.com/DeusData/codebase-memory-mcp, mapeado 05/07/2026; SEM spec ainda — specar após a Fase 6):**

1. **Benchmark de recall publicável** — protocolo do paper deles (arXiv 2603.27277) adaptado: bateria de perguntas reais respondidas COM e SEM o Brain, medindo qualidade da resposta, tokens e tool calls. Vira prova de produto pros alunos. Precisa de: desenho da bateria + harness de medição (recon: nenhum).
2. **Instalador auto-configurável multi-agente** — o `npm create @expertintegrado/expert-brain` detectar os agentes instalados (Claude Code, Cursor, Gemini CLI, ...) e configurar MCP + instruções em cada um, no padrão do install deles. Precisa de: recon no pacote npm create atual.
3. **Tool de travessia estruturada do grafo** — hoje só recall/expand; uma tool de query por relação ("decisões ligadas a X via `causes`", caminhos entre 2 notas) cobriria as perguntas que embedding não responde. Precisa de: desenho do contrato (não expor query language crua).
4. **Detecção de comunidades no curar-brain** — clustering (Louvain ou grau simples) sobre os edges pra sugerir hubs/domínios emergentes no relatório semanal de curadoria. Vive na skill/cron de curadoria, não no Worker.
5. **Upgrade visual do grafo 3D** — referência: `graph-ui/` do codebase-memory-mcp (React three-fiber + drei + `postprocessing`). O que absorver SEM trazer React: (a) passe de pós-processamento com bloom/glow nos nós (lib `postprocessing` funciona com three puro); (b) nós como instanced mesh (`NodeCloud` deles) pra performance; (c) separação tooltip leve vs painel de detalhe; (d) labels com LOD (só nós próximos/focados). Aplicar em `src/web/client/graph3d.ts` do Brain. O dono avaliou o deles como visualmente superior ao nosso (05/07/2026).

(Seção Security & Trust no README do produto e 1-liner de install assinado: itens de docs/release do pacote npm, fora desta árvore de specs.)

### Grafo de dependências formais

```text
31 ← 17
46 ← 32, 43
33 ← 31
34 ← 42, 19
35 ← 45, 19
45 ← 19, 44
21 (backend contacts) ← 22 (frontend brain), 44
19, 20, 22, 27 ← 42 (suíte de testes do contacts)
52 ← 51 (suave: 53, só pela contagem de comentários)
56 ← 55, 57 (suave: 21 — sem ela a página degrada pra só conexões explícitas)
58 ← 51 (suave: 52 — chip de projeto entra no card desenhado lá)
59 ← 17, 31
60 ← 57
61 ← 17, 31 (ordem: após a onda C2 — gateia endpoints da 56/57; coordena 60)
62 ← 56, 57 (coordena: 61 — label de contato privado nas menções)
64 ← 63 (suave), 57 (suave — last_contacted)
65 ← 63, 64 (coordena: 61 — filtro de privado no journal)
68 ← 63 (suave: 65 — start_url na home)
66, 67 ← sem dependência dura
```

Leitura: `A ← B` significa "A depende de B". A dependência declarada no frontmatter da spec prevalece sempre sobre a ordem numérica.

### Regras de paralelização

1. Dentro de uma fase, specs sem dependência entre si podem rodar em paralelo (agentes/sessões diferentes), DESDE que não compartilhem arquivos em "Arquivos afetados".
2. Entre fases, o gate da fase anterior precisa estar registrado (tabela abaixo) antes de iniciar a próxima. Exceção: specs P2 da Fase 4 sem dependência pendente podem ser adiantadas se não tocarem arquivos de specs em andamento.
3. Toda spec segue o protocolo da spec-zero (`specs/README.md`): `ready` antes de executar, `in-progress` ao começar, `done` ao terminar, migrations sempre aditivas, deploy/push de produção SÓ com OK explícito do dono da instância.

### Registro de gates (manutenção deste arquivo)

Ao concluir uma fase, o agente executor registra aqui a data e a evidência do gate — hash de commit, link de CI verde ou OK do dono dado na sessão — no mesmo commit que promove a última spec da fase pra `done`.

| Gate | Concluído em | Evidência (commit/CI/OK do dono) |
|---|---|---|
| Pré-fase (docs-base) | — | — |
| G0 | — | — |
| G1 | — | — |
| G2 | — | — |
| G3 | — | — |
| G4 | — | — |
| G5-C0 | pendente (dono) | Código pronto: `expert-contacts` `feat/console-v2` `fceecf3` (spec `10-backend/21` done), `tsc --noEmit` limpo + `vitest` 145/145. FALTA (dono): validar grafo com arestas semânticas sem query Vectorize no load + `POST /setup/provision` (migration 0005) + `POST /setup/backfill-similar` em loop + deploy — tudo SÓ com OK explícito. |
| G5-C1 | 06/07/2026 | Código pronto: `expert-brain` `feat/console-v2` `e2d2464` (spec `50-console-v2/54` done, fecha itens 2-6 da onda C1), `tsc --noEmit` limpo + `vitest` 517/517 + auth (61 arquivos). FALTA (dono): validação manual via `wrangler dev` + deploy — tudo SÓ com OK explícito. |
| G5-C2 | — | — |
| G5-C3 | — | — |
| G6-C4 | — | — |
| G6-C5 | — | — |
| G6-C6 | — | — |

Regras de manutenção:

- Spec nova entra na árvore → adicioná-la à fase adequada aqui (pela prioridade e dependências do frontmatter) E ao índice do `specs/README.md`, no mesmo commit.
- Dependência nova declarada numa spec → refletir na tabela da fase e no grafo de dependências.
- Spec fechada (`done`) → marcar os findings correspondentes no `00-sistema/02-inventario-de-falhas.md` com a data, no mesmo commit.

## Fora de escopo

- Escrever ou alterar o conteúdo técnico das specs individuais (cada uma é sua própria entrega).
- Automatizar a verificação de gates (lint de status, bot de CI) — pode virar spec futura em `40-ops/`.
- Definir processo de release npm (coberto por `RELEASING.md`).
- Priorizar itens fora da árvore `specs/` (issues antigas, backlog externo).

## Critérios de aceite

- [ ] `specs/90-roadmap.md` lista TODAS as 33 specs de trabalho da árvore, cada uma alocada em exatamente uma fase (0 a 4)
- [ ] Toda dependência declarada no frontmatter de uma spec está refletida no sequenciamento (nenhuma spec aparece numa fase anterior à sua dependência)
- [ ] Cada fase tem um gate explícito e verificável (G0 a G4), com a evidência exigida descrita
- [ ] O grafo de dependências formais confere com os frontmatters das specs
- [ ] Existe a tabela de registro de gates com instrução de preenchimento (data + evidência)
- [ ] O arquivo não contém telefone, nome de cliente, token, ID de chat ou qualquer dado pessoal real
- [ ] Todo o texto está em PT-BR com acentuação correta

## Validação

Este documento é só Markdown — não há código a validar. Sanidade ao commitá-lo:

```bash
cd C:/repos/expert-brain
npm run typecheck
npm test
```

Teste manual: pedir a um agente sem contexto que leia apenas `specs/README.md` + este arquivo e responda (a) qual spec executar primeiro hoje e (b) por que a `10-backend/21` está bloqueada — se ele responder Fase 0 (`40-ops/41`, `42`, `43`) e citar `20-frontend/22` + `40-ops/44`, o roadmap cumpre a função.

Deploy: não se aplica (documento). Push pro remoto segue o gate padrão — SÓ com OK do dono da instância.

## Arquivos afetados

- `specs/90-roadmap.md` (este arquivo)

## Riscos e reversão

- **Risco:** roadmap desatualizar em relação à árvore (spec nova sem fase, dependência nova não refletida). Mitigação: regras de manutenção — atualização no mesmo commit da mudança.
- **Risco:** agente pular gate por pressa. Mitigação: a tabela de registro exige evidência concreta; gate sem linha preenchida = não passou.
- **Reversão:** `git revert` do commit que adicionou/alterou este arquivo. Nenhum código de runtime é afetado — rollback trivial e sem efeito colateral.
