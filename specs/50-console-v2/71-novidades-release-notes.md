# Novidades: tela de release notes + banner pós-atualização

> **Status:** done · **Prioridade:** P2 · **Esforço:** S · **Repo:** expert-brain
> **Depende de:** nenhuma
> **Execução:** concluída em 06/07/2026 (pedido do dono no dia do lançamento do Console v2+v3).

## Contexto

Quando uma instância é atualizada (deploy do dono ou release dos alunos), nada avisa o usuário do que mudou — as features novas ficam invisíveis até serem descobertas por acaso.

## Design (implementado)

- `src/web/releases-data.ts`: array `RELEASES` (mais recente no topo; id estável `YYYY-MM-DD-slug`), chave `last_seen_release` na `meta`, e `releaseBannerHtml` (soft-fail).
- Banner no `renderShell` em TODA página logada enquanto `last_seen_release != LATEST_RELEASE_ID`; a própria página de novidades não o exibe.
- `GET /app/novidades` (`src/web/releases.ts`, sessão): lista as releases e marca a mais recente como vista após o render.
- Cada release futura = adicionar 1 entrada no topo de `RELEASES` no mesmo PR/commit do deploy.

## Critérios de aceite

- [x] Banner aparece em página logada com release não vista; some após visitar /app/novidades.
- [x] Página lista releases com highlights; sem sessão redireciona e não marca vista.
- [x] typecheck + suite completa verdes (test/releases.test.ts).

## Riscos e reversão

- Reversão: remover rota + banner; a chave na `meta` fica inerte. Zero migration.
