# Onda 2 — Fundação: tokens re-tematizáveis

> **Status:** ready · **Prioridade:** P0 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `60-ux-reforma/62-onda1-pesquisa-referencias-identidade.md`

## Contexto

`src/web/styles.ts` hoje exporta um único bloco `NEBULA_CSS` (definido a partir da linha 12, `:root { ... }` com as variáveis de tema nas linhas 13-34) que mistura tokens de design (cor, raio, fonte) com CSS de componente e de layout de página, tudo concatenado numa string gigante. Não há separação entre "o que muda se a identidade visual mudar" (paleta, raios, fontes) e "o que não muda" (estrutura de componente, layout). Isso é o que torna a Onda 6 (aplicar a identidade escolhida na Onda 1) arriscada: sem essa separação, trocar cor obrigaria caçar cada valor espalhado pelo arquivo inteiro.

O teste `test/web/polish.test.ts:28` asserta `expect(body).toBe(NEBULA_CSS)` contra o corpo do endpoint público `/app/styles.css` — essa igualdade byte-a-byte precisa continuar válida após a reestruturação (o export `NEBULA_CSS` precisa seguir existindo e servindo o CSS completo, mesmo que internamente seja composto de múltiplas constantes concatenadas).

## Problema / Motivação

- Tokens de cor/raio/fonte vivem soltos em `NEBULA_CSS` (`src/web/styles.ts:12-34`), SEM nenhum token de espaçamento (`--space-*`) nem de escala tipográfica (`--text-*`) — cada página define espaçamento e tamanho de fonte em valores literais (`px`) espalhados.
- Bug real de token inexistente: `color: var(--text-muted)` em `src/web/styles.ts:1653`, dentro do bloco `.local-graph-hops #local-graph-hops-value { ... }`. Os únicos tokens de texto secundário definidos são `--text-dim` (`styles.ts:19`, opacidade 0.58) e `--text-faint` (`styles.ts:20`, opacidade 0.35) — `--text-muted` nunca existiu, então o navegador ignora a declaração e usa a cor herdada (provavelmente `--text` sólido), quebrando a intenção visual de "texto secundário".
- `src/web/share.ts` inlina `NEBULA_CSS` INTEIRO 3 vezes via template string interpolada — confirmado em `src/web/share.ts:230` (`<style>${NEBULA_CSS}`), `share.ts:340` (`<style>${NEBULA_CSS}${SHARE_CSS}</style>`) e `share.ts:557` (`<style>${NEBULA_CSS}${SHARE_CSS}${NOTE_SHARE_CSS}</style>`) — em vez de servir o CSS externo cacheável que o resto do app usa via `/app/styles.css`. Isso infla o payload da página pública de compartilhamento (que é vista por quem NÃO tem sessão, potencialmente em conexão mais lenta) 3 vezes com o mesmo CSS completo, quando a página pública só precisa de um subconjunto.
- Não há preparo algum pra tema claro: o gradiente do body e o efeito de "grain" (ruído textural) estão hardcoded como valores literais, e o `theme-color` da meta tag em `src/web/render.ts:93` (a conferir na execução) não deriva de nenhum token — se a Onda 6 decidir por tema claro (direção C da Onda 1), hoje isso exigiria caçar cada valor manualmente.
- O critério de "o que sobe pro `NEBULA_CSS` global vs. o que fica CSS específico da página" nunca foi formalizado — o resultado observável é duplicação (ex. `.task-col-empty` definido em mais de um lugar, ver diagnóstico de `65-onda4-interacoes-dnd-clique-visibilidade.md` e `66-onda5-fix-list-por-tela.md`).

## Objetivo

`src/web/styles.ts` exporta `TOKENS_CSS`, `BASE_CSS`, `COMPONENTS_CSS`, `SHELL_CSS` e `SURFACES_CSS` como constantes separadas, com `export const NEBULA_CSS = TOKENS_CSS + BASE_CSS + COMPONENTS_CSS + SHELL_CSS + SURFACES_CSS` (ou equivalente) continuando a passar `test/web/polish.test.ts:28` byte-a-byte, mais uma nova `export const PUBLIC_CSS` (tokens + base + componentes, sem shell/surfaces) pronta pra `share.ts` consumir na Onda 5, e o bug `--text-muted` corrigido.

## Design proposto

### 1. Reestruturação em camadas

Dentro de `src/web/styles.ts`, dividir o conteúdo atual de `NEBULA_CSS` em constantes distintas, preservando a concatenação final:

- **`TOKENS_CSS`** — SÓ o bloco `:root { ... }` (paleta bruta, fontes, raios: o que muda entre identidades/temas). Reorganizado em 3 sub-camadas dentro do mesmo `:root`:
  - **Primitiva:** paleta bruta (`--bg`, `--bg-mid`, `--bg-accent`, `--accent-lav`, `--accent-cyan`, `--accent-pink`, `--accent-violet`, etc. — os valores hex/rgba atuais de `styles.ts:14-30`), fontes (`--font-display`, `--font-body`), raios (`--radius-sm/--radius/--radius-lg`).
  - **Semântica:** `--surface-0..3` (substituindo o `--surface`/`--surface-raised` atuais por uma escala), `--backdrop`, `--shadow-1..3`, `--text` / `--text-dim` (existente) / `--text-subtle` (NOVO, com contraste AA garantido — ver Onda 6) / `--text-faint` (existente, rebaixado explicitamente a "só decorativo, nunca conteúdo" no comentário do código), estados `--success`/`--warning`/`--danger`/`--info` cada um com variante `-bg`/`-border` via `color-mix()`, `--accent`/`--accent-2` com aliases pros nomes legados (`--accent-lav`, `--accent-violet`) continuarem funcionando sem quebrar CSS que ainda os referencia diretamente, `--prio-1..4` (cores de prioridade, hoje provavelmente hardcoded em `tasks.ts`).
  - **Escalas:** `--space-1..10` em base 4px (ex. `--space-1: 4px`, `--space-2: 8px`, ..., `--space-10: 40px`) — NOVO, não existe hoje. `--text-xs..2xl` (escala tipográfica) com `--leading-*` pareado (line-height correspondente a cada tamanho) — NOVO. `--density` (multiplicador, preparação pra densidade ajustável — sem UI de ajuste nesta onda, só o token existindo).
- **`BASE_CSS`** — reset (`* { box-sizing: border-box; }`, `*:focus`/`*:focus-visible` já existentes em `styles.ts:36-38`), `html, body` base.
- **`COMPONENTS_CSS`** — placeholder vazio ou com o mínimo que já existir de componente verdadeiramente global nesta onda; a Onda 3 é quem preenche isso de verdade. Criar a constante aqui evita que a Onda 3 precise reestruturar de novo.
- **`SHELL_CSS`** — CSS do shell (sidebar, bottom-nav, `.main`) que hoje vive misturado em `NEBULA_CSS`.
- **`SURFACES_CSS`** — o resto do CSS que hoje está em `NEBULA_CSS` e não se encaixa nas categorias acima (superfícies específicas que ainda não foram categorizadas — aceitável que essa categoria "resto" exista nesta onda e diminua nas ondas seguintes).
- **Critério de decisão "sobe pro global vs. fica por página":** um bloco de CSS sobe pro `NEBULA_CSS`/`COMPONENTS_CSS` quando o MESMO seletor ou padrão visual aparece em mais de uma página (ex. `.card`, `.btn`); fica no CSS específico da página (`TASKS_CSS` em `tasks.ts`, CSS inline em `notes.ts`, etc.) quando é layout único daquela tela.

### 2. Nova `PUBLIC_CSS`

```ts
export const PUBLIC_CSS = TOKENS_CSS + BASE_CSS + COMPONENTS_CSS;
```

Não inclui `SHELL_CSS` (a página de compartilhamento não tem sidebar/bottom-nav) nem `SURFACES_CSS` específico do console logado. Consumida por `share.ts` na Onda 5 (`66-onda5-fix-list-por-tela.md`), substituindo as 3 interpolações de `NEBULA_CSS` completo.

### 3. Preparação de tema claro (sem implementar)

- O gradiente do body e o efeito de grain viram tokens (`--bg-gradient`, `--grain-opacity` ou equivalente) em vez de valores literais no meio da regra CSS — isso não muda a aparência atual (o valor do token É o valor literal de hoje), só torna o valor substituível.
- `theme-color` da meta tag (checar a localização exata em `src/web/render.ts` — a spec original do plano cita `render.ts:93`, reconferir no momento da execução pois o arquivo pode ter mudado) passa a derivar do token `--bg` em vez de um hex duplicado manualmente.
- NÃO implementar `[data-theme="light"]` de verdade nesta onda — só garantir que a estrutura de tokens semânticos (item 1, sub-camada "semântica") é suficiente pra suportar isso quando a Onda 6 decidir aplicar.

### 4. Fix do bug `--text-muted`

Em `src/web/styles.ts:1653` (reconferir a linha exata antes de editar — pode ter se deslocado com a reestruturação acima), trocar `color: var(--text-muted);` por `color: var(--text-dim);` (ou `--text-subtle`, se a sub-camada semântica nova definir esse token como o mais adequado pro contexto — o elemento é `#local-graph-hops-value`, um contador numérico secundário no painel do grafo).

## Fora de escopo

- Construir a biblioteca de componentes de verdade (`.card`, `.btn`, etc.) — isso é a Onda 3.
- Implementar tema claro funcional — só preparação de tokens, aplicação fica pra Onda 6 SE o dono escolher uma direção que o inclua.
- Mudar qualquer valor visual perceptível ao usuário nesta onda (exceto o fix pontual do `--text-muted`, que É uma correção de bug, não mudança de identidade) — esta onda é reestruturação interna, não redesenho.
- Migrar `TASKS_CSS`, `NOTES_CSS` e outros CSS específicos de página pra dentro de `styles.ts` — eles continuam onde estão; só o que hoje é `NEBULA_CSS` é reestruturado.

## Critérios de aceite

- [ ] `src/web/styles.ts` exporta `TOKENS_CSS`, `BASE_CSS`, `COMPONENTS_CSS`, `SHELL_CSS`, `SURFACES_CSS` como constantes distintas
- [ ] `export const NEBULA_CSS` continua existindo e a concatenação das camadas produz byte-a-byte o mesmo resultado que antes da reestruturação (exceto o fix do `--text-muted`, que é uma mudança intencional)
- [ ] `test/web/polish.test.ts:28` (`expect(body).toBe(NEBULA_CSS)`) passa sem alteração no teste — só o `styles.ts` muda
- [ ] `export const PUBLIC_CSS` existe e é `TOKENS_CSS + BASE_CSS + COMPONENTS_CSS`
- [ ] Tokens de espaçamento `--space-1..10` e de escala tipográfica `--text-xs..2xl` + `--leading-*` existem em `TOKENS_CSS`, mesmo que ainda não sejam usados amplamente pelo resto do CSS (adoção ampla é trabalho das Ondas 3-5)
- [ ] `--text-muted` não aparece mais em nenhum lugar do CSS do console; o elemento que usava esse token agora usa `--text-dim` ou `--text-subtle` e o contraste resultante é visualmente equivalente ou melhor
- [ ] `--bg-gradient`/token de grain e `theme-color` derivam de token, não de valor literal duplicado
- [ ] `npm run typecheck` e `npm test` passam sem nenhuma alteração de teste além do necessário pra acomodar a reestruturação (idealmente zero alteração de teste, já que o resultado final é idêntico)

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck
npm test
node scripts/verify-wave.mjs --phase wave-2
```

Teste manual: abrir o console local logado e navegar por todas as telas visitadas no baseline da Onda 0 — nenhuma diferença visual deve ser perceptível (exceto o `--text-muted` corrigido, que deve ficar visualmente mais discreto/consistente que antes).

**Gate de deploy:** implementar e commitar localmente é livre; nenhum `wrangler deploy` nesta onda — o deploy do programa inteiro só acontece na Onda 7, com OK explícito do dono.

## Arquivos afetados

- `src/web/styles.ts` (reestruturação interna + fix do bug)
- `src/web/render.ts` (derivar `theme-color` do token, se a linha citada — reconferir número exato — realmente contiver o valor duplicado)

## Riscos e reversão

- **Risco:** a reestruturação em camadas alterar a ORDEM de cascata de alguma regra CSS de forma sutil (duas regras com mesma especificidade, ordem diferente = resultado visual diferente). Mitigação: a concatenação final (`NEBULA_CSS = TOKENS + BASE + COMPONENTS + SHELL + SURFACES`) deve preservar a ordem relativa das regras que hoje existem dentro do `NEBULA_CSS` original — não é uma reordenação livre, é um corte em blocos que mantém a sequência.
- **Risco:** o teste `polish.test.ts:28` falhar por diferença de espaço em branco na concatenação (ex. faltar ou sobrar uma quebra de linha entre blocos). Mitigação: rodar o teste imediatamente após a primeira tentativa de split, antes de prosseguir pra qualquer outra mudança.
- **Reversão:** `git revert` do commit desta onda — como não há migration nem mudança de contrato de API, o rollback é puramente de arquivo CSS/TS, sem efeito em dado.
