# Contacts: timeline completa de interações com paginação e registro manual pelo console

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** ambos (`expert-contacts` + proxy no `expert-brain`)
> **Depende de:** nenhuma bloqueante (a UI final mora na página da spec `50-console-v2/56`; até ela existir, a seção renderiza no detalhe atual). Integração automática WhatsApp↔contatos permanece na `30-features/35` (interface), fora daqui.
> **Agente sugerido:** Sonnet

## Contexto

- A base de eventos JÁ existe no contacts: tabela `events` (`entity_id`, `kind`, `ts`, `context`, `source` — `src/db/migrate.ts:119-132`), kinds canônicos `met, talked, saw_post, recommended, birthday_reminder, note, mentioned_in_brain` e sources `manual, whatsapp, brain_bridge, pipedrive` (`src/canon.ts:34-38`).
- Escrita: `handleEvent` (`src/index.ts:392-416`) valida os enums, insere e — quando `kind ∈ {met,talked,note}` — atualiza `entities.last_contacted` (`index.ts:412-414`). Exposta via REST `POST /event` e via MCP `log_event` (`mcp/index.js:149-162`).
- Leitura: o detalhe (`fetchEntity`, `src/vaults/contacts.ts:463-465`) traz APENAS os últimos 10 (`ORDER BY ts DESC LIMIT 10`), sem paginação e sem endpoint dedicado.
- O console web (`/app/*`) não tem NENHUMA forma de registrar interação — só leitura; escrever exige MCP ou REST com `OWNER_TOKEN`.
- Proxy do Brain: Bearer `CONTACTS_PROXY_TOKEN` é **read-only por design** (allowlist GET em `src/web/handler.ts:94-101` do contacts; reforçado pela spec `10-backend/24`). O console do Brain (onde a página da spec 56 vive) precisa de um caminho de ESCRITA pra registrar interação sem quebrar esse design.

## Problema / Motivação

- "Quando falei com essa pessoa pela última vez, e sobre o quê?" — a resposta existe no banco mas trava em 10 itens sem paginação (`contacts.ts:463-465`); histórico longo é inacessível na UI.
- Registrar um almoço/call/encontro exige abrir o agente MCP — fricção que mata o hábito; o dono quer registrar na hora, pela página do contato.
- Os kinds atuais não distinguem reunião formal, e-mail e mensagem — categorias que o dono usa pra ler a relação.

## Design proposto

### 1. Kinds novos (aditivo, sem migration)

`EVENT_KINDS` em `src/canon.ts:34-36` ganha `meeting`, `email`, `message` (não há CHECK no banco — validação é de aplicação; `handleEvent` passa a aceitar automaticamente). `meeting` entra no conjunto que atualiza `last_contacted` (junto de `met, talked, note`). Labels de exibição PT-BR na UI: met=Encontro, talked=Conversa, meeting=Reunião, email=E-mail, message=Mensagem, note=Nota, saw_post=Vi post, recommended=Indicação, birthday_reminder=Aniversário, mentioned_in_brain=Citado no Brain. Atualizar a descrição da tool `log_event` (`mcp/index.js:149-162`).

### 2. Endpoint paginado de leitura: `GET /app/entity/events?id=<id>&offset=0&limit=30`

No contacts (`src/web/` — handler novo `events.ts` ou dentro do detail):

- `SELECT ... FROM events WHERE entity_id=? ORDER BY ts DESC LIMIT ? OFFSET ?` + `total` (COUNT) na resposta: `{ total, events: [{id, kind, ts, context, source}] }`. `limit` cap 100.
- Acessível por sessão E por Bearer read-only (adicionar à allowlist `handler.ts:94-101`).
- Proxy no Brain: `handleContactsEvents` via `proxyToContacts(req, env, '/app/entity/events')` + rota `GET /app/contacts/entity/events` (mesmo padrão de `expert-brain/src/web/contacts-data.ts:44-55`).
- `fetchEntity` continua trazendo os 10 recentes (payload do painel do grafo fica leve); a página/timeline usa o endpoint paginado.

### 3. Registro manual pelo console (o caminho de escrita)

**No console standalone do contacts** (sessão de cookie): `POST /app/entity/event { entity_id, kind, context?, ts? }` → reusar o CORE de `handleEvent` — extrair a lógica (validação + insert + last_contacted) pra função compartilhada `recordEvent(env, input)` em módulo próprio (ex.: `src/events.ts`), chamada pelo REST atual E pelo endpoint novo (mesmo padrão da extração `reembedEntity` em `src/entity-write.ts:1-12`).

**No console do Brain** (onde a página da spec 56 mora): `POST /app/contacts/entity/event` (sessão do Brain) → o Brain repassa pro contacts via service binding com um token de ESCRITA novo e escopado:

- Secret novo `CONTACTS_WRITE_TOKEN` nos DOIS workers (gerar com `openssl rand`; documentar em `wrangler.example.toml` dos dois repos como placeholder).
- No contacts: aceito SOMENTE numa allowlist explícita de escrita — nesta spec, exatamente 1 path: `POST /app/entity/event`. Comparação em tempo constante (mesmo helper do proxy token, `handler.ts:44-54`). O `CONTACTS_PROXY_TOKEN` (read-only) NÃO ganha poder novo.
- Desenho consistente com a spec `10-backend/24` (allowlist de paths por token) — citar esta seção lá quando a 24 executar.

### 4. UI da timeline (na página da spec 56; fallback: detalhe atual)

- Lista vertical: ícone/chip por kind (labels PT acima), data/hora BRT, `context`, badge do `source` quando ≠ manual.
- Botão **"Registrar interação"** → mini-form (select de kind — só os manuais: met/talked/meeting/email/message/note —, textarea de contexto ≤2000, data/hora opcional default agora) → POST acima → prepend otimista na lista.
- **"Carregar mais"** enquanto `offset+limit < total`.

## Fora de escopo

- Ingestão automática de interações (WhatsApp/e-mail/CRM) — specs `30-features/35` e `40-ops/45`/cron.
- Editar/excluir evento (registro é append-only nesta fase; correção = novo evento `note`).
- Timeline agregada global ("todas as interações de todos os contatos").
- Notificações/lembretes derivados (ex.: follow-up) — vizinho da `40-ops/46`.
- Observações no embedding/busca semântica — spec `50-console-v2/60` (usa o `recordEvent` extraído aqui).
- Evento privado (flag + filtro no endpoint paginado) — spec `50-console-v2/61`.

## Critérios de aceite

- [x] Endpoint paginado retorna `total` correto e pagina estável (fixture com 75 eventos: 3 páginas de 30/30/15, sem duplicar item entre páginas). Teste: `expert-contacts/test/events.test.ts`.
- [x] `log_event` MCP aceita `meeting`/`email`/`message`; `meeting` atualiza `last_contacted`, `email`/`message` NÃO (mesma regra do `saw_post`). Descrição da tool atualizada (`mcp/index.js`); enum via `mcp/canon.mjs` (anti-drift). Teste: `expert-contacts/test/events.test.ts`.
- [x] Registrar interação pelo console standalone (sessão) e pela página no Brain (rota proxy de escrita) grava evento idêntico ao REST `POST /event` — incluindo atualização de `last_contacted` (função compartilhada, teste triplo nos 3 call-sites). Teste: `expert-contacts/test/events.test.ts` (describe "recordEvent compartilhado").
- [x] `CONTACTS_WRITE_TOKEN`: autoriza SÓ `POST /app/entity/event`; em qualquer outro path retorna 401; `CONTACTS_PROXY_TOKEN` em path de escrita → 401 (teste explícito de não-regressão do design read-only). Teste: `expert-contacts/test/events.test.ts` (describe "Matriz de auth").
- [x] Timeline renderiza kinds com labels PT, datas em BRT, "Carregar mais" funciona até esgotar. Implementado nos dois clients (`expert-contacts/src/web/client/detail.ts` e `expert-brain/src/web/client/graph.ts`, painel de contato — página própria da spec 56 ainda não existe, então a timeline vive no detalhe/painel atual conforme previsto no Design §4). Validação automática cobre a paginação subjacente; QA manual interativa (`wrangler dev` + clique) NÃO foi executada nesta sessão (ambiente não-interativo, sem browser).
- [x] Evento com kind inválido → 400 com lista dos válidos (mensagem honesta). Teste: `expert-contacts/test/events.test.ts` + `expert-contacts/test/write-path.test.ts` (regressão do REST).

## Validação

- Contacts: `npx tsc --noEmit` + `npm test`; Brain: `npm run typecheck` + `npm test` — verdes.
- Testes novos: paginação, kinds novos + regra last_contacted, `recordEvent` compartilhado, matriz de auth dos dois tokens, proxy de escrita do Brain.
- Manual (`wrangler dev` nos dois): registrar reunião pela página, ver na timeline, conferir `last_contacted` no detalhe.
- **Gate de deploy:** os DOIS workers + o secret novo em produção SÓ com OK explícito do dono da instância (setar via `wrangler secret put CONTACTS_WRITE_TOKEN` nos dois).

## Arquivos afetados

- expert-contacts: `src/canon.ts` (kinds), `src/events.ts` (novo, `recordEvent`), `src/index.ts` (REST usa o core), `src/web/handler.ts` (rotas + allowlists dos 2 tokens), `src/web/` (endpoint events + POST), `mcp/index.js` (descrição log_event), `wrangler.example.toml`, `test/`
- expert-brain: `src/web/contacts-data.ts` (proxy GET events + POST event com write token), `src/web/handler.ts` (rotas), `wrangler.example.toml`, client da página 56 (seção timeline), `test/`

## Riscos e reversão

- **Risco**: caminho de escrita virar porta pra mais writes "por conveniência". Mitigação: allowlist de 1 path é REGRA desta spec; ampliar exige spec nova (anotar em comentário no handler).
- **Risco**: duplicidade de eventos por double-submit no form. Mitigação: botão desabilita no submit + janela de dedupe leve (mesmo entity+kind+context em <5s → ignora).
- **Reversão**: revert dos commits; kinds novos já gravados continuam válidos (strings livres no banco, labels caem no fallback do slug).
