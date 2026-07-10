# 70 — Higiene do grafo (dedup, linking, re-pass e auditoria)

> Grupo criado em 09/07/2026 a partir do censo pós-import em massa (4.449 notas em 3 dias,
> 26 contas conectadas): ~65% do vault órfão, ~0,4% duplicado. Causa raiz: `save_note` sem
> gate de duplicata (só instrução textual, ignorada em escala) e nada induz linking.

## Decisão de arquitetura (nota `z6trwoy1aqk6` no vault do dono)

O gate de duplicata é **SOFT** (informa, nunca bloqueia): as bandas medidas empiricamente
mostram dups reais em 0.80–0.85 e vizinhas legítimas em 0.75–0.80 — margem estreita demais
pra um hard-block. Falso positivo que induz `update_note` numa nota DISTINTA (merge de teses
diferentes) é dano pior e mais difícil de reverter que uma duplicata (que a curadoria pega
depois). O hard só existe quando o próprio chamador declara identidade via `dedupe_key`.

Princípio subjacente: agente responde melhor a **dado estruturado na resposta da tool**
(`possible_duplicates`, `link_suggestions`) do que a prosa de handshake.

## Sequência de execução (gates)

1. **71** — dedup gate soft + link_suggestions + dedupe_key no `save_note` (o grosso).
2. Deploy do 71 (OK do dono) e SÓ ENTÃO o dono cola o "Passo 0" (instruções de higiene
   em `/app/config` > Instruções do dono — texto pronto no corpo da spec 71).
3. **72** — cron de re-pass do `similar_edges` (independente do 71 em código, mas o dado
   que o 73 reporta depende dele).
4. **74** — recall expõe score (trivial, carona de qualquer deploy).
5. **73** — digest de higiene semanal (por último: só faz sentido reportar com o 72 rodando).

A skill de curadoria (modo censo) vive no plugin `lab` (repo de skills), fora deste repo —
task `9b1vduhh5j15` no vault do dono.

## Riscos transversais

1. **Vazamento de nota privada** nas superfícies novas de resposta (71) — a defesa única é
   hidratar candidatos com o filtro de privacidade do caller (mesmo padrão do recall).
2. **Cron novo sem braço no dispatch** (72): `runScheduled` manda expressão desconhecida pro
   fluxo diário (fail-safe deliberado) — toml e código TÊM que ir no mesmo deploy, senão o
   digest de tasks dispara 2x/dia.
3. **Teto de 4096 chars do Telegram** (73): o digest de higiene vai em mensagem separada.
4. **Drift das bandas de score** entre ondas de import: o 71 loga os scores do gate pra
   re-medição posterior.
