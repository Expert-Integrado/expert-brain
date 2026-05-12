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
//   10. Imprime URL do Worker + comando MCP + link do dashboard
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
  step: (n, msg) => console.log(`\n${CYAN}${BOLD}[${n}/10]${RESET} ${BOLD}${msg}${RESET}`),
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

async function askHidden(question) {
  // Esconde echo via raw mode do stdin. Trata Enter / Ctrl+C / backspace.
  const stdin = process.stdin;
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
async function main() {
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

  // 9. aplica migrations via /setup/provision
  log.step(9, 'Aplicando schema do D1');
  log.info(`POST ${workerUrl}/setup/provision`);
  try {
    const res = await fetch(`${workerUrl}/setup/provision`, { method: 'POST' });
    const body = await res.text();
    if (!res.ok) die(`/setup/provision retornou ${res.status}: ${body}`);
    log.ok(`Migrations aplicadas: ${body}`);
  } catch (err) {
    die(`Nao consegui chamar /setup/provision: ${err.message}`);
  }

  // 10. sumario
  log.step(10, 'Pronto!');
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
`);
}

main().catch((err) => {
  console.error(`\n${RED}${BOLD}Setup interrompido:${RESET} ${err.message}\n`);
  if (err.stack) console.error(`${DIM}${err.stack}${RESET}`);
  process.exit(1);
});
