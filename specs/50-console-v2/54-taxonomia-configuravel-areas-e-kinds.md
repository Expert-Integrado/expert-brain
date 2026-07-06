# Taxonomia configurável: cor e nome de exibição das áreas (domains) e tipos (kinds), com criação de área pela UI

> **Status:** done · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> **Depende de:** nenhuma
> **Agente sugerido:** Sonnet (config + consumo visual; zero migração de dados)

## Contexto

- As **áreas (domains)** das notas são strings livres armazenadas no JSON `notes.domains` — não há tabela nem enum; uma área "nasce" quando a primeira nota a usa. A convenção é slug kebab-case em inglês (ex.: `management`, `sales`, `ai-applied`).
- As **cores** das áreas vêm de uma paleta FIXA no código: `src/web/domain-colors.ts` — mapa slug→hex com fallback cinza pra domain desconhecido. Consumida pelo grafo (nós/legenda), badges da lista de notas e filtros.
- Os **kinds** (concept, decision, insight, fact, pattern, principle, question) são enum estrutural validado no MCP (`save_note` exige um dos 7) e têm cor/estilo automáticos no console.
- Não existe NENHUMA UI de gestão: pra mudar a cor de uma área é preciso editar `domain-colors.ts` e fazer deploy; pra "criar" uma área, salvar uma nota com o slug novo (que aparece cinza).
- Preferências do dono já têm um padrão estabelecido: tabela `meta` (key-value) + sanitização server-side + POST de sessão — ver `graph_prefs` em `src/web/graph-prefs.ts:13-14,73-112,132-149` e `personalization_prompt` em `src/web/config.ts:24,31-47`.
- Página de configurações: `/app/config` (`src/web/config.ts:49-221`, seções `<details>`).

## Problema / Motivação

- O dono da instância quer olhar o grafo e reconhecer as áreas pelas SUAS cores e nomes — hoje a paleta é opinião do código, e área nova fica cinza pra sempre (`domain-colors.ts`, fallback).
- Slug em inglês é ótimo pra máquina (canônico, estável no MCP) e ruim pra leitura (ex.: `personal-development` vs "Desenvolvimento Pessoal") — falta a camada de LABEL de exibição.
- Criar área nova exige saber a convenção e salvar uma nota "no escuro" — não há lugar na UI que liste e gerencie a taxonomia.

## Objetivo

O dono edita cor e nome de exibição de qualquer área e de qualquer kind, e cria áreas novas, tudo em `/app/config` — refletindo em grafo, legenda, badges e filtros — **sem tocar em nenhuma nota e sem mudar nada no contrato MCP** (slugs continuam as chaves canônicas).

## Design proposto

### 1. Storage: chave `taxonomy_config` na tabela `meta` (padrão `graph_prefs`)

```json
{
  "domains": {
    "management":       { "label": "Gestão",  "color": "#8b5cf6" },
    "minha-area-nova":  { "label": "Minha Área Nova", "color": "#22c55e" }
  },
  "kinds": {
    "decision": { "label": "Decisão", "color": "#f59e0b" }
  }
}
```

- Config é SPARSE: só o que o dono customizou; o resto cai no fallback (paleta atual de `domain-colors.ts` pros domains; estilo atual pros kinds).
- Entrada em `domains` cuja área ainda não tem nota = área "pré-criada" (aparece na legenda/filtros/selects com 0 notas).
- Módulo novo `src/web/taxonomy-config.ts` espelhando `graph-prefs.ts`: `sanitizeTaxonomyConfig` (slug kebab-case `[a-z0-9-]{1,40}`, label 1-40 chars, cor `#rrggbb`, máx 64 domains e 16 kinds — kinds restritos aos 7 canônicos), `getTaxonomyConfig(env)`, `handleTaxonomyPost` (`POST /app/config/taxonomy`, sessão).

### 2. UI em `/app/config` — seção "Áreas e tipos"

- **Áreas**: tabela com TODAS as áreas em uso (query distinta sobre `notes.domains`, excluindo tasks via `NON_TASK_FILTER` de `src/db/queries.ts:31`) + as pré-criadas da config. Por linha: swatch `<input type="color">`, label editável, slug (read-only, mono), contagem de notas. Botão **"Nova área"**: campo label → slug gerado automaticamente (kebab-case, sem acentos — ex.: "Vida Pessoal" → `vida-pessoal`), editável antes de confirmar, com validação de colisão.
- **Tipos (kinds)**: as 7 linhas fixas, cada uma com swatch + label editável. SEM criar/excluir kind (enum estrutural do MCP — fora de escopo).
- Botões Salvar/Restaurar padrão (restaurar = apagar a chave `taxonomy_config`; tudo volta ao fallback).

### 3. Consumo (a parte que espalha)

Criar UM resolvedor central e fazer todos os pontos de exibição passarem por ele:

- `src/web/domain-colors.ts` ganha `resolveDomainMeta(slug, config)` → `{ label, color }` (config → fallback paleta → fallback cinza+slug) e `resolveKindMeta(kind, config)` idem.
- **Server-side (SSR)**: lista de notas (badges), detalhe da nota, legenda do grafo, página de busca — trocar acesso direto à paleta pelo resolvedor.
- **Client-side (bundles)**: o grafo importa a paleta compilada hoje; passar a ler um mapa injetado pelo server no HTML (ex.: `canvas.dataset.taxonomy` ou `<script type="application/json" id="taxonomy-config">`), com a paleta compilada como fallback — mesmo padrão do `graphPrefs` via dataset já usado pelo grafo. Aplicar em: cor dos nós, legenda/chips de filtro, painel do nó.
- **Selects de área** (filtros do console, futura criação de nota pela web): união de áreas em uso + pré-criadas, ordenadas por label.
- MCP: **inalterado** — `save_note`/`recall` seguem falando slug. As instructions do servidor MCP podem, opcionalmente, listar as áreas do dono (união em uso + config) no texto de orientação — marcar como passo opcional.

### 4. O que NÃO acontece

Renomear label NÃO renomeia slug (zero UPDATE em notas — é só exibição). "Excluir" área não existe (área some sozinha quando nenhuma nota a usa e não há entrada na config; remover a entrada da config remove só a customização/pré-criação).

## Fora de escopo

- Criar/excluir/renomear KIND (enum do MCP).
- Renomear SLUG de área existente (migração de dados em massa; se um dia, spec própria com reembed).
- Merge de áreas, hierarquia de áreas, ícones por área.
- Cores por TIPO de contato (vault contacts tem paleta própria já shipada).

## Critérios de aceite

- [x] Mudar a cor de uma área na config reflete em: nós do grafo, legenda, badge na lista de notas e chip de filtro — após reload, sem deploy.
- [x] Mudar o label exibe o nome novo em todas essas superfícies; o slug segue visível no detalhe (mono) e o MCP segue aceitando/retornando o slug.
- [x] Criar "Nova área" pela UI: aparece imediatamente em legenda/filtros/selects com 0 notas; salvar nota via MCP com o slug novo a associa normalmente.
- [x] Kind com label/cor customizados reflete nos badges do console; `save_note` com kind fora dos 7 continua rejeitado.
- [x] Restaurar padrão volta 100% ao comportamento atual (paleta compilada).
- [x] Config inválida (cor malformada, slug com maiúscula/acento, label vazio) é rejeitada no POST com mensagem clara; nada é persistido parcialmente.
- [x] Zero mudança em `notes` (nenhum UPDATE de dados) — verificável por checksum/count antes e depois nos testes.

## Validação

- `npm run typecheck` e `npm test` verdes.
- Testes novos: sanitize (casos válidos/inválidos), resolvedor (config > paleta > cinza), POST com sessão, render da legenda com área pré-criada, isolamento (task NUNCA entra na listagem de áreas).
- Manual (`wrangler dev`): customizar 2 áreas + 1 kind, criar 1 área nova, conferir grafo/lista/filtros; restaurar padrão.
- **Gate de deploy:** só com OK explícito do dono da instância.

## Arquivos afetados

- `src/web/taxonomy-config.ts` (novo), `src/web/domain-colors.ts` (resolvedores)
- `src/web/config.ts` (seção nova), `src/web/handler.ts` (rota POST)
- `src/web/graph.ts` (injeção do mapa no HTML), `src/web/client/graph.ts` (leitura + fallback)
- `src/web/notes.ts`, `src/web/search.ts` (badges/labels via resolvedor)
- `test/` (suites acima)

## Riscos e reversão

- **Risco**: ponto de exibição esquecido fora do resolvedor (drift visual). Mitigação: grep por import direto da paleta como critério de aceite do PR (só o resolvedor pode importá-la).
- **Risco**: dataset injetado crescer com muitos domains. Mitigação: cap 64 + payload é só slug/label/cor (~2KB no pior caso).
- **Reversão**: apagar a chave `taxonomy_config` da tabela `meta` (ou Restaurar padrão na UI) + revert do código — comportamento idêntico ao atual.
