# Parametrizar SERVER_INSTRUCTIONS: remover identidade do mantenedor e cobrir as 22 tools

> **Status:** done · **Prioridade:** P0 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O Expert Brain é um MCP server open-source (Cloudflare Workers + D1 + Vectorize) instalável por qualquer aluno via `npm create @expertintegrado/expert-brain@latest`. O texto de instructions que o servidor MCP anuncia pro cliente (Claude Code, Claude Desktop etc.) vive em uma constante:

- `src/mcp/instructions.ts:1` — `export const SERVER_INSTRUCTIONS = \`Expert Brain — ...\`` (constante única, sem nenhum parâmetro).
- `src/mcp/agent.ts:8-11` — a classe `ExpertBrainMCP extends McpAgent` cria o `McpServer` como field da classe, passando `{ instructions: SERVER_INSTRUCTIONS }` no construtor. O `init()` (`src/mcp/agent.ts:13-17`) só valida `auth` e chama `registerAllTools(this.server, this.env)`.
- `src/mcp/registry.ts:22-45` — `registerAllTools` registra **22 tools**: 10 de notas (`save_note`, `update_note`, `delete_note`, `restore_note`, `recall`, `expand`, `get_note`, `link`, `stats`, `reembed`), 5 de tasks (`save_task`, `list_tasks_due_today`, `list_tasks`, `complete_task`, `update_task`), 3 de mídia (`attach_media_to_note`, `get_note_media`, `delete_note_media`) e 4 de contatos read-only (`list_contacts`, `search_contacts`, `get_contact`, `get_contact_by_phone`).

Já existe um mecanismo de personalização por instância: o "prompt de personalização", editável inline em `/app/config` e persistido na tabela `meta` com a chave `personalization_prompt` (`src/web/config.ts:22` — `PREFS_META_KEY`; leitura em `src/web/config.ts:25-30` — `getPersonalizationPrompt(env)`; escrita em `handleConfigPrefsPost`, `src/web/config.ts:32-48`). O template default (`DEFAULT_PREFS_BLOCK`, `src/web/config.ts:12-20`) usa placeholders genéricos entre `[colchetes]` — e o teste `src/web/config.test.ts:46-57` já garante que a página de config NÃO contém o nome do mantenedor original quando o meta está vazio.

Ou seja: a camada web já foi despersonalizada; as instructions do MCP não.

## Problema / Motivação

1. **Vazamento de identidade do mantenedor** — a primeira linha de `src/mcp/instructions.ts:1` declara que o vault "pertence a" uma pessoa específica, com nome, cargo e empresa hardcoded. Toda instalação de aluno anuncia o vault como pertencendo ao mantenedor original, não ao dono da instância. O agente do aluno passa a "acreditar" que está falando com outra pessoa. (Findings: `instructions-hardcoded-owner`, `instructions-hardcode-owner`, `instructions-hardcoded-owner-r3`.)
2. **Incidente pessoal hardcoded** — o escape hatch de domínios (`src/mcp/instructions.ts:25`) cita data e números de um incidente da instância do mantenedor ("proliferação que aconteceu em 12/05/2026, 46 domínios espalhados em 378 notas..."), irrelevante e confuso pra qualquer outra instância.
3. **Drift de cobertura: 12 das 22 tools não aparecem nas instructions** — o texto (itens 1-9, `src/mcp/instructions.ts:9-18`) cobre `recall`, `save_note`, `update_note`, `delete_note`, `stats` e as 5 tools de tasks. Ficam de fora: `expand`, `get_note`, `link` (citado só indiretamente como "edge"), `reembed`, `restore_note`, as 3 tools de mídia e as 4 de contatos. O agente do aluno não sabe que delete é reversível (`restore_note`), que dá pra anexar mídia com dedup, nem quando usar contatos vs `recall`. (Findings: `instructions-drift-12-tools`, `backlog-4`.)

## Objetivo

Nenhuma instalação nova monta instructions contendo nome/cargo/empresa/incidente do mantenedor original, e o texto passa a orientar o uso das 22 tools registradas — verificável por teste automatizado.

## Design proposto

### 1. `src/mcp/instructions.ts` — de constante pra função

Substituir a constante `SERVER_INSTRUCTIONS` por:

```ts
export function buildServerInstructions(personalizationPrompt: string | null): string
```

- **Cabeçalho parametrizado:** a primeira linha vira algo como `Expert Brain — grafo de conhecimento pessoal latticework, rodando no Cloudflare D1 + Vectorize. Este vault pertence ao dono da instância.` Se `personalizationPrompt` for não-nulo e não-vazio, anexar um bloco `Contexto do dono (definido em /app/config):` com o texto. Se for `null` (meta vazio), fica SÓ o fallback genérico — NÃO injetar o `DEFAULT_PREFS_BLOCK` (ele contém placeholders `[seu nome]` que confundiriam o agente).
- **Remover** qualquer nome próprio, cargo, empresa e a menção ao incidente de 12/05/2026 do escape hatch (`src/mcp/instructions.ts:25`). O escape hatch continua existindo, mas com justificativa genérica (ex: "o canon existe pra evitar proliferação de domínios que quebra o recall cross-domain").
- **Manter** o conteúdo pedagógico dos itens 1-9 existentes (fluxo recall→save, atomização, edges com `why`, kinds, tasks) sem reescrever.
- **Adicionar** itens novos cobrindo as 12 tools ausentes:
  - `expand` e `get_note`: depois de um `recall` que achou nota relevante, `expand` mostra os edges (descobre notas conectadas); `get_note` traz a nota completa por id.
  - `link`: citar a tool pelo nome no item que já fala de edges/`why`.
  - **Contatos (read-only):** `list_contacts`, `search_contacts`, `get_contact`, `get_contact_by_phone` leem o vault de contatos. Usar quando a pergunta é sobre UMA pessoa/empresa (telefone, e-mail, cargo, relações); usar `recall` quando é sobre ideias/conceitos. `get_contact_by_phone` é match exato de telefone; `search_contacts` é busca por nome/semântica.
  - **Mídia:** `attach_media_to_note` anexa arquivo (base64 ou URL) com dedup SHA-256 no R2 e retorna URL assinada válida ~1h; `get_note_media` lista mídia da nota (URLs assinadas ~1h); `delete_note_media` remove.
  - **`restore_note`:** `delete_note` é SOFT delete e reversível sem limite de tempo — `restore_note` com o id desfaz, trazendo a nota de volta pro recall/grafo/stats com os edges.
  - **`reembed`:** re-gera o embedding de uma nota; usar após edição grande de título/corpo quando o recall parecer desatualizado.
- Manter um export de compatibilidade só se algum outro ponto importar a constante (hoje o único consumidor é `src/mcp/agent.ts:4` — então pode remover a constante de vez).

### 2. `src/mcp/agent.ts` — montar no `init()` do Durable Object

O `McpServer` hoje é criado como field da classe (`src/mcp/agent.ts:8-11`), antes de `this.env` estar utilizável pra I/O. Mover a criação pro `init()`:

```ts
export class ExpertBrainMCP extends McpAgent<Env, Record<string, never>, AuthContext> {
  server!: McpServer;

  async init(): Promise<void> {
    const auth = (this as any).props as AuthContext | undefined;
    if (!auth) throw new Error('ExpertBrainMCP: missing auth props');
    const prompt = await readPersonalizationPrompt(this.env); // 1 SELECT no meta
    this.server = new McpServer(
      { name: 'expert-brain', version: '0.1.0' },
      { instructions: buildServerInstructions(prompt) }
    );
    registerAllTools(this.server, this.env);
  }
}
```

- **Cache no DO:** `init()` roda uma vez por instância do Durable Object — o texto montado fica cacheado naturalmente na instância (1 leitura de D1 por DO, não por request). Não adicionar TTL/invalidação: prompt editado em `/app/config` passa a valer quando o DO reciclar (aceitável; documentar em comentário).
- **Falha suave:** se o SELECT no meta falhar, logar e cair no fallback genérico (`buildServerInstructions(null)`) — instructions nunca podem derrubar o handshake MCP.

### 3. `src/web/config.ts` — expor a leitura crua do meta

`getPersonalizationPrompt` (`src/web/config.ts:25-30`) retorna o `DEFAULT_PREFS_BLOCK` como fallback — correto pra UI, errado pro MCP (placeholders). Extrair/exportar uma variante crua:

```ts
export async function readPersonalizationPrompt(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(PREFS_META_KEY).first<{ value: string }>();
  return row?.value ?? null;
}
```

e fazer `getPersonalizationPrompt` (da UI) delegar nela com `?? DEFAULT_PREFS_BLOCK`. Alternativa aceitável: mover a leitura pra um módulo neutro (ex: `src/db/meta.ts`) pra evitar `src/mcp` importar de `src/web` — escolher o que gerar menos churn, sem mudar comportamento da UI.

### 4. Teste novo — `test/instructions.test.ts`

Espelhando a estratégia de `src/web/config.test.ts:56` (`expect(html).not.toContain(<nome do mantenedor>)`):

- `buildServerInstructions(null)` NÃO contém o nome, o cargo nem a empresa do mantenedor original (usar as strings literais que hoje estão em `src/mcp/instructions.ts:1` como asserts negativos), NÃO contém `[seu nome]` e NÃO contém `12/05/2026`.
- `buildServerInstructions(null)` contém o fallback genérico ("dono da instância").
- `buildServerInstructions('Sou Fulana. Trabalho com produto.')` contém o texto passado.
- O texto contém o nome das 22 tools registradas (assert por lista — importar/duplicar a lista de nomes e iterar `toContain`).
- Conteúdo pedagógico preservado: contém `same_mechanism_as`, os 7 kinds e os 12 domínios canônicos.

São testes puros de string (sem D1) — não precisam do harness `cloudflare:test`, mas usar o padrão do repo em `test/` (vitest já roda `test/**` e `src/**` pelos configs existentes).

### Migrations

Nenhuma mudança de schema. A tabela `meta` e a chave `personalization_prompt` já existem — mudança é 100% aditiva em código.

## Fora de escopo

- Mudar o conteúdo pedagógico dos itens 1-9 existentes (fluxo recall/save, edges, kinds, tasks) — só adicionar cobertura nova.
- Mexer em `OWNER_EMAIL`, auth, sessão ou qualquer fluxo de login.
- Invalidação ativa do cache do DO quando o prompt muda em `/app/config` (aceitar a latência até o DO reciclar).
- Traduzir/alterar descriptions individuais das tools em `src/mcp/tools/*`.
- Publicar a release do pacote de alunos (é gate desta spec, mas a publicação em si segue o runbook `RELEASING.md` e SÓ acontece com OK explícito do dono do repo).

## Critérios de aceite

- [x] `src/mcp/instructions.ts` não contém mais nenhum nome próprio, cargo, empresa nem referência ao incidente de 12/05/2026 (grep no arquivo retorna vazio pra essas strings).
- [x] `buildServerInstructions(null)` produz texto com o fallback "dono da instância" e sem placeholders `[colchetes]`.
- [x] `buildServerInstructions(prompt)` inclui o prompt de personalização quando ele existe no meta.
- [x] O `McpServer` é criado no `init()` de `src/mcp/agent.ts` com as instructions montadas a partir do meta, e o handshake MCP continua funcionando (testes e2e existentes passam).
- [x] Falha na leitura do meta não quebra o `init()` — cai no fallback genérico.
- [x] As instructions citam as 22 tools pelo nome, incluindo: contatos read-only (quando usar vs `recall`), mídia (dedup + URL assinada ~1h), `restore_note` (delete é soft e reversível) e `reembed`.
- [x] `test/instructions.test.ts` novo passa, incluindo o assert negativo espelhado de `src/web/config.test.ts:56`.
- [x] Nenhum teste existente quebra (`npm test` verde, incluindo `vitest.auth.config.ts`).
- [x] UI de `/app/config` inalterada: primeira visita continua mostrando o `DEFAULT_PREFS_BLOCK` com placeholders (testes de `src/web/config.test.ts` verdes).

## Validação

```bash
# no diretório do repo
npm run typecheck
npm test                        # vitest run + vitest run --config vitest.auth.config.ts
npx vitest run test/instructions.test.ts

# verificação anti-vazamento (deve retornar vazio):
grep -rn "12/05/2026" src/mcp/instructions.ts
```

Teste manual: `npm run dev`, conectar um cliente MCP na instância local e inspecionar as instructions retornadas no handshake (`initialize`) — conferir fallback genérico com meta vazio e, após salvar um prompt em `/app/config` e reciclar o DO, conferir que o prompt aparece.

Deploy (`npm run deploy`) e release npm (runbook `RELEASING.md` — essa mudança toca `src/`, portanto EXIGE release nova do pacote de alunos): **somente com OK explícito do dono do repo.**

## Arquivos afetados

- `src/mcp/instructions.ts` — constante → `buildServerInstructions(personalizationPrompt)`
- `src/mcp/agent.ts` — criação do `McpServer` movida pro `init()`, leitura do meta + cache no DO
- `src/web/config.ts` — exportar `readPersonalizationPrompt(env)` (leitura crua, fallback `null`)
- `test/instructions.test.ts` — novo

## Riscos e reversão

- **Risco: `init()` async passa a fazer I/O em D1 antes do handshake** — se o D1 estiver lento/indisponível, o primeiro request ao DO fica mais lento. Mitigação: try/catch com fallback genérico + o cache do DO limita a 1 leitura por instância.
- **Risco: mudar o field `server` pra atribuição no `init()`** pode conflitar com expectativas da lib `agents/mcp` (acesso a `this.server` antes do `init()`). Validar com os testes e2e existentes; se a lib exigir o field no construtor, alternativa: manter o field com instructions genéricas fixas e usar apenas o texto estático parametrizado (sem prompt do meta) — o requisito P0 (remover identidade) não depende da leitura do meta.
- **Risco: instância do mantenedor original perde o contexto pessoal nas instructions** — mitigado pelo próprio mecanismo: basta preencher o prompt em `/app/config` daquela instância (dado fica no D1 dela, fora do repo).
- **Rollback:** `git revert` do commit (mudança é só de código, sem migration, sem alteração de dados) e `npm run deploy` da versão anterior. Instalações de alunos que já receberam a release nova não precisam de ação — o texto novo é estritamente mais correto; se ainda assim for preciso, publicar release de rollback seguindo `RELEASING.md`.
