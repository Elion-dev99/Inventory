-- メンテナンス細分化 (migration 0012):
-- - maintenance_windows に emergency (緊急区分 0/1)、reason (緊急の理由)、
--   extend_count (延長した回数) を追加する。
-- - maintenance_rejections: メンテナンスで 503 拒否した件数の集計カウンタ。
--   window × 機能グループ × 店舗で UPSERT 加算する (リクエスト単位の
--   ログ行は作らない)。store_id 0 は「店舗未確定で拒否した」分。

ALTER TABLE maintenance_windows ADD COLUMN emergency INTEGER NOT NULL DEFAULT 0;
ALTER TABLE maintenance_windows ADD COLUMN reason TEXT;
ALTER TABLE maintenance_windows ADD COLUMN extend_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS maintenance_rejections (
  window_id     INTEGER NOT NULL,
  feature_key   TEXT NOT NULL,
  store_id      INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (window_id, feature_key, store_id)
);
