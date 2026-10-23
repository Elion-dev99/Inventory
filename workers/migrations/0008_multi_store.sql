-- 複数店舗 (テナント) 対応 + システム全体管理
-- 店舗 = テナントとしてデータを完全分離する。既存データはすべて店舗 1
-- 「DGOSK」に移行する。全体管理者は user_roles.store_id が NULL の
-- SYSTEM_ADMIN 割当で表す (店舗割当は store_id = 店舗 ID)。
--
-- SQLite は UNIQUE 制約や主キーを後から変更できないため、対象テーブルは
-- 0005 と同じ手順 (旧表を rename で退避 -> 新表を作成 -> データをコピー ->
-- 子表も作り直してから旧表を drop) で再構築する。外部キーはテーブル名で
-- 参照されるため、親を rename すると子の参照は旧名へ書き換わる。子の
-- 再構築が済むまで旧表は落とさない。名前付きインデックスは旧表の drop で
-- 消えるため、新表側のインデックスは最後にまとめて作り直す。

-- ------------------------------------------------------------ stores
CREATE TABLE stores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 既存データの移行先 (本番の倉庫コード DGOSK をそのまま店舗にする)
INSERT INTO stores (id, code, name, status, created_at, updated_at)
  VALUES (1, 'DGOSK', 'DGOSK', 'active', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

-- ------------------------------------------------------------ warehouses (UNIQUE を店舗スコープ化)
ALTER TABLE warehouses RENAME TO warehouses_legacy;

CREATE TABLE warehouses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  store_id   INTEGER NOT NULL DEFAULT 1 REFERENCES stores(id),
  UNIQUE (store_id, code)
);

INSERT INTO warehouses (id, code, name, created_at, updated_at, deleted_at, store_id)
  SELECT id, code, name, created_at, updated_at, deleted_at, 1 FROM warehouses_legacy;

-- ------------------------------------------------------------ locations (新 warehouses を参照)
ALTER TABLE locations RENAME TO locations_legacy;

CREATE TABLE locations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER,
  UNIQUE (warehouse_id, code)
);

INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at, deleted_at)
  SELECT id, warehouse_id, code, name, created_at, updated_at, deleted_at FROM locations_legacy;

-- ------------------------------------------------------------ user_roles (store_id を追加)
-- 既存行は店舗 1 の割当に移行する。ただし SYSTEM_ADMIN かつ倉庫スコープなし
-- (warehouse_id IS NULL) の行は全体管理者として store_id = NULL にする。
ALTER TABLE user_roles RENAME TO user_roles_legacy;

CREATE TABLE user_roles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  role_code    TEXT NOT NULL REFERENCES roles(code),
  warehouse_id INTEGER REFERENCES warehouses(id),
  -- 店舗スコープ: NULL = 全体 (プラットフォーム) 割当。店舗割当は店舗 ID
  store_id     INTEGER REFERENCES stores(id),
  UNIQUE (user_id, role_code, warehouse_id)
);

INSERT INTO user_roles (id, user_id, role_code, warehouse_id, store_id)
  SELECT id, user_id, role_code, warehouse_id,
         CASE WHEN role_code = 'SYSTEM_ADMIN' AND warehouse_id IS NULL THEN NULL ELSE 1 END
    FROM user_roles_legacy;

DROP TABLE user_roles_legacy;

-- ------------------------------------------------------------ products (UNIQUE を店舗スコープ化)
ALTER TABLE products RENAME TO products_legacy;

CREATE TABLE products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sku               TEXT NOT NULL,
  name              TEXT NOT NULL,
  unit              TEXT NOT NULL,
  barcode           TEXT,
  safety_stock      INTEGER NOT NULL DEFAULT 0,
  requires_expiry   INTEGER NOT NULL DEFAULT 0,
  expiry_alert_days INTEGER,
  unit_cost         INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER,
  store_id          INTEGER NOT NULL DEFAULT 1 REFERENCES stores(id),
  UNIQUE (store_id, sku)
);

INSERT INTO products (id, sku, name, unit, barcode, safety_stock, requires_expiry, expiry_alert_days, unit_cost, created_at, updated_at, deleted_at, store_id)
  SELECT id, sku, name, unit, barcode, safety_stock, requires_expiry, expiry_alert_days, unit_cost, created_at, updated_at, deleted_at, 1
    FROM products_legacy;

-- ------------------------------------------------------------ lots (store_id を直接持つ)
ALTER TABLE lots RENAME TO lots_legacy;

CREATE TABLE lots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  lot_code    TEXT NOT NULL,
  expiry_date INTEGER,
  received_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  store_id    INTEGER NOT NULL DEFAULT 1 REFERENCES stores(id),
  UNIQUE (product_id, lot_code)
);

INSERT INTO lots (id, product_id, lot_code, expiry_date, received_at, created_at, updated_at, deleted_at, store_id)
  SELECT l.id, l.product_id, l.lot_code, l.expiry_date, l.received_at, l.created_at, l.updated_at, l.deleted_at, p.store_id
    FROM lots_legacy l JOIN products p ON p.id = l.product_id;

-- ------------------------------------------------------------ stocks (store_id を直接持つ)
ALTER TABLE stocks RENAME TO stocks_legacy;

CREATE TABLE stocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  lot_id      INTEGER NOT NULL REFERENCES lots(id),
  quantity    INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  store_id    INTEGER NOT NULL DEFAULT 1 REFERENCES stores(id),
  UNIQUE (location_id, lot_id)
);

INSERT INTO stocks (id, location_id, lot_id, quantity, version, created_at, updated_at, store_id)
  SELECT s.id, s.location_id, s.lot_id, s.quantity, s.version, s.created_at, s.updated_at, l.store_id
    FROM stocks_legacy s JOIN lots l ON l.id = s.lot_id;

-- ------------------------------------------------------------ stock_movements (store_id を直接持つ)
ALTER TABLE stock_movements RENAME TO stock_movements_legacy;

CREATE TABLE stock_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id     TEXT NOT NULL,
  stock_id        INTEGER NOT NULL REFERENCES stocks(id),
  type            TEXT NOT NULL CHECK (type IN ('IN', 'OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUST', 'CANCEL')),
  quantity_change INTEGER NOT NULL,
  quantity_before INTEGER NOT NULL,
  quantity_after  INTEGER NOT NULL,
  actor_id        INTEGER NOT NULL REFERENCES users(id),
  department      TEXT,
  purpose         TEXT,
  reason          TEXT,
  created_at      INTEGER NOT NULL,
  store_id        INTEGER NOT NULL DEFAULT 1 REFERENCES stores(id)
);

INSERT INTO stock_movements (id, document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, department, purpose, reason, created_at, store_id)
  SELECT m.id, m.document_id, m.stock_id, m.type, m.quantity_change, m.quantity_before, m.quantity_after, m.actor_id, m.department, m.purpose, m.reason, m.created_at, s.store_id
    FROM stock_movements_legacy m JOIN stocks s ON s.id = m.stock_id;

DROP TABLE stock_movements_legacy;

-- ------------------------------------------------------------ negative_stock_approvals (store_id を直接持つ)
ALTER TABLE negative_stock_approvals RENAME TO negative_stock_approvals_legacy;

CREATE TABLE negative_stock_approvals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id     INTEGER NOT NULL REFERENCES stocks(id),
  quantity     INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  approved_by  INTEGER REFERENCES users(id),
  decided_at   INTEGER,
  movement_id  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  store_id     INTEGER NOT NULL DEFAULT 1 REFERENCES stores(id),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

INSERT INTO negative_stock_approvals (id, stock_id, quantity, reason, status, requested_by, approved_by, decided_at, movement_id, created_at, updated_at, store_id)
  SELECT a.id, a.stock_id, a.quantity, a.reason, a.status, a.requested_by, a.approved_by, a.decided_at, a.movement_id, a.created_at, a.updated_at, s.store_id
    FROM negative_stock_approvals_legacy a JOIN stocks s ON s.id = a.stock_id;

DROP TABLE negative_stock_approvals_legacy;

-- ------------------------------------------------------------ stocktake_lines (新 stocks を参照)
ALTER TABLE stocktake_lines RENAME TO stocktake_lines_legacy;

CREATE TABLE stocktake_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  stocktake_id     INTEGER NOT NULL REFERENCES stocktakes(id),
  stock_id         INTEGER NOT NULL REFERENCES stocks(id),
  book_quantity    INTEGER NOT NULL,
  counted_quantity INTEGER,
  UNIQUE (stocktake_id, stock_id)
);

INSERT INTO stocktake_lines (id, stocktake_id, stock_id, book_quantity, counted_quantity)
  SELECT id, stocktake_id, stock_id, book_quantity, counted_quantity FROM stocktake_lines_legacy;

DROP TABLE stocktake_lines_legacy;

-- ------------------------------------------------------------ purchase_order_lines (新 products を参照)
ALTER TABLE purchase_order_lines RENAME TO purchase_order_lines_legacy;

CREATE TABLE purchase_order_lines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id             INTEGER NOT NULL REFERENCES purchase_orders(id),
  product_id        INTEGER NOT NULL REFERENCES products(id),
  quantity          INTEGER NOT NULL,
  received_quantity INTEGER NOT NULL DEFAULT 0,
  unit_cost         INTEGER
);

INSERT INTO purchase_order_lines (id, po_id, product_id, quantity, received_quantity, unit_cost)
  SELECT id, po_id, product_id, quantity, received_quantity, unit_cost FROM purchase_order_lines_legacy;

DROP TABLE purchase_order_lines_legacy;

-- ------------------------------------------------------------ 旧表の撤去とインデックス再作成
-- 子表の再構築が済んだので、参照されなくなった旧表を落とす
DROP TABLE stocks_legacy;
DROP TABLE lots_legacy;
DROP TABLE locations_legacy;
DROP TABLE products_legacy;
DROP TABLE warehouses_legacy;

CREATE INDEX idx_user_roles_warehouse ON user_roles (warehouse_id);
CREATE INDEX idx_user_roles_store ON user_roles (store_id);
CREATE INDEX idx_lots_expiry ON lots (expiry_date);
CREATE INDEX idx_stocks_lot ON stocks (lot_id);
CREATE INDEX idx_stocks_store ON stocks (store_id);
CREATE INDEX idx_movements_stock_created ON stock_movements (stock_id, created_at);
CREATE INDEX idx_movements_document ON stock_movements (document_id);
CREATE INDEX idx_movements_store ON stock_movements (store_id, created_at);
CREATE INDEX idx_negative_approvals_stock_status ON negative_stock_approvals (stock_id, status);
CREATE INDEX idx_po_lines_po ON purchase_order_lines (po_id);
CREATE INDEX idx_products_store ON products (store_id);

-- ------------------------------------------------------------ feature_flags (PK を店舗スコープ化)
ALTER TABLE feature_flags RENAME TO feature_flags_legacy;

CREATE TABLE feature_flags (
  store_id   INTEGER NOT NULL DEFAULT 1 REFERENCES stores(id),
  key        TEXT NOT NULL,
  enabled    INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store_id, key)
);

INSERT INTO feature_flags (store_id, key, enabled, updated_by, updated_at)
  SELECT 1, key, enabled, updated_by, updated_at FROM feature_flags_legacy;

DROP TABLE feature_flags_legacy;

-- ------------------------------------------------------------ 列追加のみで済むテーブル
-- ADD COLUMN では REFERENCES と非 NULL デフォルトを併用できないため、
-- これらの列は外部キー句なしで足す (参照整合性はアプリ層と stores の存在で担保)。
-- stocktakes: 実施中+承認待ちは「店舗ごと」に 1 件まで
ALTER TABLE stocktakes ADD COLUMN store_id INTEGER NOT NULL DEFAULT 1;
DROP INDEX idx_stocktakes_single_active;
CREATE UNIQUE INDEX idx_stocktakes_single_active ON stocktakes (store_id)
  WHERE status IN ('in_progress', 'pending_approval');

ALTER TABLE suppliers ADD COLUMN store_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE purchase_orders ADD COLUMN store_id INTEGER NOT NULL DEFAULT 1;
-- 監査ログ: 全体操作 (店舗に属さない操作) は NULL を許す
ALTER TABLE audit_logs ADD COLUMN store_id INTEGER;
-- セッション: 現在選択中の店舗。未選択は NULL
ALTER TABLE sessions ADD COLUMN store_id INTEGER;

-- ------------------------------------------------------------ idempotency_keys (UNIQUE を店舗スコープ化)
-- 冪等キーも店舗単位で引くため、UNIQUE (key, user_id) を
-- UNIQUE (key, user_id, store_id) に作り替える (参照する子表は無い)。
ALTER TABLE idempotency_keys RENAME TO idempotency_keys_legacy;

CREATE TABLE idempotency_keys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT NOT NULL,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  endpoint        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  response_status INTEGER,
  response_body   TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  store_id        INTEGER NOT NULL DEFAULT 1 REFERENCES stores(id),
  UNIQUE (key, user_id, store_id)
);

INSERT INTO idempotency_keys (id, key, user_id, endpoint, request_hash, response_status, response_body, created_at, expires_at, store_id)
  SELECT id, key, user_id, endpoint, request_hash, response_status, response_body, created_at, expires_at, 1
    FROM idempotency_keys_legacy;

DROP TABLE idempotency_keys_legacy;

-- ------------------------------------------------------------ 権限カタログ追加
-- platform.admin はカタログにだけ載せ、店舗ロールの権限解決には混ぜない
-- (全体 API のガードは「store_id NULL の SYSTEM_ADMIN 割当」で判定する)。
INSERT OR IGNORE INTO permissions (key, label, description) VALUES
  ('platform.admin', '全体管理', 'システム全体 (全店舗) の管理');
