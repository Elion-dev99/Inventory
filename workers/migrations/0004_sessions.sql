-- セッション認証 (商品化ステップ2)
-- /auth/callback (Google OIDC 認可コードフロー) の成功時に発行する
-- ログインセッション。トークン本体は保存せず SHA-256 ハッシュのみを保持し、
-- 漏洩してもそのまま使えない形にする。有効期限は発行から 8 時間
-- (src/lib/session.ts の SESSION_TTL_MS と一致させること)。

CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
