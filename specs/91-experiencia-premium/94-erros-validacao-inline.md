# Erros e validação inline: matar a página de texto puro 400 na administração

> **Status:** draft · **Prioridade:** P0 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma (padrão de referência: toast + validação inline do modal de task)

## Contexto

O console tem dois mundos de interação:

- **Mundo moderno**: notas/tasks/board usam fetch + `src/web/client/toast.ts` +
  validação inline (modal de task) — erro aparece no lugar, estado não se perde.
- **Mundo web 1.0**: TODA a administração (usuários, chaves de API, projetos, tags,
  integrações) é `<form method="post">` + reload, e erro de validação responde
  `htmlResponse('mensagem', 400)` — uma página de texto puro que descarta o que o
  usuário digitou.

## Problema / Motivação

Evidência (amostra; a varredura completa é parte da execução):

- `src/web/users.ts:246` — `htmlResponse('Nome deve ter 1 a 60 caracteres', 400)`; idem
  `:248`, `:270`, `:275`, `:293`, `:321`, `:324`, `:326`, `:362`, `:367`.
- `src/web/api-keys.ts:37` — `htmlResponse('Nome obrigatório', 400)`; idem `:48`, `:50`,
  `:84`, `:88`, `:99`.
- `src/web/config.ts:454` — `htmlResponse('Prompt não pode ficar vazio', 400)`.
- `src/web/inbox.ts:394`, `src/web/project-share.ts`, `src/web/tasks.ts` — mesmos padrões.

Errar um campo num form de admin = perder a página, perder o que digitou, ver texto puro
sem marca. É o maior "barato" perceptível do produto no uso diário.

## Objetivo

Nenhum erro de validação de form no console resulta em navegação pra página de texto
puro; todo erro aparece inline no campo (ou como toast) preservando o que foi digitado.

## Design proposto

1. **Helper único no servidor** (novo, em `src/web/layout.ts` ou módulo próprio):
   `formError(req, message, { field?, status = 400 })`:
   - Se a requisição veio do client moderno (header `Accept: application/json` ou
     `X-Requested-With: fetch` enviado pelo helper do passo 2): responde
     `{ ok: false, error: message, field }` com o status.
   - Fallback sem JS: `303 See Other` de volta pra página de origem com
     `?error=<mensagem>` (+ `#anchor` da seção), que a página renderiza como banner de
     erro no topo do form — NUNCA mais página morta.
2. **Helper único no client** (`src/web/client/http.ts` já existe — estender):
   interceptar submit dos forms de admin (progressive enhancement por atributo
   `data-ajax-form`), enviar via fetch com o header do passo 1, e no erro:
   - marcar o campo indicado (`field`) com classe de erro + mensagem inline abaixo
     (mesmo padrão visual do modal de task);
   - sem `field`: `toast(message, 'error')`.
   - Sucesso: seguir o redirect/refresh que o servidor indicar (comportamento atual).
3. **Migrar os handlers** de `users.ts`, `api-keys.ts`, `config.ts`, `inbox.ts`,
   `project-share.ts` e `tasks.ts` pra `formError(...)` — mudança mecânica; a validação
   em si não muda.
4. `htmlResponse(msg, 4xx)` fica proibido pra erro de FORM (grep de guarda no code
   review); segue válido pra rotas de recurso (404 de mídia etc., até a spec `97`).

## Fora de escopo

- Validação client-side antecipada (HTML5/JS antes do POST) — o servidor continua a
  fonte da verdade; só o TRANSPORTE do erro muda.
- Redesign visual das telas de admin (isso é a `98-config-redesign.md`).
- Páginas 404/erro de navegação (spec `97`).

## Critérios de aceite

- [ ] Submeter form de usuário com nome vazio: erro inline no campo, valores digitados preservados, URL não muda.
- [ ] Criar chave de API sem dono: erro inline apontando o select de dono.
- [ ] Com JavaScript DESLIGADO: mesmo erro vira banner no topo do form após redirect — nunca página de texto puro.
- [ ] `grep -rn "htmlResponse('" src/web` não retorna nenhuma ocorrência com status 400/413/415 em handler de form POST do console.
- [ ] Fluxos de sucesso (criar/editar/arquivar usuário, chave, projeto, tag) inalterados.

## Validação

- Typecheck + vitest verdes; testes novos pro `formError` (JSON vs fallback) e pra pelo
  menos 1 handler migrado de cada arquivo.
- Teste manual com e sem JS nos forms de usuários e chaves.
- Gate de deploy: OK explícito do dono.

## Arquivos afetados

- `src/web/layout.ts` (ou novo `src/web/form-error.ts`) — helper servidor
- `src/web/client/http.ts`, `src/web/client/toast.ts`, `src/web/client/shell.ts` — helper client
- `src/web/users.ts`, `src/web/api-keys.ts`, `src/web/config.ts`, `src/web/config-script.ts`,
  `src/web/inbox.ts`, `src/web/project-share.ts`, `src/web/tasks.ts` — migração dos handlers
- `src/web/styles.ts` — classe de erro inline (reusar a do modal de task se já for global)

## Riscos e reversão

Migração handler a handler (commits pequenos); qualquer regressão reverte o commit do
arquivo afetado sem tocar no resto. O fallback sem JS garante que nenhum fluxo fica
inoperante se o client falhar.
