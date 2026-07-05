# PWA: console instalável no celular com atalho de captura

> **Status:** ready · **Prioridade:** P2 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** `63` (a captura é o atalho que justifica o ícone) · suave: `65` (home como start_url)
> **Agente sugerido:** Sonnet (assets + client) · **Esforço de execução:** padrão

## Contexto

- O console é web responsivo servido pelo Worker (assets via binding `ASSETS`, `wrangler.toml:63`), mas não é instalável: sem `manifest.json`, sem service worker, sem ícones — no celular vive como aba perdida do navegador.
- O dia a dia do segundo cérebro acontece no celular; a captura da `63` (quick-add + bots) resolve a ENTRADA, mas abrir o console pra triagem/consulta ainda custa achar a aba.
- Sessão por cookie (`requireSession`) — o PWA herda o login do navegador; sem auth nativa nova.

## Problema / Motivação

- Sem ícone na home screen, o console perde pra qualquer app nativo na disputa de atenção — o sistema "mais foda" precisa estar a 1 toque.
- O share target do Android/iOS (compartilhar texto/link de qualquer app → console) é a captura de menor fricção possível e só existe pra PWA instalada.

## Design proposto

### 1. Manifest + ícones

- `manifest.webmanifest` servido pelo Worker: `name`/`short_name` da instância, `start_url: /app` (home da 65; fallback `/app/tasks`), `display: standalone`, `theme_color`/`background_color` do tema NEBULA, ícones 192/512 + maskable (gerar no build, sem serviço externo).
- `<link rel="manifest">` + meta theme-color no shell (`src/web/layout.ts`).

### 2. Service worker MÍNIMO (deliberadamente burro)

- `sw.js`: cache-first SÓ pra assets estáticos versionados (o console já versiona via `asset-version.ts`); **network-only pra TODA rota `/app/*`** (dados sempre frescos — cache de HTML logado é fonte de bug e de vazamento pós-logout).
- Offline: página estática "Sem conexão" (sem dados). NENHUMA fila offline de escrita nesta fase.
- Registro do SW no shell; atualização por `skipWaiting` + reload prompt discreto.

### 3. Share target (a captura de 1 toque)

- No manifest: `share_target` (method GET, params `title/text/url`) apontando pra `/app/inbox?share=...`.
- `/app/inbox` (63): quando chegar com params de share, pré-preencher o quick-add com `title + text + url` concatenados e focar o botão salvar — compartilhou → 1 toque → capturado (`source: 'pwa-share'`).
- Atalhos de app (`shortcuts` no manifest): "Capturar" → `/app/inbox`, "Tarefas" → `/app/tasks`.

## Fora de escopo

- Push notifications (exigiria infra de subscription; o canal de notificação é o do `notify.ts`).
- Offline de leitura/escrita com sync (complexidade alta, valor marginal com rede móvel onipresente).
- App nativo/TWA na Play Store.
- PWA do console standalone do contacts (só o Brain — é o console principal).

## Critérios de aceite

- [ ] Lighthouse PWA: instalável (manifest válido + SW + HTTPS); ícone e nome corretos na home screen (Android e iOS).
- [ ] Instalado, abre em standalone na home (`/app`), logado (cookie herdado).
- [ ] Compartilhar um texto de outro app pro console → quick-add pré-preenchido → salvar cria item no inbox com `source: 'pwa-share'`.
- [ ] Rotas `/app/*` NUNCA servidas de cache (DevTools: network-only); assets estáticos vêm do cache na 2ª visita.
- [ ] Logout + reabrir PWA → tela de login (nenhum dado logado em cache).
- [ ] Deploy de versão nova → prompt de atualização aparece e o reload aplica.

## Validação

- `npm run typecheck` + `npm test` (unit do que for testável; SW é validação manual).
- Manual: instalar em 1 Android real (Chrome) e 1 iOS (Safari), rodar o roteiro dos critérios.
- **Gate de deploy:** `wrangler deploy` só com OK explícito do dono.

## Arquivos afetados

- `public/`/assets: `manifest.webmanifest`, `sw.js`, ícones (novos)
- `src/web/layout.ts` (link manifest + registro do SW), `src/web/handler.ts` (servir manifest/sw com content-type certo)
- `src/web/inbox.ts` (params de share no quick-add), `scripts/` (geração de ícones no build, se necessário)

## Riscos e reversão

- **Risco**: SW cacheando além do planejado (classe clássica de bug). Mitigação: allowlist explícita de assets versionados; `/app/*` network-only por regra negativa testada manualmente.
- **Risco**: iOS com suporte parcial a share_target. Aceito: atalho "Capturar" cobre o iOS; share target é ganho no Android.
- **Reversão**: remover manifest/SW + servir `sw.js` "suicida" (unregister + caches.delete) por um ciclo — padrão de despublicação de SW.
