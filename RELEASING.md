# RELEASING.md — como publicar uma nova versão no npm

Esse arquivo é o runbook pra publicar uma nova versão do pacote `@expertintegrado/create-expert-brain` no npm. Se você (humano ou IA) for liberar uma atualização que afeta o que aluno baixa via `npm create @expertintegrado/expert-brain@latest`, é esse o caminho. Não improvisa.

## O que tá publicado

| Coisa | Onde |
|---|---|
| Repo (source of truth) | <https://github.com/expertintegrado/expertbrain> |
| Pacote npm | <https://www.npmjs.com/package/@expertintegrado/create-expert-brain> |
| Workflow que publica | [`.github/workflows/publish-create.yml`](.github/workflows/publish-create.yml) |
| Trusted Publisher config | <https://www.npmjs.com/package/@expertintegrado/create-expert-brain/access> |
| Scaffolder (o que roda na máquina do aluno) | [`create/bin.mjs`](create/bin.mjs) |

O pacote npm **não existe no repo** — ele é gerado pelo workflow em cada release. O repo só carrega `create/bin.mjs` + `create/package.json` + `create/README.md`. A pasta `create/template/` é populada pela CI espelhando `src/`, `scripts/`, `wrangler.example.toml`, `package.json` raiz, `README.md`, `CLAUDE.md` e `LICENSE`. Não tenta manter `create/template/` à mão — ela é descartável.

## Quando publicar

Publica uma nova versão quando uma das mudanças abaixo entrar na `master`:

- Mudança em `src/` (código do Worker)
- Mudança em `scripts/setup.mjs` ou `scripts/hash-password.mjs`
- Mudança em `wrangler.example.toml` (novo binding, mudança de nome, etc)
- Mudança em `CLAUDE.md` ou `README.md` que altera o runbook de instalação
- Mudança em `create/bin.mjs` ou `create/package.json`

**Não precisa publicar** pra: mudança só em `docs/`, `assets/`, `test/`, `.github/workflows/*` (exceto o `publish-create.yml`), ou commits internos que não afetam o que aluno baixa.

## Como publicar (3 passos)

### 1. Decide a versão (semver)

- **Patch** (`1.0.0` → `1.0.1`): bug fix, doc fix, ajuste interno sem mudar comportamento.
- **Minor** (`1.0.1` → `1.1.0`): feature nova, mudança não-breaking.
- **Major** (`1.1.0` → `2.0.0`): mudança que quebra setup existente (novo secret obrigatório, mudança de schema sem migration automática, etc).

A versão atual do pacote tá em <https://www.npmjs.com/package/@expertintegrado/create-expert-brain> ou roda:

```bash
npm view @expertintegrado/create-expert-brain version
```

### 2. Garante que `master` está com as mudanças

```bash
git status              # working tree limpa
git log origin/master..HEAD  # nada unpushed
```

Se faltar push, faz `git push origin master` antes.

### 3. Cria a release no GitHub

Via CLI:

```bash
gh release create v1.0.1 --title "v1.0.1 — <descricao curta>" --notes "<o que mudou>"
```

Via UI: <https://github.com/expertintegrado/expertbrain/releases/new> → tag `v1.0.1` (com o `v` na frente) → Publish.

O workflow [`publish-create.yml`](.github/workflows/publish-create.yml) dispara automaticamente no evento `release: published`, espelha o repo, bumpa a versão no `create/package.json` pra match da tag (strip do `v`), e publica no npm via OIDC.

## Verificar que deu certo

Depois da release, espera 1-2min e confirma:

```bash
# Action passou?
gh run list --workflow publish-create.yml --limit 1

# Versão atualizada no registry?
npm view @expertintegrado/create-expert-brain version
# deve mostrar o numero novo

# Smoke test em pasta vazia (opcional, mas recomendado pra majors):
cd /tmp && npm create @expertintegrado/expert-brain@latest test-vault
```

Se o `npm view` ainda retornar a versão antiga depois de 2min, espera mais um pouco — o CDN do npm propaga em ~5min no pior caso.

## Modos de falha

- **Workflow falha no step "Publish to npm" com 403**: o Trusted Publisher do npm tá desconfigurado. Conferir em <https://www.npmjs.com/package/@expertintegrado/create-expert-brain/access> — deve listar o repo `expertintegrado/expertbrain` + workflow `publish-create.yml`. Se foi removido por engano: clica "Add trusted publisher", preenche Publisher=GitHub Actions, Org=`expertintegrado`, Repo=`expertbrain`, Workflow filename=`publish-create.yml`, Environment vazio.
- **Workflow falha no step "Resolve version" com "Versao invalida"**: a tag não tá no formato `vX.Y.Z`. Apaga a release e cria de novo com a tag certa.
- **Publish passa mas `npm view` retorna 404 por mais de 10min**: rara propagação prolongada. Se persistir após 30min, abre suporte do npm; provavelmente conta foi bloqueada.
- **Renomeou o arquivo `publish-create.yml`**: o Trusted Publisher do npm tá amarrado nesse filename específico. Atualiza no painel de Access do npm o "Workflow filename" pro novo nome.

## Não faz

- **Não rode `npm publish` localmente.** Toda publicação passa pelo workflow — isso garante que o tarball tem `--provenance` (badge "Verified" no npm) e bate exatamente com o que tá no repo na tag.
- **Não edite `create/template/`.** Essa pasta é descartável; a CI sobrescreve no publish. Se quer mudar o que vai no template, mexe na lista `for item in ...` do workflow.
- **Não publique versão pré-existente.** O npm não aceita republicar a mesma versão. Se errou um release, bumpa pra próxima (ex: errou no `1.0.1`, vai pra `1.0.2`).
- **Não use `npm version` ou similar pra bumpar o `create/package.json` no repo.** A CI bumpa em runtime baseado na tag. O `create/package.json` no repo pode ficar com `0.0.0` que tá tudo bem.
