#!/usr/bin/env node
// Deploy + provision automático (spec 10-backend/13).
//
// `wrangler deploy` publica o código novo na hora, mas as migrations D1 só
// rodam quando alguém chama POST /setup/provision. Este wrapper fecha essa
// janela: deploya, extrai a URL do worker do output do wrangler e chama o
// provision na sequência, com retry. Node >= 18, zero dependências.
// Preflight fail-closed: com migration pendente E provision não garantido
// (token ausente/erro de rede), ABORTA antes de publicar (seção 0b).
//
// Fallback de URL (custom domain / output inesperado): env BRAIN_URL.

import { spawnSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const isWin = process.platform === 'win32';

function fail(msg) {
  console.error(`\n[deploy] ERRO: ${msg}`);
  process.exit(1);
}

// Fallback win32: token persistido via `setx` só chega em shells NOVAS — uma shell
// aberta antes do setx não o herda. Ler HKCU\Environment cobre esse caso sem
// nunca imprimir o valor.
function userEnvFromRegistry(name) {
  if (process.platform !== 'win32') return undefined;
  try {
    const out = execSync(`reg query HKCU\\Environment /v ${name}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /REG_(?:EXPAND_)?SZ\s+(\S+)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

// Vault configurado exige Bearer (spec 10-backend/18): BRAIN_SETUP_TOKEN,
// SETUP_TOKEN ou GRAPH_EXPORT_TOKEN do ambiente — nunca hardcoded aqui.
const bearer =
  process.env.BRAIN_SETUP_TOKEN || process.env.SETUP_TOKEN || process.env.GRAPH_EXPORT_TOKEN ||
  userEnvFromRegistry('BRAIN_SETUP_TOKEN');
const headers = bearer ? { authorization: `Bearer ${bearer}` } : undefined;

// 0. PREFLIGHT do token (spec 80-frota-agentes/89): valida a credencial do provision
// ANTES do wrangler deploy. Incidente real (11/07/2026, migration 0027): deploy subiu,
// provision respondeu 401 e prod ficou DEGRADADA (queries selecionando colunas ainda
// não migradas) até rotacionar o token. Regras:
// - 401 no worker ATUAL → ABORTA antes de deployar (o deploy deixaria prod quebrada
//   sem como migrar). Provision é idempotente — validar com um POST real é seguro.
// - Sem bearer ou sem URL → warn e segue (primeira instalação / vault sem token).
// - Erro de rede/5xx → warn e segue (não bloquear deploy por transiente; o passo 3
//   ainda vai tentar e falhar alto se persistir).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tomlUrl = (() => {
  try {
    const toml = readFileSync(join(repoRoot, 'wrangler.toml'), 'utf8');
    return /^\s*WORKER_URL\s*=\s*"(https:\/\/[^"]+)"/m.exec(toml)?.[1];
  } catch {
    return undefined;
  }
})();
const preflightBase = process.env.BRAIN_URL || tomlUrl;
let provisionGuaranteed = false;
let preflightGap = '';
if (!bearer) {
  preflightGap = 'sem BRAIN_SETUP_TOKEN/SETUP_TOKEN no ambiente';
  console.warn(`[deploy] preflight: ${preflightGap} — validação do token pulada.`);
} else if (!preflightBase) {
  preflightGap = 'sem WORKER_URL no wrangler.toml nem BRAIN_URL';
  console.warn(`[deploy] preflight: ${preflightGap} — validação do token pulada.`);
} else {
  try {
    const resp = await fetch(`${preflightBase}/setup/provision`, { method: 'POST', headers });
    if (resp.status === 401) {
      fail(
        `preflight: o worker ATUAL rejeitou a credencial (401) — deploy ABORTADO antes de publicar.\n` +
          `Um deploy agora deixaria o código novo no ar SEM conseguir rodar as migrations (prod degradada).\n` +
          `Corrija BRAIN_SETUP_TOKEN (valor do secret SETUP_TOKEN do worker) e rode de novo.`
      );
    }
    provisionGuaranteed = true;
    console.log(`[deploy] preflight: token validado no worker atual (HTTP ${resp.status}).`);
  } catch (e) {
    preflightGap = `validação indisponível (${String(e).slice(0, 120)})`;
    console.warn(`[deploy] preflight: ${preflightGap}.`);
  }
}

// 0b. PREFLIGHT DE SCHEMA DRIFT (3ª ocorrência da classe, 17-18/07/2026, migration
// 0030/task_deps): quando o provision NÃO está garantido (token ausente, 401 já
// aborta acima, erro de rede), o deploy pode publicar código que consulta tabela/
// coluna que a migration pendente ainda não criou — prod degradada sem ninguém pra
// migrar. Gate: compara a lista MIGRATIONS do CÓDIGO (src/db/migrate.ts, a MESMA
// fonte que runMigrations usa no worker) com a tabela _migrations de PROD via
// `wrangler d1 execute --remote` (read-only, coluna `id`). Migration pendente +
// provision não garantido → ABORTA antes do deploy. Sem como verificar (wrangler
// deslogado, erro de rede, parse falhou) → ABORTA também: fail CLOSED, nunca
// "warn e segue" (foi exatamente o warn-e-segue que deixou a 0030 pra trás).
function codeMigrationIds() {
  const src = readFileSync(join(repoRoot, 'src', 'db', 'migrate.ts'), 'utf8');
  const block = /export const MIGRATIONS[^=]*=\s*\[([\s\S]*?)\];/.exec(src)?.[1];
  return [...(block ?? '').matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]);
}

function prodAppliedMigrationIds() {
  // Read-only (SELECT); "expert-brain" = database_name do wrangler.toml. execSync
  // (e não spawnSync) porque o --command tem espaços e o shell do Windows precisa
  // das aspas preservadas. --json manda o resultado puro pro stdout.
  const raw = execSync(
    'npx wrangler d1 execute expert-brain --remote --json --command "SELECT id FROM _migrations"',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const json = JSON.parse(raw.slice(raw.indexOf('[')));
  const rows = json?.[0]?.results;
  if (!Array.isArray(rows)) throw new Error(`output do wrangler d1 sem results: ${raw.slice(0, 200)}`);
  return new Set(rows.map((r) => r.id));
}

if (!provisionGuaranteed) {
  console.log(`[deploy] preflight: provision não garantido (${preflightGap}) — checando migrations pendentes em prod via wrangler d1...`);
  const codeIds = codeMigrationIds();
  if (!codeIds.length) {
    fail(
      `não consegui extrair a lista MIGRATIONS de src/db/migrate.ts — sem como checar drift de schema.\n` +
        `Deploy ABORTADO (fail closed). Confira o arquivo ou rode com BRAIN_SETUP_TOKEN setado.`
    );
  }
  let appliedIds;
  try {
    appliedIds = prodAppliedMigrationIds();
  } catch (e) {
    fail(
      `não consegui ler _migrations de prod (${String(e?.stderr || e?.message || e).trim().slice(0, 300)}).\n` +
        `Sem provision garantido E sem como conferir o schema, o deploy poderia subir código à frente das migrations — ABORTADO (fail closed).\n` +
        `Autentique o wrangler (npx wrangler login) OU sete BRAIN_SETUP_TOKEN e rode de novo.`
    );
  }
  const pending = codeIds.filter((id) => !appliedIds.has(id));
  if (pending.length) {
    fail(
      `migration pendente em prod (${pending.join(', ')}) e provision não garantido (${preflightGap}).\n` +
        `Deployar agora subiria código consultando schema que ainda não existe (caso real: 0030/task_deps, 17-18/07/2026).\n` +
        `Sete BRAIN_SETUP_TOKEN (valor do secret SETUP_TOKEN do worker) e rode de novo — o deploy aplica a migration na sequência.`
    );
  }
  console.log(`[deploy] preflight: sem migration pendente (${codeIds.length} no código, todas aplicadas em prod) — seguindo com o deploy.`);
}

// 1. wrangler deploy — captura stdout (pra extrair a URL) mas ecoa tudo.
const res = spawnSync(isWin ? 'npx.cmd' : 'npx', ['wrangler', 'deploy'], {
  encoding: 'utf8',
  shell: isWin,
  stdio: ['inherit', 'pipe', 'inherit'],
});
if (res.stdout) process.stdout.write(res.stdout);
if (res.status !== 0) {
  fail(`wrangler deploy saiu com código ${res.status} — provision NÃO rodou.`);
}

// 2. URL do worker no output (ex.: https://<worker>.<subdomain>.workers.dev).
const match = /https:\/\/[\w.-]+\.workers\.dev/.exec(res.stdout ?? '');
const base = match?.[0] ?? process.env.BRAIN_URL;
if (!base) {
  fail(
    'não achei a URL do worker no output do wrangler e BRAIN_URL não está setada.\n' +
      'provision NÃO rodou — chame manualmente: curl -sf -X POST <url-do-worker>/setup/provision'
  );
}

// 3. POST /setup/provision com retry (cobre o propagation delay do deploy).
// Bearer/headers resolvidos lá em cima (preflight) — mesma credencial.
const url = `${base}/setup/provision`;
// DOUBLE-TAP contra o propagation delay do deploy (caso real, 07/07/2026): o POST
// imediatamente após o `wrangler deploy` pode cair na versão ANTIGA do worker —
// ela roda as migrations antigas, responde 200 e a migration nova NÃO aplica
// (runMigrations é da versão que atendeu o request). Como o provision é idempotente,
// a cura é exigir DOIS 200 espaçados: o segundo (15s depois) quase certamente já
// atinge a versão nova. Falha de rede/5xx entre os taps só re-tenta.
const delays = [0, 15000, 10000, 10000];
let okCount = 0;
let lastErr = '';
for (const delay of delays) {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  try {
    const resp = await fetch(url, { method: 'POST', headers });
    const body = await resp.text();
    if (resp.ok) {
      okCount++;
      console.log(`[deploy] provision ok ${okCount}/2 (${resp.status}): ${body.slice(0, 200)}`);
      if (okCount >= 2) process.exit(0);
      continue;
    }
    if (resp.status === 401) {
      fail(
        `provision retornou 401 — o worker exige credencial nos /setup/*.\n` +
          `Sete BRAIN_SETUP_TOKEN (ou SETUP_TOKEN/GRAPH_EXPORT_TOKEN) no ambiente com o valor do secret SETUP_TOKEN do worker e rode de novo.\n` +
          `O código novo JÁ está no ar; só as migrations não rodaram.`
      );
    }
    lastErr = `HTTP ${resp.status}: ${body.slice(0, 500)}`;
  } catch (e) {
    lastErr = String(e);
  }
  console.error(`[deploy] provision falhou (${lastErr}) — tentando de novo...`);
}
fail(`provision não conseguiu 2 respostas ok (${okCount}/2) em ${url}.\nÚltimo erro: ${lastErr}`);
