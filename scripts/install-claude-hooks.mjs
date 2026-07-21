#!/usr/bin/env node
// Expert Brain — instalador da camada CLIENTE (hooks do Claude Code).
//
// O servidor MCP (Worker) so sabe RESPONDER ("ofereca salvar"). A captura PROATIVA
// ("salve sem pedir", "recall antes de perguntar", "salve na compactacao") vive em
// hooks client-side do Claude Code. Este script instala essa camada na maquina do
// usuario — e o que faz o Brain "salvar sozinho".
//
// Pipeline instalado (6 hooks):
//   SessionStart      -> prime de comportamento (recall-first, save_note na hora, save_task).
//                        Matcher startup|resume|clear. O aviso de tasks (list_tasks_due_today)
//                        tem RATE-LIMIT: 1x por periodo do dia (manha/tarde/noite, fuso local)
//                        e NUNCA em retomada de sessao (source=resume).
//   UserPromptSubmit  -> capture-nudge: sinais de prazo/decisao/insight/metrica/contato
//   PostToolUse       -> audit: registra cada save_* (alimenta a varredura)
//   Stop              -> varredura de silencio: sessao longa sem nenhum save -> 1 lembrete
//   PreCompact        -> ultima chance com contexto inteiro
//   PostCompact       -> salvar o que sobrou + ciclo de vida das tasks (SEM cobranca de atraso)
//
// Chamado pelo setup.mjs (nos DOIS caminhos: instalacao nova e atualizacao) e
// rodavel standalone:
//   node scripts/install-claude-hooks.mjs [workerUrl] [kw1,kw2,...]
//
// Garantias:
//   - Comandos gravados com CAMINHO ABSOLUTO (nunca `~`): o til so expande em
//     shells POSIX — em Windows sem Git Bash o hook morreria silenciosamente.
//   - Entradas deste pacote sao GERENCIADAS: toda execucao remove as entradas
//     `expert-brain-*.cjs` existentes (qualquer forma antiga, incl. `~`) e regrava
//     com o comando/matcher atuais. Entradas de OUTROS hooks nunca sao tocadas.
//   - Backup do settings.json antes de qualquer escrita. JSON invalido = nao mexe.
//   - Manifest em ~/.claude/hooks/expert-brain-install.json guarda url/keywords —
//     re-rodar sem passar keywords PRESERVA as que o usuario ja configurou.
//
// Nao-fatal: se falhar, avisa e retorna false. O Brain funciona sem isso (modo
// reativo); os hooks so ligam a captura automatica.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, 'claude-hooks');

// template a copiar -> evento do Claude Code que dispara o hook
// matcher: filtra por tool (PostToolUse) ou por source (SessionStart) — o do
// session-start EXCLUI 'compact' de proposito: sem ele, o hook roda de novo na
// retomada pos-compactacao e re-injeta a cobranca de tasks no meio da sessao.
const HOOKS = [
  { file: 'expert-brain-session-start.cjs', event: 'SessionStart', matcher: 'startup|resume|clear' },
  { file: 'expert-brain-capture-nudge.cjs', event: 'UserPromptSubmit' },
  {
    file: 'expert-brain-audit.cjs',
    event: 'PostToolUse',
    matcher: 'mcp__expert-brain__(save_note|save_task|update_note|update_task|complete_task|link)|mcp__expert-contacts__(save_person|save_company|connect|log_event)',
  },
  { file: 'expert-brain-stop-sweep.cjs', event: 'Stop' },
  { file: 'expert-brain-precompact.cjs', event: 'PreCompact' },
  { file: 'expert-brain-postcompact.cjs', event: 'PostCompact' },
];

// arquivos de versoes antigas deste pacote que devem sumir do disco ao atualizar
// (a entrada no settings.json ja e purgada pelo isManagedCommand; isto apaga o .cjs orfao)
const SUPERSEDED_FILES = ['expert-brain-task-nudge.cjs', 'expert-brain-overdue-nudge.cjs'];

// Uma entrada de hook e NOSSA (gerenciada) se o comando referencia um arquivo
// `expert-brain-*.cjs` — cobre a forma antiga com `~` e a nova com caminho absoluto.
function isManagedCommand(cmd) {
  return typeof cmd === 'string' && /expert-brain-[a-z-]+\.cjs/.test(cmd);
}

export function readInstallManifest() {
  try {
    const p = path.join(os.homedir(), '.claude', 'hooks', 'expert-brain-install.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

export function installClaudeHooks({ workerUrl = '', userKeywords, log } = {}) {
  const say = log || ((m) => console.log(m));
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const hooksDir = path.join(claudeDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // keywords: undefined/null = preservar as do manifest da instalacao anterior
    let kws;
    if (userKeywords === undefined || userKeywords === null) {
      const prev = readInstallManifest();
      kws = prev && Array.isArray(prev.keywords) ? prev.keywords : [];
    } else {
      kws = Array.isArray(userKeywords) ? userKeywords : [];
    }
    kws = kws.map((k) => String(k).trim()).filter(Boolean).slice(0, 20);

    // 1. gravar os hooks (substituindo placeholders pelos valores reais)
    const url = String(workerUrl).replace(/\/+$/, '') || 'seu Worker';
    // vira literal de string simples dentro do .cjs -> escapar \ e '
    const kwJson = JSON.stringify(kws).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    for (const h of HOOKS) {
      const tpl = readFileSync(path.join(TEMPLATES_DIR, h.file), 'utf8')
        .split('{{WORKER_URL}}').join(url)
        .split('{{USER_KEYWORDS_JSON}}').join(kwJson);
      writeFileSync(path.join(hooksDir, h.file), tpl);
    }
    say(`  hooks gravados em ${hooksDir}: ${HOOKS.map((h) => h.file).join(', ')}`);
    if (kws.length) say(`  temas personalizados no capture-nudge: ${kws.join(', ')}`);

    // manifest da instalacao (fonte pra preservar keywords em re-runs)
    try {
      writeFileSync(
        path.join(hooksDir, 'expert-brain-install.json'),
        JSON.stringify({ workerUrl: url, keywords: kws, installedAt: new Date().toISOString() }, null, 2)
      );
    } catch { /* best-effort */ }

    // remover arquivos de versoes antigas
    for (const f of SUPERSEDED_FILES) {
      const p = path.join(hooksDir, f);
      if (existsSync(p)) { try { unlinkSync(p); say(`  hook antigo removido: ${f}`); } catch { /* */ } }
    }

    // 2. merge seguro no settings.json
    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings = {};
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, 'utf8');
      // backup ANTES de qualquer escrita (rede de seguranca)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      copyFileSync(settingsPath, `${settingsPath}.bak-brain-${stamp}`);
      try {
        settings = JSON.parse(raw);
      } catch {
        say('  ! settings.json existe mas nao e JSON valido — nao vou mexer pra nao corromper. Backup salvo.');
        say('    Pra ligar na mao: abra o Claude Code, rode /hooks e adicione os comandos (ou conserte o JSON e rode este script de novo).');
        return false;
      }
    }

    if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
      settings.hooks = {};
    }

    // Entradas gerenciadas: purga TODAS as nossas (qualquer forma antiga) em todos
    // os eventos, preservando entradas de outros hooks — depois regrava as atuais.
    for (const ev of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[ev])) continue;
      settings.hooks[ev] = settings.hooks[ev]
        .map((g) => {
          if (!g || !Array.isArray(g.hooks)) return g;
          return { ...g, hooks: g.hooks.filter((x) => !(x && isManagedCommand(x.command))) };
        })
        .filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
    }

    for (const h of HOOKS) {
      // caminho ABSOLUTO com aspas: sobrevive a PowerShell/cmd (sem `~`) e a espacos no path
      const cmd = `node "${path.join(hooksDir, h.file)}"`;
      if (!Array.isArray(settings.hooks[h.event])) settings.hooks[h.event] = [];
      const entry = { hooks: [{ type: 'command', command: cmd, timeout: 5 }] };
      if (h.matcher) entry.matcher = h.matcher;
      settings.hooks[h.event].push(entry);
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    say(`  settings.json: ${HOOKS.length} hooks (re)instalados com o comando/matcher atuais (backup feito antes).`);
    return true;
  } catch (err) {
    say(`  ! nao consegui instalar os hooks: ${err.message}`);
    say("    O Brain funciona mesmo assim (modo reativo). Rode 'node scripts/install-claude-hooks.mjs <url>' depois pra ligar a captura automatica.");
    return false;
  }
}

// execucao standalone: `node scripts/install-claude-hooks.mjs [workerUrl] [kw1,kw2,...]`
// (sem o 3o argumento, keywords ja configuradas sao preservadas)
if (process.argv[1] && process.argv[1].endsWith('install-claude-hooks.mjs')) {
  const kwArg = process.argv[3];
  const kws = kwArg === undefined ? undefined : kwArg.split(',').map((s) => s.trim()).filter(Boolean);
  const ok = installClaudeHooks({ workerUrl: process.argv[2] || '', userKeywords: kws });
  process.exit(ok ? 0 : 1);
}
