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
import stockHistorySql from '../migrations/0023_stock_history.sql?raw';
import { createSession } from '../src/lib/session';
import { computeHistoryForecast, type HistoryPoint } from '../src/lib/history-forecast';

/**
 * 棚卸し履歴ベースの持ち日数 (0023) のテスト。
 * 純粋計算: 区間の減少分を消費とみなし、月別ペースから繁忙/閑散を出す。
 * 結合: 履歴は 2025-06 (ペース2.0/日) と 2025-07 (0.667/日) に置き、
 * 全体では 60個/50日 = 1.2/日、現在庫120 → 通常100日。
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

async function api(path: string, opts: { cookie?: string } = {}): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = `session=${opts.cookie}`;
  const res = await SELF.fetch(`https://example.com${path}`, { headers });
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

const pts = (rows: [string, number][]): HistoryPoint[] =>
  rows.map(([date, quantity]) => ({ date, quantity }));

describe('computeHistoryForecast', () => {
  it('全体ペースと月別ペース (2ヶ月分) を計算する', () => {
    const items = computeHistoryForecast([
      {
        productId: 1,
        sku: 'A',
        name: '商品A',
        unit: '個',
        currentQuantity: 120,
        points: pts([
          ['2025-06-01', 200],
          ['2025-06-11', 180],
          ['2025-06-21', 160],
          ['2025-07-01', 150],
          ['2025-07-11', 140],
          ['2025-07-21', 190], // 増えた区間は消費0として日数だけ数える
          ['2025-12-01', 100], // 62日超の空白区間は除外
        ]),
      },
    ]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.pace.typical).toBe(1.2);
    expect(item.pace.busy).toBe(1.333);
    expect(item.pace.slow).toBe(1.2); // 2ヶ月分しかないため閑散は通常に収まる
    expect(item.daysLeft.typical).toBe(100);
    expect(item.daysLeft.busy).toBe(90);
    expect(item.snapshots).toBe(7);
    expect(item.firstDate).toBe('2025-06-01');
    expect(item.lastDate).toBe('2025-12-01');
  });

  it('繁忙期 (高い3ヶ月) と閑散期 (低い3ヶ月) を分ける', () => {
    const items = computeHistoryForecast([
      {
        productId: 2,
        sku: 'B',
        name: '商品B',
        unit: '個',
        currentQuantity: 191,
        points: pts([
          ['2025-01-01', 1000],
          ['2025-01-16', 955],
          ['2025-01-31', 910],
          ['2025-02-15', 880],
          ['2025-02-28', 854],
          ['2025-03-15', 839],
          ['2025-03-30', 824],
          ['2025-04-14', 816.5],
          ['2025-04-29', 809],
        ]),
      },
    ]);
    const item = items[0]!;
    expect(item.pace.typical).toBe(1.619);
    expect(item.pace.busy).toBe(2);
    expect(item.pace.slow).toBe(1.167);
    expect(item.daysLeft.typical).toBe(118);
    expect(item.daysLeft.busy).toBe(95.5);
    expect(item.daysLeft.slow).toBe(163.7);
  });

  it('単発の異常値 (数え方の違う日) は消費に数えない', () => {
    const items = computeHistoryForecast([
      {
        productId: 5,
        sku: 'E',
        name: '商品E',
        unit: '個',
        currentQuantity: 8,
        points: pts([
          ['2025-06-01', 10],
          ['2025-06-11', 8],
          ['2025-06-21', 300], // 異常値: ここからの落差 294 は消費ではない
          ['2025-07-01', 6],
          ['2025-07-11', 4],
        ]),
      },
    ]);
    const item = items[0]!;
    // 残る区間: 10→8 (2個), 8→300 (0個), 6→4 (2個) / 30日
    expect(item.pace.typical).toBe(0.133);
    expect(item.daysLeft.typical).toBe(60);
  });

  it('月別カバーが疎でも繁忙/閑散が通常を逆転しない', () => {
    const items = computeHistoryForecast([
      {
        productId: 6,
        sku: 'F',
        name: '商品F',
        unit: '個',
        currentQuantity: 25.6,
        points: pts([
          ['2025-01-01', 100],
          ['2025-01-11', 90],
          ['2025-01-21', 80],
          ['2025-03-20', 80], // 58日・減少0: 月別には入らず全体だけ引き下げる
        ]),
      },
    ]);
    const item = items[0]!;
    expect(item.pace.typical).toBe(0.256);
    expect(item.pace.busy).toBe(1);
    expect(item.pace.slow).toBe(0.256); // 月別は 1.0 だが通常以下に収まる
    expect(item.daysLeft.busy).toBe(25.6);
    expect(item.daysLeft.slow).toBe(99.8);
  });

  it('減らない商品と点が足りない商品はペース null', () => {
    const items = computeHistoryForecast([
      {
        productId: 3,
        sku: 'C',
        name: '商品C',
        unit: '個',
        currentQuantity: 10,
        points: pts([
          ['2025-06-01', 50],
          ['2025-06-11', 50],
          ['2025-06-21', 55],
        ]),
      },
      {
        productId: 4,
        sku: 'D',
        name: '商品D',
        unit: '個',
        currentQuantity: 10,
        points: pts([['2025-06-01', 50]]),
      },
    ]);
    for (const item of items) {
      expect(item.pace.typical).toBeNull();
      expect(item.daysLeft.typical).toBeNull();
      expect(item.daysLeft.busy).toBeNull();
    }
  });
});

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
    ...statementsOf(stockHistorySql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }

  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB
      .prepare(
        `INSERT INTO stores (id, code, name, status, created_at, updated_at)
         VALUES (2, 'S1', 'Store One', 'active', ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (2, 'sub-admin', 'admin@example.com', 'Admin', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (2, 'SYSTEM_ADMIN', NULL, 2)`,
    ),
    testEnv.DB
      .prepare(
        `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
         VALUES (10, 'WH-HF', '履歴倉庫', 2, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
         VALUES (10, 10, 'HF1', '履歴棚', ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO products (id, sku, name, unit, barcode, safety_stock, requires_expiry, store_id, created_at, updated_at)
         VALUES (10, 'SKU-HF', '履歴テスト商品', '個', NULL, 0, 0, 2, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO lots (id, product_id, lot_code, expiry_date, received_at, store_id, created_at, updated_at)
         VALUES (10, 10, 'LOT-HF', NULL, ?1, 2, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO stocks (id, location_id, lot_id, quantity, version, store_id, created_at, updated_at)
         VALUES (10, 10, 10, 120, 1, 2, ?1, ?1)`,
      )
      .bind(now),
  ]);

  const history: [string, number][] = [
    ['2025-06-01', 200],
    ['2025-06-11', 180],
    ['2025-06-21', 160],
    ['2025-07-01', 150],
    ['2025-07-11', 140],
    ['2025-07-21', 190],
    ['2025-12-01', 100],
  ];
  await testEnv.DB.batch(
    history.map(([date, qty]) =>
      testEnv.DB
        .prepare(
          `INSERT INTO product_stock_history (store_id, product_id, date, quantity, source, created_at)
           VALUES (2, 10, ?1, ?2, 'test', ?3)`,
        )
        .bind(date, qty, now),
    ),
  );

  cookieAdmin = await createSession(testEnv.DB, 2);
});

describe('GET /api/v1/history-forecast', () => {
  it('未ログインは 401', async () => {
    expect((await api('/api/v1/history-forecast')).status).toBe(401);
  });

  it('履歴からペースと持ち日数を返す', async () => {
    const res = await api('/api/v1/history-forecast', { cookie: cookieAdmin });
    expect(res.status).toBe(200);
    const coverage = res.body.coverage as { records: number; snapshotDays: number; firstDate: string; lastDate: string };
    expect(coverage.records).toBe(7);
    expect(coverage.snapshotDays).toBe(7);
    expect(coverage.firstDate).toBe('2025-06-01');
    expect(coverage.lastDate).toBe('2025-12-01');
    const items = res.body.items as Array<Record<string, unknown>>;
    const item = items.find((i) => i.productId === 10)!;
    expect(item.currentQuantity).toBe(120);
    const pace = item.pace as { typical: number; busy: number; slow: number };
    expect(pace.typical).toBe(1.2);
    const daysLeft = item.daysLeft as { typical: number; busy: number };
    expect(daysLeft.typical).toBe(100);
    expect(daysLeft.busy).toBe(90);
  });
});
