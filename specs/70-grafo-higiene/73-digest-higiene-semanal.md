# Digest de higiene do grafo — segunda-feira no Telegram

> **Status:** shipped (09/07/2026 — deploy ce412aab com OK do dono. Observação pendente: primeiro digest real na segunda 13/07 ~08:00 BRT no Telegram do dono) · **Prioridade:** P3 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** 72 (sem o re-pass, os "pares suspeitos" e "órfãs" reportados estão desatualizados). PR 3 do grupo 70 — o ÚLTIMO a entrar.

## Contexto

O dono só descobre a saúde do grafo quando roda um censo manual (skill curar-brain-semanal,
que continua existindo pra CURADORIA profunda com propostas de mutação). Falta o radar
passivo: um resumo semanal do que degradou, no mesmo canal onde ele já recebe o lembrete
diário de tasks (Telegram via `sendTelegram`, src/notify.ts — no-op seguro sem os secrets).

## Problema / Motivação

Sem observabilidade contínua, a higiene regride em silêncio entre censos: órfãs acumulam,
duplicatas passam do gate soft sem ninguém agir, contas que importam em massa sem
dedupe_key não são identificadas.

## Design

Novo módulo `src/digest/hygiene.ts` (mesmo bairro do resurface digest):

- `export const HYGIENE_MAX_CHARS = 1200` — o digest vai em mensagem PRÓPRIA (separada do
  lembrete diário), bem abaixo do teto de 4096 do Telegram.
- `export function shouldSendHygieneDigest(cron: string, nowMs: number): boolean` — true
  só quando `cron` é o diário (`'0 11 * * *'`) E `new Date(nowMs).getUTCDay() === 1`
  (segunda). Função pura pra ser testável sem forjar relógio no dispatch.
- `export async function buildHygieneDigest(env, nowMs): Promise<string>` — janela = 7
  dias. SQL puro, zero Vectorize/AI (mesma filosofia do resurface). Seções:
  1. **Órfãs novas** — notas de conhecimento criadas na janela com zero linhas na tabela
     `edges` (from_id OU to_id). Contagem + até 5 títulos.
  2. **Pares suspeitos** — `similar_edges` com `score >= DEDUP_MIN_SCORE` (0.80, importada
     da similarity) entre notas vivas SEM edge real entre si. Dedupe simétrico em JS
     (chave `[a,b].sort().join('|')` — `explicitPairKey` já existe). Top 5 por score.
  3. **Volume por conta** — notas criadas na janela agrupadas por `created_by`
     (NULL = "sessão do dono"), ordem decrescente. Identifica a conta que está importando
     sem higiene.
  4. **Whys preguiçosos** — edges criados na janela com `LENGTH(why) < 30`. Contagem + até
     3 exemplos truncados.
  Corte em `HYGIENE_MAX_CHARS` com reticências; seção vazia é omitida; semana limpa devolve
  uma linha única de "grafo saudável".

Privacidade: o canal é o Telegram do DONO (mesmo destino do lembrete de tasks) — notas
privadas ENTRAM no digest por design; nenhuma superfície de credencial terceira é tocada.

Wiring no fluxo diário do `runScheduled`: braço `waitUntil` PRÓPRIO (falha do digest de
higiene não pode derrubar lembrete de tasks nem resurface), gated por
`shouldSendHygieneDigest(cron, Date.now())`, enviando via `sendTelegram`.

## Arquivos afetados

- `src/digest/hygiene.ts` — novo (constante + 2 funções exportadas).
- `src/scheduled.ts` — waitUntil do digest de higiene no fluxo diário.
- `src/db/queries.ts` — queries das 4 seções (podem viver no próprio hygiene.ts se
  ficarem mais legíveis lá; decidir na implementação).
- `test/hygiene-digest.test.ts` — novo (TDD, escrito antes da implementação).

## Critérios de aceite

- [x] Órfãs da semana contadas e tituladas; nota com edge real não conta como órfã.
- [x] Par >= 0.80 sem edge real aparece 1x (dedupe simétrico); com edge real não aparece.
- [x] Volume por `created_by` presente, NULL rotulado como sessão do dono.
- [x] Whys < 30 chars da semana contados.
- [x] Digest nunca excede HYGIENE_MAX_CHARS.
- [x] `shouldSendHygieneDigest`: true só no cron diário em segunda-feira UTC.
- [x] Semana limpa gera mensagem curta de saúde, não mensagem vazia.
- [x] Suite completa verde + typecheck.

## Validação

`npx vitest run test/hygiene-digest.test.ts` + suite. Pós-deploy (OK do dono): aguardar a
segunda-feira seguinte OU disparar `buildHygieneDigest` via rota de admin/wrangler pra
conferir o texto real contra o vault de produção.
