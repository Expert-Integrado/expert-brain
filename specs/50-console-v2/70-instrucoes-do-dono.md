# Instruções do dono: "CLAUDE.md do Brain" editável no console, servido no handshake MCP

> **Status:** done · **Prioridade:** P1 · **Esforço:** S · **Repo:** expert-brain

> **Execução:** concluída em 06/07/2026 na `feat/console-v2` (agente + orquestrador; 744 testes verdes). Junto veio o fix de UX do form "Nova coluna" do Kanban (rótulos + exemplo Backlog/categoria — feedback do dono).
> **Depende de:** `10-backend/11` (instructions parametrizadas — done)
> **Agente sugerido:** Opus · **Esforço de execução:** padrão

## Contexto

- As instructions do servidor MCP vivem em `src/mcp/instructions.ts` (spec `10-backend/11`, done) e são anunciadas ao cliente no handshake — todo agente que conecta (Claude Code, Desktop, web) as recebe automaticamente.
- Hoje o texto é fixo por build. O dono não tem NENHUM canal pra adicionar orientações próprias ("sempre responda em pt-BR", "priorize tal domínio", "nunca crie task sem due") sem editar código e redeployar.
- A tabela `meta` (chave/valor) já guarda prefs do console (`graph_prefs`, `taxonomy_config`, `resurface_digest`) com o padrão sanitize + POST de sessão em `/app/config`.

## Problema / Motivação

O dono quer um "CLAUDE.md do Brain": um bloco de instruções que ELE edita no console e que TODO acesso via MCP lê na entrada — sem depender de configurar cada cliente/máquina. Uma fonte única, viva, versionada junto do vault.

## Design proposto

### 1. Storage

- Chave nova na `meta`: `owner_instructions` (texto puro/markdown leve, cap **4000 chars**, trim; string vazia = remove a chave). Sanitize: apenas cap + strip de caracteres de controle (não é HTML — vai pro handshake como texto).

### 2. Handshake MCP

- Onde o servidor monta as instructions (`src/mcp/instructions.ts` + ponto de criação do servidor MCP), passar a compor: texto base existente + (se `owner_instructions` não-vazio) bloco final:

```
--- INSTRUÇÕES DO DONO DESTA INSTÂNCIA (editáveis em /app/config) ---
<texto>
```

- A leitura da meta é 1 query por handshake (aceitável; se o ponto de criação for hot, cachear com TTL curto em módulo — decidir na execução medindo o custo real).
- O bloco vai pra QUALQUER credencial válida (PAT read/full, OAuth) — instruções não são segredo. Anotar no help da UI: "não coloque senhas/tokens aqui".

### 3. UI

- Seção nova em `/app/config`: "Instruções pros agentes (MCP)" — textarea (rows ~8, maxlength 4000) + botão salvar (POST de sessão, padrão das outras seções) + contador de chars + help text de 2 linhas explicando onde o texto aparece (handshake) e o aviso de não-segredo.

## Fora de escopo

- Tool MCP dedicada de leitura (o handshake já entrega; agente que quiser re-ler no meio da sessão reconecta).
- Instruções por credencial/escopo (uma única global).
- Markdown rendering (texto puro no handshake).

## Critérios de aceite

- [ ] Salvar instruções no console persiste na `meta` (cap 4000 aplicado; vazio remove a chave).
- [ ] Handshake MCP com `owner_instructions` setado contém o bloco com o texto; sem a chave, instructions idênticas às atuais (byte a byte).
- [ ] POST sem sessão = 401/redirect; nenhum caminho público novo.
- [ ] typecheck + suite completa verdes.

## Validação

- `npm run typecheck` + `npm test`; teste novo cobrindo os critérios (meta round-trip, composição do handshake com/sem chave, cap).
- **Gate de deploy:** só com OK explícito do dono.

## Arquivos afetados

- `src/mcp/instructions.ts` (composição), ponto de criação do servidor MCP (leitura da meta)
- `src/web/config.ts` (seção nova + POST), `src/db/queries.ts` (se precisar de helper de meta)
- `test/`

## Riscos e reversão

- **Risco**: dono colar texto enorme/lixo e poluir todo handshake. Mitigação: cap 4000 + trim.
- **Reversão**: apagar a chave da `meta` restaura o comportamento atual; revert de código sem migration (zero schema).
