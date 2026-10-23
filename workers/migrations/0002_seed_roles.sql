-- ロール 5 種のシード (NestJS 版 prisma/seed.ts と同一)
INSERT OR IGNORE INTO roles (code, name) VALUES
  ('SYSTEM_ADMIN', 'システム管理者'),
  ('INVENTORY_MANAGER', '在庫管理者'),
  ('INVENTORY_STAFF', '在庫担当者'),
  ('VIEWER', '閲覧者'),
  ('AUDITOR', '監査者');
