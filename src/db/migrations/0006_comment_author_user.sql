-- 0006_comment_author_user.sql
-- Espelho da DDL aplicada pela migration `0020_comment_author_user` em src/db/migrate.ts.
-- (Os arquivos .sql seguem sua propria sequencia; a runtime usa o id 0020 porque ja
--  existiam 0003..0019 no array de MIGRATIONS. As migrations sao aplicadas em runtime
--  pelo Worker via runMigrations() + endpoint /setup/provision, NAO por estes arquivos.
--  Eles existem como referencia/auditoria do schema, igual 0001_init.sql etc.)
--
-- ASSINATURA DE COMENTARIO (spec 80-frota-agentes/81). Autoria do comentario de agente
-- derivada da credencial no servidor (PAT -> users via resolveMe), nunca autodeclarada.
-- NULL em todos os comentarios legados (sem backfill). Tudo aditivo.

ALTER TABLE task_comments ADD COLUMN author_user_id TEXT;
