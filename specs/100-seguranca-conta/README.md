# Grupo 100 — Segurança da conta e credenciais

> Pedido do dono (12/07/2026, voz): (a) login do console travou — "não estou conseguindo acessar o Brain com a conta que já estava salva"; (b) "teria que ter algum botão de resetar senha"; (c) "autenticação de dois fatores... a pessoa pode ligar ou desligar"; (d) tela de tokens/credenciais "não está muito intuitiva... quero mais bonita".
>
> O item (a) foi resolvido operacionalmente no mesmo dia (senha nova no 1Password item "Brain Console", hash trocado via `wrangler secret put`, login provado em produção). Os itens (b)-(d) viram as specs deste grupo. Desenho aprovado pelo dono em 12/07/2026 (opção A): ordem tela → 2FA → recuperação; recuperação por CÓDIGO (não e-mail).

| Spec | Título | Status |
|------|--------|--------|
| 101  | Criação guiada de credencial, papéis em linguagem leiga e revogação com confirmação | draft |
| 102  | Verificação em duas etapas (TOTP) no login e no authorize | draft |
| 103  | Recuperação e troca de senha (código de recuperação; senha migra pro D1) | draft |

Contexto herdado: specs `80-frota-agentes/86` (dono mora na chave), `87` (UX credenciais, shipped), `91` (presets de papel, shipped) e `91-experiencia-premium/98` (config em abas, done). Este grupo NÃO re-arquiteta a tela — refina o fluxo de criação, os textos e a segurança do login.
