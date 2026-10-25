import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import initSql from '../migrations/0001_init.sql?raw';
import seedSql from '../migrations/0002_seed_roles.sql?raw';
import permissionsSql from '../migrations/0003_permissions.sql?raw';
import sessionsSql from '../migrations/0004_sessions.sql?raw';
import businessSql from '../migrations/0005_business_completion.sql?raw';
import featuresSql from '../migrations/0006_feature_flags.sql?raw';
import purchasingSql from '../migrations/0007_purchasing_analytics.sql?raw';
import multiStoreSql from '../migrations/0008_multi_store.sql?raw';
import sessionScopeSql from '../migrations/0009_session_scope.sql?raw';
import platformSettingsSql from '../migrations/0010_platform_settings.sql?raw';
import maintenanceWindowsSql from '../migrations/0011_maintenance_windows.sql?raw';
import maintenanceExtrasSql from '../migrations/0012_maintenance_extras.sql?raw';
import announcementsSql from '../migrations/0013_announcements.sql?raw';
import practicalSql from '../migrations/0014_practical.sql?raw';
import commercialSql from '../migrations/0015_commercial.sql?raw';
import operationsSql from '../migrations/0016_operations.sql?raw';
import securitySql from '../migrations/0017_security.sql?raw';
import plansSql from '../migrations/0018_plans.sql?raw';
import { createSession } from '../src/lib/session';

/**
 * プラン制 (0018) の結合テスト。
 *
 * - 店舗 1 = DGOSK: migration 0018 が組織「DGOSK」(owner) を作って紐付ける
 * - 店舗 2 = PLAN-A: 組織 OrgA (free: 店舗1/ユーザー3/SKU200、announcements のみ)
 * - 店舗 3 = PLAN-B: 組織 OrgB (standard: フラグ全部、モジュールは returns_disposals のみ)
 * - 店舗 4 = LEGACY: 組織なし (レガシー扱い = owner 相当で制限なし)
 * ユーザー: 1 = 全体管理者、2 = 店舗2の管理者、3 = 店舗2のスタッフ、
 * 4・5 = 割当なし (ユーザー上限の検証用)、7 = 店舗3の管理者、8 = 店舗4の管理者
 */

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let cookiePlatform = '';
let cookieAdminA = '';
let cookieStaffA = '';
let cookieAdminB = '';
let cookieLegacy = '';
let keySeq = 0;

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  path: string,
  opts: { cookie?: string; method?: string; body?: unknown; key?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `session=${opts.cookie}`;
  if (opts.key) headers['Idempotency-Key'] = opts.key;
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function nextKey(): string {
  keySeq += 1;
  return `plan-test-${keySeq}`;
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

async function setFeatureFlag(storeId: number, key: string, enabled: boolean): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO feature_flags (store_id, key, enabled, updated_by, updated_at) VALUES (?1, ?2, ?3, 1, ?4)
     ON CONFLICT(store_id, key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  )
    .bind(storeId, key, enabled ? 1 : 0, Date.now())
    .run();
}

beforeAll(async () => {
  for (const sql of [
    initSql, seedSql, permissionsSql, sessionsSql, businessSql, featuresSql,
    purchasingSql, multiStoreSql, sessionScopeSql, platformSettingsSql,
    maintenanceWindowsSql, maintenanceExtrasSql, announcementsSql, practicalSql,
    commercialSql, operationsSql, securitySql, plansSql,
  ]) {
    for (const stmt of statementsOf(sql)) {
      await testEnv.DB.prepare(stmt).run();
    }
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-platform', 'platform@example.com', 'Platform', 'active', ?1, ?1),
              (2, 'sub-admin-a', 'admin-a@example.com', 'AdminA', 'active', ?1, ?1),
              (3, 'sub-staff-a', 'staff-a@example.com', 'StaffA', 'active', ?1, ?1),
              (4, 'sub-new-a', 'new-a@example.com', 'NewA', 'active', ?1, ?1),
              (5, 'sub-extra-a', 'extra-a@example.com', 'ExtraA', 'active', ?1, ?1),
              (7, 'sub-admin-b', 'admin-b@example.com', 'AdminB', 'active', ?1, ?1),
              (8, 'sub-admin-l', 'admin-l@example.com', 'AdminL', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO organizations (id, name, plan_key, created_at, updated_at)
       VALUES (2, 'OrgA', 'free', ?1, ?1), (3, 'OrgB', 'standard', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO stores (id, code, name, status, organization_id, created_at, updated_at)
       VALUES (2, 'PLAN-A', 'プランA店', 'active', 2, ?1, ?1),
              (3, 'PLAN-B', 'プランB店', 'active', 3, ?1, ?1),
              (4, 'LEGACY', 'レガシー店', 'active', NULL, ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, NULL),
              (2, 'SYSTEM_ADMIN', NULL, 2),
              (3, 'INVENTORY_STAFF', NULL, 2),
              (7, 'SYSTEM_ADMIN', NULL, 3),
              (8, 'SYSTEM_ADMIN', NULL, 4)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
       VALUES (10, 'WH-A', 'A倉庫', 2, ?1, ?1), (11, 'WH-B', 'B倉庫', 3, ?1, ?1),
              (12, 'WH-L', 'L倉庫', 4, ?1, ?1), (13, 'WH-O', 'O倉庫', 1, ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
       VALUES (10, 10, 'A-1', '棚A-1', ?1, ?1), (11, 11, 'B-1', '棚B-1', ?1, ?1),
              (12, 12, 'L-1', '棚L-1', ?1, ?1), (13, 13, 'O-1', '棚O-1', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, store_id, created_at, updated_at)
       VALUES (100, 'A-1', '商品A1', '個', 0, 0, 2, ?1, ?1),
              (300, 'B-1', '商品B1', '個', 0, 0, 3, ?1, ?1),
              (500, 'O-1', '商品O1', '個', 0, 0, 1, ?1, ?1)`,
    ).bind(now),
  ]);

  cookiePlatform = await createSession(testEnv.DB, 1);
  cookieAdminA = await createSession(testEnv.DB, 2);
  cookieStaffA = await createSession(testEnv.DB, 3);
  cookieAdminB = await createSession(testEnv.DB, 7);
  cookieLegacy = await createSession(testEnv.DB, 8);
  // 全体管理者は DGOSK (店舗 1) を選択しておく
  const sel = await api('/api/v1/session/store', { cookie: cookiePlatform, method: 'POST', body: { storeId: 1 } });
  expect(sel.status).toBe(200);
});

describe('プラン表示 (/me)', () => {
  it('free 組織の店舗では plan にキー・組織・上限・利用状況が入る', async () => {
    const me = await api('/api/v1/me', { cookie: cookieStaffA });
    expect(me.status).toBe(200);
    const plan = me.body.plan as {
      key: string; name: string; price: number;
      organization: { id: number; name: string } | null;
      limits: { stores: number | null; users: number | null; skus: number | null };
      usage: { stores: number; users: number; skus: number };
    };
    expect(plan.key).toBe('free');
    expect(plan.name).toBe('フリー');
    expect(plan.price).toBe(0);
    expect(plan.organization).toEqual({ id: 2, name: 'OrgA' });
    expect(plan.limits).toEqual({ stores: 1, users: 3, skus: 200 });
    expect(plan.usage.stores).toBe(1);
    expect(plan.usage.users).toBe(2);
    expect(plan.usage.skus).toBe(1);
    // 実効フラグ: free は announcements のみ。transfers は店舗フラグ既定 ON でも落ちる
    const features = me.body.features as Record<string, boolean>;
    expect(features.announcements).toBe(true);
    expect(features.transfers).toBe(false);
    expect(features.alerts).toBe(false);
  });

  it('DGOSK は owner プランで上限なし、組織は DGOSK', async () => {
    const me = await api('/api/v1/me', { cookie: cookiePlatform });
    const plan = me.body.plan as {
      key: string;
      organization: { id: number; name: string } | null;
      limits: { stores: number | null; users: number | null; skus: number | null };
    };
    expect(plan.key).toBe('owner');
    expect(plan.organization?.name).toBe('DGOSK');
    expect(plan.limits).toEqual({ stores: null, users: null, skus: null });
  });

  it('組織なし店舗 (レガシー) は owner 相当で organization は null', async () => {
    const me = await api('/api/v1/me', { cookie: cookieLegacy });
    const plan = me.body.plan as { key: string; organization: unknown };
    expect(plan.key).toBe('owner');
    expect(plan.organization).toBeNull();
  });
});

describe('機能フラグのプランゲート', () => {
  it('店舗フラグ ON でもプラン未許可なら PLAN_FEATURE_NOT_AVAILABLE、フラグ OFF なら FEATURE_DISABLED', async () => {
    // alerts の店舗フラグは既定 ON。free は alerts を許可しない
    const gated = await api('/api/v1/alerts', { cookie: cookieStaffA });
    expect(gated.status).toBe(403);
    expect(gated.body.error).toBe('PLAN_FEATURE_NOT_AVAILABLE');
    expect(gated.body.plan).toBe('free');

    // フラグを OFF にすると従来どおり FEATURE_DISABLED が優先する
    await setFeatureFlag(2, 'alerts', false);
    const disabled = await api('/api/v1/alerts', { cookie: cookieStaffA });
    expect(disabled.status).toBe(403);
    expect(disabled.body.error).toBe('FEATURE_DISABLED');
    await setFeatureFlag(2, 'alerts', true);

    // announcements は free でも許可される
    const ok = await api('/api/v1/announcements', { cookie: cookieStaffA });
    expect(ok.status).toBe(200);
  });
});

describe('モジュールゲート', () => {
  it('free では引当・返品が使えない', async () => {
    const reservation = await api('/api/v1/reservations', {
      cookie: cookieStaffA,
      method: 'POST',
      key: nextKey(),
      body: { productId: 100, locationId: 10, quantity: 1, reason: 'テスト' },
    });
    expect(reservation.status).toBe(403);
    expect(reservation.body.error).toBe('PLAN_FEATURE_NOT_AVAILABLE');

    const ret = await api('/api/v1/movements/return', {
      cookie: cookieStaffA,
      method: 'POST',
      key: nextKey(),
      body: { locationId: 10, productId: 100, lotCode: 'L1', quantity: 1, reasonCode: 'damaged', reason: '破損' },
    });
    expect(ret.status).toBe(403);
    expect(ret.body.error).toBe('PLAN_FEATURE_NOT_AVAILABLE');
  });

  it('standard では引当・一括編集は使えないが、フラグ系 (分析) は通る', async () => {
    const reservation = await api('/api/v1/reservations', {
      cookie: cookieAdminB,
      method: 'POST',
      key: nextKey(),
      body: { productId: 300, locationId: 11, quantity: 1, reason: 'テスト' },
    });
    expect(reservation.status).toBe(403);
    expect(reservation.body.error).toBe('PLAN_FEATURE_NOT_AVAILABLE');

    const bulk = await api('/api/v1/admin/products/bulk', {
      cookie: cookieAdminB,
      method: 'PUT',
      body: { ids: [300], patch: { safetyStock: 5 } },
    });
    expect(bulk.status).toBe(403);
    expect(bulk.body.error).toBe('PLAN_FEATURE_NOT_AVAILABLE');

    const analytics = await api('/api/v1/analytics', { cookie: cookieAdminB });
    expect(analytics.status).toBe(200);
  });

  it('レガシー店舗と owner (DGOSK) ではモジュールが使える', async () => {
    const legacyBundles = await api('/api/v1/bundles', { cookie: cookieLegacy });
    expect(legacyBundles.status).toBe(200);

    const inbound = await api('/api/v1/movements/inbound', {
      cookie: cookiePlatform,
      method: 'POST',
      key: nextKey(),
      body: { locationId: 13, productId: 500, lotCode: 'LOT-O1', quantity: 10 },
    });
    expect(inbound.status).toBe(201);
    const reservation = await api('/api/v1/reservations', {
      cookie: cookiePlatform,
      method: 'POST',
      key: nextKey(),
      body: { productId: 500, locationId: 13, quantity: 2, reason: '確保' },
    });
    expect(reservation.status).toBe(201);
  });
});

describe('SKU 上限 (free: 200)', () => {
  it('上限到達で商品作成と CSV インポートが PLAN_LIMIT_REACHED になる', async () => {
    // 店舗 2 の商品を 199 件まで直接投入する (既存 1 件 + 198 件)
    const stmts: D1PreparedStatement[] = [];
    const now = Date.now();
    for (let i = 0; i < 198; i++) {
      stmts.push(
        testEnv.DB.prepare(
          `INSERT INTO products (sku, name, unit, safety_stock, requires_expiry, store_id, created_at, updated_at)
           VALUES (?1, ?2, '個', 0, 0, 2, ?3, ?3)`,
        ).bind(`BULK-${i}`, `一括${i}`, now),
      );
    }
    await testEnv.DB.batch(stmts);

    // 200 件目までは作れる
    const created = await api('/api/v1/master/products', {
      cookie: cookieAdminA,
      method: 'POST',
      body: { sku: 'A-NEW-1', name: '上限直前', unit: '個' },
    });
    expect(created.status).toBe(201);

    // 201 件目は上限エラー (内訳つき)
    const over = await api('/api/v1/master/products', {
      cookie: cookieAdminA,
      method: 'POST',
      body: { sku: 'A-NEW-2', name: '上限超過', unit: '個' },
    });
    expect(over.status).toBe(403);
    expect(over.body.error).toBe('PLAN_LIMIT_REACHED');
    expect(over.body.resource).toBe('skus');
    expect(over.body.limit).toBe(200);
    expect(over.body.current).toBe(200);
    expect(over.body.plan).toBe('free');

    // free では csv フラグ自体がプラン未許可なので、CSV インポートは先に
    // PLAN_FEATURE_NOT_AVAILABLE で止まる (上限チェックより手前)
    const res = await SELF.fetch('https://example.com/api/v1/products/import', {
      method: 'POST',
      headers: { Cookie: `session=${cookieAdminA}`, 'Content-Type': 'text/csv' },
      body: 'sku,name,unit\nA-CSV-1,CSV品,個\n',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('PLAN_FEATURE_NOT_AVAILABLE');

    // standard (SKU 無制限) では同じ操作が通る
    const okB = await api('/api/v1/master/products', {
      cookie: cookieAdminB,
      method: 'POST',
      body: { sku: 'B-NEW-1', name: '無制限側', unit: '個' },
    });
    expect(okB.status).toBe(201);
  });
});

describe('CSV インポートの SKU 上限 (starter: 3000)', () => {
  it('投入後の合計が上限を超えるインポートは投入前に止まる', async () => {
    const now = Date.now();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO organizations (id, name, plan_key, created_at, updated_at) VALUES (4, 'OrgC', 'starter', ?1, ?1)`,
      ).bind(now),
      testEnv.DB.prepare(
        `INSERT INTO stores (id, code, name, status, organization_id, created_at, updated_at) VALUES (5, 'PLAN-C', 'プランC店', 'active', 4, ?1, ?1)`,
      ).bind(now),
      testEnv.DB.prepare(
        `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at) VALUES (9, 'sub-admin-c', 'admin-c@example.com', 'AdminC', 'active', ?1, ?1)`,
      ).bind(now),
      testEnv.DB.prepare(
        `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id) VALUES (9, 'SYSTEM_ADMIN', NULL, 5)`,
      ),
    ]);
    // 商品を 2999 件まで投入する (上限 3000 の手前)
    for (let base = 0; base < 2999; base += 250) {
      const stmts: D1PreparedStatement[] = [];
      for (let i = base; i < Math.min(base + 250, 2999); i++) {
        stmts.push(
          testEnv.DB.prepare(
            `INSERT INTO products (sku, name, unit, safety_stock, requires_expiry, store_id, created_at, updated_at)
             VALUES (?1, ?2, '個', 0, 0, 5, ?3, ?3)`,
          ).bind(`C-BULK-${i}`, `C一括${i}`, now),
        );
      }
      await testEnv.DB.batch(stmts);
    }
    const cookieAdminC = await createSession(testEnv.DB, 9);
    const importCsv = async (csv: string): Promise<ApiResult> => {
      const res = await SELF.fetch('https://example.com/api/v1/products/import', {
        method: 'POST',
        headers: { Cookie: `session=${cookieAdminC}`, 'Content-Type': 'text/csv' },
        body: csv,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    // 2 件入れると 3001 件で上限超過 → 投入前に 403
    const over = await importCsv('sku,name,unit\nC-NEW-1,品1,個\nC-NEW-2,品2,個\n');
    expect(over.status).toBe(403);
    expect(over.body.error).toBe('PLAN_LIMIT_REACHED');
    expect(over.body.resource).toBe('skus');
    expect(over.body.current).toBe(2999);
    // 1 件なら上限ちょうどで取り込める
    const fits = await importCsv('sku,name,unit\nC-NEW-1,品1,個\n');
    expect(fits.status).toBe(200);
    expect(fits.body.created).toBe(1);
  });
});

describe('ユーザー上限 (free: 3)', () => {
  it('組織の distinct ユーザー数が上限に達すると新規付与が止まり、既存メンバーの変更は通る', async () => {
    // 現メンバーは user 2・3 の 2 名。3 人目 (user 4) は付与できる
    const third = await api('/api/v1/admin/users/4/roles', {
      cookie: cookieAdminA,
      method: 'PUT',
      body: { assignments: [{ roleCode: 'INVENTORY_STAFF', warehouseId: null }] },
    });
    expect(third.status).toBe(200);

    // 4 人目 (user 5) は上限エラー
    const fourth = await api('/api/v1/admin/users/5/roles', {
      cookie: cookieAdminA,
      method: 'PUT',
      body: { assignments: [{ roleCode: 'INVENTORY_STAFF', warehouseId: null }] },
    });
    expect(fourth.status).toBe(403);
    expect(fourth.body.error).toBe('PLAN_LIMIT_REACHED');
    expect(fourth.body.resource).toBe('users');
    expect(fourth.body.limit).toBe(3);
    expect(fourth.body.current).toBe(3);

    // 既存メンバー (user 4) のロール変更は増員として数えない
    const change = await api('/api/v1/admin/users/4/roles', {
      cookie: cookieAdminA,
      method: 'PUT',
      body: { assignments: [{ roleCode: 'VIEWER', warehouseId: null }] },
    });
    expect(change.status).toBe(200);
  });
});
