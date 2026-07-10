// Conversão JSONL → INSERTs em lote (specs/50-console-v2/67-backup-export.md).
// Módulo PURO (zero dependência de Node) de propósito: é importado tanto pelo
// scripts/restore-from-snapshot.mjs (CLI de restore) quanto pelo teste de
// round-trip (test/backup.test.ts, que roda dentro do workerd) — uma única
// implementação da lógica de restore, validada em CI.

// Ordem de import que respeita as FKs do schema: kanban_columns E task_projects
// antes de notes (notes.column_id → kanban_columns.id; notes.project_id →
// task_projects.id — este segundo faltava e derrubava o restore real, drill da
// spec 69), e notes antes de tudo que referencia notes (tags/edges/similar_edges/
// note_media). users depois de api_keys (users.api_key_id) e task_assignees por
// último (FK pra notes E users — spec 37). Tabelas desconhecidas (migrations
// futuras) vão pro final, em ordem alfabética — se referenciarem notes, já
// estarão depois dela.
const TABLE_ORDER = ['_migrations', 'meta', 'api_keys', 'users', 'kanban_columns', 'task_projects', 'notes', 'tags', 'edges', 'similar_edges', 'note_media', 'task_assignees'];

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
  // Teto de BYTES por statement, além da contagem de linhas: o D1 (e o workerd
  // local) rejeita statement acima de 100KB (SQLITE_TOOBIG) — bem menor que o
  // ~1MB do SQLite puro. Um lote de 50 notas com corpos grandes estoura isso
  // mesmo sendo "só" 50 linhas. 80KB dá margem pro header + inflação multi-byte;
  // mínimo de 1 linha por statement (nota individual maior que o teto é rara e
  // passa sozinha). Descoberto no drill de restore off-site da spec 69 (10/07/2026).
  const maxStatementBytes = opts.maxStatementBytes ?? 80_000;
  const orReplace = opts.orReplace ?? false;
  const lines = String(jsonl).split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const rows = lines.map((l) => JSON.parse(l));
  // Self-FK de notes (origin_note_id → notes.id): uma task pode referenciar uma
  // nota que aparece DEPOIS dela no dump. Notas sem origem entram primeiro (a
  // origem é sempre uma nota comum, que tem origin_note_id nulo) — sort estável
  // preserva a ordem original dentro de cada grupo. Drill da spec 69 (10/07/2026).
  if (table === 'notes') rows.sort((a, b) => (a.origin_note_id ? 1 : 0) - (b.origin_note_id ? 1 : 0));
  const columns = Object.keys(rows[0]);
  const colList = columns.map((c) => `"${c}"`).join(', ');
  const verb = orReplace ? 'INSERT OR REPLACE' : 'INSERT';
  const header = `${verb} INTO "${table}" (${colList}) VALUES\n`;
  const stmts = [];
  let chunk = [];
  let bytes = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    stmts.push(`${header}${chunk.join(',\n')};`);
    chunk = [];
    bytes = 0;
  };
  for (const r of rows) {
    const v = `(${columns.map((c) => sqlQuote(r[c])).join(', ')})`;
    if (chunk.length > 0 && (chunk.length >= rowsPerStatement || bytes + v.length > maxStatementBytes)) flush();
    chunk.push(v);
    bytes += v.length + 2;
  }
  flush();
  return stmts;
}
