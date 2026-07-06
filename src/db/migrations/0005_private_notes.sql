-- 0005_private_notes.sql
-- Espelho das DDLs aplicadas pela migration `0013_private_notes` em src/db/migrate.ts.
-- (Os arquivos .sql seguem sua propria sequencia 0001..0005; a runtime usa o id 0013
--  porque ja existiam 0003..0012 no array de MIGRATIONS. As migrations sao aplicadas
--  em runtime pelo Worker via runMigrations() + endpoint /setup/provision, NAO por estes
--  arquivos. Eles existem como referencia/auditoria do schema, igual 0001_init.sql etc.)
--
-- SELO DE PRIVACIDADE (spec 30-features/31). ADD COLUMN e seguro: nao recria a tabela
-- notes (rebuild cascatearia edges/tags via foreign keys). DEFAULT 0 = TODAS as notas
-- existentes continuam PUBLICAS (zero mudanca de comportamento ate o dono marcar). O
-- indice e PARCIAL (WHERE private = 1): custo zero pras notas publicas, rapido pra
-- contar/localizar as privadas. O gate de visibilidade e 100% nos read paths do MCP
-- (recall/get_note/expand/stats/FTS filtram `private = 0` pra credencial sem escopo);
-- a nota privada continua no notes_fts (o trigger notes_au reinsere no UPDATE), igual
-- ao soft-delete. Tudo aditivo.

ALTER TABLE notes ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_notes_private ON notes(private) WHERE private = 1;
