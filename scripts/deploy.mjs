#!/usr/bin/env node
// Deploy + provision automático (spec 10-backend/13).
//
// `wrangler deploy` publica o código novo na hora, mas as migrations D1 só
// rodam quando alguém chama POST /setup/provision. Este wrapper fecha essa
// janela: deploya, extrai a URL do worker do output do wrangler e chama o
// provision na sequência, com retry. Node >= 18, zero dependências.
//
// Fallback de URL (custom domain / output inesperado): env BRAIN_URL.

import { spawnSync } from 'node:child_process';

const isWin = process.platform === 'win32';

function fail(msg) {
  console.error(`\n[deploy] ERRO: ${msg}`);
  process.exit(1);
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
// Vault configurado exige Bearer (spec 10-backend/18): BRAIN_SETUP_TOKEN,
// SETUP_TOKEN ou GRAPH_EXPORT_TOKEN do ambiente — nunca hardcoded aqui.
const url = `${base}/setup/provision`;
const bearer =
  process.env.BRAIN_SETUP_TOKEN || process.env.SETUP_TOKEN || process.env.GRAPH_EXPORT_TOKEN;
const headers = bearer ? { authorization: `Bearer ${bearer}` } : undefined;
const delays = [0, 2000, 5000];
let lastErr = '';
for (const delay of delays) {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  try {
    const resp = await fetch(url, { method: 'POST', headers });
    const body = await resp.text();
    if (resp.ok) {
      console.log(`[deploy] provision ok (${resp.status}): ${body.slice(0, 200)}`);
      process.exit(0);
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
fail(`provision falhou após ${delays.length} tentativas em ${url}.\nÚltimo erro: ${lastErr}`);
