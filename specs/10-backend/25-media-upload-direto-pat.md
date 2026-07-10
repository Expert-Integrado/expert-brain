# Upload direto de mídia com PAT — bytes nunca passam pelo contexto do modelo

> **Status:** shipped (10/07/2026) · **Prioridade:** P2 · **Esforço:** S · **Repo:** expert-brain
> **Origem:** task `tciaw1pubvw9` (perda silenciosa de ~21% dos bytes num PNG de 17KB anexado via base64 pelo MCP)
> **Depende de:** `10-backend/17` (PATs/escopos), `30-features` selo de privacidade (escopo `private`)

## Contexto

- `attach_media_to_note` (MCP) aceita `source` como base64 ou URL http(s). O caminho base64 obriga o AGENTE a gerar dezenas de milhares de caracteres como texto dentro da chamada de tool — não é transferência de bytes fiel, é geração de tokens. Para payloads de ~15-20KB+ isso corrompe silenciosamente (confirmado empiricamente: PNG de 17.115 bytes virou 13.562 no round-trip).
- O workaround real usado foi hospedar as imagens num repo GitHub público descartável só pra o Worker buscar via URL — funciona, mas é lento, expõe conteúdo publicamente e não escala.
- A infraestrutura de upload binário JÁ EXISTE: `POST /app/notes/{id}/media` aceita multipart (`file`) e chama `attachMedia` com `bytes` direto (src/web/media.ts) — é o caminho que o frontend do console usa. O que falta é AUTH: a rota só aceita sessão de browser ou `GRAPH_EXPORT_TOKEN`; o PAT do agente (`eb_pat_*`) é recusado.

## Problema / Motivação

- Agente local (com Bash/curl e acesso ao arquivo no disco) não tem NENHUM canal fiel de bytes pro R2: ou infla base64 no contexto do modelo (corrompe), ou publica numa URL externa (gambiarra com exposição pública).

## Design

1. **Aceitar `Bearer eb_pat_*` na superfície de mídia web** (`authMedia` em src/web/media.ts), via `validateApiKey` — o MESMO PAT que o agente já usa no MCP. Sem token novo, sem endpoint novo: o agente faz `curl -F file=@arquivo` na rota que já existe.
2. **Escopos respeitados (fail-closed):**
   - Mutação (POST upload, DELETE) exige escopo base `full`; PAT `read` recebe 403.
   - Nota/task privada exige escopo `private`; sem ele a nota "não existe" (404) — mesmo contrato do recall/get_note. Gate aplicado só no caminho PAT; sessão do dono e `GRAPH_EXPORT_TOKEN` continuam nível-dono.
   - `eb_pat_` inválido/revogado → 401 JSON direto (sem redirect de login: é cliente de API).
3. **`attachMedia` ganha `canSeePrivate`** (default `false`, comportamento atual intacto): a sessão do dono passa `true` — corrige de carona o bug pré-existente de o PRÓPRIO DONO não conseguir anexar mídia em nota privada pelo console (o `getNoteById` default filtra `private = 0` e devolvia "not found").
4. **Descoberta pelo agente:** description do `attach_media_to_note` e item de mídia do handshake MCP passam a documentar o upload direto (curl multipart com o mesmo Bearer) e a alertar que base64 grande gerado como texto corrompe. O retorno já inclui `content_hash` — o agente confere fidelidade comparando com o sha256 local.

## Fora de escopo

- Presigned URL S3 do R2 (exige access key S3; o Worker-como-proxy com HMAC já cobre o caso).
- Mudar os caminhos base64/URL do MCP (continuam válidos pra payloads pequenos/URLs públicas) ou dar acesso a nota privada pelas tools MCP de mídia (segue o contrato atual).
- Upload acima de 50MB (teto MAX_BYTES do runtime, spec 10-backend/23).

## Critérios de aceite

- [x] PAT `full`: upload multipart devolve 201 com bytes FIÉIS (sha256 local == `content_hash`, blob no R2 idêntico byte a byte).
- [x] PAT `read`: POST/DELETE → 403; GET lista → 200.
- [x] `eb_pat_` inválido ou revogado → 401 JSON (sem redirect).
- [x] Nota privada: PAT `full` → 404; PAT `full,private` → 201; sessão do dono → 201 (bug do console corrigido).
- [x] Servir/deletar mídia de nota privada via PAT sem escopo `private` → 404.
- [x] Sem auth nenhum: comportamento atual preservado (redirect pro login).
- [x] Suíte completa + typecheck verdes; deploy só com OK explícito do dono.

## Validação

```bash
cd C:/repos/expert-brain && npx vitest run test/media-web.test.ts && npm run typecheck
```

Pós-deploy: upload real de um PNG >15KB via curl com PAT, conferindo `content_hash` contra `sha256sum` local (o caso exato que corrompia).

## Arquivos afetados

- `src/web/media.ts` (authMedia + gates PAT), `src/media/store.ts` (param `canSeePrivate`), `src/mcp/tools/attach-media.ts` e `src/mcp/instructions.ts` (documentação do caminho direto), `test/media-web.test.ts` (novo).

## Riscos e reversão

- **Risco:** PAT vazado ganharia superfície de escrita de mídia além do MCP. Mitigação: mesmos escopos/revogação da spec 17 (validateApiKey), rota já limitada a 50MB, dedup por hash não permite sobrescrever blob alheio.
- **Reversão:** reverter o commit — a rota volta a sessão/GRAPH_EXPORT apenas; nenhuma migration, nenhum dado novo.
