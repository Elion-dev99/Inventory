-- 0020: 設定の汎用化 (店舗設定・理由コード/部門/カテゴリのマスタ化)
-- 店舗ごとに違う前提 (通貨・タイムゾーン・運用マスタ) をコード固定から設定へ移す。

-- 0) stock_movements.reason_code の列挙 CHECK (0015 で付与) を外す。
--    理由コードを店舗マスタで管理するため、DB は任意のコードを受ける。
--    SQLite は CHECK を後から変更できないため rename -> recreate -> copy で
--    作り替える。movement_photos の FK が stock_movements を指すので、
--    0015 -> 0016 と同じ手順で movement_photos も作り替えて FK を向け直す。
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
  reason_code     TEXT
);

INSERT INTO stock_movements (id, document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, department, purpose, reason, created_at, store_id, group_id, reason_code)
  SELECT id, document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, department, purpose, reason, created_at, store_id, group_id, reason_code
    FROM stock_movements_legacy;

DROP TABLE stock_movements_legacy;

CREATE INDEX idx_movements_stock_created ON stock_movements (stock_id, created_at);
CREATE INDEX idx_movements_document ON stock_movements (document_id);
CREATE INDEX idx_movements_group ON stock_movements (group_id);
CREATE INDEX idx_movements_store_id ON stock_movements (store_id, id);

ALTER TABLE movement_photos RENAME TO movement_photos_legacy;

CREATE TABLE movement_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    INTEGER NOT NULL,
  movement_id INTEGER NOT NULL REFERENCES stock_movements(id),
  image_key   TEXT NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL
);

INSERT INTO movement_photos (id, store_id, movement_id, image_key, created_by, created_at)
  SELECT id, store_id, movement_id, image_key, created_by, created_at
    FROM movement_photos_legacy;

DROP TABLE movement_photos_legacy;

CREATE INDEX idx_movement_photos_movement ON movement_photos (movement_id);
CREATE INDEX idx_movement_photos_store ON movement_photos (store_id, movement_id);

-- 1) 店舗設定 (キー・バリュー。無いキーはコード側の既定値を使う)
CREATE TABLE store_settings (
  store_id   INTEGER NOT NULL REFERENCES stores(id),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store_id, key)
);

-- 2) 返品・廃棄の理由コード (店舗ごとに編集可能。履歴はコードのスナップショット)
CREATE TABLE movement_reason_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   INTEGER NOT NULL REFERENCES stores(id),
  kind       TEXT NOT NULL CHECK (kind IN ('return', 'disposal')),
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX idx_reason_codes_unique
  ON movement_reason_codes (store_id, kind, code) WHERE deleted_at IS NULL;

-- 既存店舗へ従来の固定 4 コードを初期値として投入する
INSERT INTO movement_reason_codes (store_id, kind, code, label, sort_order, is_active, created_at, updated_at)
SELECT s.id, k.kind, c.code, c.label, c.sort_order, 1,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM stores s
  JOIN (SELECT 'return' AS kind UNION ALL SELECT 'disposal') k
  JOIN (SELECT 'damaged' AS code, '破損' AS label, 1 AS sort_order
        UNION ALL SELECT 'expired', '期限切れ', 2
        UNION ALL SELECT 'defective', '不良', 3
        UNION ALL SELECT 'other', 'その他', 4) c;

-- 3) 部門マスタ (消費の部署。履歴は名称のスナップショットで残る)
CREATE TABLE departments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   INTEGER NOT NULL REFERENCES stores(id),
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX idx_departments_unique
  ON departments (store_id, name) WHERE deleted_at IS NULL;

-- 既存の消費履歴に出てくる部署名を取り込む (表記ゆれの解消はここから始める)
INSERT INTO departments (store_id, name, sort_order, is_active, created_at, updated_at)
SELECT store_id, department, 0, 1,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM (SELECT DISTINCT store_id, department FROM stock_movements
         WHERE department IS NOT NULL AND TRIM(department) <> '' AND type = 'OUT');

-- 4) 商品カテゴリ
CREATE TABLE product_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   INTEGER NOT NULL REFERENCES stores(id),
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX idx_categories_unique
  ON product_categories (store_id, name) WHERE deleted_at IS NULL;

ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES product_categories(id);
