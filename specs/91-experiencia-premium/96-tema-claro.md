# Tema claro: segunda cartela de tokens + toggle

> **Status:** draft · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `60-ux-reforma/63` (tokens re-tematizáveis — done) · coordena com `60-ux-reforma/67` (gate AA)

## Contexto

A onda 2 da reforma reestruturou `src/web/styles.ts` (2.421 linhas) em camadas de tokens
exatamente PRA permitir retematização: primitivas (paleta bruta/fontes/raios) →
semânticas (superfícies, texto) → por-componente (comentário em `styles.ts:25-29`). Todos
os valores vivem em `:root` (`styles.ts:29`), e o `<meta name="theme-color">` espelha
`--bg` por contrato (`styles.ts:11`).

A retematização nunca foi exercida: existe UMA cartela (dark) e **zero** ocorrências de
`prefers-color-scheme` no arquivo.

## Problema / Motivação

- `grep -c "prefers-color-scheme" src/web/styles.ts` → `0`.
- Público executivo amplo espera escolher tema; uso diurno/projetor (aulas e demos do
  produto) sofre com dark-only.
- É a prova real de que a arquitetura de tokens da onda 2 funciona — se o tema claro
  exigir tocar componente, a camada semântica tem furo (e isso é bug a corrigir aqui).

## Objetivo

Tema claro completo com contraste AA, selecionável por toggle e respeitando a
preferência do sistema por padrão, sem NENHUMA mudança em CSS de componente.

## Design proposto

1. **Cartela clara** em `styles.ts`: bloco `[data-theme="light"]` sobrescrevendo SÓ as
   camadas primitiva/semântica (`--bg`, `--bg-mid`, superfícies `--surface-*`, escala de
   texto, bordas, sombras). Cores de domínio (`domain-colors.ts`) ganham variante clara
   apenas se falharem AA sobre as superfícies claras.
2. **Resolução do tema**: atributo `data-theme` no `<html>`, decidido por
   `localStorage.theme` (`light` | `dark` | `auto`, default `auto`); `auto` segue
   `prefers-color-scheme`. Script inline mínimo no `<head>` (antes do CSS pintar) pra
   evitar flash de tema errado — mesmo padrão de qualquer app com toggle.
3. **`theme-color` dinâmico**: atualizar o `<meta name="theme-color">` no client quando o
   tema muda (mantendo o contrato de `styles.ts:11`); usar dois metas com `media`
   (`prefers-color-scheme`) pro caso `auto`.
4. **Toggle**: item no rodapé da sidebar (`src/web/render.ts`) ciclando
   auto → claro → escuro, com ícone; espelhado na config.
5. **Superfícies especiais**: grafo 2D/3D (fundo do canvas vem de token? verificar
   `graph.ts`/`client/graph3d.ts` e ler o token no runtime), imagens/ilustrações dos
   empty states, e a página estática `src/static/styles.ts` (wizard) — decidir se o
   wizard também retematiza ou fica dark (aceitável; documentar).
6. **Gate AA**: rodar o mesmo gate de contraste da onda 6 (`60-ux-reforma/67`) sobre a
   cartela clara antes de considerar done.

## Fora de escopo

- Temas customizados/branding por instância (só claro/escuro/auto).
- Retematizar e-mails, digest do Telegram ou artefatos fora do console.
- Redesenhar componentes — se um componente precisar de CSS próprio pro tema claro além
  de token, isso é defeito da camada semântica e se corrige NA camada.

## Critérios de aceite

- [ ] Toggle na sidebar alterna auto/claro/escuro; escolha persiste entre sessões e abas.
- [ ] Em `auto`, mudar o tema do SO muda o console sem reload.
- [ ] Zero flash de tema errado no primeiro paint (testar com cache frio).
- [ ] Todas as telas `/app/*` legíveis no claro; gate AA da onda 6 passa nas duas cartelas.
- [ ] Grafo 2D e 3D com fundo/labels coerentes no tema claro.
- [ ] `theme-color` do PWA acompanha o tema ativo.
- [ ] Nenhum seletor de componente novo com cor hardcoded (review: diff só toca camadas de token + toggle).

## Validação

- Typecheck + vitest verdes; screenshot diff das telas principais nos dois temas
  (harness da onda 0, `60-ux-reforma/61`).
- Teste manual mobile (PWA instalado) verificando theme-color e teclado.
- Gate de deploy: OK explícito do dono.

## Arquivos afetados

- `src/web/styles.ts` (cartela light)
- `src/web/render.ts` / `src/web/layout.ts` (script inline no head, metas, toggle)
- `src/web/client/shell.ts` (lógica do toggle + persistência)
- `src/web/domain-colors.ts` (variantes AA se necessário)
- `src/web/graph.ts`, `src/web/client/graph.ts`, `src/web/client/graph3d.ts` (fundo por token)
- `src/static/styles.ts` (decisão documentada sobre o wizard)

## Riscos e reversão

Maior risco: contraste quebrado em cantos não cobertos pelo gate (badges de domínio,
estados hover). Mitigação: gate AA + screenshot diff. Reversão limpa: remover o bloco
`[data-theme="light"]` e o toggle devolve o dark-only atual.
