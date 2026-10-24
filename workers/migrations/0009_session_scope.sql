-- セッションのスコープ分離 (全体管理の別 Worker 化)
-- 全体管理 (プラットフォーム管理) を店舗アプリから別 Worker
-- (inventory-admin-workers) に分離するにあたり、sessions にスコープを持たせる。
--   scope = 'app'      : 店舗アプリ用セッション (従来どおり。既定値)
--   scope = 'platform' : 全体管理 Worker 用セッション (Cookie 名も別)
-- 店舗アプリは platform スコープのセッションを受け付けず、全体管理 Worker は
-- app スコープのセッションを受け付けない (防御の多層化)。
-- 既存セッションはすべて 'app' として扱われる。

ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'app';
CREATE INDEX idx_sessions_scope ON sessions (scope);
