-- 0018: プラン制 (組織とプラン)
--
-- 変更内容:
-- 1. organizations: 契約単位の組織。plan_key はコード側のプランカタログ
--    (workers/src/lib/plans.ts) を参照する文字列で、既定は 'free'。
--    プランの付与・変更は全体管理コンソールから運営者が行う (決済は持たない)。
-- 2. stores.organization_id: 店舗の所属組織。NULL の店舗は「レガシー扱い」
--    としてプラン制限を受けない (owner 相当)。全体管理 API から作成する
--    店舗は必ず組織に属する。
-- 3. 既存データ: 店舗 1 (DGOSK) のために組織「DGOSK」を plan_key='owner'
--    で作成し、店舗 1 を紐付ける。DGOSK はオーナーの自店舗として全機能を
--    無制限に使う特別扱い。再適用しても重複しないよう冪等に書く。

CREATE TABLE organizations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  plan_key   TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE stores ADD COLUMN organization_id INTEGER REFERENCES organizations(id);
CREATE INDEX idx_stores_organization ON stores (organization_id);

INSERT INTO organizations (name, plan_key, created_at, updated_at)
  SELECT 'DGOSK', 'owner', CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
   WHERE EXISTS (SELECT 1 FROM stores WHERE id = 1)
     AND NOT EXISTS (SELECT 1 FROM organizations WHERE name = 'DGOSK');

UPDATE stores
   SET organization_id = (SELECT id FROM organizations WHERE name = 'DGOSK' ORDER BY id ASC LIMIT 1)
 WHERE id = 1 AND organization_id IS NULL;
