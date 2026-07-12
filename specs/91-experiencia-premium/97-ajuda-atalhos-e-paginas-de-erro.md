# Descoberta de atalhos ("?") e páginas 404/erro com marca

> **Status:** draft · **Prioridade:** P2 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** nenhuma

## Contexto

O console tem atalhos de teclado reais (Ctrl+K palette, Ctrl+B sidebar — visível no
`title` de `src/web/render.ts:84` — e navegação/criação rápidas no `shell.ts`), mas
nenhuma superfície os revela: não existe tela/modal de ajuda, e o único hint é
`title=""` em hover.

Já as rotas não encontradas respondem `new Response('Não encontrado', { status: 404 })`
— texto puro sem layout — em `src/web/worker.ts:62` e `src/web/handler.ts:349`.

## Problema / Motivação

- Poder invisível: usuário descobre a palette por acidente ou nunca; o investimento das
  specs `50-console-v2/66` e `91-experiencia-premium/93` rende menos do que custa.
- `worker.ts:62` / `handler.ts:349`: errar uma URL dentro de um produto "premium" joga o
  usuário numa página de texto cru sem caminho de volta — quebra imediata de confiança.

## Objetivo

Todo atalho é descobrível em 1 tecla (`?`) e nenhuma resposta de navegação sai sem a
marca e um caminho de volta.

## Design proposto

1. **Cheatsheet de atalhos** (modal `.modal` do design system):
   - Abre com `?` (Shift+/) fora de campos de texto, e por item "Atalhos" no menu/config.
   - Conteúdo gerado de uma LISTA ÚNICA de atalhos (constante em `shell.ts`) — a mesma
     estrutura que faz os binds passa a alimentar o modal; atalho novo entra na lista e
     aparece na ajuda de graça (nada de tabela mantida à mão que envelhece).
   - Agrupar por contexto (Global / Board / Nota) e mostrar `Ctrl`/`⌘` conforme a
     plataforma.
2. **Página 404 com marca**: helper `notFoundPage(req)` em `src/web/layout.ts`
   renderizando layout mínimo (logo, "Página não encontrada", botão pra `/app` e busca)
   — substitui as duas ocorrências de texto puro (`worker.ts:62`, `handler.ts:349`).
   Manter `status: 404` e `Cache-Control: no-store` (contrato de `handler.ts:212`
   sobre não cachear erro).
3. **Erro 5xx amigável**: no catch topo do handler, mesma casca com "Algo quebrou do
   nosso lado" + id curto de correlação no texto (o mesmo que for pro log), sem stack.
   Respostas de API/JSON e MCP NÃO mudam — só navegação HTML.

## Fora de escopo

- Central de ajuda/documentação (docs continuam externas).
- Onboarding (spec `92`) e telemetria de erro (spec `40-ops/43`).
- Customizar atalhos pelo usuário.

## Critérios de aceite

- [ ] `?` abre o cheatsheet em qualquer tela `/app/*`; `Esc` fecha; não dispara dentro de input/textarea/contenteditable.
- [ ] Todo atalho listado no modal funciona, e todo bind do shell aparece no modal (fonte única).
- [ ] `GET /app/rota-inexistente` autenticado: página 404 com marca, botão de volta, status 404 e `no-store`.
- [ ] Exceção forçada num handler de página (teste): casca 5xx com marca, sem stack trace no HTML.
- [ ] Rotas de API continuam respondendo texto/JSON como hoje (sem regressão de contrato).

## Validação

- Typecheck + vitest verdes; teste da rota 404 (status + content-type + no-store) e do
  filtro de contexto do `?`.
- Teste manual dos atalhos nas 3 telas principais.
- Gate de deploy: OK explícito do dono.

## Arquivos afetados

- `src/web/client/shell.ts` (lista única de atalhos + modal + bind `?`)
- `src/web/layout.ts` (casca 404/5xx)
- `src/web/worker.ts`, `src/web/handler.ts` (substituir as respostas de texto puro)
- `src/web/styles.ts` (só se o modal precisar de variante)

## Riscos e reversão

Baixo. O único cuidado real é o bind de `?` não sequestrar digitação (filtro de alvo).
Reversão: remover o modal e devolver as duas `Response` de texto.
