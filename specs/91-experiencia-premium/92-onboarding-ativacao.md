# Onboarding e ativação: checklist "Comece aqui" + empty states guiados

> **Status:** draft · **Prioridade:** P0 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma dura (usa `.empty-state` da `60-ux-reforma/64`; coordena com `91-experiencia-premium/93`)

## Contexto

O momento mais crítico de qualquer produto — o primeiro uso — está descoberto:

- O setup da instância é feito por agente/CLI. A única superfície web de "primeira vez" é
  `src/static/wizard.ts` (`renderNotConfigured`), uma página estática que AVISA que a
  instância não está configurada — não guia ninguém.
- Vault configurado mas vazio: a home mostra cards sem conteúdo, `/app/notes` imprime
  `'Nenhuma nota ainda.'` em parágrafo cru (`src/web/notes.ts:306`), o grafo vazio é um
  canvas escuro sem mensagem, e o board de tasks abre colunas vazias sem CTA.
- Os empty states BONS já existem em home/inbox (pós-onda 8) — o padrão `.empty-state`
  da biblioteca de componentes (`60-ux-reforma/64`) está pronto pra reuso.

Dados já disponíveis pra medir ativação sem telemetria nova: contagem de notas
(`notes`), chaves com uso (`api_keys.last_used_at`, `src/db/migrate.ts:91`), assinatura
de push (`push_subscriptions`, migration `0012`), preferências da home
(`src/web/home-prefs.ts`).

## Problema / Motivação

- `src/static/wizard.ts` — primeira tela possível do produto é um beco sem saída.
- `src/web/notes.ts:306` — empty state de texto cru na tela mais usada.
- Nenhuma tela responde "e agora?" pra um vault com 0 notas, 0 agentes conectados.

Um usuário (aluno) que recebe a instância pronta e abre o console pela primeira vez não
tem NENHUM caminho guiado até o primeiro valor (capturar nota, conectar agente).

## Objetivo

Usuário novo chega do primeiro login ao primeiro agente conectado e primeira nota
capturada sem abrir documentação externa.

## Design proposto

1. **Card "Comece aqui" na home** (novo card do sistema de cards existentes de
   `src/web/home.ts` + `home-prefs.ts`):
   - Checklist de ativação com 4 passos, cada um com CTA direto:
     1. *Conecte seu primeiro agente* → link pra `/app/config` (seção de chaves) com
        instrução de 1 linha e o comando `claude mcp add` copiável.
     2. *Capture sua primeira nota* → abre a palette em modo captura (ou link `/app/notes`).
     3. *Instale no celular* → CTA de instalação PWA já existente (spec `50-console-v2/68`).
     4. *Crie sua primeira task* → link pro board.
   - Estado de cada passo é DERIVADO dos dados (sem tabela nova):
     `EXISTS(api_keys WHERE last_used_at IS NOT NULL)`, `COUNT(notes) > 0` (kind != task),
     `EXISTS(push_subscriptions)` como proxy de instalação, `COUNT(kind='task') > 0`.
   - Passo concluído ganha check; card some sozinho quando os 4 completam, e é
     dispensável manualmente (persistir dismiss em `home-prefs`, mesmo mecanismo dos cards).
2. **Empty states guiados nas telas-núcleo**, todos com o componente `.empty-state`
   (ícone + título + 1 frase + botão):
   - `/app/notes` (`src/web/notes.ts:306`): "Nenhuma nota ainda" + botão "Capturar nota"
     + dica de captura via agente.
   - `/app/tasks`: coluna/board vazio → "Nenhuma task ainda" + botão criar task.
   - `/app/graph`: 0 nós → overlay central "Seu grafo nasce da segunda nota" + CTA.
   - `/app/contacts`: sem contatos → CTA apontando a integração.
3. **`renderNotConfigured` (`src/static/wizard.ts`)** ganha o mesmo tratamento visual da
   marca (tokens do design system) e passos concretos de setup pro dono — continua
   estático, mas vira porta de entrada, não aviso.

## Fora de escopo

- Tour guiado passo a passo (product tour com tooltips) — custo alto, valor duvidoso aqui.
- Telemetria/analytics de funil — sem coleta nova de dados.
- Vídeos/GIFs embutidos (CSP + peso).
- Mudar o fluxo de setup por agente (continua sendo o caminho canônico).

## Critérios de aceite

- [ ] Vault zerado (seed vazio no wrangler dev): home mostra o card "Comece aqui" com os 4 passos pendentes.
- [ ] Conectar uma chave e usá-la 1x marca o passo 1 sem nenhuma ação manual.
- [ ] Card some quando os 4 passos completam; dismiss manual persiste entre sessões.
- [ ] `/app/notes`, `/app/tasks`, `/app/graph` e `/app/contacts` vazios renderizam `.empty-state` com CTA funcional (nada de parágrafo cru).
- [ ] Vault populado: nenhuma regressão visual nas 4 telas (empty state não aparece).
- [ ] Zero requisição externa nova; zero migration.

## Validação

- Typecheck + vitest verdes; teste novo cobrindo a derivação dos 4 estados do checklist.
- Teste manual guiado: instância dev zerada, percorrer o checklist inteiro até o card sumir.
- Gate de deploy: OK explícito do dono antes de subir pra produção.

## Arquivos afetados

- `src/web/home.ts`, `src/web/home-prefs.ts`, `src/web/client/home.ts` (card + estado)
- `src/web/notes.ts`, `src/web/tasks.ts`, `src/web/graph.ts` (empty states)
- `src/web/styles.ts` (só se `.empty-state` precisar de variante; preferir reuso)
- `src/static/wizard.ts` (porta de entrada com marca)

## Riscos e reversão

Card é aditivo e derivado de dados — remover o card e os empty states restaura o
comportamento atual. Sem migration, sem estado novo além de uma chave em `home-prefs`.
