# Config: design system unificado das 4 abas

> **Status:** in-progress (13/07/2026) · **Prioridade:** P1 · **Esforço:** L · **Repo:** expert-brain
> **Depende de:** spec 98 (abas + cards, done/reescopada) · skills `high-end-visual-design` + `frontend-design` (carregadas na sessão de 13/07)

## Contexto

O dono validou a config pós-spec-98 e seguiu insatisfeito ("ainda não estou
feliz"). Auditoria com dados reais no sandbox (13/07/2026, screenshots em
`Workspace/config-atual-*.jpeg`) + pesquisa UX (NN/g heurísticas 1/4/8 +
progressive disclosure) apontou:

1. **Texto demais, ação de menos** — quase todo card é parágrafo de manual
   antes do botão. Aba Agentes abre com 2 parágrafos de jargão ("perfil de
   atribuição", `assignee: 'me'`) antes de qualquer coisa clicável.
2. **Cada aba parece um app** — Integrações = grid de cards, Organização =
   acordeões, Sistema = cards longos, Agentes = mistura. Sem sistema.
3. **Botões sem hierarquia** — "Gerar código de recuperação", "Desativar",
   "Enviar teste" parecem texto solto; primário roxo aparece sem critério.
4. **Inputs sem tema** — os 3 campos de senha são `<input>` crus (brancos no
   escuro): `password-config.ts:113-115` sem a classe `.input` (styles.ts:660).
5. **Pill de status global errado** — "Aguardando — conecte..." no header da
   página em TODAS as abas, mas é status da aba Agentes.
6. **Cards de integração** — descrição truncada no meio ("Sincroniza etiquetas
   escolhidas da sua..."), título quebrando feio, "Indisponível" sem explicação
   nem ação.
7. **NÃO-bug descartado**: o "fundo branco" na metade de baixo era artefato de
   screenshot full-page com `background-attachment: fixed` — no scroll real o
   fundo está íntegro. Não mexer.

## Norte de design (adaptação consciente das skills)

Settings de produto EXISTENTE = consistência elevada com o tema do app
(violeta-nebula, tokens de styles.ts), não estética nova. Das skills entra a
barra de acabamento: hairlines, camadas, hierarquia tipográfica, motion contido
com easing custom. Referências: Linear/Vercel/Stripe settings.

**Regra de ouro por card: título + status + 1 linha de descrição + ações.
Manual vira `<details>` "Como funciona" recolhido (progressive disclosure).**

## Design system (CSS novo na seção CONFIG do styles.ts)

- **`.cfg-card`** (card único das 4 abas): fundo `--surface-raised` (token
  existente), borda hairline `1px solid rgba(255,255,255,0.08)`, highlight
  interno `inset 0 1px 0 rgba(255,255,255,0.04)`, radius do token vigente,
  hover: borda acesa + `transform: translateY(-1px)` com
  `transition: 240ms cubic-bezier(0.32, 0.72, 0, 1)`.
  - `.cfg-card-head`: título 15px/600 à esquerda, status/resumo à direita.
  - `.cfg-card-desc`: UMA linha 13px `--text-dim`.
  - `.cfg-card-actions`: linha de botões.
  - `.cfg-card-help`: `<details>` "Como funciona" — o manual inteiro mora aqui.
- **Hierarquia de botões** (3 níveis, mesmos radius/padding):
  - `.btn-primary` (já existe estilo accent — máx 1 por card);
  - `.btn-ghost`: outline hairline, hover acende;
  - `.btn-quiet`: texto com cor accent-dim + underline no hover (affordance
    SEMPRE — nada de texto puro clicável).
- **`.cfg-status`**: dot 6px + label, cores: verde conectado, âmbar aguardando,
  cinza indisponível — com `title` explicando o porquê quando cinza.
- Tabs mantêm; o pill "Aguardando — conecte..." SAI do header da página e vira
  `.cfg-status` no bloco "Conectar um agente" da aba Agentes.

## Reestrutura por aba

- **Agentes**: split em 2 blocos: (1) "Pessoas e agentes" — cards de perfil +
  chaves + botão Novo usuário/Nova chave; (2) "Conectar um agente" — guia
  passo a passo em acordeões POR CLIENTE (Claude Code, Codex/outros), tudo
  recolhido; os 2 parágrafos de manual do topo viram 1 linha + "Como funciona".
- **Integrações**: grid mantém; card com título em 1 linha (ellipsis),
  descrição completa em até 2 linhas SEM reticências no meio de frase (revisar
  os textos), status no canto superior direito, cinza ganha `title` com motivo
  + ação de configurar visível.
- **Organização**: acordeões viram grid 2-col dos MESMOS `.cfg-card` com
  resumo à direita (ex.: "5 tags", "4 colunas"), clicável expandindo no lugar
  (mantém o comportamento atual de expandir, só muda a pele).
- **Sistema**: cards mantêm ordem; microcopy reduzida a 1 linha + help
  recolhido; inputs de senha com `.input`; "Gerar código de recuperação" vira
  `.btn-ghost`; Notificações: "Desativar"/"Enviar teste" viram `.btn-ghost`/
  `.btn-quiet`.

## Plano de commits (cada um verde: typecheck + vitest + test:client)

1. **Spec + fixes rápidos**: inputs de senha themed (`password-config.ts`),
   pill de status fora do header (`config.ts`) e pro bloco de conexão,
   botões-fantasma com classe de botão real.
2. **Design system CSS** (`styles.ts` seção config): `.cfg-card` + botões +
   `.cfg-status` + aplicar na aba SISTEMA (a mais simples de converter).
3. **Integrações**: aplicar sistema + textos completos + estado indisponível
   com motivo/ação.
4. **Organização**: acordeões → cards com resumo.
5. **Agentes**: split + acordeões por cliente + microcopy enxuta.
6. **Bundles + validação visual** das 4 abas no sandbox (screenshots pro dono)
   + ajuste fino.

## Fora de escopo

- Mudar comportamento/rotas/handlers (é pele + arquitetura de informação; o
  config-script.ts só muda onde IDs/classes mudarem).
- Busca dentro das configurações (fica pra spec futura se o dono pedir).
- Tema claro: os tokens já respondem; validar por amostragem, sem redesenho.

## Critérios de aceite

- [ ] As 4 abas usam o MESMO componente de card e a MESMA hierarquia de botão.
- [ ] Nenhum card abre com mais de 1 linha de descrição; manual em "Como
  funciona" recolhido.
- [ ] Zero inputs sem tema; zero texto clicável sem affordance.
- [ ] Pill de status só na aba Agentes, no bloco de conexão.
- [ ] Integrações sem truncamento no meio de frase; indisponível explica e
  oferece ação.
- [ ] Suite verde em cada commit; validação visual das 4 abas pelo dono.

## Validação

Sandbox local (wrangler dev, teste@local.dev) — screenshot das 4 abas antes/
depois; config.test.ts cobre presença de seções/IDs. Gate de deploy: OK
explícito do dono.

## Riscos e reversão

Pele + IA de informação, sem mudança de schema/rota. config-script.ts depende
de IDs — manter todos os IDs funcionais (`id="..."`) intactos; classes novas
são aditivas. Rollback = reverter commits.
