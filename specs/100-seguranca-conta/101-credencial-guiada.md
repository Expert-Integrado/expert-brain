# Criação guiada de credencial, papéis em linguagem leiga e revogação com confirmação

> **Status:** draft · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** specs 86/87/91 (todas shipped) — este é o refino de UX por cima delas. Plano-mãe: grupo 100.

## Problema

O dono olhou a tela DEPOIS das specs 87/91/98 e ainda reprovou ("não está intuitiva... quero mais bonita"). Diagnóstico do que sobrou:

1. **O form de criação é um bloco denso de 5 campos técnicos num passo só** — nome, sistema, dono, papel e escopo custom empilhados, com jargão de engenharia VAZANDO pra UI: "spec 86 — a credencial ASSINA como este usuário", "(spec 91)", "CRUD completo". Spec número é referência de dev, não texto de produto.
2. **Papéis explicados em uma linha técnica dentro de `<option>`** — escolher errado é fácil e invisível (o hint some depois de selecionado).
3. **Revogar não pede confirmação** — um clique acidental (são botões pequenos, 2 superfícies: chips do card de usuário e listagem de chaves) mata uma credencial de produção na hora, sem undo.

## Design

### 1. Wizard de 3 passos (progressive disclosure client-side, zero mudança de backend)

O form continua UM `<form method="post" action="/app/api-keys/create">` — o handler não muda uma linha (radios postam os mesmos `user_id`/`preset`). Divide-se em 3 `<fieldset class="wizard-step" data-step="N">`:

- **Passo 1 — "Pra quem é a chave?"**: os usuários ativos viram RADIO-CARDS (avatar/iniciais + nome + tipo), `name="user_id"`. Link discreto "criar um perfil novo primeiro" → `#users`.
- **Passo 2 — "O que ela pode fazer?"**: os 5 presets + "Personalizado…" viram radio-cards `name="preset"`, cada um com título + descrição leiga de 1-2 linhas (fonte: `presets.ts` hints, reescritos — §3). Selecionar "Personalizado…" expande os controles legados (escopo base + private) DENTRO do card (mesmo `#key-custom-scopes`).
- **Passo 3 — "Onde ela vai rodar?"**: nome da chave + sistema (agrupamento, datalist atual) + botão "Criar chave".

Navegação client-side (config-script): indicador de passos (1 Quem · 2 Papel · 3 Onde), botões Voltar/Avançar, validação por passo (radio marcado / nome preenchido) com mensagem inline. **Sem JS (noscript/JS quebrado): os 3 fieldsets aparecem empilhados e o form funciona como hoje** — o script adiciona `wizard-js` no form e o CSS só esconde passos inativos sob essa classe.

O botão "Criar chave pra este perfil" do card de usuário (`data-create-key-for`) passa a marcar o radio do passo 1 e abrir o wizard já no passo 2.

### 2. Revogação com confirmação

Os DOIS forms de revoke (`users.ts` userKeyChips + `config.ts` keyRow) ganham `class="key-revoke-form" data-key-name="<nome>"`. O config-script instala o guard padrão da casa (mesmo do `tag-delete-form`: preventDefault → `askConfirm` → `data-confirmed` → requestSubmit): "Revogar a chave "X"? Quem estiver usando ela perde o acesso na hora. Não dá pra desfazer — pra religar, crie outra chave."

### 3. Linguagem leiga (uma fonte só)

- `presets.ts` hints reescritos pra voz de produto (precisão preservada): ex. fleet-worker → "Trabalha em todas as tarefas não-privadas e no mural de recados; não vê notas nem contatos". `label`/`id`/`scopes` intocados (contrato do whoami/badge).
- Textos da tela sem referência a spec: label do dono vira "Quem usa esta chave — tarefas, comentários e registros aparecem no nome dele". **Teste de regressão: o HTML de /app/config não contém `spec \d+`.**

### 4. CSS (styles.ts)

`.role-card` (radio-card com borda, hover, estado checked com accent), `.wizard-steps` (indicador), grid responsivo (1 coluna no mobile). Nada de framework — mesmo vocabulário visual dos conn-cards.

## Fora de escopo

- Mudar regras/rotas de chaves (criação, vínculo, sistema, revogação continuam idênticas no backend).
- Re-arquitetar a página (abas ficam como estão — spec 98 já fechou essa discussão).
- Editar escopo de chave viva (decisão da spec 91: revogar + criar outra).

## Critérios de aceite

- [ ] Criar chave com JS: 3 passos, validação por passo, radio-cards de dono e papel; POST idêntico ao atual (mesmos campos).
- [ ] Sem JS: form inteiro visível e funcional (fieldsets empilhados).
- [ ] `data-create-key-for` marca o dono e cai no passo 2.
- [ ] Revogar (nas 2 superfícies) pede confirmação com o NOME da chave; confirmar revoga, cancelar não faz nada.
- [ ] `/app/config` não contém "spec N" em texto visível.
- [ ] Suite verde (config.test.ts + novos asserts) + `npm run test:client` + typecheck.
