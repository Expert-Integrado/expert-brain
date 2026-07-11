-- 0007_api_key_user.sql
-- Espelho das DDLs aplicadas pela migration `0021_api_key_user` em src/db/migrate.ts.
-- (Os arquivos .sql seguem sua propria sequencia; a runtime usa o id 0021 porque ja
--  existiam 0003..0020 no array de MIGRATIONS. As migrations sao aplicadas em runtime
--  pelo Worker via runMigrations() + endpoint /setup/provision, NAO por estes arquivos.)
--
-- CHAVE PERTENCE AO USUARIO, 1:N (spec 80-frota-agentes/86). api_keys.user_id vira a
-- fonte da verdade do vinculo credencial->usuario (N chaves por usuario); o backfill
-- preserva os vinculos legados de users.api_key_id (mantida como fallback de leitura).
-- task_comments.author_key_id = forense por chave da assinatura (spec 81). Tudo aditivo.

ALTER TABLE api_keys ADD COLUMN user_id TEXT;
UPDATE api_keys SET user_id = (SELECT u.id FROM users u WHERE u.api_key_id = api_keys.id) WHERE user_id IS NULL;
ALTER TABLE task_comments ADD COLUMN author_key_id TEXT;
