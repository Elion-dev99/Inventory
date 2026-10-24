-- 0014: 実用機能トップ5 (ラベル印刷 / 商品画像・検品写真 / 部分棚卸し・盲検 /
--       単位換算・発注単位 / 発注点の高度化・分納・発注残管理)
--
-- 1) products: image_key (R2 のオブジェクトキー)、case_size (1ケースあたりの
--    基本単位数量 = 入数)、lead_time_days (商品個別のリードタイム日数)。
--    unit 列は 0001 で既に存在するため追加しない。
-- 2) suppliers: lead_time_days (仕入先の既定リードタイム日数)。
-- 3) purchase_orders: status の CHECK に 'closed' (残クローズ) を追加するため
--    テーブルを再構築する (0005 / 0008 と同じ手順)。expected_date は 0007 で
--    TEXT (YYYY-MM-DD) として既に存在するため、そのまま引き継ぐ。
--    あわせて purchase_order_lines に input_quantity / input_unit
--    (発注入力時の数量と単位 'base' | 'case') を追加する。
-- 4) stocktakes: scope_type ('full' | 'locations')、scope_json (対象 location_id
--    の JSON 配列)、blind (盲検 1/0)。
-- 5) movement_photos: 入出庫伝票 (stock_movements) に紐づく検品写真の台帳。
--    実体は R2 (バインディング IMAGES) に置き、ここにはキーだけを持つ。

-- 1) products
ALTER TABLE products ADD COLUMN image_key TEXT;
ALTER TABLE products ADD COLUMN case_size INTEGER;
ALTER TABLE products ADD COLUMN lead_time_days INTEGER;

-- 2) suppliers
ALTER TABLE suppliers ADD COLUMN lead_time_days INTEGER;

-- 3) purchase_orders の再構築 (status に 'closed' を追加)
ALTER TABLE purchase_orders RENAME TO purchase_orders_legacy;

CREATE TABLE purchase_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ordered', 'received', 'cancelled', 'closed')),
  expected_date TEXT,
  note          TEXT,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  store_id      INTEGER NOT NULL DEFAULT 1
);

INSERT INTO purchase_orders (id, supplier_id, status, expected_date, note, created_by, created_at, updated_at, store_id)
  SELECT id, supplier_id, status, expected_date, note, created_by, created_at, updated_at, store_id
    FROM purchase_orders_legacy;

-- 子表も新しい purchase_orders を参照するよう作り直す (入力単位の列もここで追加)
ALTER TABLE purchase_order_lines RENAME TO purchase_order_lines_legacy;

CREATE TABLE purchase_order_lines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id             INTEGER NOT NULL REFERENCES purchase_orders(id),
  product_id        INTEGER NOT NULL REFERENCES products(id),
  quantity          INTEGER NOT NULL,
  received_quantity INTEGER NOT NULL DEFAULT 0,
  unit_cost         INTEGER,
  input_quantity    INTEGER,
  input_unit        TEXT
);

INSERT INTO purchase_order_lines (id, po_id, product_id, quantity, received_quantity, unit_cost)
  SELECT id, po_id, product_id, quantity, received_quantity, unit_cost FROM purchase_order_lines_legacy;

DROP TABLE purchase_order_lines_legacy;
DROP TABLE purchase_orders_legacy;

CREATE INDEX idx_purchase_orders_supplier ON purchase_orders (supplier_id);
CREATE INDEX idx_po_lines_po ON purchase_order_lines (po_id);

-- 4) stocktakes: 部分棚卸しと盲検
ALTER TABLE stocktakes ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'full';
ALTER TABLE stocktakes ADD COLUMN scope_json TEXT;
ALTER TABLE stocktakes ADD COLUMN blind INTEGER NOT NULL DEFAULT 0;

-- 5) 検品写真の台帳
CREATE TABLE movement_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL,
  movement_id INTEGER NOT NULL REFERENCES stock_movements(id),
  image_key   TEXT NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_movement_photos_movement ON movement_photos (movement_id);
CREATE INDEX idx_movement_photos_store ON movement_photos (store_id, movement_id);
