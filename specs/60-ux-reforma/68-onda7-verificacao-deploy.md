# Onda 7 — Verificação final e deploy único

> **Status:** done (10/07/2026 — ver "Fechamento" abaixo: o desenho original de deploy único foi superado pelos deploys incrementais autorizados pelo dono; bateria automatizada verde nesta data) · **Prioridade:** P0 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** `60-ux-reforma/67-onda6-identidade-a11y.md`

## Fechamento (10/07/2026)

O "deploy único ao final" foi superado pelos fatos: entre 06 e 09/07 o dono autorizou
deploys incrementais (Console v2+v3, grupo 70-grafo-higiene em ce412aab) que levaram TODO
o código da reforma pra produção — main já estava com as ondas 0-9b mergeadas. Em 10/07 o
dono deu o OK explícito de encerramento ("pode fazer deploy de tudo, quero zerar todas as
pendências"). O que restou desta onda foi executado assim:

- Bateria automatizada (10/07): typecheck verde, suíte server verde, suíte client verde,
  `build:bundles` com `git diff --exit-code assets/` limpo, e2e 13 passed / 0 failed.
- Harness visual audit/contact-sheet: não executado — o insumo que ele gerava (aprovação
  visual PRÉ-deploy) perdeu o objeto; a validação visual é o uso real do console pelo dono
  desde 08/07 + o checklist manual abaixo.
- Checklist manual de `docs/ux-reform-verificacao.md`: entregue ao dono como checklist de
  navegador no fechamento da janela (drag de card desktop/mobile, detalhe do card, concluir
  sem navegar, 3 estados de visibilidade, home em 320px). Em 10/07/2026 o dono deu o aceite
  explícito ("considero coberta"), com a validação visual sendo o uso real do console desde
  08/07 — execução formal do checklist dispensada. Programa da reforma UX encerrado.

## Contexto

Última onda do programa. Nenhuma linha de código de produto muda aqui — o trabalho é inteiramente de verificação, validação humana e, só ao final, o deploy único de produção que o dono definiu como decisão nº 2 (`60-visao-geral.md`): "TUDO JUNTO NO FINAL — um pacote só, deploy único em produção ao final, com OK explícito dele".

## Problema / Motivação

- O programa inteiro (Ondas 0-6) roda em `wrangler dev` local, sem tocar produção. Sem uma onda dedicada de verificação final, o risco é acumular pequenas regressões não percebidas onda a onda que só apareceriam juntas no deploy real.
- O gate de deploy da spec-zero (`specs/README.md`, seção 1: "deploy de produção... SOMENTE com OK explícito do dono da instância, dado naquela sessão") exige que o pedido de autorização seja concreto — não basta "está tudo pronto", precisa de evidência (contact sheet, checklist, suíte verde) pra o dono decidir com informação.

## Objetivo

O dono compara o contact sheet baseline-vs-final, percorre o checklist manual de interação, valida localmente via `npm run dev:full` (ou equivalente com contacts integrado), e dá o OK explícito na sessão — só então o deploy único de produção acontece, seguido de verificação pós-deploy contra a URL real.

## Design proposto

1. **`verify-wave.mjs` completo** (`--phase final`): typecheck, suíte server + client, build de bundles com `git diff --exit-code assets/`, suíte e2e completa, captura de screenshots fase `final`.
2. **Contact sheet baseline vs. final:** `python scripts/ux-audit/contact_sheet.py --against baseline` gerando o artefato de aprovação visual — é o principal insumo pro dono decidir.
3. **Checklist manual de interação** (`docs/ux-reform-verificacao.md`, criado na Onda 0): arrastar card no desktop E no mobile; clicar em card abre o detalhe; concluir task não navega; visibilidade nos 3 estados (Privado/Normal/Link público) com as confirmações corretas nas transições destrutivas; home íntegra em 320px de viewport.
4. **Validação local do dono:** `npm run dev:full` (ou o comando equivalente que sobe `wrangler dev` com o binding de `expert-contacts` integrado, conforme estabelecido na Onda 0) — o dono percorre o checklist pessoalmente antes de autorizar qualquer coisa em produção.
5. **Preview opcional, com cautela:** `wrangler versions upload` gera uma URL de preview sem rotear tráfego de produção pra ela — MAS o preview usa os bindings REAIS de produção (D1 real, não um banco de teste). Se usado, é só pra NAVEGAR e olhar, nunca pra escrever/testar mutação (evitar poluir dado real de produção com teste). Alternativa mais conservadora e igualmente válida: pular o preview e validar só localmente.
6. **Deploy único, só com OK explícito:** somente depois do dono aprovar o contact sheet + o checklist + (se usado) o preview, roda `npm run deploy` (que já encadeia `build:bundles` + `scripts/deploy.mjs`, conforme `package.json:13`). Esse é o ÚNICO deploy de todo o programa de reforma.
7. **Harness pós-deploy:** rodar `scripts/ux-audit/audit.py --phase prod-pos-deploy` contra a URL de produção real (não mais `localhost:8787`) — confirma que o que foi pro ar é de fato o que foi validado localmente.
8. **Tag/release/CHANGELOG:** seguir `RELEASING.md` (processo já existente no repo) pra registrar a versão que inclui a reforma; atualizar a página GitHub Pages do produto se o conteúdo dela referenciar a UI antiga.

## Fora de escopo

- Qualquer correção de bug encontrada durante esta onda que exija mudança de código de produto — se aparecer algo assim, a onda PARA, o bug volta pra onda correspondente (provavelmente 4, 5 ou 6), e a verificação final é refeita depois do fix. Esta onda não é o lugar de fazer fix ad-hoc de última hora sem passar pela onda dona daquele código.
- Migrar dado de produção ou rodar qualquer script de backfill — fora do escopo desta reforma de UI.
- Deploy do `expert-contacts` — esta reforma é só `expert-brain`; `expert-contacts` não teve nenhum código alterado nas 7 ondas.

## Critérios de aceite

- [ ] `verify-wave.mjs --phase final` roda limpo (typecheck, testes server+client, build+diff de bundles, e2e, captura)
- [ ] Contact sheet baseline-vs-final gerado e revisado
- [ ] Checklist manual de `docs/ux-reform-verificacao.md` percorrido e todos os itens marcados
- [ ] Dono validou localmente via `wrangler dev`/`dev:full` percorrendo o checklist pessoalmente
- [ ] **OK explícito do dono registrado nesta spec antes do deploy** (data + confirmação: `[A PREENCHER NA EXECUÇÃO]`)
- [ ] `npm run deploy` executado (ÚNICO deploy do programa inteiro)
- [ ] Harness pós-deploy rodado contra a URL de produção real, sem discrepância em relação ao validado localmente
- [ ] Tag/release criada conforme `RELEASING.md`; CHANGELOG atualizado

## Validação

```bash
cd C:/repos/expert-brain
node scripts/verify-wave.mjs --phase final
```

Teste manual: o checklist completo de `docs/ux-reform-verificacao.md`, executado pelo dono, é o teste de aceite final do programa inteiro — não só desta onda.

**Gate de deploy (regra dura, reafirmada da spec-zero):** `npm run deploy`/`wrangler deploy` e qualquer `git push` pro remoto de produção só acontecem com o OK explícito do dono, dado NAQUELA sessão, depois de ele ter visto o contact sheet e percorrido o checklist. Nenhuma automação ou "carta branca" anterior substitui essa confirmação pontual — mesmo que o dono tenha aprovado o programa como um todo no início, o deploy em si exige a confirmação final, específica, desta onda.

## Arquivos afetados

- Nenhuma mudança de código de produto nesta onda (só execução de scripts de verificação e o deploy em si)
- `docs/ux-reform-verificacao.md` (preenchido/marcado durante a execução)
- `CHANGELOG.md` (se existir no repo — conferir; senão, seguir o formato que `RELEASING.md` prescrever)
- `specs/60-ux-reforma/68-onda7-verificacao-deploy.md` (este arquivo, atualizado com a evidência do OK do dono e status final `done`)
- `specs/90-roadmap.md` (registro do gate final na tabela de gates, se o roadmap tiver uma linha reservada pra isso)

## Riscos e reversão

- **Risco:** o deploy revelar algo que só se manifesta em produção (dado real, escala, latência de rede) e não apareceu local. Mitigação: o harness pós-deploy (item 7) é justamente pra pegar isso rápido; se algo quebrar, o rollback é o deploy anterior (Cloudflare Workers mantém histórico de deployments, reversível via `wrangler rollback` ou re-deploy da versão anterior).
- **Risco:** pressão de tempo levar a pular o checklist manual e ir direto pro deploy. Mitigação: o gate de deploy é uma regra dura da spec-zero, não uma sugestão — não há caminho alternativo que pule o OK explícito do dono.
- **Reversão:** `wrangler rollback` (ou novo deploy da versão anterior) reverte o Worker pro estado pré-reforma; nenhuma migration foi criada em nenhuma das 7 ondas, então não há dado a reverter, só código.
