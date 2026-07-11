-- Espelho de referência da migration runtime '0026_push_subscriptions' (src/db/migrate.ts).
-- Spec 50-console-v2/68 (notificações nível 2): assinaturas Web Push dos dispositivos
-- do dono. Envio SEM payload (dispensa RFC 8291); endpoint 404/410 é removido no envio.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT,
  auth       TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
);
