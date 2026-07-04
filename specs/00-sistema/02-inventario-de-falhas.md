# Inventário consolidado de falhas (95 findings + 17 itens de backlog)

> **Status:** draft · **Prioridade:** P0 · **Esforço:** S · **Repo:** ambos (`expert-brain` e `expert-contacts`)
> **Depende de:** nenhuma

## Contexto

Este arquivo é a **fonte de verdade de rastreabilidade** do plano spec-driven: a tabela única de todos os findings das revisões de código, deduplicada, por severidade, com a spec que cobre cada um ou a justificativa de descarte.

Fontes consolidadas:

- **5 revisões independentes**: backend do brain (`src/` exceto `src/web`), frontend do brain (`src/web` + `src/web/client`), superfície MCP do brain (`src/mcp`), expert-contacts completo (Worker + Console + MCP standalone + cron) e testes + infra/ops dos dois repos.
- **Backlog de produto** com 17 itens (melhorias desejadas, não defeitos).

Findings duplicados entre revisores foram unificados sob um **id canônico** (duplicatas anotadas na coluna de título com `(=id-duplicado)` ou `(N revisores)`); a severidade consolidada é a maior atribuída entre os revisores.

**Total: 95 findings únicos — 18 Alta / 41 Média / 36 Baixa — + 17 itens de backlog. TODOS mapeados em spec ou descartados com justificativa (seção final).**

## Problema / Motivação

- Sem um inventário versionado, não há como auditar se os 95 findings foram todos cobertos por alguma spec — findings "órfãos" somem silenciosamente quando o relatório de review sai do contexto.
- Specs individuais citam seus findings, mas não existe a visão inversa (finding → qual spec me cobre), nem registro de descartes deliberados.
- Os 17 itens de backlog de produto se misturam com defeitos quando não há separação formal, inflando severidade percebida e poluindo priorização.

## Objetivo

Toda linha deste arquivo (95 findings + 17 itens de backlog) aponta pra uma spec existente em `specs/` ou pra uma justificativa de descarte — zero findings órfãos, verificável por grep.

## Design proposto

O artefato é este próprio arquivo. Estrutura: uma tabela por severidade (colunas: id canônico — que serve de título descritivo —, descrição curta, tipo, área, spec que cobre, status), seção de mapeamento do backlog e seção final de descartes com justificativa.

### Regra de manutenção (permanente)

- Quando uma spec fechar (status `done`), marcar aqui os findings correspondentes como `resolvido em DD/MM/AAAA` — no mesmo commit que muda o status da spec.
- **Este arquivo nunca deleta linha** — resolução, descarte ou obsolescência são sempre marcados na coluna `status`, preservando o histórico completo.
- Finding novo descoberto depois do review original entra no fim da tabela da severidade correspondente com id canônico novo, nunca reaproveitando id.
- Nenhuma linha pode conter dado pessoal, credencial, endpoint privado ou nome de cliente — o repo é open-source.

### Severidade ALTA (18)

| id | descrição | tipo | área | spec que cobre | status |
|---|---|---|---|---|---|
| `instructions-hardcoded-owner` | Instructions do MCP hardcodam nome/cargo/empresa do mantenedor original — toda instalação de aluno anuncia o vault como pertencendo a ele (4 revisores; =`instructions-hardcode-owner`, `instructions-hardcoded-owner-r3`) | debt/bug | brain MCP | `10-backend/11` | aberto |
| `recall-domains-filter-vaza-tasks` | Caminho `domains_filter` do recall não exclui `kind='task'` — tasks vazam no recall (=`recall-task-leak-domain-filter`) | bug | brain MCP | `10-backend/12` | aberto |
| `migrations-alter-nao-idempotente` | `ALTER TABLE ADD COLUMN` das migrations 0004/0006 não é idempotente — retry após falha transiente trava o `/setup/provision` pra sempre | bug | brain DB | `10-backend/13` | aberto |
| `pat-sem-escopo` | PAT sem escopo: qualquer token vazado tem CRUD total do vault + export completo de contatos | security | brain auth | `10-backend/17` | aberto |
| `save-task-sem-dedupe` | `save_task` sem dedupe — duplicata garantida entre instâncias/sessões (3 revisores) | feature-gap | brain tasks | `10-backend/14` | aberto |
| `update-task-last-write-wins` | `update_task` sobrescreve silenciosamente (last-write-wins) com múltiplos clientes MCP simultâneos (3 revisores) | bug | brain tasks | `10-backend/14` | aberto |
| `csp-inline-onclick-dead-buttons` | Botões "concluir task" e "Copiar link" com onclick inline mortos pela CSP em TODO browser | bug | brain web | `20-frontend/21` | aberto |
| `graph-seed-unclustered` | Seed hash puro: grafo acima de 900 nós nasce como nuvem aleatória (d3 alpha 0.25 não reorganiza) | ux | brain web | `20-frontend/22` | aberto |
| `graph-cache-invalidation-per-write` | Cache do grafo invalidado a CADA escrita de nota/edge/reembed — layout inteiro re-semeado, mapa mental destruído | perf | brain web | `20-frontend/22` | aberto |
| `notes-ssr-no-pagination` | `/app/notes` SSR sem LIMIT: 1800+ cards, ~600KB de HTML por page view (mesma família do incidente 1102) | perf | brain web | `20-frontend/23` | aberto |
| `media-401-console-avatar` | Avatar do painel de contato SEMPRE quebrado — `/media/:hash` exige Bearer que o browser não envia e o cookie tem `Path=/app` | bug | contacts console | `20-frontend/24` | aberto |
| `save-person-dedupe-sem-variants` | Upsert de pessoa compara phone EXATO enquanto cron/lookup usam phoneVariants — duplicata garantida entre fontes (9º dígito) | bug | contacts API | `10-backend/19` | aberto |
| `recall-raw-filter-sem-overfetch` | Recall de contatos pode voltar vazio: ~5,7k imports crus ocupam o topK e o filtro é pós-fetch, sem over-fetch | bug | contacts API | `10-backend/20` | aberto |
| `contacts-zero-testes` | expert-contacts com ZERO testes e zero typecheck — regressões só aparecem em produção (=`zero-testes-zero-typecheck`) | test-gap | contacts | `40-ops/42` | aberto |
| `brain-ci-sem-gate` | CI do brain só publica no npm — nenhum gate de test/typecheck em push/PR; release pode empacotar código quebrado pros alunos | test-gap | brain ops | `40-ops/41` | aberto |
| `oauth-pat-flow-sem-teste` | Caminho de entrada de TODAS as instâncias (OAuth/PAT no `/mcp`) sem um teste sequer | test-gap | brain auth | `40-ops/41` | aberto |
| `zero-alerting-observability` | Zero alerting/observabilidade nos 2 Workers — Error 1102 só foi descoberto porque o dono abriu a página | debt | ambos ops | `40-ops/43` | aberto |
| `contacts-migrations-destrutivas-sem-tracking` | Migrations do contacts aplicadas na mão sem registro; 0002 é destrutiva (DROP TABLE) e o `migrations_dir` convida um apply do zero num banco vivo | debt | contacts DB | `40-ops/44` | aberto |

### Severidade MÉDIA (41)

| id | descrição | tipo | área | spec que cobre | status |
|---|---|---|---|---|---|
| `recall-estoura-100-binds-d1` | Hidratação do recall com `IN` de até ~110 ids estoura o cap de ~100 binds do D1 em vault grande | bug | brain MCP | `10-backend/12` | aberto |
| `recall-limit-inalcancavel-sem-paginacao` | Com `domains_filter`, o cap de 3-por-domínio torna o `limit` inalcançável; sem offset/paginação documentados | bug | brain MCP | `10-backend/12` | aberto |
| `setup-endpoints-sem-auth` | `/setup/backfill-similar` público — qualquer IP queima quota Vectorize/AI do dono (2 revisores) | security | brain auth | `10-backend/18` | aberto |
| `authorize-sem-rate-limit` | `POST /authorize` sem nenhum freio a brute-force (PBKDF2 capado em 100k iterações pelo runtime) | security | brain auth | `10-backend/18` | aberto |
| `tasks-invisiveis-em-qualquer-busca` | Tasks invisíveis em QUALQUER busca — dedupe e resgate exigem paginar até 500 itens no contexto do agente (3 revisores; =`task-sem-busca-textual`, `tasks-invisiveis-em-busca`) | feature-gap | brain tasks | `10-backend/15` | aberto |
| `sem-get-task` | Não existe `get_task` — `get_note` devolve shape de nota sem os campos de task | feature-gap | brain tasks | `10-backend/15` | aberto |
| `list-tasks-status-fechado-sem-include-closed` | `list_tasks` com status done/canceled retorna `[]` silencioso sem `include_closed` | bug | brain tasks | `10-backend/15` | aberto |
| `update-task-nao-limpa-due-priority` | `update_task` não permite limpar `due`/`priority` (o SQL já suporta null; a tool não expõe) | feature-gap | brain tasks | `10-backend/15` | aberto |
| `edge-delete-ausente-no-mcp` | Edge errada é impossível de remover via MCP — gap admitido na própria description do update_note (3 revisores; =`sem-delete-edge`, `edges-sem-delete-via-mcp`) | feature-gap | brain MCP | `10-backend/16` | aberto |
| `edges-aceitam-task-como-extremo` | `link`/`save_note` aceitam edge cujo extremo é task — edge fantasma fora do grafo (=`edge-para-task-permitido`) | bug | brain MCP | `10-backend/16` | aberto |
| `auth-props-ignorados-no-registry` | AuthContext não propagado — nenhuma tool sabe quem chamou; sem fundação de auditoria | debt | brain auth | `10-backend/17` | aberto |
| `bearer-token-scope-creep` | `TASK_REMINDER_TOKEN` e `GRAPH_EXPORT_TOKEN` intercambiáveis — o token do cron de lembrete pode deletar mídia | security | brain web | `10-backend/17` | aberto |
| `media-url-fetch-buffer-ilimitado` | Attach de mídia por URL bufferiza corpo arbitrário se o content-length mente/falta — OOM/1102 em vez de 413 limpo | perf/sec | brain mídia | `10-backend/23` | aberto |
| `helpers-msg-ai-errada-pra-update` | Mensagem "nada foi salvo" da falha do Workers AI é FALSA pro `update_note` (D1 já escrito antes do embed) | bug | brain MCP | `10-backend/23` | aberto |
| `contacts-erro-503-vira-not-found` | Binding de contatos ausente (503) reportado como "contato não existe" | ux | brain MCP | `10-backend/23` | aberto |
| `instructions-drift-12-tools` | Instructions não cobrem 12 das 22 tools (contatos, mídia, restore, reembed) | debt | brain MCP | `10-backend/11` | aberto |
| `telegram-digest-sem-teto-4096` | Digest Telegram sem teto — acima de ~4096 chars o Telegram devolve 400 e o dia de maior atraso fica SEM digest, silenciosamente (3 revisores; =`notify-digest-sem-teto`, `digest-telegram-sem-teto`) | bug | brain cron | `30-features/32` | aberto |
| `task-lifecycle-inexistente` | Nenhum lifecycle de task — backlog, board, list_tasks_due_today e digest só crescem (3 revisores) | feature-gap | brain tasks | `30-features/32` | aberto |
| `session-expired-fetch-silent-noop` | Sessão expirada: POST segue o 302 pro login com status 200 e o client reporta sucesso falso; board congela sem erro | bug | brain web | `20-frontend/21` | aberto |
| `suggested-mode-blocks-graph-interaction` | Modo "conexões sugeridas" seta `pointer-events:auto` num canvas que cobre o Sigma — mata hover/drag/clique/wheel | bug | brain web | `20-frontend/25` | aberto |
| `sim-worker-repel-update-inconsistente` | Slider de repulsão troca o modelo físico silenciosamente (strength flat sem scaling por raio) — invalida o "Salvar como padrão" | bug | brain web | `20-frontend/25` | aberto |
| `similar-overlay-no-culling` | Pan/zoom redesenha milhares de linhas sem culling de viewport nem batching | perf | brain web | `20-frontend/25` | aberto |
| `client-typecheck-quebrado` | Typecheck do client vermelho permanente (`sim-worker.ts` sem lib WebWorker) (=`sim-worker-typecheck-broken`) | debt | brain ops | `40-ops/41` | aberto |
| `shell-meta-fullscan-every-page` | `/app/graph/meta` completo (todas as notas) baixado em TODA navegação só pra alimentar um Ctrl+K que raramente abre | perf | brain web | `20-frontend/23` | aberto |
| `buildpayload-tudo-em-memoria` | `buildPayload` carrega notes+edges+similar_edges inteiros e serializa um JSON único — dezenas de MB em 5-10k notas | perf | brain web | `20-frontend/26` | aberto |
| `deploy-sem-provision-gap` | Janela humana entre deploy e provision — código novo referencia coluna inexistente e dá 500 até alguém lembrar | debt | brain ops | `10-backend/13` | aberto |
| `brain-migrations-espelho-incompleto` | Espelho `.sql` 4 migrations atrás com numeração conflitante — rodar `wrangler d1 migrations apply` hoje quebra o schema | debt | brain DB | `10-backend/13` | aberto |
| `layout-guard-1102-sem-regressao` | O fix do incidente 1102 (guard de escala do layout) não tem NENHUM teste de regressão | test-gap | brain web | `20-frontend/22` | aberto |
| `save-source-sempre-sobrescreve` | UPDATE binda `body.source \|\| 'manual'` (nunca null) e o COALESCE SEMPRE sobrescreve — contato source='pipedrive' vira 'manual' | bug | contacts API | `10-backend/19` | aberto |
| `conn-types-triplicado` | CONN_TYPES/categorias/kinds TRIPLICADOS (Worker, Console, MCP standalone) — drift garantido | debt | contacts | `10-backend/19` | aberto |
| `proxy-token-escopo-total` | `CONTACTS_PROXY_TOKEN` libera QUALQUER GET — lê PII de 7,6k contatos quando foi desenhado só pro grafo | security | contacts API | `10-backend/24` | aberto |
| `contacts-owner-token-monolitico` | `OWNER_TOKEN` monolítico de escrita total, sem escopo | security | contacts API | `10-backend/24` | aberto |
| `sem-rate-limit-login-e-api` | Login do Console e API sem nenhum rate-limit | security | contacts console | `20-frontend/27` | aberto |
| `reembed-perde-category-metadata` | Qualquer passada de reembed APAGA a category da metadata do Vectorize (SELECT não inclui category) | bug | contacts API | `10-backend/20` | aberto |
| `similarity-1-query-por-no` | Console faz 1 query Vectorize POR NÓ — repete exatamente o padrão que derrubou o grafo do Brain (1102) | perf | contacts console | `10-backend/21` | aberto |
| `layout-guard-nao-portado` | `computeLayout` roda forceAtlas2 150 iterações incondicionalmente — guard de escala do Brain não portado | perf | contacts console | `10-backend/21` | aberto |
| `connections-full-scan-truncado` | Tabela connections inteira em memória (`LIMIT 8000` sem ORDER BY, filtro em JS) — truncamento silencioso e arbitrário | perf | contacts | `10-backend/21` | aberto |
| `meta-brain-sem-cache` | Meta do vault brain re-serializa ~1815 notas + ~10k arestas via service binding a cada load da palette | perf | contacts console | `20-frontend/24` | aberto |
| `cron-sem-teto-de-trabalho` | Cron processa até 4000 pessoas numa invocação única sem teto — estoura limites do scheduled e re-tenta em loop de starvation | perf | contacts cron | `10-backend/22` | aberto |
| `contacts-cron-morre-em-silencio` | Cron avança a janela mesmo quando o fetch falhou — modificações perdidas pra sempre, sem alerta | bug | contacts cron | `10-backend/22` | aberto |
| `sem-delete-em-nada` | Nenhum caminho (REST, MCP, Console) deleta entidade, connection ou event; duplicata não tem merge | feature-gap | contacts | `30-features/34` | aberto |

### Severidade BAIXA (36)

| id | descrição | tipo | área | spec que cobre | status |
|---|---|---|---|---|---|
| `link-id-fantasma-em-duplicata` | `link` em duplicata devolve `newId()` fabricado que não existe no banco | bug | brain MCP | `10-backend/16` | aberto |
| `delete-note-e-media-aceitam-task` | `delete_note` e tools de mídia aceitam task sem regra documentada da fronteira nota/task | debt | brain MCP | `10-backend/16` | aberto |
| `complete-task-nao-idempotente` | `complete_task` em task já done re-appenda "**Resultado:**" e avança `completed_at` a cada retry | bug | brain tasks | `10-backend/14` | aberto |
| `save-task-done-sem-completed-at` | `save_task` com status inicial done/canceled não stampa `completed_at` | bug | brain tasks | `10-backend/14` | aberto |
| `parse-due-fallback-timezone-utc` | Fallback `Date.parse` cru interpreta prazo como UTC — 3h adiantado silencioso (=`due-parse-fallback-utc`) | bug | brain tasks | `10-backend/15` | aberto |
| `due-e-dueat-conflito-silencioso` | `due` e `due_at` juntos e divergentes aceitos em silêncio | ux | brain tasks | `10-backend/15` | aberto |
| `list-tasks-tag-match-exato` | Filtro de tag do `list_tasks` é case-sensitive/match exato | ux | brain tasks | `10-backend/15` | aberto |
| `list-tasks-tags-antes-do-slice` | `getTagsForNotes` roda ANTES do `slice(0,limit)`; sem LIMIT defensivo no SQL | perf | brain tasks | `10-backend/15` | aberto |
| `api-keys-revoked-at-morto` | `revoked_at` é código morto — revoke faz DELETE; `last_used_at` em promise flutuante (2 revisores; =`api-key-revoked-at-morto`) | debt | brain auth | `10-backend/17` | aberto |
| `token-compare-vaza-tamanho` | Comparação de token vaza tamanho — o comentário promete o contrário | security | brain web | `10-backend/17` | aberto |
| `mcp-version-hardcoded` | Versão do servidor MCP hardcoded em "0.1.0" — impossível diagnosticar qual deploy responde | debt | brain MCP | `10-backend/23` | aberto |
| `contacts-category-string-livre` | `category` dos schemas de contatos é string livre — typo devolve `count:0` silencioso | ux | brain MCP | `10-backend/23` | aberto |
| `graph-link-why-inconsistente` | Mínimo de `why` divergente entre camadas (client aceita 8, MCP exige 20); relation_type fixo em analogous_to | ux | brain web | `20-frontend/25` | aberto |
| `graph-prefs-compartilhadas-contacts` | Prefs do grafo compartilhadas entre vaults — tuning das notas degrada o grafo de contatos e vice-versa | ux | brain web | `20-frontend/25` | aberto |
| `tasks-ssr-link-vs-rota-canonica` | Card SSR do kanban linka `/app/notes/:id` em vez de `/app/tasks/:id` — 302 extra e inconsistência com o client | debt | brain web | `20-frontend/28` | aberto |
| `tasks-filtro-hoje-24h` | Filtro "Vencem hoje" é na verdade "próximas 24h" — diverge do `list_tasks_due_today` (dia calendário BRT) | ux | brain web | `20-frontend/28` | aberto |
| `styles-inline-49kb-por-pagina` | ~49KB de CSS inline re-baixados a cada clique (sem cache) | perf | brain web | `20-frontend/28` | aberto |
| `config-bundle-sem-versao` | `/app/config/bundle.js` sem versão no path — fix de bug demora até 1h pra chegar (max-age 3600) | debt | brain web | `20-frontend/28` | aberto |
| `serve-bundle-cacheia-erro-immutable` | `serveBundle` manda headers immutable mesmo em erro — 404 de deploy preso no cache do browser por 1 ano | bug | brain web | `20-frontend/28` | aberto |
| `graph-cache-kv-lixo-versionado` | Cada bump manual de CACHE_KEY abandona o value anterior no KV pra sempre (sem TTL) | debt | brain web | `20-frontend/26` | aberto |
| `category-string-vazia` | `category: ''` bypassa a validação e sobrescreve categoria real com vazio | bug | contacts API | `10-backend/19` | aberto |
| `connect-duplicata-simetrica` | Tipos simétricos de connection (friend, family, partner_of) duplicam na ordem invertida | debt | contacts API | `10-backend/19` | aberto |
| `events-kind-sem-validacao` | `kind` de `/event` sem validação na app (o CHECK foi dropado na migration 0002) | debt | contacts API | `10-backend/19` | aberto |
| `media-linhas-duplicadas` | Attach de mídia duplica linhas de `media` — dedup hoje só no R2 | debt | contacts API | `10-backend/19` | aberto |
| `list-entities-nan-500` | `limit`/`offset` NaN em `/list_entities` e `/setup/reembed` vira 500 | bug | contacts API | `10-backend/19` | aberto |
| `mcp-tools-defasadas` | MCP standalone defasado — sem category no save_company, sem attributes, sem list_entities, versão dessincronizada | feature-gap | contacts MCP | `10-backend/19` | aberto |
| `owner-token-timing` | `OWNER_TOKEN` comparado com `===` (timing) — a comparação constant-time já existe no handler e não é usada | security | contacts API | `10-backend/24` | aberto |
| `palette-corta-5k-contatos` | Command palette corta ~5,5k contatos (META_LIST_LIMIT 2000, sem filtro de crus nem indicação de truncamento) | ux | contacts console | `10-backend/20` | aberto |
| `sso-replay-60s` | Handoff SSO reutilizável por 60s, viajando em query string (history/logs de proxy) | security | contacts console | `20-frontend/27` | aberto |
| `logout-nao-revoga-sessao` | Logout não revoga nada — token roubado sobrevive 7 dias | security | contacts console | `20-frontend/27` | aberto |
| `pipedrive-token-na-url` | API key do CRM em querystring — vaza em logs de proxy/observability (habilitada neste Worker) | security | contacts cron | `10-backend/22` | aberto |
| `maint-lastrun-janela-com-buraco` | Checkpoint gravado no FIM do run — janela de sync com buraco entre runs | bug | contacts cron | `10-backend/22` | aberto |
| `seeds-e-4a-fonte-pendentes` | Seeds de categoria (~1451 entradas) sem script de aplicação versionado; 4ª fonte sem stub | feature-gap | contacts ops | `40-ops/45` | aberto |
| `vitest-storage-compartilhado` | `isolatedStorage:false` + singleWorker cria ordem-dependência latente entre arquivos de teste | debt | brain testes | `40-ops/41` | aberto |
| `console-brain-vault-stale-1h` | Vault brain no Console até 1h stale (`vaultSourceHash` devolve 'na', cache só por TTL) | ux | contacts console | `20-frontend/24` | aberto |
| `contacts-release-v3-legado` | Script `release-v3` legado mistura deploy com reembed total de 7,6k entidades — a um tab-complete do deploy normal | debt | contacts ops | `40-ops/42` | aberto |

### Backlog de produto (17 itens) — mapeamento

| # | item | spec que cobre | status |
|---|---|---|---|
| 1 | Selo de privacidade | `30-features/31` (depende de `10-backend/17`) | aberto |
| 2 | Compartilhamento público `/s/<token>` | `30-features/33` | aberto |
| 3 | `dedupe_key` no save_task | `10-backend/14` | aberto |
| 4 | Parametrizar dono nas instructions | `10-backend/11` | aberto |
| 5 | Lifecycle de task + cap digest + snooze | `30-features/32` | aberto |
| 6 | Versionamento otimista no update_task | `10-backend/14` | aberto |
| 7 | Busca de task | `10-backend/15` | aberto |
| 8 | Tabela própria de task | **DESCARTADO** (gated — ver seção de descartes) | descartado |
| 9 | Category seeds + 4ª fonte WhatsApp | `40-ops/45` | aberto |
| 10 | Hub WhatsApp (spec de interface) | `30-features/35` | aberto |
| 11 | Seed clusterizado por domínio | `20-frontend/22` | aberto |
| 12 | Fix typecheck do client | `40-ops/41` (promovido de P3: bloqueia o gate de CI) | aberto |
| 13 | Delete/editar edge via MCP | `10-backend/16` | aberto |
| 14 | Reativação do lembrete Telegram | `40-ops/46` (depende de `30-features/32`) | aberto |
| 15 | Tag de máquina + hook SessionStart | **REVISADO** — camada de captura genérica agora instalada pelo onboarding; tag de máquina segue convenção pessoal (ver descartes) | revisado |
| 16 | Testes contacts + CI mínimo nos 2 repos | `40-ops/41` + `40-ops/42` | aberto |
| 17 | Observabilidade mínima | `40-ops/43` | aberto |

### Descartados — justificativa

1. **`backlog-8` (tabela própria de task):** descartado por gate explícito do próprio backlog — só se a dor de coerência persistir APÓS uso real das correções de task (specs `10-backend/14`, `10-backend/15` e `30-features/32`). Migrar tasks pra tabela própria hoje custa migration de dados + reescrita de 5 tools + risco de regressão, contra uma dor ainda hipotética; o modelo `kind='task'` com índices parciais está funcionando. Fica registrado como **gated — revisitar após a Fase 4 com evidência de uso**.
2. **`backlog-15` (tag de máquina + hook SessionStart):** **revisado.** A parte de *tag de máquina* segue client-side — o servidor já suporta via tags livres (filtro case-insensitive na spec `10-backend/15`), e a convenção (`machine:<slug>`) fica na configuração pessoal do dono. Já a **camada de captura proativa** (pipeline de 6 hooks: prime de SessionStart, capture-nudge por sinal de prazo/decisão/insight/métrica/contato, audit de saves, varredura de silêncio no Stop, Pre/PostCompact) deixou de ficar "fora desta árvore": foi **genericizada — zero dado pessoal — e passou a ser instalada pelo próprio onboarding** (`scripts/install-claude-hooks.mjs`, chamado pelo `scripts/setup.mjs`), com merge idempotente e não-destrutivo no `~/.claude/settings.json` do usuário (backup antes de escrever). Sem isso, toda instalação nova nascia só com o comportamento reativo do servidor MCP — o proativo nunca chegava ao aluno. O boundary continua respeitado: entra no repo o *mecanismo genérico*, nunca o `CLAUDE.md`/hook pessoal do dono.
3. **Nenhum finding de revisor foi descartado:** todos os 95 findings únicos foram mapeados em specs — os de severidade baixa foram agrupados em specs-pacote (`10-backend/19`, `10-backend/23`, `20-frontend/25`, `20-frontend/28`) em vez de virarem specs de 1 linha.

## Fora de escopo

- Corrigir qualquer finding (cada correção tem sua própria spec).
- Re-auditar o código para descobrir findings novos.
- Automatizar a sincronização spec ↔ inventário (CI/lint) — pode virar item de backlog futuro.
- Alterar código, schema ou migrations — esta spec só toca este arquivo Markdown.

## Critérios de aceite

- [ ] Tabela Alta tem exatamente 18 linhas; Média, 41; Baixa, 36; backlog, 17.
- [ ] Toda linha de finding tem `spec que cobre` preenchido com caminho existente em `specs/` OU descarte com justificativa não vazia na seção final.
- [ ] Duplicatas entre revisores anotadas na coluna de descrição (`(=id)` / `(N revisores)`).
- [ ] Regra de manutenção (nunca deletar linha, só marcar status com data) presente e íntegra.
- [ ] Zero ocorrência de credencial, token, e-mail, telefone ou nome de cliente no arquivo.

## Validação

Sem código a compilar — validação estrutural, da raiz do repo `expert-brain`:

```bash
# Contagem de linhas por tabela (esperado: 18, 41, 36, 17 linhas de dados)
awk '/### Severidade ALTA/,/### Severidade MÉDIA/'  specs/00-sistema/02-inventario-de-falhas.md | grep -c '^| `'
awk '/### Severidade MÉDIA/,/### Severidade BAIXA/' specs/00-sistema/02-inventario-de-falhas.md | grep -c '^| `'
awk '/### Severidade BAIXA/,/### Backlog/'          specs/00-sistema/02-inventario-de-falhas.md | grep -c '^| `'
awk '/### Backlog/,/### Descartados/'               specs/00-sistema/02-inventario-de-falhas.md | grep -c '^| [0-9]'

# Todo caminho citado na coluna "spec que cobre" existe na árvore
grep -oE '`[0-9]{2}-[a-z-]+/[0-9]{2}[a-z0-9-]*`' specs/00-sistema/02-inventario-de-falhas.md \
  | tr -d '\140' | sort -u | while read -r f; do ls "specs/$f"* >/dev/null 2>&1 || echo "ÓRFÃO: $f"; done
```

Não há deploy envolvido; commit/push segue o gate padrão do repo (push só com OK do dono da instância).

## Arquivos afetados

- `specs/00-sistema/02-inventario-de-falhas.md` (este arquivo — único artefato)

## Riscos e reversão

- **Risco:** arquivo divergir das specs (finding marcado numa spec que mudou de escopo) → mitigado pela regra de manutenção: quem fecha spec atualiza o inventário no mesmo commit.
- **Risco:** vazamento de dado sensível em edição futura → mitigado pelo critério de aceite de varredura antes de cada commit (repo open-source).
- **Reversão:** `git revert` do commit (ou `git checkout <sha> -- specs/00-sistema/02-inventario-de-falhas.md`) restaura qualquer estado anterior. Nenhum dado de produção é tocado.
