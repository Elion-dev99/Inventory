-- 在庫管理システム — D1 (SQLite) 初期スキーマ
-- 正本は NestJS 版 prisma/schema.prisma。これを SQLite へ移植したもの。
-- 型の読み替え: BigInt -> INTEGER、timestamptz -> INTEGER (Unix ミリ秒)、
-- 真偽 -> INTEGER (0/1)、JSON -> TEXT、@db.Date -> INTEGER (UTC 0時のミリ秒)。
-- outbox_events は作らない: リアルタイム配信は Durable Object の WebSocket
-- ブロードキャストが担い、Outbox 相当の再送保証は Phase 2 送り (README 参照)。

CREATE TABLE roles (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE warehouses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

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

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id   TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE user_roles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  role_code    TEXT NOT NULL REFERENCES roles(code),
  -- 倉庫スコープ: NULL = 全倉庫 (Prisma 版と同じく割当と一体で持つ)
  warehouse_id INTEGER REFERENCES warehouses(id),
  -- NOTE: SQLite の UNIQUE も NULL を区別するため、NULL スコープの重複防止はアプリ層でも検証する
  UNIQUE (user_id, role_code, warehouse_id)
);
CREATE INDEX idx_user_roles_warehouse ON user_roles (warehouse_id);

CREATE TABLE products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sku               TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  unit              TEXT NOT NULL,
  barcode           TEXT,
  safety_stock      INTEGER NOT NULL DEFAULT 0,
  requires_expiry   INTEGER NOT NULL DEFAULT 0,
  expiry_alert_days INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER
);

CREATE TABLE lots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  lot_code    TEXT NOT NULL,
  -- 期限管理対象は NOT NULL (アプリ層で担保)。UTC 0時のミリ秒で保持する
  expiry_date INTEGER,
  -- FEFO 同期限時のタイブレーカー
  received_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (product_id, lot_code)
);
CREATE INDEX idx_lots_expiry ON lots (expiry_date);

CREATE TABLE stocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  lot_id      INTEGER NOT NULL REFERENCES lots(id),
  -- マイナス在庫は承認フロー経由の例外操作でのみ発生しうるため CHECK (quantity >= 0) は付けない。
  -- 通常更新は Coordinator の条件付き UPDATE (quantity >= 必要数) で防ぐ。
  quantity    INTEGER NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  -- 在庫の一意キー: SKU x 保管場所 x ロット
  UNIQUE (location_id, lot_id)
);
CREATE INDEX idx_stocks_lot ON stocks (lot_id);

-- 追記専用 (updated_at を持たない)。訂正は取消/調整伝票で行う。
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
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_movements_stock_created ON stock_movements (stock_id, created_at);
CREATE INDEX idx_movements_document ON stock_movements (document_id);

CREATE TABLE stocktakes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  status       TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'confirmed', 'cancelled')),
  started_by   INTEGER NOT NULL REFERENCES users(id),
  started_at   INTEGER NOT NULL,
  confirmed_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
-- 同時 in_progress は 1 件のみ (部分ユニークインデックス)
CREATE UNIQUE INDEX idx_stocktakes_single_in_progress ON stocktakes (status) WHERE status = 'in_progress';

CREATE TABLE stocktake_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  stocktake_id     INTEGER NOT NULL REFERENCES stocktakes(id),
  stock_id         INTEGER NOT NULL REFERENCES stocks(id),
  book_quantity    INTEGER NOT NULL,
  counted_quantity INTEGER,
  UNIQUE (stocktake_id, stock_id)
);

CREATE TABLE negative_stock_approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_id    INTEGER NOT NULL REFERENCES stocks(id),
  -- マイナスを許容する数量
  quantity    INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  decided_at  INTEGER,
  -- 確定時に発行された伝票 (stock_movements) への参照。Prisma 版と同様 FK は張らない
  movement_id INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  -- 自己承認禁止を DB でも担保する
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE INDEX idx_negative_approvals_stock_status ON negative_stock_approvals (stock_id, status);

CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  payload     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_audit_target ON audit_logs (target_type, target_id);
CREATE INDEX idx_audit_created ON audit_logs (created_at);

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
  UNIQUE (key, user_id)
);

-- Coordinator 内部用: batch() 内の条件付き UPDATE が本当に適用されたことを
-- 原子的に検証するためのガード行。条件不一致時は ok に NULL を入れて
-- NOT NULL 制約違反を起こし、batch 全体をロールバックさせる。
-- 成功時は同一 batch の末尾で削除されるため、通常は空。
CREATE TABLE write_guards (
  guard_key  TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
