# Paridade do gate de higiene nas superfícies web (link do grafo + inbox to-note)

> **Status:** shipped (10/07/2026) · **Prioridade:** P1 · **Esforço:** S/M · **Repo:** expert-brain
> **Depende de:** `71` (gate soft do save_note), `72` (re-pass). Plano-mãe: diagnóstico pós-ship do grupo 70 (10/07/2026).

## Problema

O gate de qualidade do grafo (spec 71) vale só no MCP. Duas superfícies web escapam:

1. **`POST /app/graph/link`** (`src/web/graph-data.ts` ~440): valida só `why.length >= 20`. O comentário diz "mesma régua do MCP", mas o MCP também roda `isLazyWhy` (`src/mcp/why-quality.ts`) — um why genérico de 25 chars passa na web e é rejeitado no MCP.
2. **`POST /app/inbox/to-note`** (`src/web/inbox.ts` ~233): cria nota com ZERO checagem de duplicata — é o único caminho de criação além do save_note. Um item de inbox que já virou nota semana passada vira clone silencioso.

## Design

### 1. isLazyWhy no link web

- Em `handleGraphLink`, após o check de 20 chars: `if (isLazyWhy(why))` → 400 JSON `{ error: lazyWhyError() }`.
- Corrigir o comentário pra refletir que a régua agora é DE FATO a mesma.
- Client (`src/web/client/graph.ts`): se o handler de erro já exibe a mensagem `error` do JSON como veio, NENHUMA mudança — verificar antes de mexer.

### 2. Aviso de duplicata no to-note

- Em `handleInboxToNotePost`, quando o embed der certo: pré-consulta de vizinhança IGUAL ao save_note (`queryVector(env, vec, SIMILARITY_TOP_K + 2)`, best-effort — falha não derruba a criação).
- Pós-insert: reusar os matches pra `persistSimilarEdgesFromMatches` (substitui o `refreshSimilarEdges`, que faria uma SEGUNDA query idêntica no Vectorize).
- Se o melhor match tiver `score >= DEDUP_MIN_SCORE`, hidratar título (sessão = dono, `canSeePrivate = true`) e redirecionar pra `/app/notes/<id>?dup=<dupId>` em vez de `/app/notes/<id>`.
- No detalhe da nota (`src/web/notes.ts`): se a URL tem `?dup=<id>` e a nota existe/está viva, renderizar um banner no topo: "Possível duplicata de: [título]" com link pra nota candidata + lembrete de mesclar/deletar. Banner é informativo (a nota JÁ foi criada) — decisão do plano: aviso pós-criação, NÃO tela de confirmação.

## Fora de escopo

- Trocar kind/domínio fixos do to-note (reforma UX própria).
- Tela de confirmação pré-criação.

## Critérios de aceite

- [x] `POST /app/graph/link` com why >= 20 chars mas genérico ("ambas as notas são muito relacionadas entre si") → 400 com a mensagem do `lazyWhyError`.
- [x] `POST /app/graph/link` com why substantivo segue criando a edge (regressão).
- [x] to-note de item similar a nota existente (score >= 0.80) redireciona com `?dup=` e o detalhe mostra o banner com o título da candidata.
- [x] to-note sem duplicata: fluxo idêntico ao atual (redirect limpo, sem banner).
- [x] Falha do Vectorize na pré-consulta NÃO impede a criação da nota (best-effort preservado).
- [x] Suite verde (arquivos tocados: `test/web/graph-link.test.ts`, `test/web/notes-dup-banner.test.ts`, `test/inbox-web.test.ts` — 29/29 passando; typecheck limpo nos arquivos do escopo desta spec).
