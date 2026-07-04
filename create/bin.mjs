#!/usr/bin/env node
// create-expert-brain — scaffolder oficial do Expert Brain.
//
// Uso:
//   npm create @expertintegrado/expert-brain@latest [pasta]
//   npx @expertintegrado/create-expert-brain [pasta]
//
// O que faz:
//   1. Resolve a pasta de destino (argv ou prompt interativo).
//   2. Valida que ela nao existe ou esta vazia.
//   3. Copia o template/ embarcado neste pacote pra essa pasta.
//   4. Renomeia _gitignore -> .gitignore (workaround do npm publish).
//   5. Roda `npm install` na pasta destino.
//   6. Imprime instrucoes pra o usuario rodar `npm run setup` em seguida.
//
// Reusa o setup.mjs do template pro provisionamento Cloudflare em si.
// Sem dependencias externas — so Node builtin.

import { cpSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, 'template');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const log = {
  banner: (msg) => console.log(`\n${CYAN}${BOLD}${msg}${RESET}\n`),
  step: (msg) => console.log(`\n${CYAN}${BOLD}>${RESET} ${BOLD}${msg}${RESET}`),
  info: (msg) => console.log(`  ${DIM}${msg}${RESET}`),
  ok: (msg) => console.log(`  ${GREEN}OK${RESET} ${msg}`),
  warn: (msg) => console.log(`  ${YELLOW}!${RESET} ${msg}`),
  err: (msg) => console.error(`  ${RED}X${RESET} ${msg}`),
};

function die(msg) {
  log.err(msg);
  process.exit(1);
}

function isEmptyDir(dir) {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

async function promptName(rl) {
  while (true) {
    const answer = (await rl.question(`${BOLD}Nome da pasta${RESET} ${DIM}(default: expert-brain)${RESET}: `)).trim();
    const name = answer || 'expert-brain';
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      log.warn('Use so letras, numeros, ponto, hifen ou underscore.');
      continue;
    }
    return name;
  }
}

async function main() {
  log.banner('Expert Brain — scaffolder');
  console.log(`${DIM}Vamos criar uma nova instalacao do Expert Brain.${RESET}`);
  console.log(`${DIM}Voce ainda vai precisar de uma conta Cloudflare gratuita + ~3min de setup.${RESET}`);

  if (!existsSync(TEMPLATE_DIR)) {
    die(`Template nao encontrado em ${TEMPLATE_DIR}. Pacote npm corrompido?`);
  }

  // 1. Resolver pasta destino
  let targetName = process.argv[2];
  let rl;
  if (!targetName) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    targetName = await promptName(rl);
  }
  const targetDir = path.resolve(process.cwd(), targetName);

  // 2. Validar destino
  if (existsSync(targetDir)) {
    const isDir = statSync(targetDir).isDirectory();
    if (!isDir) die(`'${targetName}' existe mas nao e uma pasta.`);
    if (!isEmptyDir(targetDir)) die(`Pasta '${targetName}' existe e nao esta vazia. Escolhe outro nome ou esvazia ela.`);
  }
  if (rl) rl.close();

  // 3. Copiar template
  log.step(`Copiando template pra ${targetDir}`);
  cpSync(TEMPLATE_DIR, targetDir, { recursive: true });
  log.ok('Template copiado.');

  // 4. Renomear _gitignore -> .gitignore (workaround npm publish)
  const renamedGitignore = path.join(targetDir, '_gitignore');
  const finalGitignore = path.join(targetDir, '.gitignore');
  if (existsSync(renamedGitignore)) {
    renameSync(renamedGitignore, finalGitignore);
    log.info('Renomeado _gitignore -> .gitignore.');
  }

  // 5. npm install
  log.step('Instalando dependencias (npm install)');
  log.info('Isso leva ~30s. Voce vai ver os logs do npm abaixo.\n');
  const installRes = spawnSync('npm', ['install'], {
    cwd: targetDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (installRes.status !== 0) {
    die(`npm install falhou (exit ${installRes.status}). Resolve o erro acima e roda 'npm install' manualmente em ${targetDir}.`);
  }
  log.ok('Dependencias instaladas.');

  // 6. Proximos passos
  const cdCmd = targetName.includes(' ') ? `cd "${targetName}"` : `cd ${targetName}`;
  console.log(`\n${GREEN}${BOLD}Tudo pronto!${RESET}\n`);
  console.log(`Proximo passo — provisionar Cloudflare e fazer deploy:\n`);
  console.log(`  ${BOLD}${cdCmd}${RESET}`);
  console.log(`  ${BOLD}npx wrangler login${RESET}     ${DIM}# uma vez por maquina, abre o browser${RESET}`);
  console.log(`  ${BOLD}npm run setup${RESET}          ${DIM}# 3 perguntas (email + senha + temas opcionais), espera ~3min${RESET}`);
  console.log(`\n${DIM}O setup imprime no final a URL do Worker, o comando MCP pra conectar no Claude e o link${RESET}`);
  console.log(`${DIM}do dashboard — e instala a captura automatica (hooks do Claude Code). Boa! 🧠${RESET}\n`);
}

main().catch((err) => {
  console.error(`\n${RED}${BOLD}Erro:${RESET} ${err.message}`);
  if (err.stack) console.error(`${DIM}${err.stack}${RESET}`);
  process.exit(1);
});
