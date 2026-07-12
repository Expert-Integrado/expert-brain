# Dashboard "Seu cérebro este mês": superfície de valor percebido

> **Status:** draft · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma dura · suave: `80-frota-agentes/89` (fleet view — compartilham queries de atividade)

## Contexto

O Brain acumula valor silenciosamente: notas capturadas, edges criados, tasks fechadas
por agentes, digest resurfando conhecimento. NADA disso é mostrado ao dono de forma
agregada — o `stats` do MCP dá contagens brutas pro agente, e o console não tem nenhuma
superfície de "quanto isso está me rendendo".

Dados já existentes, sem coleta nova:

- `notes` (created_at, kind, domains, created_by/updated_by por credencial).
- `edges` (criação de conexões).
- `task_activity` (`src/db/task-activity.ts`) — log por task: quem fez o quê, quando.
- `api_keys.last_used_at` (`src/db/migrate.ts:91`) por agente.
- Inbox resolvido, digest enviado (push), comentários.

## Problema / Motivação

Retenção de produto premium vem de valor VISÍVEL e recorrente. Hoje um usuário ativo há
3 meses não tem uma única tela que diga "seu segundo cérebro cresceu X, seus agentes te
pouparam Y" — o produto trabalha e não mostra o trabalho. (É também a tela de demo que
falta: o grafo impressiona, mas não quantifica.)

## Objetivo

Uma superfície mensal que responda em 10 segundos: "o que entrou no meu cérebro, o que
se conectou, e o que meus agentes fizeram por mim" — no mês corrente vs o anterior.

## Design proposto

1. **Card resumo na home** (sistema de cards de `src/web/home.ts`): 3-4 números do mês
   corrente com delta vs mês anterior (notas capturadas, conexões criadas, tasks
   concluídas) + link "ver detalhes".
2. **Página `/app/insights`** com o mês navegável (anterior/próximo):
   - **Captura**: notas por semana (gráfico de barras leve, SVG/CSS inline — zero lib),
     divisão por kind e por domínio (top 5, com as cores de `domain-colors.ts`).
   - **Conexão**: edges criados; nota mais conectada do mês.
   - **Execução**: tasks concluídas — divididas em "por agente" vs "pelo dono" (via
     `task_activity`/autoria por credencial); tempo médio em "Validação humana" se a
     coluna existir.
   - **Frota**: total de ações de agentes no mês (writes por credencial de agente),
     linkando pro fleet view (`80-frota-agentes/89`) quando existir.
3. **Implementação**: `src/web/insights.ts` (rota + render server-side) + módulo de
   queries agregadas (`GROUP BY` sobre created_at/completed_at em janelas mensais BRT —
   reusar a convenção de fuso já usada nos filtros "hoje"). Cache do payload mensal no
   KV com TTL curto (1h) pra não pesar o D1 a cada visita; mês fechado cacheia mais.
4. **Privacidade**: números agregados apenas; títulos de notas aparecem só no destaque
   "mais conectada" e respeitam o flag `private` (nota privada nunca aparece nomeada).

## Fora de escopo

- Exports/relatórios em PDF ou e-mail mensal (candidata a spec futura).
- Metas/gamificação (streaks, badges).
- Métricas por domínio customizadas ou query builder.
- Telemetria de uso do console (page views etc.) — só dados do grafo/tasks.

## Critérios de aceite

- [ ] Home mostra o card resumo com 3+ métricas do mês e delta vs mês anterior.
- [ ] `/app/insights` renderiza o mês corrente com captura/conexão/execução e navega pra meses anteriores.
- [ ] Divisão dono vs agente confere com uma contagem manual via SQL em base seedada de teste.
- [ ] Nota privada nunca aparece nomeada na página.
- [ ] Janela mensal calculada em BRT (nota criada dia 1º 00:30 BRT conta no mês novo).
- [ ] Payload da página < 100KB; sem dependência JS nova.

## Validação

- Typecheck + vitest verdes; testes das queries agregadas (janela BRT, autoria
  dono/agente, exclusão de deletadas) com seed determinístico.
- Teste manual com o vault dev seedado comparando números contra SQL direto.
- Gate de deploy: OK explícito do dono.

## Arquivos afetados

- `src/web/insights.ts` (novo), `src/web/handler.ts` (rota), `src/web/render.ts` (nav)
- `src/web/home.ts` (card resumo)
- `src/db/queries.ts` ou novo `src/db/insights-queries.ts` (agregações)
- `src/web/styles.ts` (gráfico de barras CSS/SVG)

## Riscos e reversão

Read-only sobre dados existentes — risco de regressão zero fora da própria página.
Atenção a custo de query em vaults grandes (usar índices existentes em created_at;
medir com `EXPLAIN QUERY PLAN` antes de fechar). Reversão: remover rota + card.
