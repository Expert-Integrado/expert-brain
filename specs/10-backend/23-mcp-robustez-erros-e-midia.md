# Brain MCP: mensagens de erro honestas, proxy de contatos com diagnóstico correto e fetch de mídia com teto real

> **Status:** done (07/07/2026) · **Prioridade:** P2 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O servidor MCP do Expert Brain roda em Cloudflare Workers e conversa com agentes LLM. As mensagens de erro das tools **são contrato de comportamento**: o agente consumidor decide "re-executo?", "aviso o usuário?", "troco de estratégia?" com base literalmente no texto retornado. Hoje esse contrato tem pontos que induzem o agente ao erro.

Peças envolvidas:

- `src/mcp/helpers.ts` — `safeToolHandler` envolve TODAS as tools e traduz exceções em mensagens padronizadas por categoria (D1, Vectorize, Workers AI, genérico). A mensagem do branch Workers AI (`helpers.ts:45-52`) foi escrita pensando no `save_note` (que embeda ANTES de gravar) e afirma categoricamente que "the note was NOT saved ... there are no partial writes".
- `src/mcp/tools/update-note.ts` — o `update_note` grava o D1 primeiro (`updateNote` em `update-note.ts:119-131`, `replaceTags` em `133-141`) e só DEPOIS chama `embed()` quando `tldr`/`domains`/`kind` mudam (`update-note.ts:144-164`). Ou seja: partial write é o comportamento normal desse caminho.
- `src/mcp/tools/contacts.ts` — 4 tools read-only (`list_contacts`, `search_contacts`, `get_contact`, `get_contact_by_phone`) que fazem proxy pro worker do Expert Contacts via service binding `CONTACTS` + Bearer (`callContacts`, `contacts.ts:8-19`). Quando o binding ou o token não estão configurados no deploy (caso típico: fork de aluno sem o segundo worker), `callContacts` devolve `{ ok: false, status: 503 }` (`contacts.ts:9-11`).
- `src/media/store.ts` — `attachMedia` aceita mídia por `base64`, `bytes` (multipart) ou `url`. O caminho `url` (`ingest`, `store.ts:95-119`) faz `fetch` da origem e bufferiza o corpo. Existe um teto documentado de 50MB (`MAX_BYTES`, `store.ts:14`) porque o dedup exige hashear o arquivo inteiro na memória do Worker (~128MB).
- `src/mcp/agent.ts` — o `McpServer` é instanciado com versão hardcoded `'0.1.0'` (`agent.ts:8-11`), desconectada do `package.json`.
- `src/db/validation.ts` — referência de estilo: `buildCanonError` (`validation.ts:67-77`) rejeita domínio fora do cânon com mensagem que lista os valores válidos E sugere o mais próximo (`suggestCanonical`, `validation.ts:86-117`). É o padrão de erro que queremos replicar em contatos.

Testes existentes: `test/helpers.test.ts` (cobre `safeToolHandler`), `test/tools/update-note.test.ts`, `test/media.test.ts`. NÃO existe `test/tools/contacts.test.ts` — será criado.

## Problema / Motivação

Cinco defeitos, todos com evidência concreta:

1. **Mensagem do Workers AI mente pro `update_note`** (`src/mcp/helpers.ts:49-50`). O texto diz "The note was NOT saved because embedding failed before the database write ... it is safe, there are no partial writes". Isso é verdade pro `save_note`, mas FALSO pro `update_note`: quando o `embed()` de `update-note.ts:150` estoura, o D1 já foi escrito (`update-note.ts:119-141`). O agente que lê "nada foi salvo, re-execute" re-executa o update inteiro achando que nada persistiu — e o vetor da nota fica dessincronizado do tldr novo sem que ninguém saiba que precisa de `reembed`.

2. **503 do proxy de contatos vira "contato não existe"** (`src/mcp/tools/contacts.ts:86`). `get_contact` responde `Contact '<id>' not found (HTTP 503)` quando na verdade o binding `CONTACTS`/`CONTACTS_PROXY_TOKEN` nem está configurado (`contacts.ts:9-11`). O agente conclui que o contato não existe (dado errado apresentado ao usuário) em vez de concluir que a feature não está disponível neste deploy. As outras 3 tools ao menos incluem o corpo do erro, mas nenhuma distingue 404 (não existe) de 503 (não configurado) de 5xx genérico (indisponível, retry vale a pena).

3. **`category` é string livre nos schemas de contatos** (`src/mcp/tools/contacts.ts:29` e `contacts.ts:59`). `z.string().optional()` com os valores canônicos só na `describe`. Um typo (`categoria: 'clientes'` em vez de `'cliente'`) passa pela validação, vai pro worker de contatos e volta `count: 0` silencioso — o agente reporta "você não tem nenhum cliente" em vez de receber um erro de validação com sugestão.

4. **Fetch de mídia por URL confia no `content-length`** (`src/media/store.ts:111-113`). O teto de 50MB é checado só contra o header declarado; na linha seguinte (`store.ts:113`) `res.arrayBuffer()` bufferiza o corpo INTEIRO. Origem sem `content-length` (chunked transfer) ou com header mentiroso bufferiza corpo arbitrário até estourar a memória do isolate (erro 1102/OOM do Workers) em vez de retornar um 413 limpo. O check de `bytes.length > MAX_BYTES` em `attachMedia` (`store.ts:183-185`) chega tarde demais — o dano de memória já aconteceu no buffer.

5. **Versão do servidor MCP hardcoded** (`src/mcp/agent.ts:9`). `version: '0.1.0'` fixo, desconectado do `package.json`. Com forks de alunos e múltiplos deploys, não dá pra diagnosticar QUAL versão do código está respondendo num handshake MCP.

Findings cobertos: `helpers-msg-ai-errada-pra-update`, `contacts-erro-503-vira-not-found`, `contacts-category-string-livre`, `media-url-fetch-buffer-ilimitado`, `mcp-version-hardcoded`.

## Objetivo

Nenhuma mensagem de erro do MCP afirma estado de persistência falso, todo erro do proxy de contatos diagnostica a causa real (404 vs 503 vs 5xx vs typo de categoria), o fetch de mídia por URL nunca bufferiza acima de `MAX_BYTES`, e o handshake MCP reporta a versão real do `package.json` — tudo com testes de regressão.

## Design proposto

Sem migration — nenhuma mudança de schema ou de dados. Só código + testes.

### 1. Mensagem honesta do Workers AI (`src/mcp/helpers.ts:45-52`)

Trocar a afirmação categórica por uma mensagem genérica que orienta o agente a VERIFICAR em vez de assumir:

```ts
if (msg.includes('@cf/baai') || msg.includes('Workers AI') || msg.includes('AiError')) {
  console.error('ExpertBrain Workers AI error:', msg);
  return toolError(
    `Workers AI (the embedding model) returned an error: ${msg}. ` +
    `This is usually transient. Whether data was persisted depends on the tool: ` +
    `save_note embeds BEFORE writing (nothing saved — safe to retry the same call); ` +
    `update_note writes to the database BEFORE embedding (the edit may have persisted with a stale vector). ` +
    `Do NOT blindly retry a write. First call get_note(id) to check what persisted; ` +
    `if the edit is there, call reembed(id) to fix the vector instead of repeating the update.`
  );
}
```

Alternativa considerada e descartada: capturar o erro DENTRO do `update_note` com try/catch em volta do `embed()` e mensagem contextual. É válida, mas duplica a lógica de classificação de erro que já vive centralizada no `safeToolHandler`, e a mensagem genérica cobre também futuras tools que escrevam antes de embedar. Se durante a implementação se preferir a variante contextual, o critério de aceite continua o mesmo: a mensagem vista pelo agente após falha de embed no `update_note` NÃO pode afirmar que nada foi salvo.

### 2. Diagnóstico por status no proxy de contatos (`src/mcp/tools/contacts.ts`)

Criar um helper único no topo do arquivo e usar nas 4 tools no lugar dos `toolError` atuais (`contacts.ts:46`, `71`, `86`, `101`):

```ts
function contactsError(action: string, r: { status: number; data: any }): ToolResult {
  if (r.status === 404) {
    return toolError(`${action}: not found (HTTP 404). The contact does not exist in the Contacts vault — do not retry with the same id/phone.`);
  }
  if (r.status === 503) {
    return toolError(
      `${action}: the Contacts vault is not configured in this deploy (HTTP 503 — CONTACTS service binding or CONTACTS_PROXY_TOKEN missing). ` +
      `This is a deployment issue, not a data issue. Contacts tools are unavailable here; tell the user instead of retrying.`
    );
  }
  if (r.status >= 500) {
    return toolError(`${action}: the Contacts service is temporarily unavailable (HTTP ${r.status}). Wait a few seconds and retry once. Details: ${JSON.stringify(r.data)}`);
  }
  return toolError(`${action} failed (HTTP ${r.status}): ${JSON.stringify(r.data)}`);
}
```

Em `get_contact` (`contacts.ts:86`), a mensagem "not found" só pode aparecer quando `r.status === 404` — os demais status caem nos branches acima.

Nota: o 503 sintético de `callContacts` (`contacts.ts:9-11`) já carrega `data.error = 'contacts binding/token not configured'`; o branch 503 do helper cobre tanto esse caso quanto um 503 real do worker de contatos (nos dois o diagnóstico correto é "indisponível neste deploy, não retry").

### 3. `category` vira enum (`src/mcp/tools/contacts.ts:29` e `:59`)

Extrair os valores canônicos pra uma constante e usar `z.enum` nos dois schemas:

```ts
const CONTACT_CATEGORIES = [
  'cliente', 'lead', 'lead-perdido', 'aluno', 'parceiro', 'fornecedor',
  'equipe', 'familia', 'pessoal', 'network', 'outro',
] as const;

// nos schemas de list_contacts e search_contacts:
category: z.enum(CONTACT_CATEGORIES).optional().describe('Segment filter.'),
```

Com `z.enum`, um typo é rejeitado pelo próprio SDK do MCP com erro de validação listando os valores aceitos — o agente se autocorrige em vez de receber `count: 0`. Isso espelha o espírito do `buildCanonError` de `src/db/validation.ts:67-77` (rejeitar com os valores válidos na mensagem); não é preciso replicar o `suggestCanonical` aqui porque o enum do Zod já enumera as opções no erro. Manter as `describe`/`description` das tools coerentes (podem referenciar a lista uma vez só).

Atenção: os valores do enum são os MESMOS que o worker de contatos aceita hoje (fonte: descriptions atuais em `contacts.ts:26-29` e `55-59`). Não inventar valores novos nem remover nenhum — mudança é só de validação, não de semântica.

### 4. Teto real no fetch de mídia por URL (`src/media/store.ts:95-119`)

Substituir `res.arrayBuffer()` (`store.ts:113`) por leitura incremental com contador e abort:

```ts
if (!res.ok) throw new MediaError(502, `source returned HTTP ${res.status}`);

// content-length declarado acima do teto: rejeita antes de ler 1 byte.
const declaredHeader = res.headers.get('content-length');
const declared = Number(declaredHeader || '0');
if (declared > MAX_BYTES) throw new MediaError(413, `source is ${declared} bytes — over the ${MAX_BYTES} limit`);

// Leitura incremental: NUNCA bufferiza mais que MAX_BYTES, mesmo com
// content-length ausente (chunked) ou mentiroso. Passou do teto → aborta
// o stream e devolve 413 limpo em vez de OOM/1102 do isolate.
const reader = res.body?.getReader();
if (!reader) throw new MediaError(502, 'source returned no body');
const chunks: Uint8Array[] = [];
let total = 0;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  total += value.byteLength;
  if (total > MAX_BYTES) {
    await reader.cancel();
    throw new MediaError(413, `source exceeded the ${MAX_BYTES}-byte (50MB) limit while streaming — download aborted`);
  }
  chunks.push(value);
}
const buf = new Uint8Array(total);
let off = 0;
for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
```

Decisões embutidas:

- **Resposta sem `content-length` é aceita** (chunked é comum e legítimo), mas protegida pelo contador incremental — o teto conservador é o próprio `MAX_BYTES`. Não criar um segundo teto menor: complexidade sem ganho, já que o contador aborta no mesmo ponto.
- **SSRF**: documentar em comentário no `ingest` que o fetch de URL é mitigado pelo isolamento do runtime Workers (o `fetch` do Worker não alcança rede interna/metadata endpoints como num servidor tradicional) e que allowlist de hosts está intencionalmente fora de escopo.
- O check posterior `bytes.length > MAX_BYTES` em `attachMedia` (`store.ts:183-185`) continua existindo — ele cobre os caminhos `base64` e `bytes`; o novo código cobre o caminho `url` na origem.

### 5. Versão do MCP importada do `package.json` (`src/mcp/agent.ts:8-11`)

```ts
import pkg from '../../package.json';
// ...
server = new McpServer(
  { name: 'expert-brain', version: pkg.version },
  { instructions: SERVER_INSTRUCTIONS }
);
```

Requer `"resolveJsonModule": true` no `tsconfig.json` raiz (adicionar se ausente). O bundler do Wrangler (esbuild) resolve import de JSON nativamente e faz tree-shaking do restante do objeto, então o bundle não incha. A partir daí, bump de versão no `package.json` aparece automaticamente no handshake MCP — em fork de aluno, `initialize` já revela qual código responde.

## Fora de escopo

- Allowlist de hosts pra fetch de mídia (SSRF fica documentado como mitigado pelo runtime, sem lista).
- Retry automático no proxy de contatos (o agente decide com base na mensagem; a tool não re-tenta sozinha).
- Mudar a ordem write-then-embed do `update_note` (transacionar D1+Vectorize não é possível; a ordem atual é a correta pra não perder edição).
- Upload de mídia acima de 50MB / streaming pro R2 sem hash no servidor.
- Qualquer mudança no worker do Expert Contacts (só o lado do proxy no Brain muda).

## Critérios de aceite

- [x] Falha do Workers AI durante `update_note` produz mensagem que NÃO afirma "nothing was saved"; a mensagem instrui verificar via `get_note` e, se persistiu, rodar `reembed(id)`.
- [x] A mensagem do branch Workers AI continua correta pro `save_note` (retry seguro continua sendo comunicado como opção para o caminho embed-antes-de-gravar).
- [x] `get_contact` com binding `CONTACTS` ausente retorna mensagem contendo "not configured in this deploy" e NÃO contém "not found".
- [x] `get_contact` com resposta 404 do worker de contatos retorna "not found" e instrui a não re-tentar com o mesmo id.
- [x] Status 5xx (≠503 sintético) nas 4 tools de contatos retorna mensagem de indisponibilidade temporária sugerindo um retry.
- [x] `list_contacts`/`search_contacts` com `category` fora do cânon são rejeitados na validação do schema (erro lista os valores aceitos); `category` válida continua passando o mesmo valor no querystring.
- [x] `ingest` por URL com `content-length` acima de 50MB rejeita com `MediaError(413)` sem ler o corpo.
- [x] `ingest` por URL com corpo maior que 50MB e `content-length` ausente ou mentiroso aborta o stream e rejeita com `MediaError(413)` — nunca bufferiza mais que `MAX_BYTES`.
- [x] `ingest` por URL com corpo pequeno e sem `content-length` (chunked) continua funcionando (bytes idênticos ao download completo).
- [x] `McpServer` reporta `version` igual a `require('package.json').version` — sem literal `'0.1.0'` em `src/mcp/agent.ts`.
- [x] Testes unitários novos cobrem cada item acima (as mensagens são contrato com o agente — asserts no TEXTO, não só no `isError`).
- [x] `npm run typecheck` e `npm test` passam; nenhum teste existente quebrado.

## Validação

```bash
npm run typecheck
npm test          # vitest run + vitest run --config vitest.auth.config.ts
```

Testes a criar/estender:

- `test/helpers.test.ts` — estender: simular erro contendo `Workers AI` e assertar a nova mensagem (contém `get_note`/`reembed`, não contém "was NOT saved" como afirmação universal).
- `test/tools/update-note.test.ts` — estender: mock de `embed` que lança `AiError` após update de tldr; assertar que o D1 ficou com o tldr novo E que a mensagem de erro não afirma que nada persistiu.
- `test/tools/contacts.test.ts` — NOVO: mock do binding `CONTACTS` (objeto com `fetch` retornando `Response` controlada) cobrindo: binding ausente → mensagem "not configured"; 404 → "not found"; 500 → "temporarily unavailable"; `category` inválida rejeitada pelo schema; `category` válida propagada no querystring.
- `test/media.test.ts` — estender com mock de `fetch` global (`vi.stubGlobal`): content-length declarado > 50MB → 413 imediato; stream chunked sem content-length que ultrapassa 50MB → 413 com abort (assertar que `reader.cancel` foi chamado ou que a leitura parou); stream pequeno chunked → sucesso com bytes corretos.

Teste manual (opcional, num deploy de dev): `attach_media_to_note` com URL de arquivo grande sem content-length e conferir 413 em vez de erro 1102; handshake MCP (`initialize`) reportando a versão do `package.json`.

**Deploy (`npm run deploy`) SOMENTE com OK explícito do dono do repo.**

## Arquivos afetados

- `src/mcp/helpers.ts` — mensagem do branch Workers AI (linhas 45-52)
- `src/mcp/tools/contacts.ts` — helper `contactsError`, uso nas 4 tools, `category` vira `z.enum`
- `src/media/store.ts` — leitura incremental com teto no caminho URL do `ingest` (linhas 110-118), comentário SSRF
- `src/mcp/agent.ts` — versão importada do `package.json`
- `tsconfig.json` — `resolveJsonModule: true` (se ainda ausente)
- `test/helpers.test.ts` — estender
- `test/tools/update-note.test.ts` — estender
- `test/tools/contacts.test.ts` — NOVO
- `test/media.test.ts` — estender

## Riscos e reversao

- **Risco: agentes consumidores calibrados nas mensagens antigas.** Mitigação: as novas mensagens só ADICIONAM diagnóstico correto; nenhum formato estruturado muda (continua `ToolResult` com `isError`). Nenhum consumidor conhecido parseia o texto programaticamente.
- **Risco: `z.enum` em `category` rejeitar valor que o worker de contatos aceita mas não está na lista.** Mitigação: a lista vem das próprias descriptions em produção; se surgir categoria nova no worker, adicionar ao array `CONTACT_CATEGORIES` é mudança de 1 linha.
- **Risco: leitura por reader se comportar diferente de `arrayBuffer()` em alguma origem exótica (ex.: body nulo em resposta 200).** Mitigação: branch explícito `MediaError(502, 'source returned no body')` + teste de paridade de bytes no caso feliz.
- **Risco: import de JSON quebrar o build do Wrangler.** Mitigação: testar `wrangler dev` local antes do deploy; esbuild suporta JSON import nativamente.
- **Reversão:** mudanças são puramente de código, sem migration e sem alteração de dados — `git revert` do commit restaura o comportamento anterior por completo. Nenhum dado escrito por este trabalho precisa de limpeza.
