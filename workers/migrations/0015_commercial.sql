-- 0015: 商用レベル第1弾 (引当・返品/廃棄・ピッキング・セット品・階層・発注テンプレート)
--
-- 変更内容:
-- 1. stock_movements: type に 'RETURN' (返品) と 'DISPOSAL' (廃棄) を追加し、
--    group_id (セット品展開・ピッキング確定など一括処理の束) と
--    reason_code (返品・廃棄の理由コード) を追加する。SQLite は CHECK 制約を
--    後から変更できないため、0008 と同じ rename -> recreate -> copy で作り替える。
-- 2. products.is_bundle: セット品フラグ (自前の在庫行を持たない)。
-- 3. locations.parent_id: 保管場所の階層 (倉庫 / ゾーン / 棚 / 段)。
-- 4. purchase_orders.source: 'manual' | 'template' | 'schedule'。
-- 5. reservations: 在庫の引当 (商品 + 任意の場所単位、ロット単位ではない)。
-- 6. pick_lists / pick_items: ピッキングリストとスキャン検品。
-- 7. product_bundles: セット品の構成品 (セットの中にセットは不可)。
-- 8. po_templates / po_schedules: 発注テンプレートと定期下書き生成。

-- ------------------------------------------------------------ stock_movements
ALTER TABLE stock_movements RENAME TO stock_movements_legacy;

CREATE TABLE stock_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id     TEXT NOT NULL,
  stock_id        INTEGER NOT NULL REFERENCES stocks(id),
  type            TEXT NOT NULL CHECK (type IN ('IN', 'OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUST', 'CANCEL', 'RETURN', 'DISPOSAL')),
  quantity_change INTEGER NOT NULL,
  quantity_before INTEGER NOT NULL,
  quantity_after  INTEGER NOT NULL,
  actor_id        INTEGER NOT NULL REFERENCES users(id),
  department      TEXT,
  purpose         TEXT,
  reason          TEXT,
  created_at      INTEGER NOT NULL,
  store_id        INTEGER NOT NULL DEFAULT 1 REFERENCES stores(id),
  group_id        TEXT,
  reason_code     TEXT CHECK (reason_code IS NULL OR reason_code IN ('damaged', 'expired', 'defective', 'other'))
);

INSERT INTO stock_movements (id, document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, department, purpose, reason, created_at, store_id)
  SELECT id, document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, department, purpose, reason, created_at, store_id
    FROM stock_movements_legacy;

DROP TABLE stock_movements_legacy;

CREATE INDEX idx_movements_stock_created ON stock_movements (stock_id, created_at);
CREATE INDEX idx_movements_document ON stock_movements (document_id);
CREATE INDEX idx_movements_group ON stock_movements (group_id);

-- ------------------------------------------------------------ セット品
ALTER TABLE products ADD COLUMN is_bundle INTEGER NOT NULL DEFAULT 0;

CREATE TABLE product_bundles (
  bundle_product_id    INTEGER NOT NULL REFERENCES products(id),
  component_product_id INTEGER NOT NULL REFERENCES products(id),
  quantity             INTEGER NOT NULL CHECK (quantity >= 1),
  PRIMARY KEY (bundle_product_id, component_product_id),
  CHECK (bundle_product_id <> component_product_id)
);

CREATE INDEX idx_product_bundles_component ON product_bundles (component_product_id);

-- ------------------------------------------------------------ ロケーション階層
ALTER TABLE locations ADD COLUMN parent_id INTEGER REFERENCES locations(id);

CREATE INDEX idx_locations_parent ON locations (parent_id);

-- ------------------------------------------------------------ 引当
CREATE TABLE reservations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL REFERENCES stores(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  location_id INTEGER REFERENCES locations(id),
  quantity    INTEGER NOT NULL CHECK (quantity >= 1),
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed')),
  expires_at  INTEGER,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_reservations_store_product ON reservations (store_id, product_id, status);
CREATE INDEX idx_reservations_store_status ON reservations (store_id, status);

-- ------------------------------------------------------------ ピッキング
CREATE TABLE pick_lists (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id       INTEGER NOT NULL REFERENCES stores(id),
  type           TEXT NOT NULL CHECK (type IN ('consume', 'transfer')),
  to_location_id INTEGER REFERENCES locations(id),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     INTEGER NOT NULL,
  completed_at   INTEGER
);

CREATE INDEX idx_pick_lists_store_status ON pick_lists (store_id, status);

CREATE TABLE pick_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id          INTEGER NOT NULL REFERENCES pick_lists(id),
  product_id       INTEGER NOT NULL REFERENCES products(id),
  from_location_id INTEGER NOT NULL REFERENCES locations(id),
  planned_qty      INTEGER NOT NULL CHECK (planned_qty >= 0),
  picked_qty       INTEGER NOT NULL DEFAULT 0 CHECK (picked_qty >= 0)
);

CREATE INDEX idx_pick_items_list ON pick_items (list_id);

-- ------------------------------------------------------------ 発注テンプレート / 定期発注
ALTER TABLE purchase_orders ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'template', 'schedule'));

CREATE TABLE po_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL REFERENCES stores(id),
  name        TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  lines       TEXT NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_po_templates_store ON po_templates (store_id);

CREATE TABLE po_schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL UNIQUE REFERENCES po_templates(id),
  interval_days INTEGER NOT NULL CHECK (interval_days >= 1),
  next_run_at INTEGER NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER
);

CREATE INDEX idx_po_schedules_next_run ON po_schedules (next_run_at, enabled);
