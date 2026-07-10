# Runbook de restore — reconstruir o Expert Brain a partir de um snapshot

> Par do backup automático (specs/50-console-v2/67-backup-export.md). O snapshot
> semanal grava um JSONL por tabela + `manifest.json` no R2 da instância
> (`backups/<YYYY-MM-DD>/`, últimos 8 mantidos); o botão **Baixar export** em
> `/app/config` entrega o MESMO conteúdo em ZIP.
>
> **Restore NUNCA é endpoint do Worker.** É uma operação manual e deliberada do
> dono da instância — uma rota de restore seria uma superfície de destruição do
> vault inteiro.

## O que o snapshot contém (e o que não contém)

| Está no snapshot | Não está — e por quê |
|---|---|
| Todas as tabelas de dados do D1 (`notes`, `tags`, `edges`, `similar_edges`, `note_media`, `meta`, `api_keys`, `_migrations`), 1 JSONL por tabela | Índice FTS (`notes_fts*`): regenerado automaticamente pelos triggers ao reinserir `notes` |
| `manifest.json`: versão de schema (último id de `_migrations`), contagem por tabela, timestamp, keys de mídia | Vectorize: regenerável a partir do D1 (passo 7) |
| Referência às keys de mídia (`media_r2_keys`) | Blobs de mídia: já vivem no MESMO bucket R2 do backup — não são recopiados (passo 8) |
| Hashes das API keys | PATs em plaintext: irrecuperáveis por design — recrie as chaves (passo 9) |

## Pré-requisitos

- `wrangler` autenticado na conta Cloudflare de destino (`npx wrangler whoami`).
- Node 18+.
- Um snapshot em mãos, num diretório local:
  - **Do export**: descompacte o ZIP baixado em `/app/config` → "Baixar export".
  - **Do R2**: baixe os objetos do prefixo desejado, ex.:
    ```bash
    npx wrangler r2 object get expert-brain-media/backups/2026-07-06/manifest.json --file snapshot/manifest.json
    # repita pra cada <tabela>.jsonl listado em manifest.tables
    ```

## Passo a passo

1. **Crie o D1 novo** (nunca restaure por cima de um banco com dados):
   ```bash
   npx wrangler d1 create expert-brain
   ```
   Anote o `database_id` e coloque no `wrangler.toml` da instância nova
   (copie de `wrangler.example.toml` ou rode `npm run setup`).

2. **Suba o Worker e provisione o schema** (migrations idempotentes):
   ```bash
   npm run deploy          # gate: deploy SÓ com OK do dono da instância
   curl -X POST https://<sua-instancia>/setup/provision
   ```
   Alternativa local (ensaio sem deploy): `npx wrangler dev` + `curl -X POST http://localhost:8787/setup/provision`.

3. **Confira a versão do schema**: o código da instância nova precisa conter a
   migration `manifest.json → schema_version` (ou mais nova). Se o snapshot é
   mais novo que o código, atualize o código ANTES de importar.

4. **Gere os lotes de import** (só gera arquivos, não toca no banco):
   ```bash
   node scripts/restore-from-snapshot.mjs ./snapshot --db expert-brain
   ```
   Saída: `snapshot/restore-sql/NNN-<tabela>-K.sql` (INSERTs em lotes, ordem que
   respeita as FKs — `notes` antes de `tags`/`edges`/`note_media`). A tabela
   `_migrations` NÃO é importada: o provision do passo 2 já a populou.

5. **Limpe os seeds do provision e importe** (o script executa os lotes na
   ordem e para no primeiro erro). O provision do passo 2 SEMEIA linhas em
   `kanban_columns` (4 colunas) e `users` (perfil do dono) que também existem no
   dump — esvazie essas duas tabelas antes do import, senão o INSERT colide:
   ```bash
   npx wrangler d1 execute expert-brain --remote --command "DELETE FROM task_assignees; DELETE FROM users; DELETE FROM kanban_columns"
   node scripts/restore-from-snapshot.mjs ./snapshot --db expert-brain --run --remote --verify
   ```
   - Sem `--remote` executa no D1 local do wrangler (bom pra ensaiar o runbook).
   - Se falhar no meio: o banco pode ter ficado parcial — **recomece do zero**
     (delete e recrie o D1). Não re-rode por cima sem `--or-replace`, e evite
     `--or-replace` em `notes` (REPLACE pode deixar entrada órfã no índice FTS).

6. **Valide as contagens** contra o manifest (o `--verify` acima já faz):
   `SELECT COUNT(*) FROM <tabela>` deve bater com `manifest.tables.<tabela>`
   pra TODAS as tabelas importadas.

7. **Regenere o Vectorize** (embeddings + arestas de similaridade):
   - Reembed por nota: conecte um agente MCP na instância e rode a tool
     `reembed` pra cada id de `notes.jsonl` (loop simples; idempotente).
   - Depois, arestas de similaridade em lote:
     ```bash
     # repita seguindo o cursor devolvido até "done": true
     curl -X POST "https://<sua-instancia>/setup/backfill-similar?after=<cursor>"
     ```
   - O `recall` volta a funcionar conforme o índice repopular (~minutos).

8. **Mídia (R2)**: os blobs não estão no snapshot. Se o bucket original existe,
   basta apontar o binding `MEDIA` da instância nova pro mesmo bucket. Se o
   bucket se perdeu, `manifest.media_r2_keys` lista exatamente o que faltou —
   as linhas de `note_media` restauradas apontam pra essas keys.

9. **API keys**: os PATs não são recuperáveis (o D1 só guarda hash). Recrie as
   chaves em `/app/config` → "Agentes externos e automações" e atualize os
   clientes (VPS, OpenClaw etc.).

10. **Sanidade final**: abra `/app/config` (Status do vault: notas/conexões
    devem bater com o manifest), `/app/graph`, `/app/tasks` e faça um `recall`
    de teste via MCP.

## Reversão

O restore acontece numa instância/banco NOVOS — a origem (se ainda existir) não
é tocada. Descartar um restore malfeito = deletar o D1 novo e repetir. Os
snapshots no R2 são dados do dono: nunca os apague como parte de uma reversão.

## Restore a partir do off-site (spec 50-console-v2/69)

Os snapshots também são espelhados semanalmente pra FORA da Cloudflare (VPS do
dono em `/var/backups/offsite/expert-brain/` + Google Drive, pasta
`Backups/expert-brain/`, via `backup-offsite.sh` — cron de terça na VPS). O
runbook acima funciona **igual** a partir dessa cópia: baixe o diretório do
snapshot (`<YYYY-MM-DD>/` com `manifest.json` + os `.jsonl`) do Drive ou da VPS
e aponte o `restore-from-snapshot.mjs` pra ele. Nenhum passo de LEITURA do
backup depende da Cloudflare.
