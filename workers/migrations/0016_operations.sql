-- 0016: 商用レベル第2弾 (運営基盤)
--
-- 変更内容:
-- 1. backups / backup_chunks: 業務データ一式の JSON スナップショットを
--    D1 内に分割保存する。生成は店舗アプリの scheduled (15分 Cron) に
--    相乗りした自動作成 (24時間間隔) と、全体管理からの手動作成。
--    復元は全体管理のみ (復元前に pre-restore バックアップを自動作成する)。
--    sessions / push_subscriptions / write_guards / idempotency_keys は
--    スナップショットに含めない。users / user_roles はスナップショットには
--    含めるが、復元対象からは外す (ロックアウト防止)。
-- 2. 大規模データ向けの不足インデックス追加:
--    - stock_movements (store_id, id): 履歴一覧は store_id で絞って id 降順に
--      ページングするため、既存の (store_id, created_at) では並び替えが残る。
--    - stocks (store_id, id): 在庫一覧も同じく id 昇順ページング用。
-- 3. movement_photos の FK 修復: 0015 で stock_movements を rename -> recreate
--    した際、SQLite の RENAME が参照側の FK を追随させたため、
--    movement_photos.movement_id が削除済みの stock_movements_legacy を
--    指したままになっている (FK を解決する文が "no such table" になる)。
--    0015 と同じ手順で movement_photos を作り直し、FK を現行の
--    stock_movements に向け直す。行データはそのまま引き継ぐ。

CREATE TABLE backups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('auto', 'manual')),
  created_at  INTEGER NOT NULL,
  created_by  INTEGER,
  size_bytes  INTEGER NOT NULL,
  note        TEXT
);

CREATE INDEX idx_backups_kind_created ON backups (kind, created_at);

CREATE TABLE backup_chunks (
  backup_id INTEGER NOT NULL REFERENCES backups(id),
  seq       INTEGER NOT NULL,
  data      TEXT NOT NULL,
  PRIMARY KEY (backup_id, seq)
);

CREATE INDEX idx_movements_store_id ON stock_movements (store_id, id);
CREATE INDEX idx_stocks_store_id ON stocks (store_id, id);

-- ------------------------------------------------ movement_photos の FK 修復
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
