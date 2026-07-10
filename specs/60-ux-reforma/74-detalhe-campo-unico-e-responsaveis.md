# Detalhe de nota/task: campo único de corpo (render por padrão) + seletor de responsáveis estilo ClickUp

> **Status:** shipped (10/07/2026) · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> Pedido direto do dono (10/07/2026, com screenshots): "não faz sentido ter um campo Descrição (markdown) e um campo Prévia — tem que ser um campo só, que abre pra editar no clique; senão a gente visualmente prejudica toda essa experiência" e "no cartão de responsáveis, quero um botãozinho de selecionar as pessoas, igual fora do cartão, igual no ClickUp".

## Problema

1. **Nota** (`src/web/notes.ts` ~473-482) e **task** (~1112-1123) mostram DOIS blocos sempre visíveis: textarea "Corpo/Descrição (markdown)" + div "Prévia" renderizada. Duplicação visual do mesmo conteúdo.
2. **Cartão RESPONSÁVEIS** (~952-980): lista de checkboxes + botão "Salvar responsáveis" (form 302 `POST /app/tasks/assignees`). O dono quer o padrão ClickUp: dots dos responsáveis atuais + botão compacto que abre um popover de seleção.

## Design

### 1. Campo único de corpo (nota E task)

- **Estado padrão = LEITURA**: só o corpo renderizado (`renderMarkdown` no SSR, mesmo output da Prévia atual) + botão discreto "Editar". Corpo vazio → placeholder "Sem descrição" clicável.
- **Clique em Editar** → esconde a view, mostra textarea (valor atual) + botões "Salvar" e "Cancelar". Ctrl/Cmd+Enter salva (mantém atalho atual).
- **Salvar** → mesmo fetch atual (`/app/notes/update` / `/app/tasks/update` com `expected_updated_at`); sucesso → re-renderiza a view com o renderer client leve já existente (`renderPreview`/`inline` de note-edit.ts/task-edit.ts) e volta pro modo leitura. 409 → mensagem atual de recarregar.
- **Cancelar** → descarta e volta pra leitura.
- Os rótulos "Prévia"/"Corpo (markdown)"/"Descrição (markdown)" somem; fica só o botão "Editar" (title="Editar em markdown").
- Título continua como está (edição inline própria).

### 2. Seletor de responsáveis estilo ClickUp

- O cartão vira: dots dos responsáveis atuais (`assigneeDotsHtml` de `src/util/task-badges.ts` — já é o mesmo visual "fora do cartão") + botão "+" que abre um POPOVER (mesma mecânica do quick-edit do board: botão + painel `hidden`).
- Popover: lista de usuários ativos (avatar/inicial + nome + selo "agente"), clique alterna seleção; arquivados fora (a menos que já atribuídos). Salvar aplica via fetch no MESMO endpoint `POST /app/tasks/assignees` (form-encoded, replace-set); sucesso → atualiza os dots sem reload.
- Manter compat: os testes existentes asseguram `Responsáveis` e `/app/tasks/assignees` no HTML (test/users-web.test.ts) — preservar rótulo e rota.
- Sem JS (noscript): manter um form fallback funcional (o form atual pode viver dentro do popover/details).

## Fora de escopo

- Campo de responsável no modal "Nova tarefa" (iteração futura).
- Editor markdown rico/toolbar.

## Critérios de aceite

- [x] Detalhe de nota e de task mostram UM só bloco de corpo, renderizado, com Editar → textarea → Salvar/Cancelar funcionando (fetch + 409 preservados).
- [x] Ctrl/Cmd+Enter salva no modo edição.
- [x] Cartão de responsáveis mostra dots + botão; popover seleciona e salva sem reload; replace-set e limite 16 preservados.
- [x] Testes existentes (users-web, notes/tasks SSR) verdes; novos asserts pro markup novo.
- [x] Suite + typecheck + build do client verdes.
