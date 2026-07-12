# Undo com toast e confirmações dignas: aposentar o confirm() nativo

> **Status:** draft · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma dura (coordena com `94-erros-validacao-inline.md` no padrão de feedback)

## Contexto

O backend já é reversível: delete de nota/task é soft-delete (`deleted_at`,
`src/db/queries.ts:251-256` — "recuperáveis via restoreNote"), com teste dedicado
(`src/db/soft-delete.test.ts`) e tool MCP de restauração
(`src/mcp/tools/restore-note.ts`). **A UI ignora isso**: toda ação destrutiva pede um
`confirm()` nativo do browser (a caixa cinza sem marca) e, depois de confirmada, não
oferece volta — sendo que a volta EXISTE.

Não há rota web de restore: `restore-note.ts` é só MCP.

## Problema / Motivação

Ocorrências de `confirm()`/`window.confirm()` nativo:

- `src/web/client/note-media.ts:74` — excluir mídia.
- `src/web/client/visibility-ui.ts:202`, `:220`, `:245`, `:282` — privacidade/link público.
- `src/web/config-script.ts:131` (fechar sem copiar chave), `:245` (restaurar taxonomia),
  `:394` (desconectar Google), `:755` (apagar tag).

Dois defeitos: (1) diálogo nativo = aparência barata e sem contexto; (2) o padrão
"confirmar antes" é usado até pra ações REVERSÍVEIS, onde o padrão premium é executar
direto + toast "Desfazer" — mais rápido e mais seguro que um confirm que todo mundo
clica sem ler.

## Objetivo

Nenhum `confirm()` nativo no console; ação reversível executa na hora com "Desfazer" no
toast; ação irreversível usa modal de confirmação do design system.

## Design proposto

1. **Toast com ação** (`src/web/client/toast.ts`): estender a assinatura
   (`toast(msg, kind)`, hoje em `toast.ts:8`) pra aceitar
   `{ action: { label: 'Desfazer', onClick } , duration }`. Botão dentro do toast,
   timeout maior (8s) quando há ação, acessível por teclado.
2. **Rota web de restore** (nova, aditiva): `POST /app/notes/:id/restore` (cobre nota E
   task — mesmo storage), reaproveitando a lógica de `restore-note.ts`/`restoreNote` de
   `queries.ts`. Auth: sessão do dono (mesmo gate das outras rotas `/app`).
3. **Classificar cada ação destrutiva**:
   - REVERSÍVEL → sem confirm; executa + toast com "Desfazer":
     delete de nota, delete de task (soft-delete já existente).
   - IRREVERSÍVEL → modal de confirmação do design system (componente `.modal` da
     `60-ux-reforma/64`), com verbo específico no botão ("Revogar link", "Apagar tag"):
     revogar link público (`visibility-ui.ts`), apagar tag de todas as notas
     (`config-script.ts:755`), restaurar taxonomia (`:245`), desconectar Google (`:394`),
     excluir mídia (`note-media.ts:74` — R2 delete é hard), fechar modal de chave sem
     copiar (`config-script.ts:131`).
4. **Consistência**: um helper `confirmModal({ title, body, verb })` retorna Promise —
   substituição 1:1 nos call sites; nenhum fluxo muda de semântica além do delete
   reversível (que perde o confirm e ganha o undo).

## Fora de escopo

- Lixeira navegável na UI (listar/restaurar deletados antigos) — só o undo imediato;
  lixeira pode virar spec futura.
- Undo de EDIÇÕES (versionamento de conteúdo) — só delete.
- Mudar a semântica do soft-delete no backend.

## Critérios de aceite

- [ ] Deletar nota: sem diálogo; toast "Nota excluída — Desfazer" por 8s; clicar restaura a nota com edges (validado recarregando a página).
- [ ] Deletar task pelo board: idem, e o card volta pra coluna original após desfazer.
- [ ] Revogar link público: modal do design system com o texto atual, nada de `window.confirm`.
- [ ] `grep -rn "confirm(" src/web` retorna zero ocorrências de `confirm(`/`window.confirm(` em código de produção.
- [ ] Rota `/app/notes/:id/restore` exige sessão; 404 pra id inexistente ou não deletado.

## Validação

- Typecheck + vitest verdes; teste novo da rota de restore (restaura, preserva edges,
  rejeita não-deletada) e do toast com ação (unit do client se houver harness).
- Teste manual: ciclo delete → desfazer em nota e task; cada modal irreversível.
- Gate de deploy: OK explícito do dono.

## Arquivos afetados

- `src/web/client/toast.ts` (ação no toast)
- `src/web/notes.ts` ou `src/web/handler.ts` (rota restore)
- `src/web/client/notes.ts`, `src/web/client/note-edit.ts`, `src/web/client/task-edit.ts`,
  `src/web/client/board-dnd.ts` (fluxos de delete/undo)
- `src/web/client/visibility-ui.ts`, `src/web/client/note-media.ts`,
  `src/web/config-script.ts` (migração pro `confirmModal`)
- `src/web/styles.ts` (variante de toast com botão, se necessário)

## Riscos e reversão

O undo depende do soft-delete já testado — risco baixo. Pior caso: reverter o commit
devolve os `confirm()` nativos. Atenção ao timeout do toast: a task/nota JÁ está
deletada no servidor quando o toast aparece (não usar "delete adiado" — se o usuário
fechar a aba, o estado é o correto).
