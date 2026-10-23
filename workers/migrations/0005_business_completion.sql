-- 業務機能の完成 (商品化ステップ3)
-- 1) 新権限 movements.transfer (在庫移動) をカタログと既定マトリクスへ追加する。
--    既定は入庫・消費と同格 (SYSTEM_ADMIN / INVENTORY_MANAGER / INVENTORY_STAFF)。
--    src/lib/access.ts の PERMISSION_CATALOG / DEFAULT_ROLE_PERMISSIONS と一致させること。
-- 2) stocktakes.status に 'pending_approval' (差異承認待ち) を許可する。
--    SQLite は CHECK 制約を変更できないためテーブルを作り直す。再構築は
--    「旧表を rename で退避 -> 新表を作成 -> データをコピー -> 子表も同じ手順で
--    作り直してから旧表を drop」の順で行い、外部キー参照 (stocktake_lines が
--    stocktakes を名前で参照) が宙に浮かないようにする。あわせて差異承認の
--    記録列 decided_by / decided_at を足し、実施中と承認待ちを合わせて 1 件
--    だけに制限する部分ユニークインデックス (定数式) に置き換える。
--    stocktake_lines.counted_quantity は 0001 で既に存在するため列追加は不要。
-- 3) lots に論理削除用の deleted_at を追加する (他のマスタと揃える)。

-- 1) movements.transfer
INSERT OR IGNORE INTO permissions (key, label, description) VALUES
  ('movements.transfer', '在庫移動', '保管場所間の在庫移動の登録');

INSERT OR IGNORE INTO role_permissions (role_code, permission_key) VALUES
  ('SYSTEM_ADMIN', 'movements.transfer'),
  ('INVENTORY_MANAGER', 'movements.transfer'),
  ('INVENTORY_STAFF', 'movements.transfer');

-- 2) stocktakes の再構築 (status に pending_approval を追加)
ALTER TABLE stocktakes RENAME TO stocktakes_legacy;

CREATE TABLE stocktakes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  status       TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'pending_approval', 'confirmed', 'cancelled')),
  started_by   INTEGER NOT NULL REFERENCES users(id),
  started_at   INTEGER NOT NULL,
  confirmed_at INTEGER,
  decided_by   INTEGER REFERENCES users(id),
  decided_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

INSERT INTO stocktakes (id, status, started_by, started_at, confirmed_at, created_at, updated_at)
  SELECT id, status, started_by, started_at, confirmed_at, created_at, updated_at
    FROM stocktakes_legacy;

-- 子表も新 stocktakes を参照するよう作り直してから旧表を落とす
CREATE TABLE stocktake_lines_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  stocktake_id     INTEGER NOT NULL REFERENCES stocktakes(id),
  stock_id         INTEGER NOT NULL REFERENCES stocks(id),
  book_quantity    INTEGER NOT NULL,
  counted_quantity INTEGER,
  UNIQUE (stocktake_id, stock_id)
);

INSERT INTO stocktake_lines_new (id, stocktake_id, stock_id, book_quantity, counted_quantity)
  SELECT id, stocktake_id, stock_id, book_quantity, counted_quantity FROM stocktake_lines;

DROP TABLE stocktake_lines;
DROP TABLE stocktakes_legacy;
ALTER TABLE stocktake_lines_new RENAME TO stocktake_lines;

-- 実施中・承認待ちは合わせて 1 件のみ (定数式への部分ユニークインデックス)
CREATE UNIQUE INDEX idx_stocktakes_single_active ON stocktakes ((1))
  WHERE status IN ('in_progress', 'pending_approval');

-- 3) lots の論理削除
ALTER TABLE lots ADD COLUMN deleted_at INTEGER;
