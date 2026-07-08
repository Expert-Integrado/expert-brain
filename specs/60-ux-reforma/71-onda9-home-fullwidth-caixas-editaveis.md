# 71 — Onda 9: home em largura total, título no digest e caixas com altura editável

- **Status:** done
- **Data:** 08/07/2026
- **Origem:** feedback do dono após a v3.2.0 (Onda 8/spec 70): "as telas lateralizadas
  foram otimizadas (...) só que a tela de início ainda não tá lateralizada, ela tá
  pequena"; a caixa do digest "tá sem título"; as caixas "teriam que expandir um pouco
  mais" e "a pessoa pudesse editar os tamanhos das caixinhas, com uma interface".

## 1. Home em largura total

Mesma exceção do notes-list/board: `.main:has(.home-grid) { max-width: none; }`
(styles.ts). O grid dos cards sobe pra `minmax(min(100%, 320px), 1fr)` — em tela
larga os cards espalham lado a lado em vez de espremer no cap de 980px.

## 2. Título no card do digest

O card "Do seu cérebro" era o único sem `<h2>` (o `<strong>` interno do callout não
tem a anatomia dos vizinhos — era a "caixa sem título" do feedback). A home agora
monta o wrapper com `<h2>Do seu cérebro <a href="/app/notes">notas →</a></h2>` e
chama `renderDigestCard(digest, { bare: true })` (novo opt em notes.ts: omite o
strong, mantém `#resurface-digest-card` + a lista). A lista de notas segue com o
callout completo (comportamento default intacto).

## 3. Caixas maiores por padrão + altura editável pelo dono

- A altura virou custom property: `.home-card { max-height: var(--home-card-h, 420px) }`
  (default subiu de 340) e `.home-activity-box { max-height: var(--home-card-h, 560px) }`
  (subiu de 460). Cada caixa carrega `data-home-box="today|inbox|digest|activity"` e,
  quando há pref salva, `style="--home-card-h:NNNpx"` no SSR.
- **Modal "Ajustar caixas"** (botão no page-header): um slider por caixa presente na
  página (220–960px, step 20), com preview AO VIVO (o client aplica a custom property
  direto no elemento), "Restaurar padrão" e "Salvar". Fechar sem salvar (backdrop, ✕,
  Esc) reverte o preview. Reusa o `.modal` genérico da Onda 3.
- **Persistência por dono** (`src/web/home-prefs.ts`, espelho do graph-prefs): POST
  `/app/home/prefs` grava `{ heights: {...} }` na tabela `meta` (chave `home_prefs`)
  — sincroniza entre as máquinas do dono, zero migration. Sanitize clampa nos
  limites e DROPA chave desconhecida/valor inválido (cai no default, nunca 400 por
  lixo parcial). Valor igual ao default é omitido do save (chave ausente = default).

## Critérios de aceite

- [x] `/app` usa a largura toda; cards lado a lado em tela larga.
- [x] Card do digest com h2 igual aos vizinhos.
- [x] Defaults maiores (420/560); slider muda a caixa na hora; salvar persiste e
  sobrevive a reload; fechar sem salvar reverte; restaurar padrão limpa.
- [x] Suítes server (804) + client (38) + e2e (25, incluindo o spec novo do modal)
  verdes; QA interativo no browser com console limpo.

## Evidências

- Testes: `test/web/home-prefs.test.ts` (sanitize + endpoint + reflexo no SSR),
  `test/web/home.test.ts` (data-home-box + style var), `e2e/home.spec.ts` (modal
  com preview/persistência/reset).
- QA Playwright em 2047px: main max-width none, grid 1696px, preview 700px ao vivo,
  revert pra 420px ao fechar sem salvar, 0 erros de console.
