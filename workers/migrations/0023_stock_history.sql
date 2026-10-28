-- 過去の棚卸しスナップショット (Excel 等から取り込んだ履歴)。
-- 予約連動の予測 (0022) とは別系統で、「過去の減り方」から通常/繁忙期/
-- 閑散期のペースと持ち日数を出すために使う。元データから再取り込みできる
-- ため、バックアップ/エクスポートの対象には含めない。
CREATE TABLE IF NOT EXISTS product_stock_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores (id),
  product_id INTEGER NOT NULL REFERENCES products (id),
  date TEXT NOT NULL,
  quantity REAL NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (store_id, product_id, date, source)
);
CREATE INDEX IF NOT EXISTS idx_product_stock_history_lookup
  ON product_stock_history (store_id, product_id, date);
