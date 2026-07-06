import type { Env } from '../env.js';

// Snapshot completo do D1 pro R2 (specs/50-console-v2/67-backup-export.md).
// Dump de TODAS as tabelas de dados em JSON Lines paginado + manifest.json com
// contagens e versão de schema, gravado no bucket MEDIA sob backups/<YYYY-MM-DD>/.
// A mídia NÃO é recopiada (os blobs já vivem neste mesmo bucket) — o manifest só
// referencia as keys. Vectorize fica de fora (regenerável: reembed a partir do D1).
// O export manual (/app/export) usa o MESMO dump (buildSnapshot) — fonte única.

export const BACKUP_PREFIX = 'backups/';
export const RETENTION_SNAPSHOTS = 8;
export const LAST_BACKUP_META_KEY = 'last_backup';
// Lotes de 500 linhas por query — respeita o CPU-time do Worker sem carregar
// a tabela inteira de uma vez (cursor por rowid, ver dumpTable).
const PAGE_SIZE = 500;

export interface TableDump {
  name: string;
  count: number;
  jsonl: string;
}

export interface SnapshotManifest {
  version: 1;
  created_at: number;
  created_at_iso: string;
  // Último id aplicado em _migrations — a versão do schema deste snapshot.
  schema_version: string | null;
  // Contagem de linhas por tabela — o restore valida contra isto (docs/restore.md).
  tables: Record<string, number>;
  // Keys de mídia no R2 referenciadas por note_media. O snapshot NÃO copia os
  // blobs (já moram neste mesmo bucket); num restore pra bucket novo, copiar
  // estas keys é passo manual do runbook.
  media_r2_keys: string[];
  notes_for_restore: string[];
}

export interface SnapshotBuild {
  tables: TableDump[];
  manifest: SnapshotManifest;
}

export interface SnapshotResult {
  ok: boolean;
  at: number;
  date: string;
  prefix: string;
  tables: Record<string, number>;
  total_rows: number;
  bytes: number;
  duration_ms: number;
  deleted_prefixes: string[];
  error?: string;
}

// Tabelas fora do dump: virtual/shadow do FTS5 (o índice é regenerado pelos
// triggers notes_ai no re-INSERT das notes) e internas do SQLite/D1.
// `_migrations` ENTRA (é a versão do schema); `meta` ENTRA (config do dono);
// `api_keys` ENTRA (só hashes — os PATs não são recuperáveis, por design).
function isDataTable(name: string, sql: string | null): boolean {
  if (name.startsWith('sqlite_')) return false;
  if (name.startsWith('_cf')) return false;
  if (name === 'd1_migrations') return false; // migrations do wrangler (não usadas aqui)
  if ((sql ?? '').toUpperCase().includes('CREATE VIRTUAL TABLE')) return false; // notes_fts
  if (/_fts(_|$)/.test(name)) return false; // shadow tables do FTS5
  return true;
}

export async function listDataTables(env: Env): Promise<string[]> {
  const rs = await env.DB.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`
  ).all<{ name: string; sql: string | null }>();
  return (rs.results ?? []).filter((r) => isDataTable(r.name, r.sql)).map((r) => r.name);
}

// Dump paginado por rowid (lotes de PAGE_SIZE). Todas as tabelas do schema são
// rowid tables (nenhuma WITHOUT ROWID), então o cursor funciona uniformemente.
// O __rowid auxiliar é removido antes de serializar — o JSONL só carrega as
// colunas reais da tabela.
export async function dumpTable(env: Env, table: string): Promise<TableDump> {
  const lines: string[] = [];
  let cursor = -1; // rowid real é sempre >= 1
  for (;;) {
    const rs = await env.DB.prepare(
      `SELECT rowid AS __rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`
    )
      .bind(cursor, PAGE_SIZE)
      .all<Record<string, unknown>>();
    const rows = rs.results ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const { __rowid, ...data } = row;
      lines.push(JSON.stringify(data));
    }
    cursor = Number(rows[rows.length - 1].__rowid);
    if (rows.length < PAGE_SIZE) break;
  }
  return { name: table, count: lines.length, jsonl: lines.length ? lines.join('\n') + '\n' : '' };
}

// Fonte ÚNICA do conteúdo de backup: o cron semanal (runSnapshot) e o export
// manual (/app/export) chamam esta função — nenhum formato divergente.
export async function buildSnapshot(env: Env, now: number): Promise<SnapshotBuild> {
  const names = await listDataTables(env);
  const tables: TableDump[] = [];
  for (const name of names) tables.push(await dumpTable(env, name));

  const schemaRow = names.includes('_migrations')
    ? await env.DB.prepare(`SELECT id FROM _migrations ORDER BY id DESC LIMIT 1`).first<{ id: string }>()
    : null;
  const mediaKeys = names.includes('note_media')
    ? await env.DB.prepare(`SELECT DISTINCT r2_key FROM note_media ORDER BY r2_key`).all<{ r2_key: string }>()
    : { results: [] as Array<{ r2_key: string }> };

  const counts: Record<string, number> = {};
  for (const t of tables) counts[t.name] = t.count;

  const manifest: SnapshotManifest = {
    version: 1,
    created_at: now,
    created_at_iso: new Date(now).toISOString(),
    schema_version: schemaRow?.id ?? null,
    tables: counts,
    media_r2_keys: (mediaKeys.results ?? []).map((r) => r.r2_key),
    notes_for_restore: [
      'Vectorize NÃO está no snapshot: é regenerável a partir do D1 (tool reembed por nota + POST /setup/backfill-similar).',
      'api_keys guarda só hashes sha256 — os PATs em plaintext NÃO são recuperáveis, por design; recrie as chaves após o restore.',
      'Os blobs de mídia não são recopiados: vivem no mesmo bucket R2, nas keys listadas em media_r2_keys.',
      'Runbook completo de restore: docs/restore.md (restore NUNCA é endpoint do Worker).',
    ],
  };
  return { tables, manifest };
}

async function listDatePrefixes(bucket: R2Bucket): Promise<string[]> {
  const prefixes: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, delimiter: '/', cursor });
    prefixes.push(...(page.delimitedPrefixes ?? []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return prefixes;
}

// Retenção: mantém os `keep` snapshots mais recentes (prefixo YYYY-MM-DD ordena
// lexicográfico = cronológico) e apaga TODOS os objetos dos prefixos excedentes.
// Chamada SOMENTE após o sucesso do snapshot novo — snapshot falho não apaga nada.
async function pruneOldSnapshots(bucket: R2Bucket, keep: number): Promise<string[]> {
  const prefixes = (await listDatePrefixes(bucket)).sort().reverse(); // mais novo primeiro
  const stale = prefixes.slice(keep);
  for (const p of stale) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: p, cursor });
      const keys = page.objects.map((o) => o.key);
      if (keys.length) await bucket.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return stale;
}

// Snapshot completo: dump → grava JSONL por tabela no R2 → manifest por ÚLTIMO
// (a presença dele marca o snapshot como completo) → retenção. O resultado
// (ok/falha + contagens) SEMPRE vai pra meta.last_backup, pra UI de /app/config.
export async function runSnapshot(env: Env, now = Date.now()): Promise<SnapshotResult> {
  const started = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  const prefix = `${BACKUP_PREFIX}${date}/`;
  let result: SnapshotResult;
  try {
    const bucket = env.MEDIA;
    if (!bucket) throw new Error('R2 (binding MEDIA) não configurado — snapshot impossível');
    const { tables, manifest } = await buildSnapshot(env, now);
    const enc = new TextEncoder();
    let bytes = 0;
    for (const t of tables) {
      const body = enc.encode(t.jsonl);
      bytes += body.byteLength;
      await bucket.put(`${prefix}${t.name}.jsonl`, body, {
        httpMetadata: { contentType: 'application/jsonl; charset=utf-8' },
      });
    }
    const manifestBody = enc.encode(JSON.stringify(manifest, null, 2));
    bytes += manifestBody.byteLength;
    await bucket.put(`${prefix}manifest.json`, manifestBody, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });

    const deleted = await pruneOldSnapshots(bucket, RETENTION_SNAPSHOTS);

    const total = tables.reduce((s, t) => s + t.count, 0);
    result = {
      ok: true,
      at: now,
      date,
      prefix,
      tables: manifest.tables,
      total_rows: total,
      bytes,
      duration_ms: Date.now() - started,
      deleted_prefixes: deleted,
    };
  } catch (e) {
    result = {
      ok: false,
      at: now,
      date,
      prefix,
      tables: {},
      total_rows: 0,
      bytes: 0,
      duration_ms: Date.now() - started,
      deleted_prefixes: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
  // Melhor esforço: se a escrita do status falhar, o snapshot em si não é desfeito.
  try {
    await env.DB.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
      .bind(LAST_BACKUP_META_KEY, JSON.stringify(result))
      .run();
  } catch (e) {
    console.error('backup: falha ao gravar last_backup na meta', e);
  }
  return result;
}

export function parseLastBackup(value: string | null): SnapshotResult | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as SnapshotResult;
  } catch {
    return null;
  }
}

export async function readLastBackup(env: Env): Promise<SnapshotResult | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(LAST_BACKUP_META_KEY)
    .first<{ value: string }>();
  return parseLastBackup(row?.value ?? null);
}
