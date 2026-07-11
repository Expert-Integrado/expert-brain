-- Espelho de referência da migration runtime '0022_agent_mailbox' (src/db/migrate.ts).
-- Mailbox por agente (spec 80-frota-agentes/82): itens endereçados a UM usuário,
-- produzidos por menção @Nome em comentário ('mention'), atribuição de task
-- ('assignment') ou comentário em task atribuída ('comment_on_assigned').
-- Sem FK deliberado — produção best-effort nunca derruba a escrita principal.

CREATE TABLE IF NOT EXISTS mailbox_items (
  id TEXT PRIMARY KEY,            -- mbx_<newId()>
  user_id TEXT NOT NULL,          -- destinatário (users.id)
  kind TEXT NOT NULL,             -- 'mention' | 'assignment' | 'comment_on_assigned'
  task_id TEXT NOT NULL,
  comment_id TEXT,                -- NULL em 'assignment'
  actor_user_id TEXT,             -- quem causou; NULL = dono via web sem perfil
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_mailbox_unread ON mailbox_items(user_id, read_at, created_at);
