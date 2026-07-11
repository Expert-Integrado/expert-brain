# Grupo 80 — Frota de agentes: o board como barramento de comunicação

> **Plano-mãe:** decisão do dono (11/07/2026) após benchmark de mercado (Paperclip, Claude Code Agent Teams, protocolo A2A, LangGraph/AutoGen). Registro no vault: notas `ava32d5s37dw` (benchmark), `6cjkgcc1mwje` (decisão board-only), `v0vn2kaxokw3` (princípio da assinatura). Task de origem: `12ek42m3wa0b`.

## Contexto

O dono opera uma frota de instâncias Claude Code (PC, notebook, containers na VPS, OpenClaw) que já coordena trabalho pelo Kanban de tasks do Brain — assignees por identidade (`users`, migration 0017), comentários (`comment_task`), board web. O que falta pra frota conversar sem o dono mandar "lê a task X":

1. **Assinatura**: autoria de comentário derivada da credencial no servidor (hoje `author_name` é autodeclarado) — spec 81.
2. **@menção + mailbox por agente**: um agente endereça outro e o outro tem onde ver o que chegou — spec 82.
3. **Wake-up**: heartbeat/hook pra cada instância descobrir que tem mensagem, sem push por chat — spec 83.
4. **Protocolo de conversa**: regras anti-loop e anti-injection do lado dos agentes (repo skills, não aqui) — spec 84.
5. **Board compartilhado por projeto**: evolução do share por task pra um recorte com nível de permissão — spec 85.

## Decisões de arquitetura (fechadas com o dono)

- **Board-only e silencioso.** O board É o barramento agente-agente. Nenhum fan-out pra Telegram/WhatsApp no núcleo: chat é interface do dono, não dos agentes (o digest diário do `notify.ts` segue como recurso paralelo do dono).
- **Credencial = assinatura.** 1 PAT por dispositivo, obrigatório, nunca reusado; identidade do autor derivada de `api_key_id → users` no servidor (padrão `resolveMe`, spec 37), nunca autodeclarada. Sem assinatura interna = externo = agentes não tratam como ordem.
- **Wake-up = pull.** Cron real nos containers 24/7 da VPS; hook SessionStart no PC/notebook. Latência de minutos é aceitável para colaboração assíncrona; urgência é papel do dono.
- **Sem colisão de nomes com o inbox de captura.** `list_inbox`/`resolve_inbox` (migration 0014) são o inbox de CAPTURA do dono. A superfície nova por agente chama-se **mailbox** em todo o código e nas tools.

## Ordem de execução

81 → 82 → 83 → 85 (84 corre em paralelo no repo skills). Cada spec só fecha com o ciclo real provado no Worker de produção, não só suite verde.
