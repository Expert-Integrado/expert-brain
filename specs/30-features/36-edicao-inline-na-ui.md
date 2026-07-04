# Edição inline na UI: tasks, notas e contatos editáveis direto na interface

> **Status:** in-progress · **Prioridade:** P2 · **Esforço:** L · **Repo:** ambos
> **Depende de:** nenhuma

## Contexto

Hoje a UI web do Brain (`/app/*`) é majoritariamente **leitura**. A escrita acontece quase toda via agente (tools MCP), com duas exceções pontuais já em produção:

- **Board de tasks** (`src/web/tasks.ts`, `src/web/client/tasks.ts`): já tem edição real via clique/drag — drag-and-drop entre colunas (`POST /app/tasks/status`, handler `handleTaskStatusPost` em `src/web/tasks.ts:90-104`) e botão "✓ concluir" (`POST /app/tasks/complete`, handler `handleTaskCompletePost` em `src/web/tasks.ts:107-121`, wiring client em `src/web/client/tasks.ts:135-147` e `src/web/client/note-media.ts:146-168`). Isso prova que o padrão "POST de sessão que reusa a query de baixo nível" já funciona neste repo.
- **Mídia de nota/task** (`src/web/client/note-media.ts`): upload/delete de anexos já é escrita direta na UI (`POST /app/notes/:id/media`, `DELETE /app/media/:id`).

Fora esses dois pontos, o detalhe de nota (`/app/notes/<id>`, `handleNoteDetail` em `src/web/notes.ts:134-256`) e o detalhe de task (`/app/tasks/<id>`, `handleTaskDetail` em `src/web/notes.ts:269-335`) são **read-only**: título, corpo (markdown renderizado via `renderMarkdown`), tldr, domínios, kind, prazo e prioridade só mudam pelas tools MCP (`update_task` em `src/mcp/tools/update-task.ts`, `update_note` em `src/mcp/tools/update-note.ts`).

Camadas de concorrência hoje são **assimétricas**:
- `updateTask` (`src/db/queries.ts:505-548`) já suporta versionamento otimista via `expected_updated_at` opcional — se passado, o `UPDATE` ganha `AND updated_at = ?` e devolve `'conflict'` quando 0 linhas mudam (`src/db/queries.ts:531-544`). A tool `update_task` (`src/mcp/tools/update-task.ts:20-22, 116, 122-129`) já expõe isso.
- `updateNote` (`src/db/queries.ts:142-155`) **não tem** parâmetro de concorrência — é um `UPDATE` incondicional por `id`. A tool `update_note` (`src/mcp/tools/update-note.ts`) não passa (nem recebe) `expected_updated_at`.

No repositório irmão `expert-contacts` (`C:/repos/expert-contacts`), o Console (`src/web/*`) também é read-only: `GET /app/entity?vault=&id=` (`src/web/detail.ts`) resolve o adapter e devolve o `EntityDetail`, sem nenhuma rota de escrita no Console. A escrita de contato hoje só existe via `POST /save_person` no Worker de API (`src/index.ts:698`, handler `handleSaveEntity` em `src/index.ts:200-` — upsert por `id` OU `phone` para pessoa, `COALESCE` campo a campo, sem `expected_updated_at`/versionamento algum), exposta como tool MCP `save_person` (`mcp/index.js:51-70`).

A CSP do app (`src/web/render.ts:118-127`) é `script-src 'self'` sem `unsafe-inline`/`script-src-attr` — todo wiring de botão precisa de listener JS em bundle próprio, nunca `onclick` inline. Os bundles client já seguem esse padrão (`src/web/client/tasks.ts`, `src/web/client/note-media.ts`).

## Problema / Motivação

O dono da instância quer que, **ao entrar na interface**, consiga clicar e editar direto — sem precisar pedir a um agente MCP para mudar a data de vencimento de uma task, o status/prioridade, o texto de uma nota, ou um campo de contato. A UI vira **complemento de edição rápida**; o fluxo agente-first (MCP) continua sendo o principal e não é substituído.

Evidência concreta do gap: `handleNoteDetail` (`src/web/notes.ts:134-256`) renderiza `note.title`, `domainsToBadges(note.domains)` e `renderMarkdown(note.body, ...)` como HTML estático — não existe nenhum formulário, nenhum `contenteditable`, nenhum endpoint `POST`/`PATCH` associado a esses campos. O mesmo vale para `handleTaskDetail` (`src/web/notes.ts:269-335`): título, corpo, domínios não são editáveis ali (só status via botão "concluir", que é um caso estreito). No `expert-contacts`, `handleEntityDetail` (`src/web/detail.ts:29-51`) é estritamente `GET`.

## Objetivo

O dono da instância consegue, sem sair da UI web:
1. Editar prazo, prioridade, status, título e corpo de uma task — tanto no card do board quanto no detalhe (`/app/tasks/<id>`).
2. Editar título, corpo (com preview de markdown), tldr, domínios e kind de uma nota no detalhe (`/app/notes/<id>`).
3. Editar campos básicos e categoria de um contato no Console do `expert-contacts`.

Toda escrita passa pelas MESMAS funções de banco que as tools MCP usam (nenhuma validação duplicada), com concorrência detectável (não há sobrescrita silenciosa de uma edição concorrente do agente).

## Design proposto

### Decisão 1 — Autosave vs botão salvar

**Recomendação: híbrido por tipo de campo**, seguindo o padrão que o board de tasks já estabeleceu:

- **Campos estruturados de baixo risco** (status, prioridade, prazo, domínios, kind): autosave imediato ao mudar o valor (`onchange` do `<select>`/`<input type="date">`), igual ao já existente `POST /app/tasks/status` no drag-drop. Risco de erro de digitação é zero (são pickers/selects, não texto livre).
- **Campos de texto livre** (título, corpo/body, tldr): botão "Salvar" explícito + atalho `Ctrl+Enter`/`Cmd+Enter`, com detecção de "unsaved changes" (aviso ao navegar para fora com edição pendente via `beforeunload`). Justificativa: título/corpo são texto longo, digitação é destrutiva se autosave disparar no meio de uma frase incompleta ou gerar staccato de requests; e o corpo da nota aciona reembed (custo de Workers AI) — não queremos disparar isso a cada tecla.
- Corpo da nota/task usa **debounce mínimo de 800ms** só para o indicador visual "digitando..." → "salvo", mas o **PATCH real só sai no blur do textarea OU no botão Salvar**, nunca em cada keystroke.

### Decisão 2 — Endpoints novos `/app/*/update` (sessão) reusando as MESMAS queries das tools MCP

**Recomendação: sim, endpoints de sessão dedicados, que chamam diretamente as funções de `src/db/queries.ts`** — nunca duplicar lógica de validação/patch.

Novos endpoints no `expert-brain` (padrão idêntico a `handleTaskStatusPost`/`handleTaskCompletePost`, autenticação via `requireSession` — sessão de browser; **sem** `authorizeBearer`, pois esta é edição humana via UI, diferente do board que também aceita automação):

- `POST /app/tasks/update` — body `{ id, title?, details?, due?, priority?, status?, expected_updated_at? }`. Handler novo em `src/web/tasks.ts` que:
  - Valida com a MESMA lógica de parse que `update_task` usa (`parseDueToMs` de `src/util/time.js`, `TASK_STATUSES` de `src/db/queries.js`).
  - Chama `updateTask(env, id, patch, now, expected_updated_at)` — a mesmíssima função que a tool MCP chama. Zero reimplementação de regra.
  - Se `updateTask` retornar `'conflict'`, responde `409` com o `updated_at` atual (mesmo formato de erro que `update_task` devolve ao agente, adaptado a JSON HTTP) — ver Decisão 3.
- `POST /app/notes/update` — body `{ id, title?, body?, tldr?, domains?, kind?, expected_updated_at? }`. Handler novo em `src/web/notes.ts` que:
  - Reusa `validateDomains` (`src/db/validation.js`) para domínios.
  - Chama `updateNote(env, id, patch)` (`src/db/queries.ts:142-155`) e, se `tldr`/`domains`/`kind` mudou, reusa o MESMO bloco de reembed que `update_note` MCP faz (`embed` + `upsertNoteVector` + `refreshSimilarEdges`, hoje só existente em `src/mcp/tools/update-note.ts:143-164`) — **extrair esse bloco de reembed para uma função compartilhada** (ex. `reembedNoteIfNeeded` em `src/db/queries.ts` ou novo `src/web/notes-write.ts`) chamada tanto pela tool MCP quanto pelo endpoint de sessão. Isso é o ponto onde duplicação apareceria se não for extraído — a spec EXIGE a extração, não a duplicação inline.
  - Bloqueia edição se `kind === 'task'` (mesma regra de `update_note`, `src/mcp/tools/update-note.ts:95-100`) — task se edita só por `/app/tasks/update`.

No `expert-contacts`, novo endpoint `POST /app/entity/update` (Console, `src/web/detail.ts` ou arquivo companheiro `src/web/entity-update.ts`) que:
  - Reusa a MESMA lógica de patch por `COALESCE` que `handleSaveEntity` (`src/index.ts:200-`) já usa — **extrair o corpo do `UPDATE ... COALESCE` para uma função compartilhada** (ex. `updateEntityFields` em `src/vaults/contacts.ts` ou módulo companheiro) chamada tanto por `handleSaveEntity` (API/MCP) quanto pelo novo endpoint de sessão do Console. Mesma regra da Decisão 2 acima: extrair, nunca duplicar.
  - Exige sessão de Console autenticada (o Console já tem seu próprio `session.ts`/SSO — reusar o mesmo guard que `handleEntityDetail` usaria se fosse protegido; confirmar mecanismo de auth do Console lendo `src/web/session.ts` e `src/web/sso.ts` do `expert-contacts` antes de implementar).

### Decisão 3 — Concorrência via `updated_at`

**Recomendação: estender concorrência otimista para notas e contatos, no mesmo padrão que tasks já validou.**

- **Tasks**: já resolvido — `expected_updated_at` já existe fim a fim (`src/db/queries.ts:505-548`, `src/mcp/tools/update-task.ts:20-22`). O endpoint `/app/tasks/update` só precisa PASSAR o `updated_at` que a página carregou como `expected_updated_at`. A UI mostra "essa task foi editada em outro lugar — recarregue" em caso de `409`, com botão "recarregar" (não sobrescrever automaticamente).
- **Notas**: `updateNote` (`src/db/queries.ts:142-155`) HOJE não aceita `expected_updated_at`. Esta spec exige adicionar o parâmetro opcional a `updateNote`, no MESMO padrão de `updateTask` (`WHERE id = ? AND updated_at = ?` quando fornecido, retorno `'conflict'` sentinela quando 0 linhas mudam). Migração de assinatura é aditiva (parâmetro opcional, retrocompatível — chamadas existentes sem o parâmetro continuam last-write-wins). A tool MCP `update_note` pode opcionalmente passar a aceitar `expected_updated_at` também (fora do escopo obrigatório desta spec, mas a função de banco já fica pronta para isso).
- **Contatos**: `handleSaveEntity` (`src/index.ts:200-`) faz `UPDATE ... COALESCE(...) WHERE id = ?` sem checar versão. Esta spec exige o mesmo padrão: coluna `updated_at` já existe em `entities` (usada em `contactsSourceHash`, `src/vaults/contacts.ts:186-192`) — adicionar `expected_updated_at` opcional na função extraída de update, com o mesmo sentinela de conflito. Confirmar tipo/formato exato da coluna `updated_at` de `entities` (ler schema/migração antes de implementar — pode ser epoch ms ou ISO string, diferente do Brain).

Em todos os casos: **a UI sempre lê o `updated_at` atual junto com o registro (já retornado por `getTaskById`/`getNoteById`/`fetchEntity`) e reenvia como `expected_updated_at` no PATCH.** Nunca "last write wins" silencioso na UI — só as tools MCP mantêm esse comportamento por omissão do parâmetro (retrocompatibilidade deliberada, já documentada em `src/mcp/tools/update-task.ts:38`).

### Decisão 4 — O que fica FORA (ver seção própria abaixo)

### UI — Task (fases 1)

- **Card do board** (`src/web/client/tasks.ts`, função `cardHTML`): adicionar, além do drag-drop e botão concluir já existentes, um ícone/botão "editar prazo" e "editar prioridade" inline no próprio card (popover leve com `<input type="date">` + `<select>` de prioridade 1-4), disparando `POST /app/tasks/update` on-change. Não abre página nova — edição rápida sem sair do board.
- **Detalhe `/app/tasks/<id>`** (`src/web/notes.ts`, `handleTaskDetail`): trocar os `<span>` estáticos de status/prioridade/prazo (`metaBits`, `src/web/notes.ts:294-299`) por controles editáveis (`<select>` de status, `<select>` de prioridade, `<input type="date">`+hora de prazo — todos autosave). Título vira `<input>` editável com botão salvar. Corpo (`renderMarkdown(task.body,...)`) ganha modo "editar" que troca a renderização por um `<textarea>` com preview lado a lado (ou toggle), salvando via botão + `Ctrl+Enter`.

### UI — Nota (fase 2)

- **Detalhe `/app/notes/<id>`** (`src/web/notes.ts`, `handleNoteDetail`): título vira `<input>` editável (autosave no blur ou botão). Domínios e kind viram `<select>`/chips editáveis com autosave (reusar visual de `domains-chips` já existente na listagem `src/web/notes.ts:113-120` se fizer sentido). Tldr vira `<input>`/`<textarea>` curto com contador de caracteres (10-280, mesma validação de `update_note`). Corpo (markdown) ganha textarea com preview — reusar `renderMarkdown` do lado cliente OU reservar uma chamada leve ao servidor para preview (decidir na implementação; preferir preview client-side simples para não gerar round-trip a cada tecla).
- Nenhuma edição de nota no nível de listagem (`/app/notes`) nesta spec — só no detalhe.

### UI — Contato (fase 3, repo `expert-contacts`)

- Spec de **interface**: o Console (`src/web/detail.ts` + painel lateral que hoje só lê `EntityDetail`) ganha modo de edição para campos básicos de pessoa (nome, telefone, email, role, empresa-texto, aniversário, `last_contacted`) e `category` (select com o enum canônico `CONTACT_CATEGORIES`, mesmo conjunto de `save_person`: cliente, lead, lead-perdido, aluno, parceiro, fornecedor, equipe, familia, pessoal, network, outro). Implementação concreta acontece no working tree do `expert-contacts`, seguindo a seção 6 de `specs/README.md` (ler a spec aqui, implementar lá, validar com os comandos daquele repo).
- Fora desta spec: edição de empresa (`save_company`), edição de conexões (`connect`) — ver "Fora de escopo".

## Fora de escopo

- **Edição de edges na UI** (Brain: `link`/`delete_link`; Contacts: `connect`). Grafo de relações continua exclusivamente via MCP nesta spec — é uma superfície de risco maior (dedupe, direção, `why` obrigatório) que merece spec própria se o dono pedir.
- **Editor WYSIWYG pesado** (rich text, toolbar de formatação, Markdown-it configurável, drag de imagem inline no corpo). O editor de corpo desta spec é `<textarea>` markdown puro + preview, igual ao que já existe implicitamente em ferramentas de nota — nada de ProseMirror/TipTap/Lexical. Se o dono quiser WYSIWYG completo depois, é spec nova.
- **Criação de nota/task/contato pela UI.** Esta spec é só EDIÇÃO de registros existentes. Criar continua via MCP (`save_note`, `save_task`, `save_person`, `save_company`).
- **Edição de tags** na UI (tasks e notas têm `tags` editável via MCP hoje). Fora desta spec — tags têm semântica reservada (`dedupe:`) que exige cuidado extra; tratar em spec futura se necessário.
- **Edição de empresa** (`save_company`) e de campos avançados de contato (`attributes` JSON, `notes_text` semântico que dispara reembed) no Console — fica para spec futura de contacts, focar aqui só nos campos básicos + categoria listados.
- **Bulk edit** (editar várias tasks/notas de uma vez). Esta spec é edição unitária por registro.
- **Undo/histórico de versões.** Sem "desfazer" nem log de mudanças nesta spec — só a proteção de concorrência via `expected_updated_at`.

## Critérios de aceite

**Task (fase 1 — expert-brain):**
- [x] No board `/app/tasks`, é possível mudar prazo e prioridade de uma task direto no card, sem abrir o detalhe, e a mudança persiste (reload confirma).
- [x] Em `/app/tasks/<id>`, título, corpo, prazo, prioridade e status são editáveis; salvar cada campo grava via `POST /app/tasks/update`, que internamente chama `updateTask` de `src/db/queries.ts` (mesma função que `update_task` MCP usa) — nenhuma lógica de validação de data/patch duplicada no handler HTTP.
- [x] Editar uma task na UI enquanto o `updated_at` local está desatualizado (simulando edição concorrente via MCP) retorna `409` e a UI exibe aviso de conflito com opção de recarregar, sem sobrescrever silenciosamente.
- [x] `npm run typecheck` e `npm test` passam no `expert-brain` após a mudança.

**Nota (fase 2 — expert-brain):**
- [ ] Em `/app/notes/<id>`, título, corpo (com preview de markdown), tldr, domínios e kind são editáveis; salvar grava via `POST /app/notes/update`, que chama `updateNote` de `src/db/queries.ts` (função compartilhada com `update_note` MCP).
- [ ] `updateNote` em `src/db/queries.ts` aceita `expected_updated_at` opcional, seguindo o mesmo padrão de `updateTask` (retorno sentinela `'conflict'`), de forma retrocompatível (chamadas existentes sem o parâmetro continuam funcionando).
- [ ] Editar tldr, domínios ou kind pela UI dispara o mesmo fluxo de reembed (Workers AI + `refreshSimilarEdges`) que `update_note` MCP já dispara — via função compartilhada extraída, não reimplementada.
- [ ] Tentar editar uma nota com `kind='task'` pela rota `/app/notes/update` falha com erro claro (mesma regra de `update_note` MCP) — o editor de nota nunca edita task.
- [ ] `npm run typecheck` e `npm test` passam no `expert-brain` após a mudança.

**Contato (fase 3 — expert-contacts, spec de interface):**
- [x] No Console do `expert-contacts`, o painel de detalhe de uma pessoa permite editar nome, telefone, email, role, empresa (texto), aniversário, `last_contacted` e categoria, salvando via novo endpoint de sessão que reusa a lógica de `handleSaveEntity`/`updateEntityFields`. (`POST /app/entity/update` em `src/web/entity-update.ts`; `updateEntityFields`/`normalizeCategory`/`reembedEntity` extraídos p/ `src/entity-write.ts`, helpers de embedding p/ `src/embedding.ts`; painel editável em `src/web/client/detail.ts`.)
- [x] A validação de `category` no endpoint de sessão usa o MESMO enum `CONTACT_CATEGORIES` que `handleSaveEntity` já valida — sem lista duplicada. (`normalizeCategory` é a fonte única consumida pelo REST e pelo Console.)
- [x] Comandos de validação do `expert-contacts` (typecheck/testes conforme definidos naquele repo) passam após a mudança. (typecheck raiz+client OK; `npm test` 109/109; build de bundles OK. Concorrência otimista via `expected_updated_at`→409 implementada, provada no navegador: category persiste, phone concorrente 409 sem sobrescrever.)

**Geral:**
- [x] Nenhum endpoint novo introduz `onclick`/`onchange` inline em HTML — todo wiring respeita a CSP `script-src 'self'` existente (listeners em bundle client, padrão de `src/web/client/note-media.ts`). (Fase 3: edição inline de contato via `createElement`+`addEventListener` no `detail.bundle.js`, zero JS inline; provado no navegador sem violação de CSP.)
- [x] Nenhuma spec, commit ou código novo contém telefone, e-mail pessoal, nome de cliente real ou credencial (regra anti-vazamento de `specs/README.md` seção 4). (Fase 3: testes usam `owner@example.com` + telefones fictícios `5511900000001`; credenciais só em `.dev.vars` gitignorado, removido pós-validação.)

## Validação

```bash
# expert-brain (fases 1 e 2)
cd C:/repos/expert-brain
npm run typecheck
npm test
```

```bash
# expert-contacts (fase 3) — comandos exatos a confirmar lendo package.json daquele repo
cd C:/repos/expert-contacts
npx tsc --noEmit
```

Teste manual (fase 1): abrir `/app/tasks`, arrastar uma task de coluna (já funciona hoje — não deve quebrar), editar prazo direto no card, confirmar no reload. Abrir o detalhe da mesma task, editar título e corpo, salvar, confirmar via `get_task`/`list_tasks` (MCP) que o agente vê a mudança.

Teste manual (fase 2): abrir `/app/notes/<id>` de uma nota de teste, editar tldr e domínios, confirmar que `recall` (MCP) reflete a nova posição semântica após a latência de indexação documentada em `update_note` (~1-2 min).

Teste manual (fase 3): abrir o Console do `expert-contacts`, editar telefone/categoria de um contato de teste, confirmar via `get_contact`/`recall` (MCP) que a mudança persistiu.

**Gate de deploy:** implementar e commitar localmente é livre nas duas fases/repos; `wrangler deploy` (ambos os Workers) só com OK explícito do dono da instância, dado na sessão de execução — conforme protocolo de `specs/README.md`.

## Arquivos afetados

**expert-brain:**
- `src/web/tasks.ts` — novo handler `handleTaskUpdatePost` (`POST /app/tasks/update`); ajustes em `handleTaskDetail`/`TASK_DETAIL_CSS` (via `src/web/notes.ts`, ver abaixo) não se aplicam aqui, mas o roteamento novo entra em `src/web/handler.ts`.
- `src/web/notes.ts` — `handleTaskDetail` (controles editáveis de status/prioridade/prazo/título/corpo), `handleNoteDetail` (controles editáveis de título/corpo/tldr/domínios/kind), novo handler `handleNoteUpdatePost` (`POST /app/notes/update`).
- `src/web/handler.ts` — registrar as duas rotas novas (`POST /app/tasks/update`, `POST /app/notes/update`).
- `src/web/client/tasks.ts` — edição inline de prazo/prioridade no card do board.
- `src/web/client/notes.ts` (ou novo `src/web/client/note-edit.ts`) — wiring de edição no detalhe de nota.
- Novo bundle client para edição de task detail (extensão de `src/web/client/note-media.ts` ou arquivo novo `src/web/client/task-edit.ts`) — decidir na implementação evitando inflar `note-media.ts` com responsabilidade alheia.
- `src/db/queries.ts` — adicionar `expected_updated_at` opcional a `updateNote`; extrair bloco de reembed de `src/mcp/tools/update-note.ts` para função compartilhada reutilizável pelo novo endpoint HTTP.
- `src/mcp/tools/update-note.ts` — ajustar para chamar a função de reembed extraída (sem duplicar lógica).

**expert-contacts:**
- `src/web/detail.ts` (ou novo `src/web/entity-update.ts`) — novo handler de `POST /app/entity/update`.
- `src/web/handler.ts` — registrar a rota nova.
- `src/index.ts` — extrair o corpo `UPDATE ... COALESCE` de `handleSaveEntity` para função compartilhada (ex. em `src/vaults/contacts.ts`).
- `src/vaults/contacts.ts` — nova função `updateEntityFields` (ou nome equivalente) reusada por API e Console.
- Console frontend (arquivo(s) de painel de detalhe — confirmar path exato lendo o restante de `src/web/` daquele repo antes de implementar, ex. `layout.ts`/`console-page.ts`).

## Riscos e reversão

- **Risco:** duplicar validação entre endpoint de sessão e tool MCP, gerando comportamento divergente (ex. UI aceita um domínio que o MCP rejeitaria). Mitigação: a spec EXIGE reuso das mesmas funções de `src/db/queries.ts`/`src/vaults/contacts.ts` — nenhum handler HTTP novo reimplementa parse/validação; critérios de aceite verificam isso explicitamente.
- **Risco:** adicionar `expected_updated_at` a `updateNote` quebra chamadas existentes. Mitigação: parâmetro opcional, comportamento idêntico ao atual quando omitido (retrocompatível) — mesmo padrão já validado em `updateTask`.
- **Risco:** autosave de campos estruturados gerar tempestade de requests (ex. usuário arrastando um slider de prioridade). Mitigação: campos de task/nota são `<select>`/`<input type="date">` (eventos discretos `change`, não `input` contínuo) — sem debounce necessário para esses; só o corpo de texto livre tem debounce visual e salva só no blur/botão.
- **Risco:** CSP quebra por script inline esquecido. Mitigação: todo wiring novo segue o padrão de bundle client já estabelecido (`data-*` attributes + listener em módulo separado, nunca `onclick=`), igual ao botão "✓ concluir" existente (`src/web/client/note-media.ts:146-168`).
- **Reversão:** cada fase é reversível independentemente — `git revert` dos commits da fase específica remove os endpoints novos e os controles de UI, voltando o detalhe de nota/task/contato ao estado read-only atual. Nenhuma migração de schema destrutiva está prevista (só a extensão opcional de assinatura de `updateNote` e, possivelmente, checagem de coluna `updated_at` já existente em `entities`) — reversão de código não deixa dado inconsistente.
