-- 招待リンク・参加リクエスト (保留エリア) とユーザー名のカスタム設定 (0021)
--
-- 店舗への追加導線を「招待リンク/QR → 参加リクエスト (保留) → 管理者が
-- ロールを付与」に変えるための2テーブルと、ユーザーが自分で表示名を
-- 設定できるようにするためのフラグ列。
-- - store_invites: 店舗ごとの招待トークン。有効期限つき・取消し可能で、
--   複数人が同じリンクから参加リクエストできる (accepted_count で受付数を保持)。
-- - store_pending_members: 招待を受けたユーザーの保留レコード。
--   権限付与 = user_roles への割当追加と保留の削除を同時に行う。
-- - users.display_name_custom: 1 のユーザーは Google ログイン時の同期で
--   表示名を上書きしない (自分で設定したユーザー名を保持する)。

CREATE TABLE IF NOT EXISTS store_invites (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  token          TEXT NOT NULL UNIQUE,
  memo           TEXT,
  created_by     INTEGER NOT NULL REFERENCES users(id),
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_invites_store
  ON store_invites (store_id, created_at);

CREATE TABLE IF NOT EXISTS store_pending_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   INTEGER NOT NULL REFERENCES stores(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  invite_id  INTEGER REFERENCES store_invites(id),
  created_at INTEGER NOT NULL,
  UNIQUE (store_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_pending_members_store
  ON store_pending_members (store_id, created_at);

ALTER TABLE users ADD COLUMN display_name_custom INTEGER NOT NULL DEFAULT 0;
