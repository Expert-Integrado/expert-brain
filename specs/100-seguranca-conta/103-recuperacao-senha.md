# Recuperação de senha por código + trocar senha pelo console

> **Status:** draft · **Prioridade:** P1 · **Esforço:** M · **Repo:** expert-brain
> Plano-mãe: grupo 100. Pedido do dono: "esqueci a senha... recuperar por código" (decisão do desenho: código de recuperação, NÃO e-mail — a instância não tem remetente e o dono usa 1Password).

## Contexto e limitação real

A senha do dono hoje é o secret `OWNER_PASSWORD_HASH` do Worker — e um Worker **não consegue trocar o próprio secret em runtime**. Logo qualquer fluxo de "trocar senha" exige mover a senha efetiva pra um lugar gravável: a tabela `meta` (D1).

**Decisão:** a senha efetiva passa a ser `meta.owner_password_hash` **com fallback** pro env secret. Instância nova continua nascendo do secret (bootstrap); a primeira troca de senha grava na meta e dali em diante a meta manda. Rollback de emergência: apagar a linha da meta volta pro secret.

## Design

### 1. `src/auth/owner-password.ts` (novo)

- `verifyOwnerPassword(env, plain)` — verifica contra `meta.owner_password_hash ?? env.OWNER_PASSWORD_HASH`. Substitui o `verifyPassword(..., env.OWNER_PASSWORD_HASH)` nos DOIS call sites (`/app/login`, `/authorize`).
- `setOwnerPassword(env, plain)` — `hashPassword` → meta.
- Código de recuperação: `generateRecoveryCode(env)` (formato `XXXX-XXXX-XXXX`, alfabeto sem ambíguos, ~60 bits; hash PBKDF2 em `meta.recovery_code_hash` + `recovery_code_created_at`; plaintext retorna UMA vez — regenerar substitui o antigo), `verifyRecoveryCode(env, code)` (NÃO consome), `consumeRecoveryCode(env)` (apaga), `recoveryCodeInfo(env)`.

### 2. Fluxo "Esqueci a senha" — `/app/login/recover` (GET+POST, público)

TELA ÚNICA, sem estado intermediário: código de recuperação + senha nova + confirmação — e, com 2FA ligado, também o código do app. POST valida TUDO antes de escrever: recovery code confere → segundo fator confere (quando ligado — **recuperar senha NÃO pula o 2FA**) → senha nova válida (mín. 10 chars, confirmação igual) → grava a senha na meta → só então consome o recovery code → 302 pro login com banner "senha trocada". Falha em qualquer etapa NÃO consome o código. Não loga automaticamente (entrar com a senha nova é a prova, e o 2FA segue no caminho).

Rate limit: mesmo mecanismo KV, bucket `recovery` por IP. `checkOrigin` no POST como no login. Link "Esqueci a senha" na tela de login.

### 3. Console — card "Senha e recuperação" (aba Sistema, junto do card Segurança)

- **Trocar senha** (`POST /app/config/password`): senha ATUAL + nova + confirmação. Exige a atual mesmo logado (sessão roubada não troca a senha sozinha).
- **Código de recuperação** (`POST /app/config/recovery-code`): estado ("nenhum" / "gerado em X") + botão gerar/regenerar. O código aparece UMA vez (flash KV one-time, mesmo padrão dos backup codes) com instrução de guardar no 1Password. Regenerar invalida o anterior.

## Critérios de aceite

- [ ] Login e /authorize aceitam a senha do env quando a meta não existe (compat total — suites atuais verdes sem edição).
- [ ] Após `setOwnerPassword`, a senha NOVA loga e a antiga (env) NÃO.
- [ ] Recover: código válido + senha nova troca a senha e CONSOME o código (segunda tentativa falha); código errado não consome nem troca; com 2FA ligado, exige segundo fator válido.
- [ ] Senha nova < 10 chars ou confirmação diferente = erro sem efeito colateral.
- [ ] Trocar senha logado exige a senha atual correta.
- [ ] Código de recuperação aparece UMA vez; regenerar invalida o antigo; rate limit no recover; suite + typecheck verdes.
