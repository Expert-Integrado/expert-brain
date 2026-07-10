# Backup off-site: rotina externa que copia os snapshots pra FORA da Cloudflare

> **Status:** shipped (10/07/2026 — token S3 read-only criado pelo dono e guardado no cofre; credenciais injetadas no servidor externo; 1ª execução real verificada: snapshots dos 2 Workers espelhados em disco + nuvem alheia, manifests validados; teste de escrita NEGADA confirmado (403); drill de restore ponta a ponta a partir da cópia off-site com contagens 14/14 batendo o manifest) · **Prioridade:** P1 · **Esforço:** M · **Repo:** ops (servidor externo do dono) — zero código nos Workers
> **Depende de:** `50-console-v2/67` (os snapshots que esta rotina copia). **Exige o dono no loop** (criar tokens R2 e autorizar o destino em nuvem).
> **Agente sugerido:** Opus · **Esforço de execução:** padrão

## Contexto

- A spec `67` (implementada) gera snapshot semanal completo dos dois D1 (Brain e Contacts) em JSONL + manifest, gravado no **R2 da própria conta Cloudflare** (`backups/<YYYY-MM-DD>/`, retenção 8), + export manual em ZIP pelo console (sessão).
- Cobertura atual: perda/corrupção de DADOS (restaura de um snapshot). **NÃO cobre perda da CONTA** (bloqueio, comprometimento, erro administrativo, fim do serviço): R2 e D1 caem juntos. A `67` deixou a perna externa explicitamente fora de escopo ("automação externa é operação") — esta spec é essa perna.
- O R2 expõe **API S3-compatível** com tokens de acesso próprios (criados no dashboard, escopo por bucket, permissão read-only) — dá pra puxar os snapshots de fora sem tocar nos Workers e sem passar pelo endpoint de export (que é sessão-only, por design).
- O dono tem um servidor Linux externo sempre-ligado com cron (fora da Cloudflare) e usa Google Drive corporativo. Detalhes de host/credenciais NÃO entram nesta spec (repo é distribuível) — o executor obtém do dono/cofre de senhas na execução.

## Problema / Motivação

- Hoje, conta Cloudflare perdida = segundo cérebro inteiro perdido (dados + backups no mesmo blast radius). O export manual existe, mas depende de disciplina humana — backup que depende de lembrar não é backup.
- Regra 3-2-1 mínima: os snapshots precisam existir em pelo menos UMA localização fora da Cloudflare, atualizada automaticamente.

## Design proposto

### 1. Credenciais (ação do dono, guiada pelo executor)

- Criar no dashboard Cloudflare **um token S3 do R2 read-only** com escopo restrito aos buckets dos dois Workers (ou um token por bucket). Guardar no cofre de senhas do dono; injetar no servidor externo como variável de ambiente/arquivo de config do rclone com permissão 600. NUNCA em texto plano em repo/chat.
- Destino em nuvem: remote do **rclone** pro Google Drive do dono (OAuth feito pelo dono uma vez, token do rclone fica no servidor). Pasta dedicada, ex.: `Backups/expert-brain/` e `Backups/expert-contacts/`.

### 2. Rotina no servidor externo (cron semanal)

Script único (`backup-offsite.sh`, idempotente, versionado no repo de infra do dono — NÃO neste repo):

1. `rclone sync r2:<bucket-brain>/backups/ <dir-local>/expert-brain/` e idem contacts — espelha TODOS os snapshots retidos (a retenção 8 da `67` vale como fonte; o sync propaga remoções).
2. `rclone copy <dir-local>/ gdrive:Backups/` — segunda cópia na nuvem alheia à Cloudflare.
3. **Verificação real, não fé**: pro snapshot mais recente de cada Worker, ler o `manifest.json` baixado e validar (a) JSON parseia, (b) todos os `.jsonl` listados existem no destino com tamanho > 0, (c) data do snapshot tem menos de 8 dias (detecta cron da 67 parado).
4. Agendar DEPOIS do horário dos snapshots da `67` (que rodam segunda de madrugada) — ex.: terça de madrugada.

### 3. Alerta de falha (sem silêncio)

- Qualquer passo falhou OU verificação reprovou → notificação ativa pro dono pelo canal de alerta que o servidor já usa (bot de mensagens existente). Sucesso = silêncio (no máximo linha de log com timestamp e bytes).
- Log em arquivo com rotação simples (últimas ~50 execuções).

### 4. Restore a partir do off-site

- Adendo no `docs/restore.md` dos dois repos (1 parágrafo): o runbook da `67` funciona igual a partir da cópia off-site — baixar o diretório do snapshot do Google Drive/servidor e apontar o `restore-from-snapshot.mjs` pra ele. Nenhuma dependência da Cloudflare pra LER o backup.

## Fora de escopo

- Mudanças em qualquer Worker (a `67` já expõe tudo que é preciso via R2).
- Backup de mídia R2 completo (as keys estão referenciadas no manifest; cópia de mídia pro off-site é iteração futura — o conhecimento em si está 100% nos JSONL).
- Cofre/criptografia adicional no destino (Google Drive do dono já é autenticado; avaliar cripto client-side se um dia houver dado de terceiros).
- Agendamento na máquina Windows do dono (proibido por convenção do ambiente; a rotina vive no servidor Linux externo).

## Critérios de aceite

- [x] Token R2 read-only com escopo mínimo criado e testado (10/07/2026: listagem e download de `backups/` ok na 1ª execução real; PUT explicitamente NEGADO com 403 AccessDenied).
- [x] Cron semanal no servidor externo roda o script (instalado 10/07/2026, terça de madrugada — depois dos snapshots de segunda); 1ª execução real ok com os 2 Workers espelhados (disco + nuvem).
- [x] Verificação: manifest válido, JSONL presentes com tamanho > 0, snapshot < 8 dias — implementada no script; alerta real testado com falha forçada em 10/07/2026 (canal de alerta do dono recebeu). Na 1ª execução real a verificação foi corrigida pra tratar os DOIS shapes de manifest (brain e contacts) e falhar explicitamente em parse ilegível.
- [x] Snapshot recém-baixado do off-site passa no `restore-from-snapshot.mjs --verify` num banco local limpo (drill de 10/07/2026: 7.006 notas, contagens 14/14 batendo o manifest; 3 fixes de gerador descobertos e corrigidos — ver docs/restore.md).
- [x] Nenhum secret em texto plano em repo, log ou chat (secrets via `/etc/environment.d/expert.conf` 600; remote R2 do rclone definido por env vars em runtime, nada gravado em rclone.conf).
- [x] `docs/restore.md` dos dois repos ganha o parágrafo do restore off-site (10/07/2026).

## Validação

- Execução manual do script fim-a-fim (primeira carga), depois 1 ciclo real de cron observado.
- Teste de negação: token R2 tentando PUT → erro de permissão.
- Simulação de desastre (tabletop): com a Cloudflare "indisponível", confirmar que o caminho Google Drive → restore local funciona só com o que existe fora dela.

## Arquivos afetados

- Servidor externo do dono: script + entrada de cron + config rclone (repo de infra do dono, fora desta árvore).
- expert-brain e expert-contacts: `docs/restore.md` (parágrafo off-site) — única mudança nos repos.

## Riscos e reversão

- **Risco**: token R2 vazar. Mitigação: read-only + escopo por bucket; rotação registrada no cofre; snapshots não contêm secrets recuperáveis (PATs são hashes, anotado no manifest da 67).
- **Risco**: rotina apodrecer em silêncio (o clássico de backup). Mitigação: verificação com alerta ativo em falha é critério de aceite, não opcional; o check de "snapshot < 8 dias" pega até a 67 parada.
- **Reversão**: remover cron + revogar token R2 + apagar remotes — zero efeito nos Workers.
