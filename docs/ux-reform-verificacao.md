# Reforma UI/UX — checklist manual de fim de onda

Complemento HUMANO do `npm run verify:wave -- --phase <onda>` (specs/60-ux-reforma/61).
~5 minutos num browser real contra `npm run dev:full` (http://localhost:8787), com o
seed aplicado (`npm run seed:dev`). Rodar em desktop E num viewport mobile (devtools).

## Interações críticas (os bugs que motivaram a reforma)

- [ ] **Drag no board**: arrastar um card entre colunas move o card; o feedback visual
  fica no CARD arrastado e na COLUNA alvo (borda/header) — nunca a coluna inteira pintada.
- [ ] **Drag no touch** (devtools mobile): long-press ~300ms arma o drag; scroll normal
  da página NÃO arma.
- [ ] **Clique no card**: clicar em qualquer área do card (fora de botão/checkbox) abre
  o detalhe da task. Concluir/editar NÃO navega.
- [ ] **Visibilidade 3 estados** (detalhe da task): Privado / Normal / Link público num
  seletor único; transições destrutivas pedem confirmação; o texto nunca sugere que
  "Normal" está exposto na internet.
- [ ] **Link público**: /s/<token> abre em janela anônima; após revogar, dá 404/410.

## Telas

- [ ] **Home** em 320px de largura: nada transborda; card com erro mostra estado de
  erro visível (não some).
- [ ] **Login**: entrar leva pra home (/app) — pós Onda 5.
- [ ] **Board mobile**: colunas utilizáveis, sem CSS quebrado no breakpoint.
- [ ] **Grafo**: carrega, título "Grafo", sem flash de tela clara.
- [ ] **Palette Ctrl+K**: abre, filtra, Enter navega.

## Regressões gerais

- [ ] Nenhum texto novo sem acentuação correta (PT-BR).
- [ ] Foco visível ao navegar por Tab nas telas tocadas pela onda.
- [ ] Contact sheet da onda (C:/tmp/ux-audit/<onda>/contact-sheet.html) revisado
  lado a lado contra o baseline — mudanças são as INTENCIONAIS da onda.
