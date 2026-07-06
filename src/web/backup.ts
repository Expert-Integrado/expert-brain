import type { Env } from '../env.js';
import { requireSession } from './session.js';
import { buildSnapshot, runSnapshot } from '../backup/snapshot.js';
import { buildZip, type ZipEntry } from '../backup/zip.js';

// Endpoints de backup do console (specs/50-console-v2/67-backup-export.md).
// Ambos exigem sessão de browser — nenhum caminho público novo.

// POST /app/config/backup-now — snapshot on-demand pro R2 (MESMA função do cron
// semanal). O resultado (ok/falha + contagens) fica em meta.last_backup e a
// seção Backup de /app/config lê de lá após o redirect.
export async function handleBackupNowPost(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  await runSnapshot(env);
  return new Response(null, { status: 302, headers: { location: '/app/config?saved=backup#backup' } });
}

// GET /app/export — export manual do dono: MESMO dump do snapshot (buildSnapshot,
// fonte única — sem formato divergente), zipado e devolvido na hora. Decisão de
// execução da spec: resposta bufferizada, não link R2 assinado — o vault atual
// gera poucos MB de JSONL (ainda menos comprimido), ordens de grandeza abaixo
// dos limites de memória/resposta do Worker. Se o volume um dia estourar isso,
// o fallback documentado é gravar no R2 e devolver link assinado de curta duração.
export async function handleExportGet(req: Request, env: Env): Promise<Response> {
  const session = await requireSession(req, env);
  if (!session.ok) return session.response;
  const now = Date.now();
  const { tables, manifest } = await buildSnapshot(env, now);
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [
    ...tables.map((t) => ({ name: `${t.name}.jsonl`, data: enc.encode(t.jsonl) })),
    { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2)) },
  ];
  const zip = await buildZip(entries, new Date(now));
  const date = manifest.created_at_iso.slice(0, 10);
  return new Response(zip, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="expert-brain-export-${date}.zip"`,
      'cache-control': 'no-store',
    },
  });
}
