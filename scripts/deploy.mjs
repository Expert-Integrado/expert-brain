#!/usr/bin/env node
// Deploy + provision automático (spec 10-backend/13).
//
// `wrangler deploy` publica o código novo na hora, mas as migrations D1 só
// rodam quando alguém chama POST /setup/provision. Este wrapper fecha essa
// janela: deploya, extrai a URL do worker do output do wrangler e chama o
// provision na sequência, com retry. Node >= 18, zero dependências.
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
const tomlUrl = (() => {
  try {
    const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.toml'), 'utf8');
    return /^\s*WORKER_URL\s*=\s*"(https:\/\/[^"]+)"/m.exec(toml)?.[1];
  } catch {
    return undefined;
  }
})();
const preflightBase = process.env.BRAIN_URL || tomlUrl;
if (!bearer) {
  console.warn('[deploy] preflight: sem BRAIN_SETUP_TOKEN/SETUP_TOKEN no ambiente — pulando validação (ok em primeira instalação).');
} else if (!preflightBase) {
  console.warn('[deploy] preflight: sem WORKER_URL no wrangler.toml nem BRAIN_URL — pulando validação do token.');
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
    console.log(`[deploy] preflight: token validado no worker atual (HTTP ${resp.status}).`);
  } catch (e) {
    console.warn(`[deploy] preflight: validação indisponível (${String(e).slice(0, 120)}) — seguindo com o deploy.`);
  }
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
