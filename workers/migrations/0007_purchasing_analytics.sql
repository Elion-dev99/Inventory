-- 発注・仕入先 (商品化の追加機能) と分析用の単価
-- 1) 新権限 purchases.read / purchases.write をカタログと既定マトリクスへ追加する。
--    src/lib/access.ts の PERMISSION_CATALOG / DEFAULT_ROLE_PERMISSIONS と一致させること。
--    既定: SYSTEM_ADMIN と INVENTORY_MANAGER は両方、INVENTORY_STAFF は read のみ。
-- 2) suppliers (仕入先マスタ。他のマスタと同様に論理削除を持つ)
-- 3) purchase_orders / purchase_order_lines (発注書と明細)
-- 4) products.unit_cost (分析レポートの在庫評価額に使う単価、円、NULL 可)

-- 1) purchases.read / purchases.write
INSERT OR IGNORE INTO permissions (key, label, description) VALUES
  ('purchases.read', '発注参照', '発注書・発注提案の参照'),
  ('purchases.write', '発注登録', '発注書の作成と入荷登録');

INSERT OR IGNORE INTO role_permissions (role_code, permission_key) VALUES
  ('SYSTEM_ADMIN', 'purchases.read'),
  ('SYSTEM_ADMIN', 'purchases.write'),
  ('INVENTORY_MANAGER', 'purchases.read'),
  ('INVENTORY_MANAGER', 'purchases.write'),
  ('INVENTORY_STAFF', 'purchases.read');

-- 2) 仕入先マスタ
CREATE TABLE suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  contact    TEXT,
  email      TEXT,
  phone      TEXT,
  note       TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- 3) 発注書と明細
CREATE TABLE purchase_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ordered', 'received', 'cancelled')),
  expected_date TEXT,
  note          TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_purchase_orders_supplier ON purchase_orders (supplier_id);

CREATE TABLE purchase_order_lines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id             INTEGER NOT NULL REFERENCES purchase_orders(id),
  product_id        INTEGER NOT NULL REFERENCES products(id),
  quantity          INTEGER NOT NULL,
  received_quantity INTEGER NOT NULL DEFAULT 0,
  unit_cost         INTEGER
);
CREATE INDEX idx_po_lines_po ON purchase_order_lines (po_id);

-- 4) 商品の単価 (在庫評価額の算出用)
ALTER TABLE products ADD COLUMN unit_cost INTEGER;
