-- 予約連動の消費予測 (0022)
--
-- 備品の消費量が予約件数に連動する業態向けに、日ごとの予約件数を
-- 店舗ごとに記録する。予測 (lib/forecast.ts) は「記録のある日の消費合計 ÷
-- 記録のある日の予約合計」から 1 予約あたりの平均消費量を求め、
-- 今後の予約ペースを掛けて在庫が切れる時期を読む。
-- date は店舗タイムゾーンの暦日 ('YYYY-MM-DD')。

CREATE TABLE IF NOT EXISTS store_reservation_days (
  store_id   INTEGER NOT NULL REFERENCES stores(id),
  date       TEXT NOT NULL,
  count      INTEGER NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store_id, date)
);
