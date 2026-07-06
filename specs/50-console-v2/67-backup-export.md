# Backup e portabilidade: snapshot automático do D1 pro R2 + export manual do dono

> **Status:** in-progress · **Prioridade:** P1 · **Esforço:** M · **Repo:** ambos (expert-brain + expert-contacts, mesmo padrão nos dois)
>
> **Estado 05/07/2026 — IMPLEMENTADA nos dois repos, aguardando validação do dono:** brain em `feat/67-backup` (4 commits, topo `21ec142`, 357 testes verdes) e contacts em `feat/67-backup` (4 commits, topo `ac9923d`, 125 testes verdes). Falta: (1) validação manual `wrangler dev` (backup agora + inspecionar ZIP); (2) **adicionar `"0 5 * * 1"` ao `wrangler.toml` LOCAL do brain** (arquivo gitignored — o agente só pôde atualizar o `wrangler.example.toml`); (3) merge das branches; (4) deploy com OK do dono; (5) conferir 1º snapshot real contra `stats`. Desvios aceitos registrados nos relatórios: dispatch extraído pra `src/scheduled.ts` (brain), resultado em KV `backup:last` no contacts (repo não tem tabela meta), export ZIP bufferizado sem gravar no R2.
> **Depende de:** nenhuma (independente de todas as ondas; pode rodar a QUALQUER momento — quanto antes melhor)
> **Agente sugerido:** Opus (dados + cron + runbook de restore) · **Esforço de execução:** ultrathink

## Contexto

- TODO o segundo cérebro vive em D1 (notas/edges/tasks/menções no Brain; entidades/canais/eventos no contacts) + R2 (mídia) + Vectorize (regenerável por reembed). **Não existe NENHUM backup além do que a Cloudflare faz internamente** (Time Travel do D1 cobre ~30 dias de point-in-time, mas é da plataforma — não protege contra conta comprometida/suspensa nem dá portabilidade).
- Os dois workers já têm cron diário (`wrangler.toml` — Brain `0 11 * * *` → `scheduled()` em `src/index.ts:46`; contacts `0 9 * * *` → `src/index.ts:638`) e bucket R2 vinculado (`MEDIA` no Brain; bucket próprio no contacts).
- `scheduled()` de ambos hoje faz UMA tarefa; múltiplos crons exigem dispatch por `controller.cron` dentro do handler.

## Problema / Motivação

- Se a conta Cloudflare tiver problema (bloqueio, comprometimento, erro administrativo), o segundo cérebro morre junto — anos de conhecimento sem cópia externa acessível.
- Não há export pro DONO: nenhum jeito de baixar "tudo que é meu" num formato legível/portável (requisito também pro produto distribuído aos alunos).

## Design proposto

### 1. Módulo `src/backup/snapshot.ts` (mesmo desenho nos dois repos)

`runSnapshot(env): Promise<SnapshotResult>`:

- Dump de TODAS as tabelas de dados (excluir `_migrations` não — incluir; excluir só tabelas de cache/sessão efêmera) via `SELECT *` paginado (lotes de 500 linhas, cursor por rowid/PK — respeita limites de CPU do Worker).
- Formato: **JSON Lines por tabela** (`<tabela>.jsonl`) + `manifest.json` (versão do schema = último id de `_migrations`, contagens por tabela, timestamp) — formato mecanicamente restaurável e legível.
- Gravação: R2 no prefixo `backups/<YYYY-MM-DD>/...` (bucket existente; no Brain usar o `MEDIA` com prefixo dedicado — mídia já está no R2, o snapshot NÃO recopia mídia, só referencia as keys no manifest).
- **Retenção**: manter os últimos 8 snapshots; o 9º mais antigo é apagado ao final de um snapshot BEM-SUCEDIDO (nunca apagar antes de gravar o novo).
- Vectorize NÃO entra no snapshot (regenerável: `reembed`/`handleReembedAll` a partir do D1 — anotar no manifest).

### 2. Agendamento (cron adicional, sem tocar o existente)

- `wrangler.toml`: adicionar segunda expressão — Brain: `crons = ["0 11 * * *", "0 5 * * 1"]` (snapshot semanal, segunda 2h BRT); contacts equivalente. `scheduled()` passa a fazer dispatch: expressão do digest/rotina atual → fluxo atual; expressão nova → `runSnapshot` (com `ctx.waitUntil` e try/catch — falha de snapshot loga e NÃO afeta o resto).
- Resultado (ok/falha + contagens) gravado na tabela `meta` (chave `last_backup`) pra UI.

### 3. Export manual do dono (console)

- Seção "Backup" em `/app/config`: status do último snapshot (data, tamanho, contagens — lido da `meta`), botão **"Fazer backup agora"** (POST sessão → `runSnapshot`) e botão **"Baixar export"** → `GET /app/export` (sessão) que gera o snapshot on-demand e responde um ZIP dos JSONL (streaming; se o tamanho estourar o limite de resposta, devolver link R2 assinado de curta duração — decidir na execução pelo tamanho real do vault).
- Export é a MESMA função do snapshot (fonte única) — sem formato divergente.

### 4. Runbook de restore (documentação, não endpoint)

Arquivo `docs/restore.md` em cada repo: passo a passo pra reconstruir do zero — criar D1 novo, rodar `/setup/provision` (migrations), importar JSONL por tabela (`wrangler d1 execute` em lotes gerados por script Node incluído em `scripts/restore-from-snapshot.mjs`), rodar reembed geral, revalidar contagens contra o manifest. **Restore NUNCA é endpoint do Worker** (superfície de destruição; é operação manual e deliberada do dono).

### 5. Segurança

- Snapshot contém TUDO (incluindo notas/contatos privados) — fica no MESMO R2 privado da instância (nenhum bucket novo, nenhuma URL pública). O download manual exige sessão; link assinado (se usado) expira em minutos. Nenhum secret vai pro snapshot (tabela `api_keys` guarda só hashes — incluir; anotar no manifest que os PATs não são recuperáveis, por design).

## Fora de escopo

- Backup cross-cloud (copiar pra fora da Cloudflare) — o export manual baixado pelo dono cumpre esse papel; automação externa (cron no PC baixando o export) é operação, não spec.
- Restore automatizado por endpoint (runbook manual, deliberadamente).
- Criptografia própria dos snapshots (R2 já cifra at-rest; o bucket é privado).
- Backup incremental/diferencial (semanal completo basta no volume atual).

## Critérios de aceite

- [ ] Snapshot gera 1 JSONL por tabela + manifest com contagens batendo (fixture com dados nos dois repos).
- [ ] Retenção: com 8 snapshots existentes, o 9º remove o mais antigo SOMENTE após sucesso do novo; snapshot falho não apaga nada.
- [ ] Cron: expressão nova dispara snapshot; a rotina diária existente segue intocada (teste com `controller.cron` forjado pros dois valores).
- [ ] `/app/config` mostra último backup; "Fazer backup agora" funciona; "Baixar export" entrega ZIP válido cujo conteúdo reimporta limpo num D1 vazio (teste do script de restore contra o export).
- [ ] `scripts/restore-from-snapshot.mjs` + `docs/restore.md`: seguindo o runbook num banco novo local, contagens finais = manifest.
- [ ] Endpoints exigem sessão; nenhum caminho público novo.

## Validação

- Nos DOIS repos: typecheck + testes verdes; teste de ida-e-volta (snapshot → restore → diff de contagens) com miniflare/banco local.
- Manual (`wrangler dev`): backup agora + baixar + inspecionar ZIP.
- **Gate de deploy:** os DOIS workers só com OK explícito do dono. Primeiro snapshot de produção: conferir manifest contra `stats` reais antes de confiar.

## Arquivos afetados (espelhado nos dois repos)

- `src/backup/snapshot.ts` (novo), `src/index.ts` (dispatch do scheduled), `wrangler.toml` (+cron)
- `src/web/config.ts`/equivalente (seção Backup) + rotas (`/app/export`, POST backup-now)
- `scripts/restore-from-snapshot.mjs` (novo), `docs/restore.md` (novo), `test/`

## Riscos e reversão

- **Risco**: vault crescer além do CPU-time do Worker no dump. Mitigação: paginação em lotes + medir no primeiro real; se estourar, quebrar por tabela em múltiplas invocações via Queue/cron (iteração futura — anotar limite observado).
- **Risco**: snapshot com privados baixado num dispositivo inseguro. Aceito e documentado na UI ("o export contém TUDO, inclusive privados").
- **Reversão**: revert do código + remover a expressão de cron; snapshots existentes ficam no R2 (dados do dono — não apagar na reversão).
