-- 0003_task_fields.sql
-- Espelho das DDLs aplicadas pela migration `0006_task_fields` em src/db/migrate.ts.
-- (Os arquivos .sql seguem sua propria sequencia 0001/0002/0003; a runtime usa o id
--  0006 porque ja existiam 0003_api_keys, 0004_soft_delete e 0005_similar_edges no
--  array de MIGRATIONS. As migrations sao aplicadas em runtime pelo Worker via
--  runMigrations() + endpoint /setup/provision, NAO por estes arquivos. Eles existem
--  como referencia/auditoria do schema, igual 0001_init.sql e 0002_api_keys.sql.)
--
-- TASK FIELDS — migracao ClickUp -> Brain native tasks. Uma task e uma nota com
-- kind='task' + 4 colunas nullable. ADD COLUMN e seguro: nao recria a tabela notes
-- (rebuild cascatearia edges/tags via foreign keys). As colunas ficam NULL pra TODAS
-- as ~1094 notas de conhecimento existentes — NULL nao viola CHECK no SQLite, entao a
-- migracao nao toca nenhuma linha antiga. Indices PARCIAIS (WHERE kind='task') nao
-- indexam as notas de conhecimento. due_at/completed_at em unix ms (Date.now()).

ALTER TABLE notes ADD COLUMN status TEXT CHECK (status IS NULL OR status IN ('open','in_progress','done','canceled'));
ALTER TABLE notes ADD COLUMN due_at INTEGER;
ALTER TABLE notes ADD COLUMN priority INTEGER CHECK (priority IS NULL OR (priority BETWEEN 1 AND 4));
ALTER TABLE notes ADD COLUMN completed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_notes_task_open ON notes (status, due_at) WHERE kind = 'task' AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_notes_task_due ON notes (due_at) WHERE kind = 'task' AND status IN ('open','in_progress');
