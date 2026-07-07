# Espelho `.sql` — referência de leitura APENAS

Estes arquivos são **referência/auditoria de schema**, não um caminho de aplicação.

- O runtime aplica migrations via `runMigrations()` em `src/db/migrate.ts`, disparado por `POST /setup/provision` (e automaticamente ao final de `npm run deploy`).
- **Nunca** rode `wrangler d1 migrations apply` neste diretório: a numeração diverge da runtime (ex.: `0003_task_fields.sql` espelha a migration runtime `0006`) e o conjunto está incompleto. Aplicar por aqui quebra o schema e desalinha a tabela `_migrations`.
- Fonte de verdade do schema: array `MIGRATIONS` em `src/db/migrate.ts`.

O `migrations_dir` foi removido do `wrangler.toml` de propósito (spec `10-backend/13`), justamente pra que o wrangler não enxergue estes arquivos.
