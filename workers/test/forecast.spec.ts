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
import maintenanceSql from '../migrations/0011_maintenance_windows.sql?raw';
import maintenanceExtrasSql from '../migrations/0012_maintenance_extras.sql?raw';
import announcementsSql from '../migrations/0013_announcements.sql?raw';
import practicalSql from '../migrations/0014_practical.sql?raw';
import commercialSql from '../migrations/0015_commercial.sql?raw';
import operationsSql from '../migrations/0016_operations.sql?raw';
import securitySql from '../migrations/0017_security.sql?raw';
import plansSql from '../migrations/0018_plans.sql?raw';
import passkeyVerifiedSql from '../migrations/0019_session_passkey_verified.sql?raw';
import generalizationSql from '../migrations/0020_generalization.sql?raw';
import invitesSql from '../migrations/0021_invites.sql?raw';
import reservationForecastSql from '../migrations/0022_reservation_forecast.sql?raw';
import { createSession } from '../src/lib/session';
import { addDaysToKey, dateKeyInTz } from '../src/lib/forecast';

/**
 * 予約連動の消費予測 (0022) の結合テスト。
 *
 * ユーザー: 2 = 店舗2の SYSTEM_ADMIN、3 = 店舗2の VIEWER (書込権限なし)、
 * 4 = 店舗2の INVENTORY_STAFF (消費記録可)。
 * 予測の検証データ: 過去5日 (記録日) に予約20件/日・消費10/日 →
 * 係数 0.5。今日と明日に予約30件を入れると今後7日は210件ペース →
 * 予想消費 15/日、現在庫30 → あと2日。
 */

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

let cookieAdmin = '';
let cookieViewer = '';
let cookieStaff = '';
let todayKey = '';

async function api(
  path: string,
  opts: { cookie?: string; method?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `session=${opts.cookie}`;
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
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
    ...statementsOf(maintenanceSql),
    ...statementsOf(maintenanceExtrasSql),
    ...statementsOf(announcementsSql),
    ...statementsOf(practicalSql),
    ...statementsOf(commercialSql),
    ...statementsOf(operationsSql),
    ...statementsOf(securitySql),
    ...statementsOf(plansSql),
    ...statementsOf(passkeyVerifiedSql),
    ...statementsOf(generalizationSql),
    ...statementsOf(invitesSql),
    ...statementsOf(reservationForecastSql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }

  const now = Date.now();
  todayKey = dateKeyInTz(now, 'Asia/Tokyo');
  await testEnv.DB.batch([
    testEnv.DB
      .prepare(
        `INSERT INTO stores (id, code, name, status, created_at, updated_at)
         VALUES (2, 'S1', 'Store One', 'active', ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (2, 'sub-admin', 'admin@example.com', 'Admin', 'active', ?1, ?1),
              (3, 'sub-viewer', 'viewer@example.com', 'Viewer', 'active', ?1, ?1),
              (4, 'sub-staff', 'staff@example.com', 'Staff', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (2, 'SYSTEM_ADMIN', NULL, 2),
              (3, 'VIEWER', NULL, 2),
              (4, 'INVENTORY_STAFF', NULL, 2)`,
    ),
    testEnv.DB
      .prepare(
        `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
         VALUES (10, 'WH-FC', '予測倉庫', 2, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
         VALUES (10, 10, 'FC1', '予測棚', ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO products (id, sku, name, unit, barcode, safety_stock, requires_expiry, store_id, created_at, updated_at)
         VALUES (10, 'SKU-FC', '予測テスト商品', '個', NULL, 0, 0, 2, ?1, ?1),
                (11, 'SKU-FC2', '消費なし商品', '個', NULL, 0, 0, 2, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO lots (id, product_id, lot_code, expiry_date, received_at, store_id, created_at, updated_at)
         VALUES (10, 10, 'LOT-FC', NULL, ?1, 2, ?1, ?1),
                (11, 11, 'LOT-FC2', NULL, ?1, 2, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO stocks (id, location_id, lot_id, quantity, version, store_id, created_at, updated_at)
         VALUES (10, 10, 10, 30, 1, 2, ?1, ?1),
                (11, 10, 11, 50, 1, 2, ?1, ?1)`,
      )
      .bind(now),
  ]);

  // 過去5日 (記録日): 予約20件/日、消費 (OUT) 10/日 を直接投入する
  const stmts: D1PreparedStatement[] = [];
  for (let i = 5; i >= 1; i--) {
    const day = addDaysToKey(todayKey, -i);
    const noonJst = Date.parse(`${day}T12:00:00+09:00`);
    stmts.push(
      testEnv.DB
        .prepare(
          `INSERT INTO store_reservation_days (store_id, date, count, updated_by, created_at, updated_at)
           VALUES (2, ?1, 20, 4, ?2, ?2)`,
        )
        .bind(day, now),
      testEnv.DB
        .prepare(
          `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, created_at, store_id)
           VALUES (?1, 10, 'OUT', -10, 100, 90, 4, ?2, 2)`,
        )
        .bind(`doc-fc-${i}`, noonJst),
    );
  }
  await testEnv.DB.batch(stmts);

  cookieAdmin = await createSession(testEnv.DB, 2);
  cookieViewer = await createSession(testEnv.DB, 3);
  cookieStaff = await createSession(testEnv.DB, 4);
});

describe('予約件数の記録', () => {
  it('未ログインは 401', async () => {
    const res = await api('/api/v1/reservation-days', { method: 'PUT', body: { date: todayKey, count: 10 } });
    expect(res.status).toBe(401);
  });

  it('消費の記録権限が無いユーザーは書けない (403)', async () => {
    const res = await api('/api/v1/reservation-days', {
      cookie: cookieViewer,
      method: 'PUT',
      body: { date: todayKey, count: 10 },
    });
    expect(res.status).toBe(403);
  });

  it('実在しない日付は 400', async () => {
    const res = await api('/api/v1/reservation-days', {
      cookie: cookieStaff,
      method: 'PUT',
      body: { date: '2026-02-30', count: 5 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_DATE');
  });

  it('負の件数は 400', async () => {
    const res = await api('/api/v1/reservation-days', {
      cookie: cookieStaff,
      method: 'PUT',
      body: { date: todayKey, count: -1 },
    });
    expect(res.status).toBe(400);
  });

  it('スタッフが今日と明日の予約を記録でき、上書きもできる', async () => {
    const tomorrow = addDaysToKey(todayKey, 1);
    const r1 = await api('/api/v1/reservation-days', {
      cookie: cookieStaff,
      method: 'PUT',
      body: { date: todayKey, count: 30 },
    });
    expect(r1.status).toBe(200);
    expect(r1.body.count).toBe(30);
    const r2 = await api('/api/v1/reservation-days', {
      cookie: cookieStaff,
      method: 'PUT',
      body: { date: tomorrow, count: 30 },
    });
    expect(r2.status).toBe(200);
    const r3 = await api('/api/v1/reservation-days', {
      cookie: cookieStaff,
      method: 'PUT',
      body: { date: tomorrow, count: 30 },
    });
    expect(r3.status).toBe(200);

    const list = await api(
      `/api/v1/reservation-days?from=${addDaysToKey(todayKey, -6)}&to=${tomorrow}`,
      { cookie: cookieViewer },
    );
    expect(list.status).toBe(200);
    const days = list.body.days as { date: string; count: number }[];
    expect(days.length).toBe(7);
    expect(days[0]?.count).toBe(20);
    expect(days[5]?.date).toBe(todayKey);
    expect(days[5]?.count).toBe(30);
    expect(days[6]?.count).toBe(30);
  });
});

describe('消費予測', () => {
  it('係数とペースから切れる時期を読む', async () => {
    const res = await api('/api/v1/forecast', { cookie: cookieAdmin });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const basis = res.body.basis as { recordedDays: number; totalReservations: number };
    expect(basis.recordedDays).toBe(5);
    expect(basis.totalReservations).toBe(100);
    const pace = res.body.pace as { next7Reservations: number; dailyReservations: number };
    expect(pace.next7Reservations).toBe(210);
    expect(pace.dailyReservations).toBe(30);
    const items = res.body.items as Record<string, unknown>[];
    expect(items.length).toBe(1);
    expect(items[0]?.productId).toBe(10);
    expect(items[0]?.perReservation).toBe(0.5);
    expect(items[0]?.expectedDaily).toBe(15);
    expect(items[0]?.expected7d).toBe(105);
    expect(items[0]?.daysLeft).toBe(2);
    expect(items[0]?.currentQuantity).toBe(30);
  });

  it('予約が先行すると切れる時期が早まる (ペース連動)', async () => {
    // 明日の予約を 30 → 100 に増やすと今後7日の見込みが増え、daysLeft が縮む
    const tomorrow = addDaysToKey(todayKey, 1);
    const put = await api('/api/v1/reservation-days', {
      cookie: cookieStaff,
      method: 'PUT',
      body: { date: tomorrow, count: 100 },
    });
    expect(put.status).toBe(200);
    const res = await api('/api/v1/forecast', { cookie: cookieAdmin });
    const items = res.body.items as Record<string, unknown>[];
    // 入力済みの今後分平均 = (30 + 100) / 2 = 65 → 7日で 455 件、係数 0.5 → 32.5/日
    expect(items[0]?.expectedDaily).toBe(32.5);
    expect(items[0]?.daysLeft).toBe(0.9);
  });
});
