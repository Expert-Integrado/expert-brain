# Experiência premium do console — visão geral da série 91-99

> **Status:** draft · **Prioridade:** P0 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** nenhuma (as specs filhas declaram as suas)

## Contexto

Decisão do dono da instância (11/07/2026): o console do Expert Brain **continua gratuito
pros alunos, sem billing, sem multiusuário e sem i18n** — mas a experiência de uso deve
ser a de um SaaS premium. Esta série nasce de uma auditoria completa de UI/UX (superfície
de telas + qualidade de interação, repo inteiro) que separou o que já impressiona do que
quebra a percepção de qualidade.

O que **já sustenta** a percepção premium (não mexer, é o pitch):

- MCP nativo pra agentes: PAT escopado, mailbox, assignee "me" — o diferencial real.
- Grafo 2D (sigma.js) e 3D (three, lazy self-hosted) — o "uau" de demo.
- Resurfacing digest (`50-console-v2/64`) + home de cards arrastáveis (`60-ux-reforma/71`).
- PWA de verdade: share target de arquivo, push com digest, instalável (`50-console-v2/68`).
- Command palette Ctrl+K unificada (`50-console-v2/66`) e copy pt-BR consistente.
- Design system em `src/web/styles.ts` (tokens em camadas, contraste AA anotado,
  reduced-motion) — resultado das ondas 2/3 da reforma (`60-ux-reforma/63` e `64`).

O que **quebra** a percepção (cada item vira uma spec desta série):

| Spec | Gap | Prioridade |
|---|---|---|
| `92-onboarding-ativacao.md` | Onboarding zero: vault novo é um deserto sem CTA | P0 |
| `93-busca-mobile.md` | Palette só abre com Ctrl+K — busca inacessível no celular | P0 |
| `94-erros-validacao-inline.md` | Erro de form admin vira página de texto puro 400 | P0 |
| `95-undo-e-confirmacoes.md` | `confirm()` nativo em tudo; soft-delete existe mas nunca vira "Desfazer" | P1 |
| `96-tema-claro.md` | Só dark theme; zero `prefers-color-scheme` | P1 |
| `97-ajuda-atalhos-e-paginas-de-erro.md` | Atalhos sem descoberta; 404/erro sem marca | P2 |
| `98-config-redesign.md` | Config é a tela menos premium do app (1.048 linhas numa página só) | P1 |
| `99-dashboard-seu-cerebro.md` | Nenhuma superfície de valor percebido ("seu cérebro este mês") | P1 |
| `80-frota-agentes/89-fleet-view.md` | Frota de agentes só aparece como tabela de chaves | P1 |

(O fleet view mora na série 80 porque é produto da frota, mas faz parte deste programa.)

## Problema / Motivação

Evidência concreta em cada spec filha. O resumo: metade do app (administração) é form
POST + reload com erro em página morta (`src/web/users.ts:246`, `src/web/api-keys.ts:37`),
o primeiro contato de um usuário novo é um aviso estático (`src/static/wizard.ts`,
`renderNotConfigured`) e telas-núcleo vazias sem chamada de ação
(`src/web/notes.ts:306`). O produto É bom; a primeira e a milésima impressão não dizem isso.

## Objetivo

Fechar os 9 gaps mapeados de forma que um usuário novo chegue do login vazio ao primeiro
agente conectado sem docs externas, e o uso diário (mobile incluso) não tenha nenhuma
interação "web 1.0".

## Design proposto (ordem de ataque)

- **Fase A — uso diário (P0):** `92`, `93`, `94`. Independentes e paralelizáveis.
- **Fase B — polish estrutural (P1):** `95`, `96`, `98` (a `98` depende da `94`).
- **Fase C — valor percebido:** `89` (fleet view), `99` (dashboard), `97`.

Princípios transversais (valem pra TODAS as specs da série):

1. Reusar tokens e componentes das ondas 2/3 (`styles.ts`, `.card`, `.btn`, `.chip`,
   `.empty-state`, `.modal`) — nenhuma spec cria CSS ad-hoc novo.
2. Padrão de feedback = o já existente: `src/web/client/toast.ts` + validação inline do
   modal de task. Nada de padrão novo por tela.
3. Zero dependência externa nova (CSP restrita; tudo self-hosted).
4. Migrations sempre aditivas; nada quebra instância de aluno já rodando.
5. Regra anti-PII da spec-zero (`specs/README.md` §4) — repo público.

## Fora de escopo

- Multiusuário/workspaces (auth por usuário continua `OWNER_EMAIL`) — decisão do dono.
- Billing, planos, quotas, trial — decisão do dono.
- i18n/inglês — decisão do dono.
- Relatórios/exports apresentáveis (fica pra depois; o backup ZIP de `50-console-v2/67` cobre o dado).

## Critérios de aceite

- [ ] As 9 specs filhas existem, seguem o template da spec-zero e estão no índice do `specs/README.md` §7.
- [ ] Nenhuma spec da série referencia PII ou credencial (varredura antes de cada commit).
- [ ] Ao final da Fase A: teste guiado de usuário novo (wrangler dev seedado do zero) chega do login ao 1º agente conectado sem docs externas.
- [ ] Ao final da Fase B: Lighthouse mobile (PWA/perf/a11y) igual ou melhor que o baseline pré-série.

## Validação

- Por spec filha: typecheck + vitest verdes (padrão da casa) antes de marcar done.
- Gate de deploy: deploy de produção de cada fase SÓ com OK explícito do dono da instância.

## Arquivos afetados

Nenhum diretamente (documento-mapa). Ver specs filhas.

## Riscos e reversão

Documento de planejamento — reverter é apagar a pasta. O risco real mora nas specs filhas.
