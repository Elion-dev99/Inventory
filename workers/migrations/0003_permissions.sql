-- 権限 (permission) の DB 管理化
-- ロールは「権限の束」にすぎず、実効権限はこの role_permissions を正として
-- リクエストごとに解決する (src/lib/access.ts の PERMISSION_CATALOG /
-- DEFAULT_ROLE_PERMISSIONS と一致させること)。
-- seed は移行前の各エンドポイントの許可ロールを忠実に移行した既定マトリクス。
-- 読み取り系 (stocks.read / alerts.read / master.read) は移行前が
-- 「割当があれば可」だったため全ロールに付与する。SYSTEM_ADMIN は全権限。

CREATE TABLE permissions (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT
);

CREATE TABLE role_permissions (
  role_code      TEXT NOT NULL REFERENCES roles(code),
  permission_key TEXT NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role_code, permission_key)
);

INSERT OR IGNORE INTO permissions (key, label, description) VALUES
  ('stocks.read', '在庫参照', '在庫一覧・詳細の参照'),
  ('alerts.read', 'アラート参照', '期限・不足・マイナス在庫アラートの参照'),
  ('movements.inbound', '入庫', '入庫の登録'),
  ('movements.consume', '消費', '社内消費 (FEFO 出庫) の登録'),
  ('master.read', 'マスタ参照', '商品・倉庫・保管場所・ロットの一覧参照'),
  ('master.write', 'マスタ登録・編集', '商品・倉庫・保管場所・ロットの登録'),
  ('negative.request', 'マイナス在庫申請', 'マイナス在庫の例外申請の作成'),
  ('negative.decide', 'マイナス在庫承認', 'マイナス在庫申請の承認・却下'),
  ('stocktakes.manage', '棚卸し管理', '棚卸しの開始・終了'),
  ('admin.users', 'ユーザー管理', 'ユーザー一覧の参照とロール付与の変更'),
  ('admin.permissions', '権限管理', 'ロール×権限マトリクスの変更');

-- SYSTEM_ADMIN: 全権限
INSERT OR IGNORE INTO role_permissions (role_code, permission_key) VALUES
  ('SYSTEM_ADMIN', 'stocks.read'),
  ('SYSTEM_ADMIN', 'alerts.read'),
  ('SYSTEM_ADMIN', 'movements.inbound'),
  ('SYSTEM_ADMIN', 'movements.consume'),
  ('SYSTEM_ADMIN', 'master.read'),
  ('SYSTEM_ADMIN', 'master.write'),
  ('SYSTEM_ADMIN', 'negative.request'),
  ('SYSTEM_ADMIN', 'negative.decide'),
  ('SYSTEM_ADMIN', 'stocktakes.manage'),
  ('SYSTEM_ADMIN', 'admin.users'),
  ('SYSTEM_ADMIN', 'admin.permissions');

-- INVENTORY_MANAGER: 管理系以外すべて (移行前はマスタ登録・入出庫・申請・承認・棚卸しが可)
INSERT OR IGNORE INTO role_permissions (role_code, permission_key) VALUES
  ('INVENTORY_MANAGER', 'stocks.read'),
  ('INVENTORY_MANAGER', 'alerts.read'),
  ('INVENTORY_MANAGER', 'movements.inbound'),
  ('INVENTORY_MANAGER', 'movements.consume'),
  ('INVENTORY_MANAGER', 'master.read'),
  ('INVENTORY_MANAGER', 'master.write'),
  ('INVENTORY_MANAGER', 'negative.request'),
  ('INVENTORY_MANAGER', 'negative.decide'),
  ('INVENTORY_MANAGER', 'stocktakes.manage');

-- INVENTORY_STAFF: 入出庫と申請まで (移行前どおり)
INSERT OR IGNORE INTO role_permissions (role_code, permission_key) VALUES
  ('INVENTORY_STAFF', 'stocks.read'),
  ('INVENTORY_STAFF', 'alerts.read'),
  ('INVENTORY_STAFF', 'movements.inbound'),
  ('INVENTORY_STAFF', 'movements.consume'),
  ('INVENTORY_STAFF', 'master.read'),
  ('INVENTORY_STAFF', 'negative.request');

-- VIEWER / AUDITOR: 参照のみ (移行前どおり)
INSERT OR IGNORE INTO role_permissions (role_code, permission_key) VALUES
  ('VIEWER', 'stocks.read'),
  ('VIEWER', 'alerts.read'),
  ('VIEWER', 'master.read'),
  ('AUDITOR', 'stocks.read'),
  ('AUDITOR', 'alerts.read'),
  ('AUDITOR', 'master.read');
