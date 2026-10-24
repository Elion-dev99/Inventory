-- メンテナンスウィンドウ (全体管理が登録するメンテナンス予定・実施枠)
-- 全体管理 Worker (inventory-admin-workers) が書き、店舗アプリが読む。
-- kind='once' は starts_at〜ends_at (UNIX ミリ秒、ends_at NULL は終了未定) の
-- 単発枠、kind='weekly' は JST の weekday (0=日..6=土) と start_minute /
-- end_minute (JST 0時からの分。end_minute は 1440 を超えて翌日跨ぎ可) の
-- 毎週繰り返し枠。level は 'read_only' (書き込み停止) / 'features' (機能別
-- 停止、features に JSON 配列で対象キー) / 'full' (全面停止)。
-- store_id NULL は全店舗対象。cancelled_at が入った枠は無効。
-- 従来の platform_settings 'maintenance' (即時オン/オフ) も互換として併用する。

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  starts_at    INTEGER,
  ends_at      INTEGER,
  weekday      INTEGER,
  start_minute INTEGER,
  end_minute   INTEGER,
  level        TEXT NOT NULL,
  features     TEXT,
  store_id     INTEGER,
  message      TEXT,
  created_by   INTEGER,
  created_at   INTEGER NOT NULL,
  cancelled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_maintenance_windows_store
  ON maintenance_windows (store_id);
