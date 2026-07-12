# Spec 91 — Presets de credencial + visibilidade assigned-only (modelo de permissão multi-robô)

> Grupo 80-frota-agentes. Status: implementado 12/07/2026 (fases 0-3, commits
> 2c6ab97 → c266294) + deltas 4-5 da verificação adversarial pós-implementação
> (mailbox gated + leitura de menções), aguardando deploy.

## Problema

Uma pessoa quer conectar VÁRIOS robôs ao próprio Brain, cada um com um nível de
confiança diferente: o robô central da empresa (VPS compartilhada) deve ver SÓ as
tasks atribuídas a ele — nem notas do segundo cérebro, nem contatos; o robô pessoal
tem confiança média; os dispositivos do dono, confiança total. Antes desta spec o
Brain tinha 2 níveis (credencial com/sem escopo `private`): qualquer PAT `full`
lia e EDITAVA qualquer task não-privada, lia todas as notas e contatos.

A proposta original era uma matriz CRUD por recurso (recurso × verbo × sensibilidade
≈ 28 toggles por credencial). REJEITADA de propósito: ninguém configura 28 botões
certo, e o erro de configuração VIRA o vazamento; a matriz crua ainda tem células
sem sentido ("editar privada sem ler privada") e delete de task nem existe no MCP.
Padrão da indústria: papéis nomeados por cima de um motor de escopos.

## Desenho: 3 eixos ortogonais, presets na UI, CSV no motor — ZERO migration

`api_keys.scopes` continua TEXT CSV. Gramática:

```
<full|read>[,private][,notes:none][,contacts:none][,tasks:assigned]
```

1. **CAPACIDADE** — `full` | `read` (pré-existente, intocado; "editar⇒ler" por construção).
2. **SUPERFÍCIE** — tokens SUBTRATIVOS que removem famílias de tools no REGISTRO:
   `notes:none`, `contacts:none`. Ausente = tudo (retrocompatível por definição:
   `hasScope(undefined, 'notes:none') === false`).
3. **VISIBILIDADE** — `private` (aditivo, pré-existente) + `tasks:assigned`
   (subtrativo, novo): row-level, só linhas atribuídas/mencionadas/criadas.

Vocabulário fechado em `KNOWN_SCOPE_TOKENS` + `validateScopesCsv` (api-keys.ts).
Toda chave existente e o OAuth do dono seguem bit a bit idênticos — sem migration D1.

### Presets (`src/auth/presets.ts` — únicos escritores dos tokens novos)

| Preset | CSV | Tools registradas |
|---|---|---|
| `personal-full` Dispositivo pessoal total | `full,private` | 36 |
| `personal` Dispositivo pessoal | `full` | 36 (sem rows privadas) |
| `reader` Leitor | `read` | 14 read-only |
| `fleet-worker` Robô de frota | `full,notes:none,contacts:none` | 13: tasks(8) + share(2) + mailbox(2) + users(1) |
| `task-worker` Robô colaborador | `full,notes:none,contacts:none,tasks:assigned` | 11: tasks(8) + mailbox(2) + users(1) |

Robô de frota vê todas as tasks não-privadas (pull da fila available); robô
colaborador SÓ as dele — é o caso da VPS compartilhada. `presetForScopes` faz o
reverse-map CSV→preset por conjunto normalizado (badge na listagem + campo
`preset` no `/api/whoami`; CSV fora dos presets = "Personalizado"/null).

## Enforcement em 2 camadas

### (a) Registro — `scopeGuard` (registry.ts)

O `readOnlyGuard` virou `scopeGuard(server, scopes)`: cada uma das 36 tools declara
`annotations.resource` (`notes` | `notes.media` | `tasks` | `tasks.share` |
`contacts` | `mailbox` | `users`); tool de resource suprimido NEM APARECE no
tools/list (invisível, não "erro 403" — tool presente-mas-vazia queima contexto e
induz retry). **Tool nova SEM annotation = suprimida fail-closed pra credencial
restrita** (console.warn) — o snapshot literal em `test/registry-scope.test.ts`
quebra o build se alguém esquecer o resource. Regra do `read` preservada byte a byte.
`share_task`/`unshare_task` são `tasks.share`: suprimidas sob `tasks:assigned`
(link público = exfiltração).

### (b) Call-time — `TaskVisibility` + `taskVisFilter` (row-level)

`src/auth/visibility.ts` unificou as 3 definições duplicadas de canSeePrivate
(helpers.ts virou wrapper; media.ts deletou a cópia; mailbox-api.ts usa o núcleo).
`TaskVisibility {includePrivate, assignedOnlyUserId}` substituiu o boolean
`includePrivate` SEM default — o compilador forçou cada call-site a declarar
intenção (dono/board/cron/push/web = `OWNER_TASK_VIS`; superfícies bearer legadas =
`taskVisPublic(bool)`).

`taskVisFilter(vis, p)` gera o predicado SQL de 3 ramos (EXISTS na PK — não Set em
memória: get_task por id precisa de gate POR LINHA e o LIMIT 500 quebraria filtro
pós-query):

```sql
atribuída a mim (task_assignees)
OR mencionado pra mim (mailbox_items kind='mention')
OR created_by IN (chaves do meu user)      -- api_keys.user_id UNION users.api_key_id
```

- Menção CONCEDE visibilidade (senão o mailbox entregaria item de task ilegível =
  beco); SÓ o kind `mention` concede ⇒ **desatribuir REVOGA** (itens `assignment`
  históricos não re-concedem).
- `created_by` ⇒ o robô não perde de vista a task `[pedido]` que criou pro dono.
  O vínculo PAT↔user existe nas DUAS direções do schema (`api_keys.user_id` e a
  legada `users.api_key_id` — espelho do `getUserByApiKeyId`), o IN cobre ambas.
- **Mailbox PRECISA do mesmo gate** (a premissa original "todo item endereçado a
  mim referencia task visível" era FALSA — achado da auditoria adversarial, ver
  delta 4): desatribuir remove a linha de `task_assignees` mas NADA apaga
  `mailbox_items`, então os itens `assignment`/`comment_on_assigned` órfãos
  entregariam título AO VIVO + corpo de comentário de task revogada, e o unread
  viraria oráculo de existência. `listMailboxItems`/`countMailboxUnread`/
  `ackMailboxItems` recebem a `TaskVisibility` do caller e aplicam `taskVisFilter`
  no JOIN com notes — cobre check_mailbox, ack_mailbox e as rotas bearer
  `/api/mailbox/summary` e `/api/mailbox/wait`. Item `mention` continua visível
  por construção (a própria linha satisfaz o ramo mention do predicado).

Aplicado nas **8 funções base** de queries.ts: getTaskById, listActiveTasks,
listRecentClosedTasks, listTasksDueBefore, ftsSearchTasks, listTasksAwaitingOwner,
**findActiveTaskByTag** (dedupe_key vazaria task invisível) e
**findSimilarActiveTasksByTitle** (possible_duplicates vazaria títulos).

`resolveTaskVis(env, auth)` (user-ref.ts), resolvido POR CHAMADA, fail-closed:
`tasks:assigned` sem user vinculado = erro instrutivo apontando /app/config —
nunca vê-tudo nem vazio silencioso.

### Escrita reusa a visibilidade (anti-oráculo)

update_task (AMBOS os caminhos — field-edit e sem-field-edit), complete_task,
comment_task, claim_task e get_task pré-leem com a vis do CALLER; task invisível =
**MESMO "not found" de inexistente** (byte-idêntico, só o id ecoado muda — nada
denuncia existência, privacidade ou atribuição). Re-leituras INTERNAS pós-gate
(conflict 409, pós-setTaskPrivate, moveTaskToColumn) usam OWNER_TASK_VIS. De
carona: bug do comment_task morto (a pré-leitura era public-only até pro dono —
dono não comentava task privada via MCP).

**Reatribuição proibida** sob `tasks:assigned`: a única mudança de assignee
permitida é REMOVER A SI MESMO (sem adições; remoções ⊆ {eu}). Checado ANTES de
qualquer escrita e DEPOIS do gate de visibilidade (anti-oráculo + zero escrita
parcial). Fecha a escalada da auditoria: PAT restrito se auto-atribuindo em
qualquer task cujo id descobrisse (e removendo os outros).

### save_task sob restrição

- `origin_note_id` REJEITADO sob `notes:none` (é oráculo de nota + a task herdaria
  mentions de nota ilegível) — antes de qualquer leitura/escrita.
- `mentions` REJEITADAS sob `contacts:none` (entity ids vêm do vault de Contacts);
  idem `mentions`/`mentions_remove` no update_task.
- `assignees` a TERCEIROS permitido (é o fluxo `[pedido]` da frota). Risco de
  injeção de conteúdo aceito — o protocolo da frota (spec 84) trata board como
  DADO, não instrução.
- Dedupe/duplicates com a vis do caller: `dedupe_key` colidindo com task invisível
  CRIA NOVA sem ecoar a existente; `possible_duplicates` não ecoa títulos invisíveis.

## Decisões de borda

- **Claim da fila available**: robô colaborador NÃO (não vê ⇒ não claima, zero
  código; quem precisa de pull usa fleet-worker).
- **Mídia**: fora dos robôs — resource `notes.media` no registro + **403 nas rotas
  HTTP** `/app/notes/:id/media` pra PAT `notes:none` (media.ts authReq).
- **stats/digest/recall/inbox**: suprimidos no registro pros robôs.
- **list_users sem `bio`** sob `notes:none` (bio vaza estrutura organizacional).
- **Editar escopo de chave existente**: NÃO — revogar+recriar (mesmo racional do
  orphan-only da spec 87).

## Deltas da auditoria adversarial

1. **Gate kind='task' no share** — implementado NA FRONTEIRA DA TOOL, não no
   createShare como o plano original dizia: share_task/unshare_task pré-checam
   `getTaskById(id, vis)` (filtra kind='task' + visibilidade do caller) ANTES de
   tocar o share. **Desvio documentado**: `createShare` segue aceitando nota de
   conhecimento DE PROPÓSITO — o handler web `/app/notes/share` (spec 33) usa o
   mesmo trilho `/s/` pra compartilhar NOTAS pela UI logada. Bônus anti-oráculo: o
   erro de share em task privada pra caller sem escopo virou o "not found" genérico
   (antes vazava "is PRIVATE" = existência + status).
2. **Throttle no push de `[bloqueio]`**: KV GRAPH_CACHE, 1 push/30min por
   (credencial, task) — mata o spam no celular do dono; falha de KV não derruba o
   comentário (try/catch, o push é best-effort).
3. **list_users omite bio** pra credencial `notes:none`.
4. **Mailbox gated pela TaskVisibility do caller** (achado P1 da rodada de
   verificação PÓS-implementação, workflow adversarial de 12/07): check_mailbox,
   ack_mailbox e as rotas bearer `/api/mailbox/*` aplicavam só `private = 0` e
   vazavam itens órfãos de desatribuição (título ao vivo + corpo de comentário +
   unread como oráculo). Fix: `taskVisFilter` nas 3 funções de leitura/ack do
   mailbox (ver seção do predicado). O ack também é gated — `acked` contando item
   ilegível denunciaria existência.
5. **Leitura de menções gated sob `contacts:none`** (mesma rodada): a escrita já
   era rejeitada, mas o get_task ecoava `mentions` (entity ids + labels do vault
   de Contacts) de task visível. Fix em 3 pontos: get_task devolve `mentions: []`
   sempre (shape estável sem oráculo); o filtro `mentions_entity` do list_tasks é
   REJEITADO (sondar "task X menciona o contato Y?" é oráculo de associação —
   paridade com o write-side); get_note também devolve `[]` por defesa em
   profundidade (os presets nunca registram get_note com `contacts:none` — o
   `notes:none` acompanha —, mas um CSV custom pode desacoplar os tokens e o gate
   não pode depender do registro).

## Riscos residuais ACEITOS (documentados, fora de escopo)

- **Signed-URL de mídia fura o gate de privada** — bug pré-existente à spec,
  hardening à parte.
- **Polaridade subtrativa**: CSV corrompido/vazio colapsa em full (`scopes ?? 'full'`).
  Mutação de scopes só existe via sessão do dono; corromper exige acesso ao DB, que
  derrota qualquer esquema. Mitigação: presets são os únicos escritores por UI.
- **Caveat de ROLLBACK**: versão antiga do Worker IGNORA os tokens novos — rollback
  pra pré-91 exige REVOGAR as chaves restritas antes, senão elas viram full.
- **update_task private:true em task própria** (griefing menor, auto-contido).
- **Granularidade de contatos** = Worker expert-contacts (outro repo); `contacts:none`
  já resolve deste lado (as 4 tools de contato daqui são proxies read-only).

## Verificação

- `test/registry-scope.test.ts` (17): snapshot LITERAL das tools por preset
  (36/36/14/13/11), vocabulário, scopeGuard fail-closed pra tool sem resource.
- `test/db/task-visibility.test.ts` (13): os 3 ramos do predicado nas 8 funções,
  composição com private, mention concede / desatribuir revoga / assignment não
  re-concede, dual-link do created_by.
- `test/tools/assigned-only.test.ts` (17): E2E do robô colaborador — anti-oráculo
  byte-idêntico em leitura E escrita, nada persiste em tentativa bloqueada, ciclo
  completo na task atribuída, reatribuição proibida (remover-se permitido), dedupe
  sem eco, rejeições por token, PAT sem vínculo = erro instrutivo; deltas 4-5:
  desatribuir revoga o mailbox (título renomeado não vaza), mention segue visível
  e ackável, ack up_to ignora item invisível (acked=0, linha intocada no DB),
  get_task sem eco de menções e mentions_entity rejeitado sob contacts:none.
- `test/mailbox-summary.test.ts` (+1): rota bearer sob tasks:assigned — item órfão
  fora do summary, mention concede. `test/tools/mentions.test.ts` (+1): get_note
  com CSV custom `full,contacts:none` devolve mentions [].
- `test/config-ux-keys.test.ts` (+7): preset grava CSV canônico, custom/desconhecido
  caem no legado, retrocompat do POST antigo, select no SSR, badge, whoami.preset.
- Suite completa 1307+ verde ao fim de cada fase (fases 0-3).
