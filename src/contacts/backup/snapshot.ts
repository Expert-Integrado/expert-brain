// ─────────────────────────────────────────────────────────────────────────────
// Snapshot de backup: D1 → R2 em JSON Lines (spec 50-console-v2/67 do
// expert-brain, espelhada aqui no contacts).
//
// runSnapshot(env) faz o dump de TODAS as tabelas de dados do D1 (inclusive
// `_migrations` — versão do schema; excluídas só as internas `sqlite_*`/`_cf_*`)
// em lotes de 500 linhas por rowid, grava 1 `<tabela>.jsonl` por tabela +
// `manifest.json` no bucket R2 já vinculado (MEDIA), sob o prefixo
// `backups/<YYYY-MM-DD>/`. O manifest é gravado por ÚLTIMO — presença dele =
// snapshot completo (o restore confia nisso).
//
// Mídia do R2 NÃO é recopiada (os blobs já vivem no MESMO bucket, prefixo
// sha256/): o manifest referencia as keys. Vectorize NÃO entra (regenerável via
// POST /setup/reembed — anotado no manifest).
//
// Retenção: os últimos RETAIN_SNAPSHOTS ficam; excedente é apagado SOMENTE após
// o snapshot novo ter sido gravado com sucesso (snapshot falho não apaga NADA).
//
// Resultado (ok/falha + contagens) gravado no KV CACHE (chave `backup:last`) —
// mesmo padrão do cron de manutenção (`maint:last_run`); o contacts não tem
// tabela meta e a spec manda seguir o padrão do repo SEM migration.
// ─────────────────────────────────────────────────────────────────────────────

import type { Env } from '../env';

/** Expressão de cron do snapshot semanal (segunda 05:30 UTC = 02:30 BRT).
 *  PRECISA bater com a segunda entrada de `crons` no wrangler.toml — o
 *  scheduled() do index.ts faz dispatch por controller.cron com esta constante. */
export const SNAPSHOT_CRON = '30 5 * * 1';

/** Prefixo dos snapshots no bucket R2 (MEDIA). */
export const BACKUP_PREFIX = 'backups/';

/** Chave no KV CACHE com o resultado do último snapshot (ok OU falha). */
export const LAST_BACKUP_KEY = 'backup:last';

/** Quantos snapshots ficam no R2 (os mais novos). */
export const RETAIN_SNAPSHOTS = 8;

/** Tamanho do lote de leitura do D1 (respeita CPU-time do Worker). */
const BATCH_SIZE = 500;

export interface SnapshotResult {
  ok: true;
  date: string; // YYYY-MM-DD (UTC)
  prefix: string; // backups/<date>/
  schema_version: string | null; // último id aplicado em _migrations
  tables: Record<string, number>; // contagem de linhas por tabela
  total_rows: number;
  files: string[]; // keys R2 gravadas (jsonl + manifest)
  bytes: number; // total gravado no snapshot
  media_keys_referenced: number; // keys de mídia referenciadas no manifest
  deleted_snapshots: string[]; // prefixos apagados pela retenção
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

export interface SnapshotFailure {
  ok: false;
  error: string;
  finished_at: string;
}

export type SnapshotOutcome = SnapshotResult | SnapshotFailure;

// Tabelas de dados = tudo de sqlite_master que não é interno do SQLite
// (`sqlite_*`) nem do runtime D1/miniflare (`_cf_*`). `_migrations` ENTRA
// (é a versão do schema — o restore valida contra ela).
async function listDataTables(db: D1Database): Promise<string[]> {
  const r = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all<{ name: string }>();
  return (r.results ?? [])
    .map((x) => x.name)
    .filter((n) => !n.startsWith('sqlite_') && !n.startsWith('_cf_'));
}

// Dump paginado por rowid (todas as tabelas do contacts têm rowid — nenhuma é
// WITHOUT ROWID). O alias __rowid serve só de cursor e NÃO vai pro JSONL.
async function dumpTableJsonl(
  db: D1Database,
  table: string
): Promise<{ lines: string[]; count: number }> {
  const lines: string[] = [];
  let cursor = 0;
  for (;;) {
    const page = await db
      .prepare(`SELECT rowid AS __rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`)
      .bind(cursor, BATCH_SIZE)
      .all<Record<string, unknown>>();
    const rows = page.results ?? [];
    if (!rows.length) break;
    for (const row of rows) {
      cursor = Number(row.__rowid);
      const { __rowid: _drop, ...data } = row;
      lines.push(JSON.stringify(data));
    }
    if (rows.length < BATCH_SIZE) break;
  }
  return { lines, count: lines.length };
}

// Último id aplicado em _migrations (versão do schema). null se a tabela ainda
// não existe (banco nunca provisionado via runMigrations).
async function schemaVersion(db: D1Database): Promise<string | null> {
  try {
    const r = await db
      .prepare(`SELECT id FROM _migrations ORDER BY id DESC LIMIT 1`)
      .first<{ id: string }>();
    return r?.id ?? null;
  } catch {
    return null;
  }
}

// Keys de mídia referenciadas pelo vault (media.r2_key + entities.avatar_r2_key),
// deduplicadas — paginado pra não estourar uma resposta única do D1.
async function collectMediaKeys(db: D1Database): Promise<string[]> {
  const keys: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await db
      .prepare(
        `SELECT k FROM (
           SELECT r2_key AS k FROM media
           UNION
           SELECT avatar_r2_key AS k FROM entities WHERE avatar_r2_key IS NOT NULL
         ) WHERE k IS NOT NULL ORDER BY k LIMIT ? OFFSET ?`
      )
      .bind(BATCH_SIZE, offset)
      .all<{ k: string }>();
    const rows = page.results ?? [];
    for (const r of rows) keys.push(r.k);
    if (rows.length < BATCH_SIZE) break;
    offset += rows.length;
  }
  return keys;
}

// Prefixos de snapshot existentes (backups/<YYYY-MM-DD>/), em ordem ASC —
// datas ISO ordenam lexicograficamente, então o primeiro é o mais antigo.
async function listSnapshotPrefixes(bucket: R2Bucket): Promise<string[]> {
  const prefixes = new Set<string>();
  let cursor: string | undefined;
  do {
    const l = await bucket.list({ prefix: BACKUP_PREFIX, delimiter: '/', cursor });
    for (const p of l.delimitedPrefixes) prefixes.add(p);
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  return [...prefixes].sort();
}

// Apaga todos os objetos sob um prefixo (relista até esvaziar — delete em lote).
async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  for (;;) {
    const l = await bucket.list({ prefix, limit: 1000 });
    const keys = (l.objects ?? []).map((o) => o.key);
    if (!keys.length) break;
    await bucket.delete(keys);
    if (!l.truncated) break;
  }
}

/**
 * Roda o snapshot completo: dump D1 → JSONL no R2 + manifest + retenção.
 * Lança em caso de falha (quem chama decide registrar/engolir — ver
 * runSnapshotRecorded). NUNCA apaga snapshot antigo antes do novo estar gravado.
 */
export async function runSnapshot(env: Env): Promise<SnapshotResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const bucket = env.MEDIA;
  if (!bucket) throw new Error('R2 bucket not configured (MEDIA binding missing)');

  const date = startedAt.slice(0, 10);
  const prefix = `${BACKUP_PREFIX}${date}/`;
  const encoder = new TextEncoder();

  const tables = await listDataTables(env.DB);
  if (!tables.length) throw new Error('no data tables found in D1');

  const counts: Record<string, number> = {};
  const files: string[] = [];
  const jsonlNames: string[] = [];
  let bytes = 0;

  // 1 JSONL por tabela (gravados antes do manifest — manifest é o marcador de
  // snapshot completo).
  for (const table of tables) {
    const { lines, count } = await dumpTableJsonl(env.DB, table);
    counts[table] = count;
    const key = `${prefix}${table}.jsonl`;
    const body = encoder.encode(lines.length ? lines.join('\n') + '\n' : '');
    await bucket.put(key, body, {
      httpMetadata: { contentType: 'application/x-ndjson; charset=utf-8' },
    });
    files.push(key);
    jsonlNames.push(`${table}.jsonl`);
    bytes += body.byteLength;
  }

  const version = await schemaVersion(env.DB);
  const mediaKeys = await collectMediaKeys(env.DB);
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);

  const manifest = {
    service: 'expert-contacts',
    spec: 'specs/50-console-v2/67-backup-export.md (repo expert-brain)',
    created_at: startedAt,
    date,
    schema_version: version,
    tables: counts,
    total_rows: totalRows,
    files: jsonlNames,
    r2_media: {
      copied: false,
      note:
        'Mídia NÃO é recopiada pelo snapshot — os blobs já vivem neste MESMO bucket (prefixo sha256/). ' +
        'As keys abaixo são as referenciadas pelo D1 (media.r2_key + entities.avatar_r2_key).',
      keys: mediaKeys,
    },
    vectorize: {
      included: false,
      note: 'Vectorize é regenerável a partir do D1: POST /setup/reembed (paginado — ver scripts/reembed-all.mjs).',
    },
    secrets: {
      note: 'Nenhum secret vive no D1 deste worker (tokens são secrets do Wrangler) — snapshot não contém credencial, por design.',
    },
  };

  const manifestKey = `${prefix}manifest.json`;
  const manifestBody = encoder.encode(JSON.stringify(manifest, null, 2));
  await bucket.put(manifestKey, manifestBody, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });
  files.push(manifestKey);
  bytes += manifestBody.byteLength;

  // Retenção — SÓ depois do snapshot novo completo (manifest gravado). Mantém os
  // RETAIN_SNAPSHOTS mais novos; apaga o excedente mais antigo.
  const deleted: string[] = [];
  const prefixes = await listSnapshotPrefixes(bucket);
  const excess = prefixes.length - RETAIN_SNAPSHOTS;
  for (let i = 0; i < excess; i++) {
    const old = prefixes[i];
    if (old === prefix) continue; // nunca apaga o que acabou de gravar
    await deletePrefix(bucket, old);
    deleted.push(old);
  }

  const finished = Date.now();
  return {
    ok: true,
    date,
    prefix,
    schema_version: version,
    tables: counts,
    total_rows: totalRows,
    files,
    bytes,
    media_keys_referenced: mediaKeys.length,
    deleted_snapshots: deleted,
    started_at: startedAt,
    finished_at: new Date(finished).toISOString(),
    duration_ms: finished - started,
  };
}

/**
 * runSnapshot com registro do resultado (ok OU falha) no KV CACHE
 * (`backup:last`) — é o que o cron, o botão do Console e o export usam.
 * Nunca lança: falha vira { ok: false, error } (o cron loga e segue vivo).
 */
export async function runSnapshotRecorded(env: Env): Promise<SnapshotOutcome> {
  try {
    const result = await runSnapshot(env);
    await env.CACHE.put(LAST_BACKUP_KEY, JSON.stringify(result));
    return result;
  } catch (e: any) {
    const failure: SnapshotFailure = {
      ok: false,
      error: String(e?.message || e),
      finished_at: new Date().toISOString(),
    };
    try {
      await env.CACHE.put(LAST_BACKUP_KEY, JSON.stringify(failure));
    } catch {
      /* registrar a falha não pode mascarar a falha original */
    }
    return failure;
  }
}
