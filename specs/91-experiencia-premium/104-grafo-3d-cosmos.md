# Grafo 3D "cosmos": bloom, gaiola esférica e ano

> **Status:** shipped (12/07/2026 — commits 74dae68, c9d0250, 6bd6b74 + bundles/calibração; deploy pendente de OK) · **Prioridade:** P2 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** grafo 3D existente (spec 29 / onda do palco 3D — `src/web/client/graph3d.ts`, 3d-force-graph@1.80 sobre three@0.185) · grupo 91 (o 3D é o "uau de demo" da experiência premium)

## Contexto / referência visual

Eric mandou um print de um vídeo famoso de "second brain" perguntando se o nosso 3D
consegue ficar parecido. A referência tem: fundo espacial escuro, nós BRILHANDO com
halo (clusters tipo fogos de artifício), tudo dentro de uma ESFERA ARAMADA (gaiola de
meridianos/paralelos, estilo globo) e o ano flutuando no topo.

O 3D atual já entrega o esqueleto: globo girando (auto-rotate), clusters por área
(força `domainGravity`), cores por área. Faltam exatamente três coisas:

1. **BRILHO** — pós-processamento bloom (hoje inexistente).
2. **GAIOLA** — esfera wireframe envolvendo a nuvem.
3. **ANO** — sprite de texto no topo da esfera.

Fatos verificados que viabilizam barato:

- A lib já renderiza via `EffectComposer` + `RenderPass` (three-render-objects) e expõe
  `postProcessingComposer()` — plugar `UnrealBloomPass` é 1 `addPass`. Delta de bundle
  MEDIDO: ~12KB (+0,9%).
- A cena (`graph.scene()`) nunca é recriada — gaiola e sprite persistem por
  filtros/busca/reheat.
- Resize do composer é automático pela lib; pixelRatio desktop já clampa em 2.
- O fantasma de busca (rgba alfa 0.22) fica abaixo do threshold do bloom → busca
  continua legível com glow (matches acesos, resto apagado).

## Decisões de design

- **Bloom exige `OutputPass`**: sem ele o bloom escurece a cena (os passes não
  convertem pra sRGB). Com `enabled=false` nos dois passes o pipeline volta
  byte-idêntico ao atual — toggle limpo, rollback trivial.
- **Knobs do bloom**: strength 0.8, radius 0.5, threshold 0.30 — CALIBRADOS na
  validação visual de 12/07/2026 (a 1ª rodada 1.0/0.6/0.15 estourava o miolo denso
  num branco só; o bloom aditivo acumula onde há muitas esferas).
- **Glow efetivo = pref E tema escuro E desktop.** Em fundo claro o bloom lava a
  imagem; mobile v1 força off (GPU) — o switch aparece desabilitado com help text
  leigo ("desliga sozinho no tema claro e no celular").
- **Cores por área FICAM** — a referência também é multi-cor com dominante quente; o
  incandescente vem do bloom, não da paleta. Paleta "toda quente" descartada: cor =
  área é funcional (filtros/legenda/customização).
- **Gaiola**: 12 meridianos + 7 paralelos + 64 segmentos numa ÚNICA
  BufferGeometry/LineSegments (1 draw call), opacity 0.12-0.18, `depthWrite:false`,
  cor do tema. Raio = `min(r98*1.05, r88*1.4)` do `computeCore` (percentis da nuvem),
  reposicionada nos MESMOS momentos do frameCore (a cada 30 ticks no assentamento +
  todo onEngineStop).
- **Ano: REMOVIDO (12/07/2026, decisão do dono).** O "2026" da referência era artefato
  do print de exemplo, não requisito do produto. Shipou na primeira leva (sprite
  CanvasTexture calibrado) e foi retirado no mesmo dia ao validar com o dono — sprite,
  shim de tipos (Sprite/SpriteMaterial/CanvasTexture) e testes do ano removidos; a
  cenografia ficou só com a gaiola.
- **`CORE_MARGIN` 1.15→1.30** pra moldura de câmera não colar na gaiola.
- **Arestas explícitas: alfa 0.55→0.35 quando glow ativo** (com bloom elas saturam).
- **Perf/higiene junto (dívidas do palco 3D que este trabalho encosta):**
  - `pause()`/`resume()` no controller — HOJE o 3D continua renderizando escondido ao
    voltar pro 2D (desperdício real de GPU); `pauseAnimation()` da lib resolve.
  - `dispose()` ganha `bloom.dispose()`/`output.dispose()` — o EffectComposer NÃO
    descarta passes adicionados (vazamento de ~8 render targets por sessão 3D).
  - Mobile: `nodeResolution 16→8`, pixelRatio ≤1.5 no renderer E no composer.
- **Tema lido no init, sem reação viva** (mesma limitação do BG_COLOR atual,
  registrada em comentário). Reagir ao toggle de tema ao vivo = commit opcional
  separado (MutationObserver em `data-theme`), decisão do dono.
- **Shim de tipos `three-addons.d.ts`**: three@0.185 não publica `.d.ts` — declarar só
  o subconjunto usado (mesmo padrão do `d3-force-3d.d.ts`).

## Plano de commits

1. **Pref `glow`** no perfil visual 3D (`graph-prefs.ts`: interface + default `true` +
   sanitize) + testes de roundtrip/isolamento por superfície.
2. **Bloom + gaiola + ano** (`graph3d.ts` + novo `graph3d-scenery.ts` com funções puras
   testáveis: `computeCore`, `cagePositions`, `buildCage`, `buildYearSprite`) + guards
   (mobile/tema claro) + pause/resume + dispose dos passes + testes client (contagem/
   norma de vértices da gaiola, percentis com outliers, sprite null sem canvas 2d).
3. **Switch "Brilho"** no painel Visual do grafo (`graph.ts` SSR + wiring client:
   default+merge, controller, enter3D/exit3D com resume/pause, syncVisualSliders,
   onGlowToggle, onResetAll). "Salvar como padrão" já espalha `visual3d` — persiste de
   graça.
4. **`npm run build:bundles`** + validação visual (wrangler dev + screenshot vs
   referência).
5. *(Opcional, decisão do dono)* reação viva ao toggle de tema.

## Fora de escopo (registrado)

- Paleta "toda quente" da referência (ver decisão acima).
- Rótulos sempre visíveis, starfield de fundo, bloom em mobile, fit-to-matches 3D (já
  fora por spec 29).
- Comandar o tema do 3D independente do tema do app.

## Critérios de aceite

- [x] `/app/graph?mode=3d` em tema escuro desktop: nós com halo/glow, gaiola esférica
  envolvendo a nuvem — comparável à referência (validado 12/07/2026, screenshot v3
  após 2 rodadas de calibração; o ano foi removido depois, por decisão do dono).
- [x] Switch "Brilho" liga/desliga ao vivo (validado via Playwright).
- [x] Busca no 3D com glow: matches acesos, resto apagado e legível.
- [x] Tema claro: sem bloom (switch desabilitado), gaiola em cor escura legível.
- [x] Mobile 375px: sem bloom, switch desabilitado (nodeResolution 8,
  pixelRatio ≤1.5).
- [x] Alternar 2D↔3D 4x: sem erro de console; pause/resume no exit/enter.
- [x] Typecheck + vitest + test:client verdes em cada commit.

## Validação

Suite completa + visual local (`npm run build:bundles && npm run dev` → screenshot
Playwright vs referência; knobs de ajuste: strength/radius/threshold do bloom, opacity
e raio da gaiola). Gate de deploy: OK explícito do dono (junto com specs 101-103).

## Riscos e reversão

Aditivo e atrás de pref (default `true` só muda visual, não dado). Rollback: desligar
o switch (user-level) ou reverter os commits (código). O bloom desabilitado restaura o
pipeline byte-idêntico. Nenhuma mudança de schema/dado.
