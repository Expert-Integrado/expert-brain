// Conversão JSONL → INSERTs em lote (specs/50-console-v2/67-backup-export.md).
// Módulo PURO (zero dependência de Node) de propósito: é importado tanto pelo
// scripts/restore-from-snapshot.mjs (CLI de restore) quanto pelo teste de
// round-trip (test/backup.test.ts, que roda dentro do workerd) — uma única
// implementação da lógica de restore, validada em CI.

// Ordem de import que respeita as FKs do schema: kanban_columns antes de notes
// (notes.column_id referencia kanban_columns.id), e notes antes de tudo que
// referencia notes (tags/edges/similar_edges/note_media). users depois de
// api_keys (users.api_key_id) e task_assignees por último (FK pra notes E users
// — spec 37). Tabelas desconhecidas (migrations futuras) vão pro final, em
// ordem alfabética — se referenciarem notes, já estarão depois dela.
const TABLE_ORDER = ['_migrations', 'meta', 'api_keys', 'users', 'kanban_columns', 'notes', 'tags', 'edges', 'similar_edges', 'note_media', 'task_assignees'];

export function sortTablesForRestore(names) {
  return [...names].sort((a, b) => {
    const ia = TABLE_ORDER.indexOf(a);
    const ib = TABLE_ORDER.indexOf(b);
    const ra = ia === -1 ? TABLE_ORDER.length : ia;
    const rb = ib === -1 ? TABLE_ORDER.length : ib;
    return ra - rb || a.localeCompare(b);
  });
}

// Literal SQL seguro pra um valor vindo do JSONL (dump D1 só produz
// string/número/null — BLOB não existe no schema).
export function sqlQuote(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

// Converte o JSONL de uma tabela em statements INSERT multi-linha (lotes de
// `rowsPerStatement`). INSERT simples por padrão: o restore é sempre num banco
// VAZIO (runbook) — duplicata deve FALHAR alto, não ser mascarada. `orReplace`
// existe pra re-execuções deliberadas (REPLACE em `notes` pode deixar entrada
// órfã no FTS externo — só usar sabendo disso; ver docs/restore.md).
export function jsonlToInsertStatements(table, jsonl, opts = {}) {
  const rowsPerStatement = opts.rowsPerStatement ?? 50;
  const orReplace = opts.orReplace ?? false;
  const lines = String(jsonl).split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const rows = lines.map((l) => JSON.parse(l));
  const columns = Object.keys(rows[0]);
  const colList = columns.map((c) => `"${c}"`).join(', ');
  const verb = orReplace ? 'INSERT OR REPLACE' : 'INSERT';
  const stmts = [];
  for (let i = 0; i < rows.length; i += rowsPerStatement) {
    const chunk = rows.slice(i, i + rowsPerStatement);
    const values = chunk
      .map((r) => `(${columns.map((c) => sqlQuote(r[c])).join(', ')})`)
      .join(',\n');
    stmts.push(`${verb} INTO "${table}" (${colList}) VALUES\n${values};`);
  }
  return stmts;
}
