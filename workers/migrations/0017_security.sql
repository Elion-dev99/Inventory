-- 0017: セキュリティ強化 (パスキー / セッション管理 / ログイン履歴 /
--       監査ハッシュチェーン / ステップアップ再認証)
--
-- 変更内容:
-- 1. passkey_credentials: WebAuthn (パスキー) の公開鍵クレデンシャル。
--    credential_id は authenticator が返す rawId の base64url。公開鍵は
--    COSE (EC2 P-256) を変換した JWK (JSON 文字列) で保持し、検証は
--    WebCrypto で行う。秘密鍵は authenticator 側にしか存在しない。
-- 2. webauthn_challenges: 登録・ログイン・ステップアップ用の使い捨て
--    チャレンジ。検証時に削除し、5 分で失効する。
-- 3. sessions への列追加: user_agent / ip (発行時の記録)、last_seen_at
--    (認証のたびに最大 1 時間に 1 回更新)、step_up_at (重要操作の
--    再認証。ログイン自体もステップアップとして発行時に打つ)。
-- 4. login_events: 全ログイン (Google / パスキー) の履歴。device_label は
--    UA から正規化したラベルで、初めて見るラベル + IP の組み合わせを
--    「新しい端末」として本人へプッシュ通知する。
-- 5. audit_logs への prev_hash / row_hash 追加: ハッシュチェーンによる
--    改ざん検知。既存行は NULL のまま (チェーン開始前として扱い、
--    検証では NULL 行を読み飛ばす)。

CREATE TABLE passkey_credentials (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key_jwk TEXT NOT NULL,
  sign_count    INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  label         TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX idx_passkey_credentials_user ON passkey_credentials (user_id);

CREATE TABLE webauthn_challenges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  challenge  TEXT NOT NULL,
  purpose    TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'step_up')),
  session_id INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_webauthn_challenges_challenge ON webauthn_challenges (challenge);
CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges (expires_at);

ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN step_up_at INTEGER;

CREATE TABLE login_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  method       TEXT NOT NULL CHECK (method IN ('google', 'passkey')),
  ip           TEXT,
  user_agent   TEXT,
  device_label TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_login_events_user ON login_events (user_id, created_at);

ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_logs ADD COLUMN row_hash TEXT;
