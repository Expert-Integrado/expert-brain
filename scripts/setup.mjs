#!/usr/bin/env node
// Expert Brain — bootstrap automatico.
//
// Faz em 1 comando o que o runbook do CLAUDE.md descreve em 9 passos:
//   1. Verifica `wrangler whoami` (autenticacao Cloudflare)
//   2. Copia `wrangler.example.toml` -> `wrangler.toml` se nao existe
//   3. Pergunta e-mail + senha do owner (com confirmacao)
//   4. Cria D1 + Vectorize + 2 KV namespaces na conta Cloudflare ativa
//   5. Substitui placeholders REPLACE_ME_* no wrangler.toml com os IDs reais
//   6. Gera hash PBKDF2 da senha + SESSION_SECRET aleatorio
//   7. `wrangler secret put` os 3 secrets
//   8. `wrangler deploy`
//   9. POST /setup/provision pra rodar migrations no D1
//   10. Instala os hooks do Claude Code (camada cliente — captura proativa)
//   11. Imprime URL do Worker + comando MCP + link do dashboard
//
// Idempotente: se um recurso ja existe no wrangler.toml (nao e placeholder),
// pula a criacao. Pode rodar varias vezes sem corromper estado.
//
// Pre-requisitos:
//   - Node 18+
//   - `wrangler login` rodado uma vez (abre browser)
//   - Conta Cloudflare gratuita (sem cartao)

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installClaudeHooks, readInstallManifest } from './install-claude-hooks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WRANGLER_TOML = path.join(REPO_ROOT, 'wrangler.toml');
const WRANGLER_EXAMPLE = path.join(REPO_ROOT, 'wrangler.example.toml');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const log = {
  step: (n, msg) => console.log(`\n${CYAN}${BOLD}[${n}/11]${RESET} ${BOLD}${msg}${RESET}`),
  info: (msg) => console.log(`  ${DIM}${msg}${RESET}`),
  ok: (msg) => console.log(`  ${GREEN}OK${RESET} ${msg}`),
  warn: (msg) => console.log(`  ${YELLOW}!${RESET} ${msg}`),
  err: (msg) => console.error(`  ${RED}X${RESET} ${msg}`),
};

function die(msg) {
  log.err(msg);
  process.exit(1);
}

// Wrangler helpers
function runWrangler(args, { input = null, capture = true, allowFail = false } = {}) {
  const res = spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf-8',
    input,
    shell: process.platform === 'win32',
  });
  if (!allowFail && res.status !== 0) {
    if (capture) {
      log.err(`wrangler ${args.join(' ')} falhou:`);
      console.error(res.stderr || res.stdout);
    }
    process.exit(res.status ?? 1);
  }
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
}

function runWranglerStream(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['wrangler', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    proc.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`wrangler ${args.join(' ')} retornou ${code}`));
    });
  });
}

// Prompts
async function askVisible(rl, question) {
  return (await rl.question(question)).trim();
}

// Pergunta opcional do capture-nudge: temas/palavras do usuario que sempre
// merecem a sugestao de salvar. TTY-gated: em pipe/CI pula sem perguntar.
// Retorna: undefined = manter os temas ja configurados; [] = limpar; array = nova lista.
async function askCaptureKeywords() {
  if (!process.stdin.isTTY) return undefined; // sem TTY: preserva o que ja existe
  const current = (readInstallManifest() || {}).keywords || [];
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  console.log(`\n${DIM}Durante as conversas, o Claude vai sugerir salvar no Brain quando aparecer decisão, número importante ou prazo.${RESET}`);
  console.log(`${DIM}Se quiser, adicione temas SEUS que também merecem esse toque — ex: nome de um projeto ou de um cliente importante.${RESET}`);
  if (current.length) {
    console.log(`${DIM}Temas já configurados: ${current.join(', ')} — Enter mantém; digite "limpar" pra remover todos.${RESET}`);
  }
  const raw = (await rl.question(`  Temas, separados por vírgula (Enter ${current.length ? 'mantém os atuais' : 'pula sem problema'}): `)).trim();
  rl.close();
  if (!raw) return undefined; // Enter: mantem os atuais (ou nenhum, se nao havia)
  if (/^limpar$/i.test(raw)) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
}

// Pergunta opcional do quadro de tarefas (kanban): por padrao nascem 3 etapas
// (A fazer / Em progresso / Concluido — seeds da migration). Oferecemos SO uma
// etapa extra, Backlog, antes de "A fazer"; mais que isso o dono cria depois
// direto no console (/app/tasks). TTY-gated: em pipe/CI segue com as 3 padrao.
async function askKanbanBacklog() {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  console.log(`\n${DIM}Por padrão, seu quadro de tarefas nasce com 3 etapas: A fazer, Em progresso e Concluído — recomendamos começar só com essas.${RESET}`);
  console.log(`${DIM}Se quiser, dá pra adicionar uma etapa Backlog antes de "A fazer" (outras etapas você cria depois direto no console, em /app/tasks).${RESET}`);
  const raw = (await rl.question('  Adicionar a etapa Backlog? (s/N): ')).trim();
  rl.close();
  return /^(s|sim|y|yes)$/i.test(raw);
}

async function askHidden(question) {
  // Esconde echo via raw mode do stdin. Trata Enter / Ctrl+C / backspace.
  // Se stdin nao for TTY (pipe, CI, etc), faz fallback pra readline visivel
  // — usabilidade pior, mas o script ao menos roda em vez de crashar.
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    process.stdout.write(`${question}${YELLOW}(stdin nao e TTY — senha visivel)${RESET} `);
    const value = await rl.question('');
    rl.close();
    return value;
  }
  process.stdout.write(question);
  let buffer = '';
  return new Promise((resolve) => {
    const onData = (char) => {
      const c = char.toString('utf-8');
      const code = c.charCodeAt(0);
      if (code === 3) {
        // Ctrl+C
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\n');
        process.exit(0);
      } else if (code === 13 || code === 10) {
        // Enter (\r ou \n)
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\n');
        resolve(buffer);
      } else if (code === 127 || code === 8) {
        // Backspace (DEL ou BS)
        if (buffer.length > 0) buffer = buffer.slice(0, -1);
      } else {
        buffer += c;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

// Crypto
function hashPassword(passphrase) {
  // Match exato do formato esperado pelo Worker (src/auth/password.ts).
  // PBKDF2-SHA256, 100k iteracoes, salt 16B aleatorio, hash 32B.
  const ITERATIONS = 100_000;
  const HASH_LEN = 32;
  const SALT_LEN = 16;
  const salt = randomBytes(SALT_LEN);
  const hash = pbkdf2Sync(passphrase, salt, ITERATIONS, HASH_LEN, 'sha256');
  return `pbkdf2$sha256$${ITERATIONS}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function generateSessionSecret() {
  return randomBytes(32).toString('hex');
}

// wrangler.toml helpers
function readToml() {
  return readFileSync(WRANGLER_TOML, 'utf-8');
}

function writeToml(content) {
  writeFileSync(WRANGLER_TOML, content, 'utf-8');
}

function replacePlaceholder(content, placeholder, value) {
  return content.replace(`"${placeholder}"`, `"${value}"`);
}

function hasPlaceholder(content, placeholder) {
  return content.includes(`"${placeholder}"`);
}

// Setup flow
function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (Number.isNaN(major) || major < 18) {
    die(`Node ${process.versions.node} e antigo demais. Atualiza pra Node 18+ (https://nodejs.org) e tente de novo.`);
  }
}

// Descobre IDs de recursos Expert Brain ja existentes na conta — usado no modo
// ATUALIZACAO pra reaproveitar tudo sem recriar (clone fresco que so quer
// atualizar). KV casa por title exato (== binding) ou sufixo (-binding).
function discoverResources() {
  const out = { d1: null, oauthKv: null, graphCache: null };
  const d1 = runWrangler(['d1', 'list', '--json'], { allowFail: true });
  if (d1.status === 0) {
    try {
      const dbs = JSON.parse(d1.stdout || '[]');
      out.d1 = dbs.find((d) => d.name === 'expert-brain')?.uuid ?? null;
    } catch { /* ignore parse */ }
  }
  const kv = runWrangler(['kv', 'namespace', 'list'], { allowFail: true });
  if (kv.status === 0) {
    try {
      const ns = JSON.parse(kv.stdout || '[]');
      const pick = (b) => ns.find((n) => n.title === b || (n.title || '').endsWith(`-${b}`))?.id ?? null;
      out.oauthKv = pick('OAUTH_KV');
      out.graphCache = pick('GRAPH_CACHE');
    } catch { /* ignore parse */ }
  }
  return out;
}

// Garante o indice Vectorize (idempotente — ignora "already exists").
function ensureVectorize() {
  const vec = runWrangler(['vectorize', 'create', 'expert-brain-embeddings', '--dimensions=1024', '--metric=cosine'], { allowFail: true });
  if (vec.status !== 0) {
    const combined = (vec.stdout || '') + (vec.stderr || '');
    if (/already exists|duplicate_name|3002/i.test(combined)) { log.info('Vectorize ja existe - reutilizando.'); return; }
    die(`wrangler vectorize create falhou: ${vec.stderr}`);
  }
  log.ok('Indice Vectorize criado.');
}

// Build + deploy + WORKER_URL + migrations. Compartilhado por instalacao e atualizacao.
// R2 (midia das notas) — opcional: em contas free sem billing o R2 nao esta
// habilitado; nesse caso removemos o binding e o Brain sobe sem midia (tudo o
// resto funciona). Sem isso o `wrangler deploy` falharia com bucket inexistente.
// Roda nos DOIS modos (instalacao e atualizacao): um clone fresco em modo
// atualizacao parte do wrangler.example.toml, que traz o binding — sem garantir
// o bucket aqui, o deploy da atualizacao quebraria do mesmo jeito.
function ensureMediaBucket(toml) {
  if (!/\[\[r2_buckets\]\]/.test(toml)) return toml;
  log.info('Garantindo bucket R2 "expert-brain-media" (midia das notas)...');
  const r2 = runWrangler(['r2', 'bucket', 'create', 'expert-brain-media'], { allowFail: true });
  const r2out = (r2.stdout || '') + (r2.stderr || '');
  if (r2.status === 0 || /already exists/i.test(r2out)) {
    log.ok('Bucket R2 pronto.');
    return toml;
  }
  log.warn('Nao consegui criar o bucket R2 (conta sem R2 habilitado? requer billing na Cloudflare).');
  log.warn('Seguindo SEM midia: removi o binding do wrangler.toml — anexos de nota ficam desativados.');
  log.warn('Pra ligar depois: habilite R2 na Cloudflare, crie o bucket "expert-brain-media" e restaure o bloco [[r2_buckets]] do wrangler.example.toml.');
  toml = toml.replace(/\n?\[\[r2_buckets\]\][\s\S]*?(?=\n\[|\n*$)/, '\n');
  writeToml(toml);
  return toml;
}

async function buildDeployProvision() {
  log.info('Buildando bundles...');
  const build = spawnSync('npm', ['run', 'build:bundles'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (build.status !== 0) die('npm run build:bundles falhou.');
  log.ok('Bundles buildados.');

  log.info('Deployando...');
  const deploy = await runWranglerStream(['deploy']).catch((err) => die(err.message));
  const urlMatch = deploy.stdout.match(/https:\/\/expert-brain\.[a-z0-9-]+\.workers\.dev/);
  if (!urlMatch) die('Nao consegui extrair a URL do Worker. Cheque o output acima.');
  const workerUrl = urlMatch[0];
  log.ok(`Worker deployado: ${workerUrl}`);

  log.info('Setando WORKER_URL...');
  const wuResult = runWrangler(['secret', 'put', 'WORKER_URL'], { input: workerUrl, allowFail: true });
  if (wuResult.status !== 0) log.warn(`wrangler secret put WORKER_URL falhou (nao critico): ${wuResult.stderr}`);
  else log.ok('WORKER_URL OK.');

  const setupToken = await ensureSetupToken();
  await provisionWorker(workerUrl, setupToken);
  return workerUrl;
}

// SETUP_TOKEN (spec 10-backend/18): vault configurado exige Bearer nos /setup/*.
// Gera um token novo e grava como secret no Worker; o valor fica so em memoria
// deste processo (nunca em arquivo/log). Regenerar a cada setup e inofensivo —
// o unico consumidor persistente e o proprio provision desta execucao; deploys
// futuros usam GRAPH_EXPORT_TOKEN ou BRAIN_SETUP_TOKEN do ambiente.
async function ensureSetupToken() {
  log.info('Setando SETUP_TOKEN (auth dos /setup/*)...');
  const token = randomBytes(32).toString('hex');
  const r = runWrangler(['secret', 'put', 'SETUP_TOKEN'], { input: token, allowFail: true });
  if (r.status !== 0) {
    log.warn(`wrangler secret put SETUP_TOKEN falhou (nao critico): ${r.stderr}`);
    return null;
  }
  log.ok('SETUP_TOKEN OK.');
  return token;
}

// POST /setup/provision com Bearer + retry (cobre propagation delay do deploy
// e do secret put). Vault ainda nao configurado aceita sem auth; configurado
// exige o Bearer que acabamos de gravar.
async function provisionWorker(workerUrl, setupToken) {
  log.info(`POST ${workerUrl}/setup/provision`);
  const headers = setupToken ? { authorization: `Bearer ${setupToken}` } : undefined;
  let lastErr = '';
  for (const delay of [0, 3000, 8000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(`${workerUrl}/setup/provision`, { method: 'POST', headers });
      const body = await res.text();
      if (res.ok) {
        log.ok(`Migrations aplicadas: ${body}`);
        return;
      }
      lastErr = `HTTP ${res.status}: ${body.slice(0, 300)}`;
    } catch (err) {
      lastErr = err.message;
    }
    log.warn(`provision falhou (${lastErr}) — tentando de novo...`);
  }
  die(`/setup/provision falhou apos 3 tentativas: ${lastErr}`);
}

async function main() {
  checkNodeVersion();

  console.log(`\n${BOLD}Expert Brain - setup automatico${RESET}\n`);
  console.log(`${DIM}Este script provisiona D1, Vectorize, KV, gera secrets, e deploya${RESET}`);
  console.log(`${DIM}o Worker na sua conta Cloudflare. Leva ~3 minutos.${RESET}`);

  // 1. wrangler whoami
  log.step(1, 'Verificando autenticacao Cloudflare');
  const who = runWrangler(['whoami'], { allowFail: true });
  if (who.status !== 0 || !who.stdout.includes('@')) {
    die('Voce nao esta autenticado. Rode `npx wrangler login` em outro terminal, autorize no browser, e tente de novo.');
  }
  const emailMatch = who.stdout.match(/associated with the email\s+([^\s,]+@[^\s,]+\.[^\s,]+)/);
  const cfEmail = emailMatch?.[1] ?? '(desconhecido)';
  log.ok(`Logado como ${cfEmail}`);

  const accountMatch = who.stdout.match(/[a-f0-9]{32}/);
  const accountId = accountMatch?.[0];
  if (!accountId) die('Nao consegui extrair o account_id do `wrangler whoami`. Cola ele manualmente no wrangler.toml.');
  log.ok(`Account ID detectado: ${accountId}`);

  // 2. garante wrangler.toml
  log.step(2, 'Preparando wrangler.toml');
  if (!existsSync(WRANGLER_TOML)) {
    if (!existsSync(WRANGLER_EXAMPLE)) die('wrangler.example.toml nao encontrado. Repo esta incompleto?');
    copyFileSync(WRANGLER_EXAMPLE, WRANGLER_TOML);
    log.ok('Copiei wrangler.example.toml -> wrangler.toml');
  } else {
    log.info('wrangler.toml ja existe - reutilizando.');
  }

  let toml = readToml();
  if (hasPlaceholder(toml, 'REPLACE_ME_ACCOUNT_ID')) {
    toml = replacePlaceholder(toml, 'REPLACE_ME_ACCOUNT_ID', accountId);
    writeToml(toml);
    log.ok('account_id substituido.');
  }

  // 2.5 Instalacao nova OU atualizacao? Se ja existe um Expert Brain nesta conta
  // (wrangler.toml configurado, ou recursos achados na conta), entra em modo
  // ATUALIZACAO: descobre os IDs, NAO toca em credenciais/secrets/dados, so
  // rebuilda e redeploya o codigo. `npm run setup -- --reinstall` forca do zero.
  const forceReinstall = process.argv.includes('--reinstall');
  let isUpdate = false;
  if (!forceReinstall) {
    if (!toml.includes('REPLACE_ME_')) {
      isUpdate = true; // wrangler.toml ja configurado (pasta de uma instalacao previa)
    } else {
      log.info('Procurando uma instalacao Expert Brain existente na sua conta...');
      const found = discoverResources();
      if (found.d1 && found.oauthKv && found.graphCache) {
        toml = replacePlaceholder(toml, 'REPLACE_ME_D1_ID', found.d1);
        toml = replacePlaceholder(toml, 'REPLACE_ME_OAUTH_KV_ID', found.oauthKv);
        toml = replacePlaceholder(toml, 'REPLACE_ME_GRAPH_CACHE_ID', found.graphCache);
        writeToml(toml);
        isUpdate = true;
      }
    }
  }

  if (isUpdate) {
    console.log(`\n${CYAN}${BOLD}[atualizar]${RESET} ${BOLD}Instalacao existente detectada - modo ATUALIZACAO${RESET}`);
    log.info('Mantenho seus dados (D1/Vectorize), credenciais e login. So atualizo o codigo.');
    ensureVectorize();
    toml = ensureMediaBucket(toml);
    if (toml.includes('REPLACE_ME_')) {
      die('Faltou resolver algum ID no wrangler.toml. Rode `npm run setup -- --reinstall` pra reprovisionar do zero.');
    }
    const workerUrl = await buildDeployProvision();
    try {
      const st = await fetch(`${workerUrl}/status`).then((r) => r.json());
      if (st && st.configured === false) {
        log.warn('Worker subiu mas /status = configured:false (secrets faltando). Rode `npm run setup -- --reinstall`.');
      }
    } catch { /* ignore */ }

    // Camada cliente TAMBEM no modo atualizacao — e por aqui que quem ja tinha
    // uma instalacao antiga ganha (ou atualiza) a captura automatica.
    console.log(`\n${CYAN}${BOLD}[atualizar]${RESET} ${BOLD}Ativando captura automatica (hooks do Claude Code)${RESET}`);
    const updKeywords = await askCaptureKeywords();
    const updHooksOk = installClaudeHooks({ workerUrl, userKeywords: updKeywords, log: (m) => console.log(m) });
    if (!updHooksOk) {
      log.warn(`Hooks nao instalados agora — o Brain segue reativo. Pra ligar depois: node scripts/install-claude-hooks.mjs ${workerUrl}`);
    }

    console.log(`
${GREEN}${BOLD}Expert Brain atualizado.${RESET}

  ${BOLD}URL:${RESET}  ${workerUrl}
  ${BOLD}MCP:${RESET}  ${workerUrl}/mcp

${DIM}Dados e login continuam os mesmos. Abra ${workerUrl}/app/graph e de Ctrl+Shift+R.${RESET}
${updHooksOk
    ? `${DIM}Captura automatica: hooks atualizados em ~/.claude/hooks/ (backup do settings.json feito antes; temas preservados).${RESET}`
    : `${YELLOW}Captura automatica NAO ativada — pra ligar: node scripts/install-claude-hooks.mjs ${workerUrl}${RESET}`}
`);
    return;
  }

  // 3. prompt email + senha
  log.step(3, 'Suas credenciais de owner');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ownerEmail = await askVisible(rl, '  E-mail do owner (login do dashboard): ');
  if (!ownerEmail.includes('@')) {
    rl.close();
    die('E-mail invalido.');
  }
  rl.close();

  const passphrase = await askHidden('  Senha (minimo 12 caracteres): ');
  if (passphrase.length < 12) die('Senha muito curta - minimo 12 caracteres.');
  const passphrase2 = await askHidden('  Confirme a senha: ');
  if (passphrase !== passphrase2) die('Senhas nao bateram.');
  log.ok('Credenciais coletadas.');

  // Etapas do quadro de tarefas: pergunta agora (junto dos outros prompts),
  // cria depois do provision (passo 9), quando kanban_columns ja existe no D1.
  const wantBacklog = await askKanbanBacklog();

  // 4. cria recursos Cloudflare
  log.step(4, 'Provisionando recursos na Cloudflare');

  if (hasPlaceholder(toml, 'REPLACE_ME_D1_ID')) {
    log.info('Criando D1 "expert-brain"...');
    const d1 = runWrangler(['d1', 'create', 'expert-brain'], { allowFail: true });
    if (d1.status !== 0) {
      const combined = (d1.stdout || '') + (d1.stderr || '');
      if (/already exists/i.test(combined)) {
        log.warn('D1 "expert-brain" ja existe nessa conta. Listando IDs...');
        const list = runWrangler(['d1', 'list', '--json']);
        const dbs = JSON.parse(list.stdout || '[]');
        const found = dbs.find((d) => d.name === 'expert-brain');
        if (!found) die('D1 "expert-brain" apareceu como existente mas nao achei o ID. Resolve manualmente.');
        toml = replacePlaceholder(toml, 'REPLACE_ME_D1_ID', found.uuid);
        writeToml(toml);
        log.ok(`D1 reutilizado: ${found.uuid}`);
      } else {
        die(`wrangler d1 create falhou: ${d1.stderr}`);
      }
    } else {
      const idMatch = d1.stdout.match(/database_id\s*=\s*"([a-f0-9-]+)"/);
      if (!idMatch) die('Nao consegui extrair database_id do output do wrangler.');
      toml = replacePlaceholder(toml, 'REPLACE_ME_D1_ID', idMatch[1]);
      writeToml(toml);
      log.ok(`D1 criado: ${idMatch[1]}`);
    }
  } else {
    log.info('D1 ja configurado no wrangler.toml - pulando.');
  }

  log.info('Criando indice Vectorize "expert-brain-embeddings"...');
  const vec = runWrangler(['vectorize', 'create', 'expert-brain-embeddings', '--dimensions=1024', '--metric=cosine'], { allowFail: true });
  if (vec.status !== 0) {
    const combined = (vec.stdout || '') + (vec.stderr || '');
    if (/already exists/i.test(combined)) {
      log.info('Vectorize "expert-brain-embeddings" ja existe - reutilizando.');
    } else {
      die(`wrangler vectorize create falhou: ${vec.stderr}`);
    }
  } else {
    log.ok('Indice Vectorize criado.');
  }

  const kvSpecs = [
    ['REPLACE_ME_OAUTH_KV_ID', 'OAUTH_KV'],
    ['REPLACE_ME_GRAPH_CACHE_ID', 'GRAPH_CACHE'],
  ];
  for (const [placeholder, kvName] of kvSpecs) {
    if (hasPlaceholder(toml, placeholder)) {
      log.info(`Criando KV namespace "${kvName}"...`);
      const kv = runWrangler(['kv', 'namespace', 'create', kvName], { allowFail: true });
      if (kv.status !== 0) {
        die(`wrangler kv namespace create ${kvName} falhou: ${kv.stderr}`);
      }
      const idMatch = kv.stdout.match(/id\s*=\s*"([a-f0-9]+)"/);
      if (!idMatch) die(`Nao consegui extrair id do KV ${kvName}.`);
      toml = replacePlaceholder(toml, placeholder, idMatch[1]);
      writeToml(toml);
      log.ok(`KV ${kvName} criado: ${idMatch[1]}`);
    } else {
      log.info(`KV ${kvName} ja configurado no wrangler.toml - pulando.`);
    }
  }

  // 4.5 R2 (midia das notas) — opcional; ver ensureMediaBucket.
  toml = ensureMediaBucket(toml);

  // 5. confirma que nenhum placeholder sobrou
  log.step(5, 'Validando wrangler.toml');
  if (toml.includes('REPLACE_ME_')) {
    die('Ainda ha placeholders REPLACE_ME_* no wrangler.toml. Resolve manualmente e tente de novo.');
  }
  log.ok('Todos os placeholders foram substituidos.');

  // 6. gera secrets
  log.step(6, 'Gerando secrets');
  const ownerPasswordHash = hashPassword(passphrase);
  const sessionSecret = generateSessionSecret();
  log.ok('OWNER_PASSWORD_HASH gerado (PBKDF2-SHA256, 100k iter).');
  log.ok('SESSION_SECRET gerado (32 bytes hex).');

  // 7. wrangler secret put
  log.step(7, 'Enviando secrets pro Worker');
  const secrets = [
    ['OWNER_EMAIL', ownerEmail],
    ['OWNER_PASSWORD_HASH', ownerPasswordHash],
    ['SESSION_SECRET', sessionSecret],
  ];
  for (const [name, value] of secrets) {
    log.info(`Setando ${name}...`);
    const r = runWrangler(['secret', 'put', name], { input: value, allowFail: true });
    if (r.status !== 0) die(`wrangler secret put ${name} falhou: ${r.stderr}`);
    log.ok(`${name} OK.`);
  }

  // 8. deploy
  log.step(8, 'Deployando Worker (build + upload)');
  log.info('Buildando bundles...');
  const build = spawnSync('npm', ['run', 'build:bundles'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (build.status !== 0) die('npm run build:bundles falhou.');
  log.ok('Bundles buildados.');

  log.info('Deployando...');
  const deploy = await runWranglerStream(['deploy']).catch((err) => die(err.message));
  const urlMatch = deploy.stdout.match(/https:\/\/expert-brain\.[a-z0-9-]+\.workers\.dev/);
  if (!urlMatch) die('Nao consegui extrair a URL do Worker. Cheque o output acima.');
  const workerUrl = urlMatch[0];
  log.ok(`Worker deployado: ${workerUrl}`);

  // WORKER_URL como secret para que o Durable Object (MCP) gere links clicaveis das notas
  log.info('Setando WORKER_URL...');
  const wuResult = runWrangler(['secret', 'put', 'WORKER_URL'], { input: workerUrl, allowFail: true });
  if (wuResult.status !== 0) {
    log.warn(`wrangler secret put WORKER_URL falhou (nao critico): ${wuResult.stderr}`);
  } else {
    log.ok('WORKER_URL OK.');
  }

  // 9. aplica migrations via /setup/provision (com Bearer — os OWNER_* ja foram
  // setados no passo 7, entao o vault ja esta "configurado" e o gate exige auth)
  log.step(9, 'Aplicando schema do D1');
  const setupToken = await ensureSetupToken();
  await provisionWorker(workerUrl, setupToken);

  // Etapa extra do kanban escolhida no passo 3 — so agora a tabela existe.
  // INSERT OR IGNORE: idempotente se o setup rodar de novo. position 0 poe o
  // Backlog antes de "A fazer" (colunas ordenam por position ASC).
  if (wantBacklog) {
    log.info('Criando a etapa Backlog no quadro de tarefas...');
    const kb = runWrangler(['d1', 'execute', 'DB', '--remote', '--yes', '--command',
      "INSERT OR IGNORE INTO kanban_columns (id, label, color, position, category, archived_at) VALUES ('col_backlog','Backlog',NULL,0,'open',NULL)"], { allowFail: true });
    if (kb.status === 0) log.ok('Etapa Backlog criada (antes de "A fazer").');
    else log.warn(`Nao consegui criar a etapa Backlog (nao critico — crie depois no console, em /app/tasks): ${(kb.stderr || kb.stdout || '').trim()}`);
  }

  // 10. instala a camada cliente (hooks do Claude Code) — captura proativa
  log.step(10, 'Ativando captura automatica (hooks do Claude Code)');
  const captureKeywords = await askCaptureKeywords();
  const hooksOk = installClaudeHooks({ workerUrl, userKeywords: captureKeywords, log: (m) => console.log(m) });
  if (hooksOk) {
    log.ok('Hooks ligados: o Brain passa a salvar e lembrar sozinho (recall antes de perguntar, save_note/save_task por sinal na conversa, varredura de sessao longa sem captura, salvar na compactacao).');
  } else {
    log.warn('Hooks nao instalados agora — o Brain segue no modo reativo. Veja a mensagem acima pra ligar depois.');
  }

  // 11. sumario
  log.step(11, 'Pronto!');
  console.log(`
${GREEN}${BOLD}Expert Brain esta no ar.${RESET}

  ${BOLD}URL do Worker:${RESET}  ${workerUrl}
  ${BOLD}Dashboard:${RESET}      ${workerUrl}/app/login
  ${BOLD}Endpoint MCP:${RESET}   ${workerUrl}/mcp

${BOLD}Conectar no Claude Code:${RESET}
  ${CYAN}claude mcp add --transport http expert-brain ${workerUrl}/mcp${RESET}

${BOLD}Conectar no Claude Desktop / Web:${RESET}
  Settings -> Connectors -> Add custom connector -> cola: ${workerUrl}/mcp

${BOLD}Primeiro login:${RESET}
  Abre ${workerUrl}/app/login e usa o e-mail e a senha que voce acabou de cadastrar.
  No /app/config copia o bloco de personalizacao pra Claude -> Settings -> Personalization.
${hooksOk ? `
${BOLD}Captura automatica (hooks):${RESET}
  Ativada em ~/.claude/hooks/ e ligada no ~/.claude/settings.json (com backup antes de mexer).
  Rode 'npm run setup' de novo quando sair versao nova do Brain — atualiza o servidor E os hooks
  (seus temas personalizados sao preservados).
` : `
${YELLOW}${BOLD}Captura automatica (hooks): NAO ativada.${RESET}
  O Brain funciona no modo reativo (salva quando voce pede). Pra ligar a captura:
  ${CYAN}node scripts/install-claude-hooks.mjs ${workerUrl}${RESET}
`}`);
}

main().catch((err) => {
  console.error(`\n${RED}${BOLD}Setup interrompido:${RESET} ${err.message}\n`);
  if (err.stack) console.error(`${DIM}${err.stack}${RESET}`);
  process.exit(1);
});
