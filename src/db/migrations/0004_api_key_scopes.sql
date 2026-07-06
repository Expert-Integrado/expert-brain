-- 0004_api_key_scopes.sql
-- Espelho das DDLs aplicadas pela migration `0012_api_key_scopes` em src/db/migrate.ts.
-- (Os arquivos .sql seguem sua propria sequencia 0001/0002/0003/0004; a runtime usa o id
--  0012 porque ja existiam 0003..0011 no array de MIGRATIONS. As migrations sao aplicadas
--  em runtime pelo Worker via runMigrations() + endpoint /setup/provision, NAO por estes
--  arquivos. Eles existem como referencia/auditoria do schema, igual 0001_init.sql etc.)
--
-- ESCOPO DE PAT + AUTORIA DE ESCRITA (spec 10-backend/17). ADD COLUMN e seguro: nao
-- recria as tabelas api_keys/notes (rebuild cascatearia edges/tags via foreign keys).
-- scopes DEFAULT 'full' preserva o comportamento de TODAS as chaves existentes ('full'
-- = CRUD completo; 'read' = somente leitura). created_by/updated_by guardam o id da api
-- key (api_keys.id) ou 'oauth:<email>' pra sessoes OAuth — nullable, notas antigas ficam
-- NULL. Fundacao de auditoria (so grava, sem UI aqui). Tudo aditivo.

ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT 'full';
ALTER TABLE notes ADD COLUMN created_by TEXT;
ALTER TABLE notes ADD COLUMN updated_by TEXT;
