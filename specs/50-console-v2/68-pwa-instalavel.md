# PWA: share target de captura + atalhos de app (o PWA base JÁ existe)

> **Status:** done · **Prioridade:** P2 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** `63` (o share target aponta pro inbox) · suave: `65` (home como `start_url`)
> **Agente sugerido:** Sonnet (assets + 1 rota) · **Esforço de execução:** padrão

## Contexto

**O PWA base JÁ EXISTE E RODA** — esta spec NÃO cria PWA, só o completa:

- `assets/manifest.webmanifest`: name/short_name, `start_url: /app/graph`, `display: standalone`, theme NEBULA, ícones 192/512 + maskable — completo e válido.
- `assets/sw.js`: service worker com a estratégia certa (cache-first só em assets estáticos por extensão, network-first em HTML, nunca toca endpoints) — registrado pelo shell (`src/web/client/shell.ts`, bloco `serviceWorker.register('/sw.js')`).
- Existe até página de instalação (`assets/instalar.html`).

O que NÃO existe no manifest: `share_target` (compartilhar de outro app → console) e `shortcuts` (ações no long-press do ícone). E o `start_url` aponta pro grafo — quando a home da `65` existir, o app deve abrir nela.

## Problema / Motivação

- O PWA instalado abre no grafo — bom pra consulta, inútil pra CAPTURA, que é o gesto mais frequente no celular.
- Compartilhar um texto/link de qualquer app pro Brain (share sheet do Android) é a captura de menor fricção possível e está a um bloco de manifest de distância.

## Design proposto

### 1. `share_target` no manifest

```json
"share_target": {
  "action": "/app/inbox",
  "method": "GET",
  "params": { "title": "title", "text": "text", "url": "url" }
}
```

- `/app/inbox` (da `63`): ao chegar com params de share, pré-preencher o quick-add com `title + text + url` concatenados e focar o botão salvar — compartilhou, 1 toque, capturado (`source: 'pwa-share'`). Sem sessão → login → redirect de volta com os params preservados (conferir que o fluxo de login atual preserva querystring; ajustar se não).

### 2. `shortcuts` no manifest

- "Capturar" → `/app/inbox` · "Tarefas" → `/app/tasks` · "Hoje" → `/app` (só quando a `65` tiver rodado).

### 3. `start_url`

- Quando a `65` existir: `start_url: /app` (home Hoje). Enquanto não existir: manter `/app/graph`. (Se esta spec rodar antes da 65, deixar um TODO comentado no manifest e um item no critério da 65.)

### 4. Higiene

- Confirmar que `sw.js` NÃO cacheia `/app/inbox` com params (a regra atual por extensão já garante — HTML é network-first; validar).
- Bump de versão do SW se o cache de assets precisar invalidar pelo manifest novo.

## Fora de escopo

- Push notifications, offline de escrita, TWA/loja.
- Recriar manifest/SW/ícones (existem e estão certos).
- PWA do console standalone do contacts.

## Critérios de aceite

- [x] Android: compartilhar texto de outro app lista "Expert Brain"; escolher → quick-add pré-preenchido → salvar cria item no inbox com `source: 'pwa-share'`. (manifest `share_target` + `/app/inbox` pré-preenche pelo GET e o hidden `source` do form grava `pwa-share`; ponta a ponta coberto por teste — validação real num Android fica pro dono antes do deploy, share target não roda em desktop.)
- [x] Long-press no ícone mostra os shortcuts e eles abrem as rotas certas. (`shortcuts` no manifest: Capturar→`/app/inbox`, Tarefas→`/app/tasks`, Hoje→`/app`; validado por teste de estrutura do JSON — o long-press em si só é observável num Android real.)
- [x] Share sem sessão: login → volta pro quick-add com o conteúdo preservado. (`requireSession` já incluía `pathname+search` no `next`; corrigido bug latente em `safeNextPath` que derrubava a query inteira quando o texto compartilhado continha `..` — coberto por teste de round-trip completo do login.)
- [x] Manifest continua válido (Lighthouse instalável); nada do PWA atual regride (SW, ícones, standalone). (JSON validado por teste; `display`/`icons`/`name` intactos; SW com bump de versão pra invalidar cache antigo do manifest. Lighthouse em si é validação manual do dono.)
- [x] `start_url` conforme o estado da 65 (home se existir; senão grafo, com TODO). (a `65` já rodou e setou `start_url: /app` — nada a fazer aqui.)

## Validação

- `npm run typecheck` + `npm test` — verdes (730 testes no pool de Workers + 5 no pool node, incl. `test/manifest.test.ts` novo). Testes novos: prefill do quick-add a partir de `title`/`text`/`url`, hidden `source` (`console` vs `pwa-share`) com allowlist fechada no POST, round-trip completo do login preservando querystring com `..`, estrutura do `share_target`/`shortcuts`/campos existentes do manifest.
- **Pendente (dono, antes do deploy):** validação real em 1 Android (Chrome) — share target e long-press de shortcuts não são observáveis em desktop nem em teste automatizado; Lighthouse "instalável".
- **Gate de deploy:** `wrangler deploy` só com OK explícito do dono.

## Arquivos afetados

- `assets/manifest.webmanifest` (share_target, shortcuts, start_url)
- `src/web/inbox.ts` (params de share no quick-add — coordenar com a 63), `src/web/login.ts`/handler (preservar querystring no redirect, se necessário)
- `assets/sw.js` (bump de versão, se necessário)

## Riscos e reversão

- **Risco**: iOS não suporta share_target. Aceito: shortcuts cobrem iOS; share é ganho Android.
- **Risco**: SW antigo servir manifest cacheado. Mitigação: manifest casa na regra de assets — bump de versão do SW invalida.
- **Reversão**: remover os blocos novos do manifest; PWA volta ao estado atual.
