import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
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

/**
 * 追加エンドポイントの結合テスト。
 * - GET /api/v1/products/:id/availability (在庫内訳・引当・発注残)
 * - POST /api/v1/movements/bulk (一括入出庫の原子性と冪等)
 * - GET /api/v1/lots/:id/history (ロット追跡)
 * - GET /api/v1/movements?sinceId= (差分取得)
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

let tokenMgr = '';
let tokenMgrB = '';
let tokenViewer = '';
let keySeq = 0;

async function mintToken(sub: string, email: string, privateKey: KeyLike): Promise<string> {
  return new SignJWT({ email, email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function api(
  path: string,
  opts: { token?: string; method?: string; body?: unknown; key?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
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
  return `endpoints2-test-${keySeq}`;
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

interface AvailabilityBody {
  product: { id: number; sku: string };
  totals: { quantity: number; reserved: number; free: number };
  onOrderQuantity: number;
  stocks: { stockId: number; lotCode: string; quantity: number; freeQuantity: number; reservedQuantity: number }[];
}

interface LotHistoryBody {
  lot: { id: number; lotCode: string; productSku: string };
  totals: { totalIn: number; totalOut: number; currentQuantity: number };
  stocks: { stockId: number; quantity: number }[];
  movements: { id: number; type: string; quantityChange: number }[];
}

const EXPIRY_2026_12_01 = Date.UTC(2026, 11, 1);

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;

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
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }

  tokenMgr = await mintToken('sub-mgr-a', 'mgr@example.com', privateKey);
  tokenMgrB = await mintToken('sub-mgr-b', 'mgrb@example.com', privateKey);
  tokenViewer = await mintToken('sub-viewer-a', 'viewer@example.com', privateKey);

  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB
      .prepare(
        `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
         VALUES (1, 'sub-mgr-a', 'mgr@example.com', 'MgrA', 'active', ?1, ?1),
                (2, 'sub-mgr-b', 'mgrb@example.com', 'MgrB', 'active', ?1, ?1),
                (3, 'sub-viewer-a', 'viewer@example.com', 'ViewerA', 'active', ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB.prepare(
      `INSERT INTO stores (id, code, name, status, created_at, updated_at)
       VALUES (2, 'STORE-B', '店舗B', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'INVENTORY_MANAGER', NULL, 1),
              (2, 'INVENTORY_MANAGER', NULL, 2),
              (3, 'VIEWER', NULL, 1)`,
    ),
    testEnv.DB
      .prepare(
        `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
         VALUES (1, 'WH-A', 'A倉庫', 1, ?1, ?1), (2, 'WH-B', 'B倉庫', 2, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
         VALUES (1, 1, 'A1', 'A1棚', ?1, ?1), (2, 1, 'A2', 'A2棚', ?1, ?1),
                (3, 2, 'B1', 'B1棚', ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO products (id, sku, name, unit, barcode, safety_stock, requires_expiry, store_id, created_at, updated_at)
         VALUES (1, 'SKU-A', '商品A', '個', NULL, 0, 0, 1, ?1, ?1),
                (2, 'SKU-B', '期限付き商品B', '個', NULL, 0, 1, 1, ?1, ?1),
                (3, 'SKU-A', '商品A', '個', NULL, 0, 0, 2, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO lots (id, product_id, lot_code, expiry_date, received_at, store_id, created_at, updated_at)
         VALUES (1, 1, 'LOT-1', NULL, ?2, 1, ?1, ?1),
                (2, 1, 'LOT-2', NULL, ?3, 1, ?1, ?1),
                (3, 2, 'LOT-E', ?4, ?5, 1, ?1, ?1),
                (4, 3, 'LOT-B', NULL, ?2, 2, ?1, ?1)`,
      )
      .bind(now, now - 2000, now - 1000, EXPIRY_2026_12_01, now - 3000),
    testEnv.DB
      .prepare(
        `INSERT INTO stocks (id, location_id, lot_id, quantity, version, store_id, created_at, updated_at)
         VALUES (1, 1, 1, 10, 1, 1, ?1, ?1),
                (2, 2, 1, 5, 1, 1, ?1, ?1),
                (3, 1, 2, 3, 1, 1, ?1, ?1),
                (4, 1, 3, 2, 1, 1, ?1, ?1),
                (5, 3, 4, 9, 1, 2, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO reservations (store_id, product_id, location_id, quantity, reason, status, expires_at, created_by, created_at, updated_at)
         VALUES (1, 1, NULL, 4, 'テスト引当', 'active', NULL, 1, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO suppliers (id, name, created_at, updated_at)
         VALUES (1, 'テスト仕入先', ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO purchase_orders (id, supplier_id, status, created_by, store_id, created_at, updated_at)
         VALUES (1, 1, 'ordered', 1, 1, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB.prepare(
      `INSERT INTO purchase_order_lines (po_id, product_id, quantity, received_quantity)
       VALUES (1, 1, 10, 3)`,
    ),
  ]);
});

describe('GET /api/v1/products/:id/availability', () => {
  it('場所・ロット別の内訳と引当・フリー・発注残を返す', async () => {
    const res = await api('/api/v1/products/1/availability', { token: tokenMgr });
    expect(res.status).toBe(200);
    const body = res.body as unknown as AvailabilityBody;
    expect(body.product.sku).toBe('SKU-A');
    expect(body.totals).toEqual({ quantity: 18, reserved: 4, free: 14 });
    expect(body.onOrderQuantity).toBe(7);
    expect(body.stocks).toHaveLength(3);
    const first = body.stocks.find((s) => s.stockId === 1)!;
    expect(first.quantity).toBe(10);
    expect(first.reservedQuantity).toBe(4);
    expect(first.freeQuantity).toBe(6);
  });

  it('他店舗の商品は 404', async () => {
    const res = await api('/api/v1/products/3/availability', { token: tokenMgr });
    expect(res.status).toBe(404);
  });

  it('閲覧者 (stocks.read) でも読める', async () => {
    const res = await api('/api/v1/products/1/availability', { token: tokenViewer });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/movements/bulk', () => {
  const bulkBody = {
    lines: [
      { type: 'IN', locationId: 1, productId: 1, lotCode: 'LOT-1', quantity: 4 },
      { type: 'OUT', productId: 1, quantity: 2, department: 'テスト部', purpose: '一括検証' },
      { type: 'IN', locationId: 1, productId: 2, lotCode: 'LOT-E2', expiryDate: '2027-01-01', quantity: 6 },
    ],
  };
  let bulkKey = '';
  let bulkDocumentId = '';

  it('混在の一括を 1 伝票で適用する', async () => {
    bulkKey = nextKey();
    const res = await api('/api/v1/movements/bulk', {
      token: tokenMgr,
      method: 'POST',
      key: bulkKey,
      body: bulkBody,
    });
    expect(res.status).toBe(201);
    bulkDocumentId = res.body.documentId as string;
    const results = res.body.results as { line: number; type: string; quantity?: number }[];
    expect(results).toHaveLength(3);
    expect(results[0]!.quantity).toBe(14);
    const movements = await api('/api/v1/movements?take=50', { token: tokenMgr });
    const mine = (movements.body as unknown as { documentId: string; type: string }[]).filter(
      (m) => m.documentId === bulkDocumentId,
    );
    expect(mine).toHaveLength(3);
    const avail = await api('/api/v1/products/1/availability', { token: tokenMgr });
    expect((avail.body as unknown as AvailabilityBody).totals.quantity).toBe(20);
  });

  it('同じキーでの再送は冪等 (再適用しない)', async () => {
    const res = await api('/api/v1/movements/bulk', {
      token: tokenMgr,
      method: 'POST',
      key: bulkKey,
      body: bulkBody,
    });
    expect(res.status).toBe(201);
    expect(res.body.documentId).toBe(bulkDocumentId);
    const avail = await api('/api/v1/products/1/availability', { token: tokenMgr });
    expect((avail.body as unknown as AvailabilityBody).totals.quantity).toBe(20);
  });

  it('1 行でも不足すれば全体を止める (先行する入庫も適用されない)', async () => {
    const res = await api('/api/v1/movements/bulk', {
      token: tokenMgr,
      method: 'POST',
      key: nextKey(),
      body: {
        lines: [
          { type: 'IN', locationId: 1, productId: 1, lotCode: 'LOT-9', quantity: 1 },
          { type: 'OUT', productId: 1, quantity: 9999, department: 'テスト部', purpose: '不足検証' },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('BULK_LINE_INVALID');
    expect(String(res.body.message)).toContain('line 2');
    const lot = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM lots WHERE lot_code = 'LOT-9'",
    ).first<{ n: number }>();
    expect(lot?.n).toBe(0);
    const avail = await api('/api/v1/products/1/availability', { token: tokenMgr });
    expect((avail.body as unknown as AvailabilityBody).totals.quantity).toBe(20);
  });

  it('同じ一括内の入庫を後続の消費が使える (FEFO 順も一致する)', async () => {
    const res = await api('/api/v1/movements/bulk', {
      token: tokenMgr,
      method: 'POST',
      key: nextKey(),
      body: {
        lines: [
          { type: 'IN', locationId: 1, productId: 2, lotCode: 'LOT-NEW', expiryDate: '2027-06-01', quantity: 5 },
          { type: 'OUT', productId: 2, quantity: 5, department: 'テスト部', purpose: 'FEFO検証' },
        ],
      },
    });
    expect(res.status).toBe(201);
    const avail = await api('/api/v1/products/2/availability', { token: tokenMgr });
    const body = avail.body as unknown as AvailabilityBody;
    expect(body.totals.quantity).toBe(8);
    expect(body.stocks.find((s) => s.lotCode === 'LOT-E')!.quantity).toBe(0);
    expect(body.stocks.find((s) => s.lotCode === 'LOT-E2')!.quantity).toBe(3);
    expect(body.stocks.find((s) => s.lotCode === 'LOT-NEW')!.quantity).toBe(5);
  });

  it('期限必須の商品に期限なし入庫は行番号つきで 422', async () => {
    const res = await api('/api/v1/movements/bulk', {
      token: tokenMgr,
      method: 'POST',
      key: nextKey(),
      body: {
        lines: [{ type: 'IN', locationId: 1, productId: 2, lotCode: 'LOT-X', quantity: 1 }],
      },
    });
    expect(res.status).toBe(422);
    expect(String(res.body.message)).toContain('line 1');
  });

  it('閲覧者は一括入出庫できない (403)', async () => {
    const res = await api('/api/v1/movements/bulk', {
      token: tokenViewer,
      method: 'POST',
      key: nextKey(),
      body: {
        lines: [{ type: 'IN', locationId: 1, productId: 1, lotCode: 'LOT-1', quantity: 1 }],
      },
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/v1/lots/:id/history', () => {
  it('ロットの現在庫と入出庫の累計・履歴を返す', async () => {
    const res = await api('/api/v1/lots/1/history', { token: tokenMgr });
    expect(res.status).toBe(200);
    const body = res.body as unknown as LotHistoryBody;
    expect(body.lot.lotCode).toBe('LOT-1');
    expect(body.lot.productSku).toBe('SKU-A');
    expect(body.totals).toEqual({ totalIn: 4, totalOut: 2, currentQuantity: 17 });
    expect(body.movements).toHaveLength(2);
    expect(body.movements[0]!.quantityChange).toBe(-2);
    expect(body.movements[1]!.quantityChange).toBe(4);
  });

  it('take で履歴件数を絞れる', async () => {
    const res = await api('/api/v1/lots/1/history?take=1', { token: tokenMgr });
    expect(res.status).toBe(200);
    expect((res.body as unknown as LotHistoryBody).movements).toHaveLength(1);
  });

  it('他店舗のロットは双方向に 404', async () => {
    const a = await api('/api/v1/lots/4/history', { token: tokenMgr });
    expect(a.status).toBe(404);
    const b = await api('/api/v1/lots/1/history', { token: tokenMgrB });
    expect(b.status).toBe(404);
  });
});

describe('GET /api/v1/movements?sinceId=', () => {
  it('sinceId より後だけを古い順に返し、新規分だけを差分で取れる', async () => {
    const all = await api('/api/v1/movements?take=200', { token: tokenMgr });
    const rows = all.body as unknown as { id: number }[];
    expect(rows.length).toBeGreaterThan(0);
    const maxId = rows[0]!.id;
    const none = await api(`/api/v1/movements?sinceId=${maxId}`, { token: tokenMgr });
    expect(none.body as unknown as unknown[]).toHaveLength(0);
    const asc = await api('/api/v1/movements?sinceId=0&take=200', { token: tokenMgr });
    const ascRows = asc.body as unknown as { id: number }[];
    expect(ascRows).toHaveLength(rows.length);
    for (let i = 1; i < ascRows.length; i++) {
      expect(ascRows[i]!.id).toBeGreaterThan(ascRows[i - 1]!.id);
    }
    const inbound = await api('/api/v1/movements/inbound', {
      token: tokenMgr,
      method: 'POST',
      key: nextKey(),
      body: { locationId: 1, productId: 1, lotCode: 'LOT-1', quantity: 1 },
    });
    expect(inbound.status).toBe(201);
    const diff = await api(`/api/v1/movements?sinceId=${maxId}`, { token: tokenMgr });
    const diffRows = diff.body as unknown as { id: number }[];
    expect(diffRows).toHaveLength(1);
    expect(diffRows[0]!.id).toBeGreaterThan(maxId);
  });
});

describe('権限 (stocks.read を外した閲覧者)', () => {
  it('在庫内訳とロット追跡が 403 になる', async () => {
    await testEnv.DB.prepare(
      "DELETE FROM role_permissions WHERE role_code = 'VIEWER' AND permission_key = 'stocks.read'",
    ).run();
    const a = await api('/api/v1/products/1/availability', { token: tokenViewer });
    expect(a.status).toBe(403);
    const b = await api('/api/v1/lots/1/history', { token: tokenViewer });
    expect(b.status).toBe(403);
  });
});
