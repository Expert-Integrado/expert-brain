# Verificação em duas etapas (TOTP) no login e no authorize

> **Status:** draft · **Prioridade:** P1 · **Esforço:** L · **Repo:** expert-brain
> Plano-mãe: grupo 100. Pedido do dono: "autenticação de dois fatores... configurada no menu individual da pessoa, pode ligar ou desligar".

## Contexto e limite honesto

O console tem UM login (o dono — `OWNER_EMAIL`); os "usuários" do Brain são perfis de atribuição sem senha própria. Logo o 2FA da v1 é do LOGIN DO DONO, com liga/desliga num card "Segurança" (aba Sistema do /app/config). Se um dia houver login multi-usuário, o toggle migra pro perfil individual — o desenho já nasce com esse caminho.

Há DUAS portas que aceitam a senha: `POST /app/login` (console) e `POST /authorize` (OAuth dos agentes MCP). O 2FA precisa cobrir AS DUAS, senão é decorativo.

## Design

### 1. Núcleo TOTP — `src/auth/totp.ts` (novo, zero deps)

RFC 6238 sobre HMAC-SHA1 (RFC 4226) em WebCrypto: `base32Encode/Decode`, `generateTotpSecret()` (20 bytes), `totpCode(secret, timeMs, digits=6)` (step 30s), `verifyTotp` (janela ±1 step), `otpauthUri(secret, account, issuer)`. SHA-1 é o padrão universal dos autenticadores e aqui é HMAC (não colisão). Testes com os vetores oficiais do Appendix B da RFC 6238 (digits=8).

### 2. Estado — `src/auth/twofactor.ts` (novo; storage na tabela `meta`, sem migration)

Chaves: `totp_secret` (base32; mesmo trust boundary do resto do D1), `totp_enabled` ('1'), `totp_pending_secret` (setup em andamento), `totp_backup_codes` (JSON de hashes PBKDF2 — `hashPassword` — dos 8 códigos `XXXX-XXXX`, charset sem ambíguos; código usado é REMOVIDO do array).

API: `twoFactorEnabled`, `startTwoFactor` (gera pending), `confirmTwoFactor` (código válido contra pending → promove + gera backup codes, retorna os códigos plaintext UMA vez), `disableTwoFactor` (exige segundo fator válido), `verifySecondFactor(code)` → `'totp' | 'backup' | null` (formato decide o caminho: 6 dígitos = TOTP; com hífen = backup, que consome).

### 3. Token intermediário do login — cookie `eb_2fa`

`POST /app/login` com senha ok E 2FA ligado NÃO emite `eb_session`: emite `eb_2fa` (Max-Age 300) e redireciona pra `GET /app/login/2fa` (form de código; POST valida e aí sim emite a sessão).

**Segurança (achado de code-review desta spec):** `requireSession` não compara o e-mail do token com `OWNER_EMAIL` — um token intermediário assinado com o MESMO `SESSION_SECRET` poderia ser copiado pro cookie `eb_session` e passaria, bypassando o 2FA com senha roubada (exatamente o cenário que o 2FA protege). Por isso o `eb_2fa` é assinado com **secret derivado** (`SESSION_SECRET + ':2fa'`) — a assinatura não valida como sessão — e expira em 5 min (checagem própria de `issuedAt`, além do TTL do cookie).

Rate limit: mesmo mecanismo KV do login com bucket separado (`2fa:<email>` no lugar do e-mail).

### 4. `/authorize` (OAuth) — campo de código na mesma tela

Com 2FA ligado, o form do authorize ganha o input "Código de verificação" (tela única: e-mail + senha + código; sem estado intermediário). POST: senha ok E `verifySecondFactor` ok. Sem o campo (agente/bookmark antigo) = erro pedindo o código.

### 5. UI — card "Segurança" na aba Sistema do /app/config

- **Desligado:** explicação leiga ("além da senha, um código de 6 dígitos do seu app — 1Password ou Google Authenticator — a cada login") + botão "Ativar" → `POST /app/config/2fa/start` → recarrega com o bloco de setup.
- **Setup pendente (sobrevive a refresh):** secret base32 copiável + link `otpauth://` ("no 1Password: adicione um campo 'senha de uso único' e cole") + form de confirmação com código → `POST /app/config/2fa/confirm`. Confirmou: liga e mostra os 8 backup codes UMA vez (banner one-time, padrão do flash KV da chave criada — copiar e "Já salvei"). Botão "Cancelar configuração" limpa o pending.
- **Ligado:** "Ativa desde X · N códigos reserva restantes" + desativar exige um código válido (TOTP ou backup) → `POST /app/config/2fa/disable`.
- QR code fica FORA da v1 (o fluxo do dono é 1Password, que aceita colar o secret; apps móveis aceitam o link otpauth). Regenerar backup codes fora da v1 (acabaram = desativa e reativa).

## Critérios de aceite

- [ ] Vetores RFC 6238 passam; janela ±1 step; código fora da janela falha.
- [ ] Com 2FA DESLIGADO nada muda (suite de login atual verde, byte a byte).
- [ ] Login web: senha certa → tela de código; código certo → sessão; errado → erro + rate limit; backup code entra e é consumido (não repete).
- [ ] Valor do `eb_2fa` colado no cookie `eb_session` NÃO vira sessão (secret derivado).
- [ ] `/authorize` com 2FA exige código válido; sem 2FA segue como hoje.
- [ ] Ativação exige provar o código ANTES de ligar (sem lockout por secret não cadastrado); desativação exige segundo fator.
- [ ] Backup codes aparecem UMA vez; contagem restante visível; suite + typecheck verdes.
