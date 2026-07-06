// Tipos do módulo puro de restore (scripts/lib/jsonl-to-sql.mjs) — permite que
// o teste de round-trip (test/backup.test.ts, TypeScript) importe a MESMA
// implementação usada pelo CLI scripts/restore-from-snapshot.mjs.
export declare function sortTablesForRestore(names: string[]): string[];
export declare function sqlQuote(v: unknown): string;
export declare function jsonlToInsertStatements(
  table: string,
  jsonl: string,
  opts?: { rowsPerStatement?: number; orReplace?: boolean }
): string[];
