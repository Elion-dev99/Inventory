-- 0013: お知らせ (announcements) + Web プッシュ通知
--
-- - announcements: 店舗別または全店舗 (store_id NULL) 宛のお知らせ。
--   掲載期間は starts_at <= now かつ (ends_at IS NULL または ends_at > now)。
--   priority は 'normal' | 'important'。push=1 のものは掲載開始時に Web Push を送り、
--   push_sent_at に送信済みを記録する (作成時フック + Cron の scheduled ハンドラ)。
-- - announcement_reads: ユーザーごとの既読。未読数は reads が無い件数で数える。
-- - push_subscriptions: Web Push の購読 (PushSubscription 相当)。endpoint が一意。
-- - 権限 announcements.write (お知らせ投稿) をカタログと既定ロールへ追加する。

CREATE TABLE announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NULL, -- NULL = 全店舗宛
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'important')),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NULL, -- NULL = 無期限
  push INTEGER NOT NULL DEFAULT 0,
  push_sent_at INTEGER NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_announcements_store_period ON announcements (store_id, starts_at, ends_at);
CREATE INDEX idx_announcements_pending_push ON announcements (push, push_sent_at, starts_at);

CREATE TABLE announcement_reads (
  announcement_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);

CREATE INDEX idx_announcement_reads_user ON announcement_reads (user_id);

CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);

-- 権限カタログへの追加 (0003 と同形式)。既定付与はシステム管理者と在庫管理者。
INSERT OR IGNORE INTO permissions (key, label, description) VALUES
  ('announcements.write', 'お知らせ投稿', 'お知らせの投稿・編集・削除');

INSERT OR IGNORE INTO role_permissions (role_code, permission_key) VALUES
  ('SYSTEM_ADMIN', 'announcements.write'),
  ('INVENTORY_MANAGER', 'announcements.write');
