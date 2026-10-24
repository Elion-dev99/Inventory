import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import initSql from '../../workers/migrations/0001_init.sql?raw';
import seedSql from '../../workers/migrations/0002_seed_roles.sql?raw';
import permissionsSql from '../../workers/migrations/0003_permissions.sql?raw';
import sessionsSql from '../../workers/migrations/0004_sessions.sql?raw';
import businessSql from '../../workers/migrations/0005_business_completion.sql?raw';
import featuresSql from '../../workers/migrations/0006_feature_flags.sql?raw';
import purchasingSql from '../../workers/migrations/0007_purchasing_analytics.sql?raw';
import multiStoreSql from '../../workers/migrations/0008_multi_store.sql?raw';
import sessionScopeSql from '../../workers/migrations/0009_session_scope.sql?raw';
import platformSettingsSql from '../../workers/migrations/0010_platform_settings.sql?raw';
import maintenanceWindowsSql from '../../workers/migrations/0011_maintenance_windows.sql?raw';
import maintenanceExtrasSql from '../../workers/migrations/0012_maintenance_extras.sql?raw';
import announcementsSql from '../../workers/migrations/0013_announcements.sql?raw';
import practicalSql from '../../workers/migrations/0014_practical.sql?raw';
import commercialSql from '../../workers/migrations/0015_commercial.sql?raw';
import operationsSql from '../../workers/migrations/0016_operations.sql?raw';
import { createSession } from '../../workers/src/lib/session';
import {
  createBackup,
  maybeAutoBackup,
  restoreBackup,
} from '../../workers/src/lib/backup';

/**
 * 商用レベル第2弾 (運営基盤) の全体管理側の結合テスト (migration 0016):
 * - バックアップ作成 → ダウンロード → 変更 → 復元で業務データが戻る
 * - 復元してもユーザー・割当・セッションは保持される (ロックアウト防止)
 * - 復元前に pre-restore バックアップが自動作成される
 * - 保持件数 (auto 7 件 / manual 3 件) を超えた分は chunks ごと削除される
 * - 自動バックアップ (Cron 相乗り) は 24 時間に 1 回だけ作る
 * - 利用量 (店舗別件数・DB 行数・セッション数・バックアップ容量) の集計
 * - 認証ガード: 未認証 401 / 全体管理者でないユーザーは 403
 *
 * ユーザー: 1 = 全体管理者 (SYSTEM_ADMIN・store_id NULL)、2 = 店舗1のスタッフ。
 */

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let adminCookie = '';
let staffCookie = '';
let appScopeCookie = '';

interface ApiResult {
  status: number;
  headers: Headers;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function api(
  path: string,
  opts: { cookie?: string; method?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `admin_session=${opts.cookie}`;
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  return { status: res.status, headers: res.headers, text, body: parsed };
}

function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function productName(id: number): Promise<string | null> {
  const row = await testEnv.DB.prepare('SELECT name FROM products WHERE id = ?1')
    .bind(id)
    .first<{ name: string }>();
  return row?.name ?? null;
}

beforeAll(async () => {
  for (const stmt of [
    ...statementsOf(initSql),
    ...statementsOf(seedSql),
    ...statementsOf(permissionsSql),
    ...statementsOf(sessionsSql),
    ...statementsOf(businessSql),
    ...statementsOf(featuresSql),
    ...statementsOf(purchasingSql),
    ...statementsOf(multiStoreSql),
    ...statementsOf(sessionScopeSql),
    ...statementsOf(platformSettingsSql),
    ...statementsOf(maintenanceWindowsSql),
    ...statementsOf(maintenanceExtrasSql),
    ...statementsOf(announcementsSql),
    ...statementsOf(practicalSql),
    ...statementsOf(commercialSql),
    ...statementsOf(operationsSql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-admin', 'admin@example.com', 'Admin', 'active', ?1, ?1),
              (2, 'sub-staff', 'staff@example.com', 'Staff', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, NULL), (2, 'INVENTORY_STAFF', NULL, 1)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
       VALUES (1, 'WH1', '本社倉庫', 1, ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
       VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, store_id, sku, name, unit, safety_stock, requires_expiry, created_at, updated_at)
       VALUES (1, 1, 'SKU-BK', '復元検証品', '個', 0, 0, ?1, ?1)`,
    ).bind(now),
  ]);
  adminCookie = await createSession(testEnv.DB, 1, { scope: 'platform' });
  staffCookie = await createSession(testEnv.DB, 2, { scope: 'platform' });
  appScopeCookie = await createSession(testEnv.DB, 1, { scope: 'app' });
});

describe('認証ガード', () => {
  it('未認証は 401、全体管理者でないユーザーは 403、app スコープは 401', async () => {
    expect((await api('/api/platform/backups')).status).toBe(401);
    expect((await api('/api/platform/backups', { cookie: staffCookie })).status).toBe(403);
    expect((await api('/api/platform/backups', { cookie: appScopeCookie })).status).toBe(401);
    expect((await api('/api/platform/usage')).status).toBe(401);
    expect((await api('/api/platform/usage', { cookie: staffCookie })).status).toBe(403);
  });
});

describe('バックアップと復元', () => {
  it('作成 → 変更 → 復元で業務データが戻り、ユーザーとセッションは保持される', async () => {
    // 手動バックアップを作成
    const created = await api('/api/platform/backups', { cookie: adminCookie, method: 'POST', body: {} });
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('manual');
    expect(created.body.sizeBytes).toBeGreaterThan(0);
    const backupId = created.body.id as number;

    // 一覧に出る
    const list = await api('/api/platform/backups', { cookie: adminCookie });
    expect(list.status).toBe(200);
    expect(list.body.items.some((b: { id: number }) => b.id === backupId)).toBe(true);

    // ダウンロードはスナップショット JSON そのもの (対象外テーブルを含まない)
    const dl = await api(`/api/platform/backups/${backupId}/download`, { cookie: adminCookie });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('Content-Disposition')).toContain('inventory-backup-');
    const snapshot = JSON.parse(dl.text) as { version: number; tables: Record<string, unknown[]> };
    expect(snapshot.version).toBe(1);
    expect(snapshot.tables.products).toHaveLength(1);
    expect(snapshot.tables.sessions).toBeUndefined();
    expect(snapshot.tables.push_subscriptions).toBeUndefined();
    expect(snapshot.tables.users).toHaveLength(2);

    // バックアップ後に業務データを変更し、ユーザーも増やす
    await testEnv.DB.batch([
      testEnv.DB.prepare("UPDATE products SET name = '変更後の名前' WHERE id = 1"),
      testEnv.DB.prepare(
        `INSERT INTO products (id, store_id, sku, name, unit, safety_stock, requires_expiry, created_at, updated_at)
         VALUES (2, 1, 'SKU-AFTER', 'バックアップ後の商品', '個', 0, 0, ?1, ?1)`,
      ).bind(Date.now()),
      testEnv.DB.prepare(
        `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
         VALUES (3, 'sub-new', 'new@example.com', 'New', 'active', ?1, ?1)`,
      ).bind(Date.now()),
    ]);
    expect(await productName(1)).toBe('変更後の名前');
    const sessionsBefore = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();

    // 復元
    const restored = await api(`/api/platform/backups/${backupId}/restore`, {
      cookie: adminCookie,
      method: 'POST',
      body: {},
    });
    expect(restored.status).toBe(200);
    expect(restored.body.restored).toBe(true);
    expect(restored.body.preRestoreBackupId).toBeGreaterThan(0);
    expect(restored.body.restoredTables.products).toBe(1);

    // 業務データはバックアップ時点に戻る (追加した商品は消える)
    expect(await productName(1)).toBe('復元検証品');
    expect(await productName(2)).toBeNull();

    // ユーザー・割当・セッションは復元の対象外 (増えたユーザーも残る)
    const users = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(users?.n).toBe(3);
    const roles = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM user_roles').first<{ n: number }>();
    expect(roles?.n).toBe(2);
    const sessionsAfter = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
    expect(sessionsAfter?.n).toBe(sessionsBefore?.n);

    // pre-restore バックアップが手動種別で残っている
    const listAfter = await api('/api/platform/backups', { cookie: adminCookie });
    const pre = listAfter.body.items.find(
      (b: { id: number; note: string | null }) => b.id === restored.body.preRestoreBackupId,
    );
    expect(pre).toBeDefined();
    expect(pre.note).toBe('pre-restore');
    expect(pre.kind).toBe('manual');

    // 監査に作成・ダウンロード・復元が記録される
    const audit = await testEnv.DB.prepare(
      "SELECT action FROM audit_logs WHERE action LIKE 'platform.backup.%' ORDER BY id ASC",
    ).all<{ action: string }>();
    const actions = audit.results.map((r) => r.action);
    expect(actions).toContain('platform.backup.create');
    expect(actions).toContain('platform.backup.download');
    expect(actions).toContain('platform.backup.restore');
  });

  it('存在しないバックアップのダウンロードと復元は 404', async () => {
    expect((await api('/api/platform/backups/99999/download', { cookie: adminCookie })).status).toBe(404);
    expect(
      (await api('/api/platform/backups/99999/restore', { cookie: adminCookie, method: 'POST', body: {} })).status,
    ).toBe(404);
  });
});

describe('保持件数と自動バックアップ', () => {
  it('manual は最新 3 件だけが残り、古い分は chunks ごと消える', async () => {
    const now = Date.now();
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await createBackup(testEnv.DB, {
        kind: 'manual',
        createdBy: 1,
        note: `keep-test-${i}`,
        nowMs: now + i * 1000,
      }));
    }
    const rows = await testEnv.DB.prepare(
      "SELECT id FROM backups WHERE kind = 'manual' ORDER BY created_at DESC, id DESC",
    ).all<{ id: number }>();
    // 先行テストの pre-restore 等も manual のため、保持は「全体で 3 件」になる
    expect(rows.results.length).toBe(3);
    // 一番古い keep-test-0 は消えている
    const keptIds = rows.results.map((r) => r.id);
    expect(keptIds).not.toContain(ids[0]);
    const orphanChunks = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM backup_chunks WHERE backup_id = ?1',
    ).bind(ids[0]).first<{ n: number }>();
    expect(orphanChunks?.n).toBe(0);
  });

  it('auto は 24 時間に 1 回だけ作られ、保持は 7 件', async () => {
    const t0 = Date.now() + 60_000;
    const first = await maybeAutoBackup(testEnv.DB, t0);
    expect(first).not.toBeNull();
    // 24 時間以内は作らない
    expect(await maybeAutoBackup(testEnv.DB, t0 + 60_000)).toBeNull();
    // 24 時間経過後は作る
    const second = await maybeAutoBackup(testEnv.DB, t0 + 24 * 60 * 60 * 1000 + 1);
    expect(second).not.toBeNull();

    // auto を 8 件まで増やすと古い 1 件が落ちて 7 件になる
    for (let i = 0; i < 6; i++) {
      await createBackup(testEnv.DB, {
        kind: 'auto',
        createdBy: null,
        note: `auto-fill-${i}`,
        nowMs: t0 + (i + 2) * 24 * 60 * 60 * 1000,
      });
    }
    const rows = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM backups WHERE kind = 'auto'",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(7);
  });

  it('lib の restoreBackup は存在しない id で例外にする', async () => {
    await expect(
      restoreBackup(testEnv.DB, 987654, { actorId: 1, nowMs: Date.now() }),
    ).rejects.toThrow('Backup not found');
  });
});

describe('利用量', () => {
  it('店舗別件数と DB 全体の実測値を返す', async () => {
    const res = await api('/api/platform/usage', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const store1 = (res.body.stores as { id: number; products: number; users: number }[]).find((s) => s.id === 1);
    expect(store1).toBeDefined();
    // 復元検証の状態を引き継ぐため商品は 1 件以上、ユーザーは店舗1の割当が 1 人
    expect(store1?.products).toBeGreaterThanOrEqual(1);
    expect(store1?.users).toBe(1);
    expect(res.body.database.totalRows).toBeGreaterThan(0);
    // ページ数ベースのサイズが取れる環境では数値、取れなければ null。
    // D1 では PRAGMA が使えないため、ペイロード長ベースの推定値が返る
    if (res.body.database.sizeBytes !== null) {
      expect(res.body.database.sizeBytes).toBeGreaterThan(0);
    } else {
      expect(res.body.database.sizeEstimateBytes).toBeGreaterThan(0);
    }
    expect(res.body.activeSessions).toBeGreaterThanOrEqual(1);
    expect(res.body.backups.count).toBeGreaterThanOrEqual(1);
    expect(res.body.backups.totalBytes).toBeGreaterThan(0);
  });
});
