# Polish de micro-UX: feedback de erro visível, acessibilidade móvel e detalhes de formulário

> **Status:** done · **Prioridade:** P2 · **Esforço:** S · **Repo:** ambos (expert-brain + expert-contacts)
> **Depende de:** nenhuma (zero migration, zero mudança de API/MCP, zero superfície pública nova)
> **Pré-aprovação:** o dono autorizou em 07/07/2026 a execução direta de melhorias garantidamente seguras de qualidade e micro-UX ("deixe pré-aprovadas todas as que garantidamente sejam seguras"). Esta spec só contém itens dessa classe.

## Contexto

Auditoria de micro-UX de 07/07/2026 nos dois consoles (pós-Console v2+v3). A base está sólida — focus-visible global, palette Ctrl+K, appFetch com 401 centralizado, noopener nos _blank, maxlength com contador no config — mas sobraram detalhes que degradam a percepção de qualidade no uso diário.

## Achados e correções (todas verificadas contra o código em 07/07/2026)

### expert-brain

1. **Não existe toast no client** — o único "flash" é o padrão KV server-side das API keys (`src/web/api-keys.ts:15-28`). Criar util mínimo `toast(msg, kind?)` (div fixa, auto-dismiss ~4s, `aria-live="polite"`, sem dependência) em `src/web/client/` + estilo em `styles.ts`, importável pelos bundles.
2. **Falhas do kanban são silenciosas** — criar inline, mover e concluir card fazem só `console.warn` e recarregam o board (`src/web/client/tasks.ts:343-346, 364-366, 378-380`): o card "volta sozinho" sem explicação. Ligar o toast de erro nesses três catches.
3. **Catches silenciosos equivalentes** em `client/note-edit.ts` e `client/notes.ts` (ex.: `notes.ts:37,97`): mesmo tratamento onde a falha afeta ação do usuário (não logs de telemetria).
4. **Coluna vazia do kanban fica muda** — sem placeholder, o drop-target não tem alvo visual. Adicionar hint discreto ("Solte tarefas aqui") quando a coluna tem 0 cards.
5. **Comentário de convidado na página pública `/s/<token>` sem indicação de limite** — textarea tem `maxlength` (`src/web/share.ts:350`) sem nenhum aviso. A página tem CSP `script-src 'none'` deliberada (spec 53) — contador dinâmico exigiria afrouxá-la, o que NÃO é seguro por definição. Correção segura: hint estático server-rendered "Até N caracteres" sob o textarea.

### expert-contacts

6. **`maximum-scale=1` no viewport** (`src/web/console-page.ts:134`) — bloqueia pinch-zoom (anti-padrão de acessibilidade, WCAG 1.4.4). Remover o `maximum-scale` mantendo o resto.
7. **Sem `<meta name="theme-color">`** nas páginas do console standalone (`console-page.ts` templates e `login.ts:10`) — paridade com o brain (`#070a13`), barra do navegador móvel destoa do tema.
8. ~~Falhas silenciosas no detail~~ — **descartado na verificação**: os catches de `client/detail.ts` (273/292/342/503) são fallbacks graciosos (formato de data, cache vazio, página nula) e o fluxo "Carregar mais" já mostra "Erro ao carregar interações" e esconde o botão (detail.ts:551-554). Nenhuma mudança necessária.

## Fora de escopo

- Qualquer feature nova, migration, mudança de API/MCP ou de superfície pública.
- Redesign visual, mudanças de layout, animações.
- Itens de UX que exigem decisão de produto (ficam pra spec futura com o dono).

## Critérios de aceite

- [x] Toast util no brain com `aria-live`, sem dependência externa (client/toast.ts; validado por typecheck do client — bundles não têm harness DOM, criar um seria mudança não-mínima).
- [x] Mover/criar/concluir card com falha mostra toast de erro (wiring nos 3 catches de client/tasks.ts).
- [x] Coluna vazia renderiza placeholder "Solte tarefas aqui" com estilo de drop-target (antes: travessão cru sem CSS).
- [x] Página pública `/s/` mostra hint estático de limite do textarea (server-render puro; CSP `script-src 'none'` intocada).
- [x] Viewport do contacts sem `maximum-scale`; theme-color presente nas páginas do console standalone.
- [x] typecheck + suites completas verdes nos DOIS repos (brain 748; contacts 280).

## Validação

- Suites + typecheck verdes; smoke manual nas páginas tocadas.
- **Gate de deploy:** coberto pela autorização permanente de 07/07/2026 do dono pra deploy com testes verdes (registrada em sessão); verificar produção pós-deploy.

## Riscos e reversão

- Risco baixo: mudanças aditivas de UI. Reversão = revert do commit; nenhum estado persistido.
