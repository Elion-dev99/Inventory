-- 全体管理の設定 (プラットフォーム設定)
-- 全体管理 Worker (inventory-admin-workers) が書き、店舗アプリが読む
-- システム全体の設定を key/value で持つ。現在は maintenance
-- (メンテナンスモード) のみ: value は JSON 文字列 {"on":bool,"message":string}。
-- 店舗アプリはこのテーブルが無い DB ではメンテナンス OFF として扱う
-- (後方互換)。updated_at は他のテーブルと違い TEXT (ISO 文字列) で持つ。

CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_by INTEGER,
  updated_at TEXT
);
