# Busca no celular: abrir a command palette sem teclado físico

> **Status:** done · **Prioridade:** P0 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** nenhuma (a palette já existe — `50-console-v2/66`)

## Contexto

A busca unificada (notas + tasks + contatos + ações rápidas) vive na command palette,
implementada em `src/web/client/shell.ts`. O produto é mobile-first de captura (PWA
instalável, share target, push) — mas a palette só abre por atalho de teclado.

## Problema / Motivação

- `src/web/client/shell.ts:534-535`: o ÚNICO gatilho da palette é
  `(e.ctrlKey || e.metaKey) && e.key === 'k'`. Num celular isso não existe.
- `src/web/render.ts` (shell/sidebar/bottom-nav): nenhum item de busca — a navegação tem
  Início/Grafo/Notas/Tarefas/Contatos/Config (`src/web/render.ts:78-85`), busca não.
- Resultado: a feature mais cara do console (busca unificada) é INACESSÍVEL em mobile,
  exatamente onde a captura rápida mais importa.

## Objetivo

Abrir a busca em qualquer tela com 1 toque no celular e 1 clique no desktop, sem
regressão do atalho Ctrl+K.

## Design proposto

1. **Botão de busca na navegação** (`src/web/render.ts`):
   - Desktop: item "Buscar" na sidebar (ícone lupa no padrão `SIDEBAR_ICONS`), acima de
     Início, com hint visual `Ctrl+K` no label.
   - Mobile: ícone de lupa no bottom-nav (mesmos traços dos ícones existentes — o
     comentário em `render.ts:15` já exige consistência sidebar/bottom-nav).
   - O botão dispara a MESMA função de abertura da palette (expor um
     `openPalette()` público em `shell.ts` em vez de duplicar lógica).
2. **Palette touch-friendly** (`src/web/client/shell.ts` + `src/web/styles.ts`):
   - Em viewport estreito: palette ancorada no TOPO da tela (não centro) pra não ser
     coberta pelo teclado virtual; input com `autofocus` ao abrir.
   - Alvos de toque dos resultados com altura mínima 44px.
   - Fechar por toque no backdrop (além do Esc já existente).
   - `type="search"` + `enterkeyhint="search"` no input pro teclado mobile correto.
3. Nenhuma mudança no ranking/fonte de resultados — só acesso e ergonomia.

## Fora de escopo

- Mudar o conteúdo/ranking da busca (coberto por `50-console-v2/66`).
- Busca por voz, filtros avançados.
- FAB flutuante de captura (avaliar depois; o bottom-nav resolve o acesso).

## Critérios de aceite

- [x] Em viewport mobile (visualização responsiva 390px), a lupa aparece no bottom-nav em todas as telas `/app/*` e abre a palette com 1 toque.
- [x] No desktop, o item "Buscar" na sidebar abre a palette; Ctrl+K continua funcionando idêntico (onKey intacto; o botão usa a MESMA openPalette).
- [x] Com teclado virtual aberto, o input e os 3 primeiros resultados permanecem visíveis (palette a 8px do topo, lista max-height 48dvh).
- [x] Toque no backdrop fecha a palette (já existia — listener no cmd-backdrop).
- [x] Zero regressão nos testes existentes do shell (suite completa 1159/1159 verde).

> Implementado em 11/07/2026: botão Buscar na sidebar + lupa na bottom-nav (`data-cmd-open`,
> delegação em `wireSearchTriggers`), input `type="search"` + `enterkeyhint="search"`,
> palette top-anchored no mobile com alvos 44px. Testes em `test/web/search-nav.test.ts`.

## Validação

- Typecheck + vitest verdes.
- Teste manual: wrangler dev + device emulation (iPhone/Android) percorrendo abrir →
  digitar → navegar até resultado nas telas home, notes e board.
- Gate de deploy: OK explícito do dono.

## Arquivos afetados

- `src/web/render.ts` (item de navegação + ícone)
- `src/web/client/shell.ts` (expor `openPalette()`, bind do botão, modo mobile)
- `src/web/styles.ts` (posicionamento mobile da palette, alvos de toque)

## Riscos e reversão

Puramente aditivo no client — reverter é remover o item de nav e o reposicionamento
CSS. Risco principal: quebra do layout do bottom-nav com 1 item a mais em telas muito
estreitas; validar em 320px.
