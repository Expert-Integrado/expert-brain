// Rotas de backup do Console (spec 50-console-v2/67 do expert-brain).
//
//   POST /app/backup/run — roda o snapshot AGORA (mesma função do cron semanal).
//   GET  /app/export     — snapshot on-demand + download de um ZIP com os JSONL
//                          e o manifest (fonte ÚNICA: runSnapshot — o export é
//                          exatamente o que o cron grava no R2).
//
// SESSÃO OBRIGATÓRIA nas duas — o gate fica em handler.ts, DEPOIS do allowlist
// do CONTACTS_PROXY_TOKEN (que deliberadamente NÃO cobre backup: o export
// contém o vault INTEIRO, inclusive dados privados).

import type { Env } from '../env.js';
import { runSnapshotRecorded } from '../backup/snapshot.js';
import { buildZip, type ZipEntry } from '../backup/zip.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export async function handleBackupRun(req: Request, env: Env): Promise<Response> {
  const result = await runSnapshotRecorded(env);
  // Submit de <form> do /app/config (CSP bloqueia JS inline; a página não tem
  // bundle) → volta pra config com o resultado na query. Chamada programática
  // (Accept sem text/html) recebe o JSON do resultado.
  const wantsHtml = (req.headers.get('accept') || '').includes('text/html');
  if (wantsHtml) {
    return new Response(null, {
      status: 303,
      headers: { location: `/app/config?backup=${result.ok ? 'ok' : 'err'}` },
    });
  }
  return json(result, result.ok ? 200 : 500);
}

export async function handleExportGet(_req: Request, env: Env): Promise<Response> {
  if (!env.MEDIA) return json({ ok: false, error: 'R2 bucket not configured (MEDIA binding missing)' }, 503);

  // Export = MESMA função do snapshot (grava no R2 e registra em backup:last);
  // o ZIP é montado lendo de volta os arquivos recém-gravados — garantia de que
  // o que o dono baixa é byte-a-byte o que o backup semanal guarda.
  const result = await runSnapshotRecorded(env);
  if (!result.ok) return json(result, 500);

  const entries: ZipEntry[] = [];
  for (const key of result.files) {
    const obj = await env.MEDIA.get(key);
    if (!obj) return json({ ok: false, error: `snapshot file missing in R2: ${key}` }, 500);
    entries.push({
      name: key.slice(result.prefix.length), // entities.jsonl, manifest.json, ...
      data: new Uint8Array(await obj.arrayBuffer()),
    });
  }

  const zip = buildZip(entries);
  return new Response(zip, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="expert-contacts-backup-${result.date}.zip"`,
      'cache-control': 'no-store',
    },
  });
}
