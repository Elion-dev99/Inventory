-- 機能フラグ (管理者が機能単位でオン/オフできる仕組み)
-- 実効値は「行があれば enabled、無ければカタログの既定値」で解決する
-- (src/lib/features.ts の FEATURE_CATALOG が正)。行は管理画面 / 管理 API から
-- 切り替えた時点で作られる。変更履歴は audit_logs (feature_flag.update) に残す。

CREATE TABLE feature_flags (
  key        TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL
);
