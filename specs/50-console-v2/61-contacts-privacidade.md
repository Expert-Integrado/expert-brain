# Contacts: privacidade — entidade e evento privados, fail-closed no proxy e escopo propagado pelo Brain

> **Status:** ready · **Prioridade:** P1 · **Esforço:** L · **Repo:** ambos (expert-contacts + expert-brain)
> **Depende de:** `10-backend/17` (AuthContext propagado) **e** `30-features/31` (helper `hasScope`, formato CSV de scopes e o escopo `private` com checkbox na UI de PAT — tudo nasce lá). Rodar DEPOIS da onda C2 (`55`/`56`/`57` criam os endpoints que esta spec gateia) e junto/depois da `60` (o filtro de embedding referencia a coluna criada aqui).
> **Agente sugerido:** Opus (superfície de segurança cross-repo)

## Contexto

- **Auth do contacts** (`src/index.ts:69-76`): Bearer `OWNER_TOKEN` = acesso total (REST + MCP local do dono); Bearer `CONTACTS_PROXY_TOKEN` = **somente GET** (usado pelo Brain via service binding pro grafo/detalhe — comentários em `src/index.ts:72-75,671,699`). Console standalone usa sessão de cookie.
- **Superfícies servidas ao proxy** (todas GET): `/app/graph/data|meta`, `/app/entity` — e, após a C2, `/app/entity/neighbors` (`56`) e `/app/entity/events` (`57`).
- **No Brain**, as 4 tools read-only de contatos (`src/mcp/tools/contacts.ts:35-97`) são expostas a QUALQUER credencial válida do Brain; a spec `10-backend/17` cria `AuthContext.scopes` propagado ao registry, e a `30-features/31` define o escopo `private` (CSV) com `hasScope()` — hoje usados só pra notas.
- Schema contacts: `entities` (sem coluna de visibilidade), `events` (`id, entity_id, kind, ts, context, source`). Migrations runtime no array `MIGRATIONS` de `src/db/migrate.ts` (última `0004`; `0005` é o indicativo da `55` — usar o próximo livre; regra transversal da Fase 5).
- Embedding: entidades têm vetor no Vectorize; a `60` adiciona observações (events `kind='note'`) ao texto do vetor.

## Problema / Motivação

- **Qualquer credencial do Brain lê a agenda inteira.** Um PAT criado pra um agente de nicho (só `recall` de conteúdo) também lista/busca TODOS os contatos via as tools proxy — incluindo relações sensíveis (candidatos, negociações, contatos pessoais).
- O dono quer marcar contato como privado ("só eu vejo") e também observação privada num contato público (ex.: avaliação sensível sobre uma pessoa da rede) — hoje não existe nenhum eixo de visibilidade no contacts.
- As superfícies novas da C2 (página própria, timeline, vizinhos) multiplicam os read paths — gatear DEPOIS de existirem, num passo único, evita spec-drift.

## Design proposto

### 1. Migration `0006_privacy` (aditiva, em `src/db/migrate.ts` — número indicativo)

```sql
ALTER TABLE entities ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events   ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_entities_private ON entities(private) WHERE private = 1;
CREATE INDEX IF NOT EXISTS idx_events_private   ON events(private)   WHERE private = 1;
```

DEFAULT 0 = tudo continua público; zero mudança de comportamento até o dono marcar.

### 2. Modelo de confiança: quem vê o quê

| Credencial | Vê privados? |
|---|---|
| Sessão do console contacts (dono) | SIM — badge `🔒` em tudo |
| `OWNER_TOKEN` (REST/MCP local do dono) | SIM (é o dono; documentar no comentário do `requireAuth`) |
| `CONTACTS_PROXY_TOKEN` SEM header | **NÃO** (fail-closed) |
| `CONTACTS_PROXY_TOKEN` + header `X-Include-Private: 1` | SIM |

O header é a forma de o **Brain propagar o escopo do SEU caller** downstream: o segredo continua sendo o token (quem tem o token já podia ler tudo hoje); o header é auto-restrição do Brain por request — protege contra os CALLERS do Brain (PATs sem escopo), não contra vazamento do token em si. Honrado APENAS quando o Bearer é o proxy token válido; em qualquer outro caso é ignorado.

### 3. Lado Brain: propagação do escopo

- `proxyToContacts` (helper do Brain) ganha `includePrivate: boolean` → seta o header.
- Call sites: rotas web do console Brain (protegidas por `requireSession` = dono) → `true`. Tools MCP de contatos (`src/mcp/tools/contacts.ts`) → `hasScope(auth.scopes, 'private')` com o `auth` propagado pela 17 (mesma regra da 31: sessão OAuth do dono = `true`; PAT precisa do escopo CSV `private`).
- O grafo do console Brain (camada de contatos) é rota de sessão → dono continua vendo o grafo COMPLETO, com marcação visual de privado nos nós.

### 4. Lado contacts: filtro em TODOS os read paths GET

Helper único `callerSeesPrivate(req, env): boolean` (sessão OU owner token OU proxy+header) e, quando `false`:

- `/app/graph/data|meta`: nós com `private = 1` fora do payload; conexões explícitas e `similar_edges` (da `10-backend/21`) com QUALQUER ponta privada fora.
- `/app/entity` / `fetchEntity` (`src/vaults/contacts.ts:449-537`): entidade privada → mesmo 404 de inexistente (não vazar que existe); em entidade pública, `events` do payload filtram `private = 0` e conexões omitem vizinho privado.
- `/app/entity/neighbors` (da `56`): seeds e resultados excluem privados (1º e 2º nível — nó privado não serve nem de `via`).
- `/app/entity/events` (da `57`): `AND private = 0`; o `total` da paginação conta só visíveis.
- REST GET (`/entities/:id`, search, list — `src/index.ts:233-257,332,554`): mesmo helper (OWNER_TOKEN passa; proxy sem header filtra).
- Busca LIKE e o EXISTS de observações (da `60`): `AND ev.private = 0` quando o caller não vê privados.

### 5. Embedding e Vectorize

- **Entidade privada PERMANECE no Vectorize** (o recall do dono precisa achá-la); a proteção é na hidratação D1 dos read paths (item 4) — mesmo padrão da 31 no Brain ("o vetor só devolve ids; o D1 é a fonte de verdade").
- **Event privado NUNCA entra no texto de embedding**: o helper de observações da `60` ganha `AND private = 0` incondicional (observação privada é invisível até pra busca semântica do dono — trade-off aceito e documentado: confidencialidade > recall).
- **Marcar event como privado DISPARA `reembedEntity`** (via `ctx.waitUntil`, mesmo padrão do gatilho da `60`): sem isso, o texto da observação continua dentro do vetor antigo e a entidade seguiria "achável" por termo privado (vazamento por inferência). O mesmo vale pro caminho inverso (despublicar via UI). Marcar a ENTIDADE privada não reembeda (o filtro é na hidratação D1).

### 6. Escrita da flag

- MCP/REST: `save_person`/`save_company`/upsert aceitam `private: true` na criação/update (one-way — `private: false` via API → erro orientando pra UI, espelho da 31). `log_event`/`recordEvent` aceitam `private: true` no evento.
- Console (sessão): toggle "Contato privado" no detalhe/página da entidade (`POST /app/entity/private { id, private }`, `requireSession` APENAS — único lugar que desmarca) + checkbox "privada" no form "Registrar interação" da `57`; eventos privados listam com `🔒` na timeline do dono.
- Marcar entidade privada NÃO mexe nos events dela (a entidade inteira já some pra quem não vê).

## Fora de escopo

- Privacidade por CAMPO (canal/telefone individual — a `55` herda a visibilidade da entidade).
- Criptografia at-rest, auditoria de marcação, TTL de privacidade.
- Escopo novo no contacts além do modelo header (não criar segundo token).
- Compartilhamento público de contato (não existe e continua não existindo).

## Critérios de aceite

- [ ] Migration aplicada: contagens intactas, tudo `private = 0`, comportamento idêntico ao atual.
- [ ] Proxy SEM header: grafo sem nós/arestas privados; `/app/entity` de privada = 404 padrão; timeline/eventos/neighbors sem itens privados; search/list REST idem. **Um teste por superfície.**
- [ ] Proxy COM header e OWNER_TOKEN e sessão: veem tudo; console mostra badges.
- [ ] Header em request SEM Bearer válido (ou com token errado) é ignorado (fail-closed).
- [ ] No Brain: PAT sem escopo `private` chamando as tools de contatos não recebe entidade privada (nem em list/search/get); PAT `read,private` e sessão do dono recebem.
- [ ] Event privado em entidade pública: fora da timeline proxy, fora do embedding (recall semântico NÃO acha a entidade por termo que só existe no event privado), visível com `🔒` pro dono.
- [ ] Toggle web desmarca; API com `private: false` → erro; `POST /app/entity/private` sem sessão → 401/redirect.
- [ ] `npx tsc --noEmit` + testes verdes nos DOIS repos.

## Validação

- Contacts: suíte nova `test/privacy.test.ts` (vazamento por superfície, header trust, one-way). Brain: teste das tools de contatos com auth mock sem/com escopo.
- Manual (`wrangler dev` nos dois): marcar 1 contato e 1 observação de teste, conferir os dois lados (proxy sem header via curl; console logado), desmarcar pela UI.
- **Gate de deploy:** deploy dos DOIS workers só com OK explícito do dono (contacts primeiro — o header é ignorado pelo worker antigo, então Brain novo + contacts antigo não quebra, só não filtra; documentar a ordem).

## Arquivos afetados

**expert-contacts:** `src/db/migrate.ts` (migration), `src/index.ts` (`requireAuth`/helper `callerSeesPrivate`, REST paths, flag no write), `src/vaults/contacts.ts` (fetchEntity/search/graph), `src/web/*` (toggle, badges, checkbox no form de interação), `src/entity-write.ts` (flag no patch), `mcp/index.js` (param `private` + descriptions), `test/privacy.test.ts`.

**expert-brain:** helper `proxyToContacts` (header), `src/mcp/tools/contacts.ts` (escopo por caller), rotas web de contatos do console (sessão → header), testes.

## Riscos e reversão

- **Risco**: superfície GET nova no contacts nascer sem o helper. Mitigação: `callerSeesPrivate` é função única e a suíte por-superfície é critério de aceite (disciplina da 31).
- **Risco**: confiar no header amplia o dano de um vazamento do proxy token? NÃO amplia — hoje o token já lê 100%; o header só restaura esse teto. Registrado no modelo de confiança (item 2).
- **Risco**: dono esquece que observação privada fica fora do recall e "perde" o registro. Mitigação: aviso fixo no form ("observação privada não aparece em buscas — só na timeline deste contato").
- **Reversão**: revert dos códigos; colunas/índices ficam inertes (aditivos). Efeito colateral do rollback no contacts: privados voltam a ser servidos ao proxy (código antigo não filtra) — avisar o dono ANTES, igual à 31.
