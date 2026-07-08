# Onda 0 — Infra de auditoria e baseline

> **Status:** in-progress · **Prioridade:** P0 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** `60-ux-reforma/60-visao-geral.md`

## Contexto

Antes de qualquer mudança de código nas Ondas 1-7, esta onda constrói a rede de segurança: um harness que fotografa o estado atual do console (baseline), congela esse baseline, e prepara a infraestrutura de teste que faltava na camada client. Sem isso, não há como provar ao dono, ao final, que a reforma não regrediu nenhuma tela.

Estado real do repo no momento em que esta spec foi escrita (verificar de novo antes de continuar — pode ter avançado):

- `scripts/ux-audit/audit.py`, `scripts/ux-audit/screens.py` e `scripts/ux-audit/contact_sheet.py` **já existem no working tree, mas estão UNTRACKED** (`git status --short` mostra `?? scripts/ux-audit/`) — ninguém commitou ainda. `screens.py` já define `VIEWPORTS = {"desktop": {1440x900}, "mobile": {390x844}}` e uma lista `SCREENS` com o formato descrito no "Design proposto" abaixo, e seu próprio docstring já referencia esta spec (`specs/60-ux-reforma/61`).
- `scripts/ux-audit/diff.mjs` (pixelmatch) **ainda não existe**.
- `scripts/seed-dev.mjs`, `scripts/verify-wave.mjs`, `vitest.client.config.ts`, a pasta `e2e/` e `docs/ux-reform-verificacao.md` **ainda não existem**.
- `C:/repos/expert-brain/.dev.vars` e `C:/repos/expert-contacts/.dev.vars` **JÁ TÊM `CONTACTS_PROXY_TOKEN` preenchido com o MESMO valor nos dois arquivos** (confirmado por comparação de hash nesta sessão, sem expor o valor). Isso diverge do diagnóstico original do plano de projeto (que registrava os dois arquivos como vazios nesse campo) — **o item "fix de `.dev.vars`" desta onda pode já estar resolvido; o agente que executar esta spec deve reconferir os dois arquivos ANTES de gastar tempo recriando o token**, e só documentar o achado (não sobrescrever um token que já funciona).
- `package.json` (raiz) não tem `jsdom` em devDependencies, não tem script `test:client`, e `vitest.config.ts`/`vitest.auth.config.ts` são os únicos configs de vitest hoje — confirma que a infra de teste client é trabalho novo desta onda.
- Não existe pasta `prototypes/` no repo (chega na Onda 1).

## Problema / Motivação

- Sem baseline fotografado ANTES de mudar código, não há como o dono comparar "antes vs depois" ao final (Onda 7) nem como qualquer onda intermediária provar que não quebrou uma tela que não deveria tocar.
- A camada de client (`src/web/client/*.ts`) tem zero testes automatizados hoje — confirmado por ausência de `vitest.client.config.ts` e de pasta `test/client/`. A Onda 4 (DnD, clique, seletor de visibilidade) reescreve exatamente essa camada; sem harness de teste jsdom/e2e, cada onda seguinte fica sem rede de segurança pra regressão de interação.
- As superfícies que dependem de `expert-contacts` (avatares, timeline, menções) davam 503 localmente quando o proxy não tinha token configurado — hoje já não é mais o caso (ver Contexto acima), mas isso só foi descoberto verificando o arquivo; sem essa auditoria, o baseline capturaria erros que na verdade já não existem.
- Não existe hoje um processo padronizado de "isso está pronto pra próxima onda" — cada onda precisa rodar typecheck, os dois conjuntos de teste server, build de bundles, e a captura de tela, manualmente e sem checklist.

## Objetivo

Um agente rodando `scripts/ux-audit/audit.py --phase baseline` produz o manifest + as ~16 telas × 2 viewports em `C:/tmp/ux-audit/baseline/`, `npm run test:client` roda uma suíte jsdom (mesmo que mínima) e passa, `e2e/` tem pelo menos um smoke test Playwright rodando localmente, e `scripts/verify-wave.mjs` existe e encadeia typecheck → testes → build → e2e → captura → comparação, pronto para ser chamado ao final de cada onda seguinte.

## Design proposto

### 1. Harness de screenshots (`scripts/ux-audit/`)

- **`audit.py`** (já existe, 238 linhas — revisar e completar, não reescrever do zero): login em `wrangler dev` local (`http://localhost:8787`), credenciais via env vars (`OWNER_EMAIL`/senha local — NUNCA hardcoded no repo público; usar as mesmas do `.dev.vars` local), Playwright Python. Deve orquestrar `screens.py` (inventário de telas) e `contact_sheet.py` (comparação).
- **`screens.py`** (já existe, 52 linhas — já define o formato de entrada correto): cada item da lista `SCREENS` é um dict com `slug`, `path` (rota fixa ou callable que recebe ids descobertos), `needs` (`'task' | 'note' | 'contact' | 'share' | None`), `logged_in` (bool), `full_page` (bool — `False` pra canvas/overlay do grafo), `settle_ms` (espera extra), `action` (ex. `'palette'` abre Ctrl+K antes do shot), `wait_hidden` (seletor que precisa sumir antes do shot, ex. `#graph-center-loading.hidden`). Cobrir as ~16 telas: login, home, board, task detail, notes lista, notes detalhe, journal, inbox, contacts, contact page, graph 2D (com `settle_ms` de 4000-5000 e `wait_hidden: '#graph-center-loading.hidden'`), config, api-keys, novidades/releases, `/s/<token>` (contexto SEM cookies — sessão limpa), palette via Ctrl+K.
- **IDs descobertos em runtime:** token de share obtido via `POST /app/tasks/share` numa task existente descoberta antes via `GET /app/tasks/data`; task/note/contact ids da mesma forma (não fixar IDs hardcoded — o seed determinístico da seção 2 abaixo só roda DEPOIS do baseline, então o baseline usa o que já existir no D1 local).
- **2 viewports:** `1440x900` (desktop) e `390x844` (mobile touch) — já declarados em `VIEWPORTS` em `screens.py`.
- **Antes de cada shot:** `page.emulate_media(reduced_motion="reduce")` e aguardar `document.fonts.ready` — elimina flakiness de fonte/animação nas comparações.
- **`contact_sheet.py`** (já existe, 97 linhas): gera HTML comparativo lado a lado quando chamado com `--against <fase-anterior>`. É a ferramenta de review do dono — abrir no navegador e olhar lado a lado.
- **`diff.mjs`** (NOVO, Node + pixelmatch): usado SÓ sob demanda, nas telas que uma onda específica NÃO deveria ter tocado (detecta regressão de CSS global). Não é gate automático em toda onda — numa reforma deliberada, diff de pixel constante seria ruído. O grafo (`graph.ts`) fica excluído do diff por natureza (canvas não determinístico).
- **Saída:** `C:/tmp/ux-audit/<fase>/` (ex. `baseline/`, `wave-1/`, `wave-4/`, `final/`), com `manifest.json` incluindo o SHA do commit git no momento da captura.
- **Git:** commitar `audit.py`, `screens.py`, `contact_sheet.py`, `diff.mjs` no repo (`scripts/ux-audit/` — código de tooling, não dado de cliente); a SAÍDA das capturas (PNGs, manifests) fica em `C:/tmp/`, fora do repo, nunca commitada.

### 2. `.dev.vars` e contacts local

- **Reconferir primeiro** (ver Contexto): se `CONTACTS_PROXY_TOKEN` já está preenchido e IGUAL nos dois `.dev.vars`, pular esta etapa e só registrar o achado no commit desta onda.
- Se algum dos dois estiver vazio ou os valores divergirem: gerar um token novo local (não-secreto, é só pra dev local — mesmo assim NUNCA commitar o `.dev.vars`, que já está no `.gitignore` de ambos os repos) e colocar o MESMO valor nos dois arquivos.
- Rodar os dois workers juntos: opção A (preferida) — `wrangler dev -c wrangler.toml -c C:/repos/expert-contacts/wrangler.toml` (processo único; wrangler 4.81 suporta multi-config). Fallback: 2 terminais/processos separados, contando com o dev registry do wrangler pra conectar o binding de service entre eles.
- Se a integração emperrar por qualquer motivo: o baseline captura o estado de erro (503) mesmo assim — isso também é dado válido pro "antes". Não criar stub nem mock pra mascarar a falha.

### 3. Seed determinístico (`scripts/seed-dev.mjs`)

Roda DEPOIS do baseline capturado (o baseline reflete o dado orgânico que já existe local; o seed padroniza o que vem depois pra tornar as telas reproduzíveis entre execuções da mesma onda).

- Executa via `wrangler d1 execute DB --local` (não abre conexão HTTP — usa o binding local do D1).
- Cria: ~20 notas cobrindo os 7 `kind`s canônicos (concept/decision/insight/fact/pattern/principle/question), ~10 edges com `why` preenchido, 14 tasks distribuídas nas 4 categorias visuais do board (a fazer/em andamento/feito/etc — conferir os nomes reais de coluna no schema antes de fixar), com prioridades, tags, `due` relativo calculado no momento do seed (não datas fixas que expiram), 3 tasks com comentários, 1 task privada (`private=1`), 1 task com `share_token` fixo no formato `ebs_` + 40 caracteres alfanuméricos (mesmo formato do token real, só que sintético). 2 projetos. 5 itens de inbox. Menções fictícias usando nomes claramente inventados (ex. "Ana Almeida" — nunca nome de pessoa real do contexto do dono).
- IDs fixos com prefixo `seed-*`, conteúdo 100% fictício, em PT-BR.
- Salvaguardas obrigatórias: exige flag `--local` ou `--ci` explícita (recusa rodar sem); aborta com erro se já existirem notas no banco e a flag `--force` não foi passada; `--reset` apaga SÓ as linhas com id `seed-%` (nunca um `DELETE FROM notes` genérico).

### 4. Infra de teste client (`vitest.client.config.ts` + `e2e/`)

- **`vitest.client.config.ts`** (novo, jsdom): adicionar `jsdom` como devDependency. Primeiros testes cobrem módulos puros e importáveis sem efeito colateral de bootstrap: `save-queue`, `toast`, `http`, `src/util/task-badges.ts` (client-safe, sem import de DOM real — ver conteúdo em `src/util/task-badges.ts:1-53`, cuidado com o path real, NÃO é `src/web/task-badges.ts`). Controllers de página inteiros (ex. `client/tasks.ts`) têm hoje bootstrap que roda no import (efeito colateral) — cada onda seguinte que mexer numa dessas páginas deve refatorar pra "entry fina" (bootstrap isolado do resto do módulo) antes de testar, não é obrigação desta onda cobrir 100%.
- Novo script `"test:client": "vitest run --config vitest.client.config.ts"` em `package.json`.
- **`e2e/`** (pasta nova — NÃO usar `test/`, que já tem `test/e2e.test.ts` de outro contexto e colidiria): `playwright.config.ts` com `webServer` apontando pro `wrangler dev` local, `global-setup.ts` rodando migrations via endpoint `/setup` + o seed da seção 3 + captura de `storageState` autenticado, 5-6 specs de smoke.
- **Técnica de DnD nos testes:** a implementação ATUAL usa `dispatchEvent` com um `DataTransfer` sintético (HTML5 DnD). Quando a Onda 4 trocar a implementação real pra Pointer Events, os testes e2e de drag são reescritos pra `page.mouse` (`move`/`down`/`up` em passos) — não reescrever agora, só deixar a spec da Onda 4 ciente da dependência.
- **CI:** job novo em `.github/workflows/ci.yml` rodando `wrangler dev` local no runner do Actions + a suíte e2e + `test:client`. Anti-flakiness: seed fixo (não aleatório), `workers: 1`, `retries: 1` só no CI (não local), o teste de grafo (canvas) fica FORA do e2e, runtime alvo ≤ 3 minutos pro job.
- Credencial de teste usada nos testes (`teste@local.dev` / `teste-local-3d`) já está pública em `vitest.config.ts` do próprio repo — pode aparecer nesta spec e no código sem violar a regra anti-vazamento.

### 5. `scripts/verify-wave.mjs`

Script único que cada onda seguinte roda ao terminar, na ordem:

1. `npm run typecheck`
2. `npm test` (suíte server) + `npm run test:client` (suíte client, criada aqui)
3. `npm run build:bundles` seguido de `git diff --exit-code assets/` (garante que o bundle commitado bate com o source — pega esquecimento de rebuild, problema real já visto no histórico do repo — ver `50-console-v2/65` no roadmap, onde um bundle ficou dessincronizado por uma onda inteira)
4. Suíte e2e (`e2e/`)
5. `python scripts/ux-audit/audit.py --phase wave-N`
6. `python scripts/ux-audit/contact_sheet.py --against baseline`

Falha em qualquer etapa para o script com código de saída não-zero e mensagem indicando qual etapa falhou — não continua silenciosamente.

Complementar: `docs/ux-reform-verificacao.md` (novo) com o checklist manual de 5 minutos que o dono roda antes de aprovar cada onda relevante (não substitui `verify-wave.mjs`, é a camada humana).

## Fora de escopo

- Corrigir qualquer bug de UI identificado durante a captura do baseline — o baseline é só fotografia, não conserto. Bugs vão pras ondas correspondentes (1-7).
- Cobertura completa de testes client para TODOS os módulos — só a fundação (módulos puros + smoke e2e). Cobertura ampliada é responsabilidade de cada onda ao tocar o módulo dela.
- Rodar o seed em produção ou em qualquer ambiente que não seja local (`--local`/`--ci` são obrigatórios).
- Resolver a integração `expert-contacts` além do necessário pro dev local funcionar (não é objetivo desta onda mexer no código do outro repo).

## Critérios de aceite

- [ ] `scripts/ux-audit/audit.py`, `screens.py`, `contact_sheet.py` commitados (hoje existem mas estão untracked) e `diff.mjs` criado
- [ ] Baseline capturado em `C:/tmp/ux-audit/baseline/` com as ~16 telas × 2 viewports + `manifest.json` com SHA do commit, ANTES de qualquer edição de código de produto desta reforma
- [ ] Estado do `CONTACTS_PROXY_TOKEN` nos dois `.dev.vars` reconferido e documentado no commit (se já estava certo, dizer isso; se corrigido, confirmar igualdade sem expor o valor)
- [ ] `scripts/seed-dev.mjs` existe, roda com `--local`, recusa rodar sem a flag, aborta sem `--force` se já há notas, e `--reset` só afeta linhas `seed-%`
- [ ] `vitest.client.config.ts` existe, `npm run test:client` passa com pelo menos os módulos puros cobertos
- [ ] `e2e/playwright.config.ts` + `global-setup` + pelo menos 1 spec de smoke rodam localmente com sucesso
- [ ] `scripts/verify-wave.mjs` existe e executa as 6 etapas em sequência, parando no primeiro erro
- [ ] `docs/ux-reform-verificacao.md` existe com o checklist manual
- [ ] `.github/workflows/ci.yml` tem o job novo de e2e + test:client

## Validação

```bash
cd C:/repos/expert-brain
npm run typecheck
npm test
npm run test:client
node scripts/verify-wave.mjs --phase wave-0-selfcheck
```

Teste manual: abrir `C:/tmp/ux-audit/baseline/contact-sheet.html` (gerado por `contact_sheet.py`) e conferir visualmente que as ~16 telas × 2 viewports estão presentes e legíveis.

**Gate de deploy:** não se aplica — esta onda não toca nenhuma tela de produto, só tooling e scripts locais. Nenhum `wrangler deploy` nesta spec.

## Arquivos afetados

- `scripts/ux-audit/audit.py`, `screens.py`, `contact_sheet.py` (já existem, untracked — revisar e commitar)
- `scripts/ux-audit/diff.mjs` (novo)
- `scripts/seed-dev.mjs` (novo)
- `scripts/verify-wave.mjs` (novo)
- `vitest.client.config.ts` (novo, raiz)
- `package.json` (novo script `test:client`, nova devDependency `jsdom`)
- `e2e/playwright.config.ts`, `e2e/global-setup.ts`, `e2e/*.spec.ts` (novos)
- `docs/ux-reform-verificacao.md` (novo)
- `.github/workflows/ci.yml` (job novo)
- `.dev.vars` (local, NÃO commitado — só reconferido/corrigido)

## Riscos e reversão

- **Risco:** baseline capturado incompleto (ex. contacts em 503) vira falso "correto" e mascara regressão real mais tarde. Mitigação: o manifest registra explicitamente quais telas deram erro no baseline; a comparação final trata "erro→sucesso" como melhoria esperada, não regressão.
- **Risco:** seed determinístico rodar sem querer contra um banco com dados reais. Mitigação: as 3 salvaguardas (`--local`/`--ci` obrigatório, abort sem `--force` se `notes > 0`, `--reset` restrito a `seed-%`) tornam isso preciso de ação deliberada em 2 flags.
- **Reversão:** toda esta onda é tooling novo, sem tocar `src/web/`. `git rm` dos arquivos listados reverte por completo, sem efeito em produção (nada aqui é deployado).
