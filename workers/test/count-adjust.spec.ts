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
import maintenanceWindowsSql from '../migrations/0011_maintenance_windows.sql?raw';
import maintenanceExtrasSql from '../migrations/0012_maintenance_extras.sql?raw';
import announcementsSql from '../migrations/0013_announcements.sql?raw';
import practicalSql from '../migrations/0014_practical.sql?raw';
import commercialSql from '../migrations/0015_commercial.sql?raw';
import operationsSql from '../migrations/0016_operations.sql?raw';

/**
 * 個数記録 (実数調整) POST /api/v1/stocks/count の結合テスト。
 * 在庫チェックで数えた実数に場所の合計を合わせる:
 * - 減分は FEFO 順、増分は FEFO で最後に消費されるロットへ寄せる
 * - 台帳は ADJUST (reason 'count-adjustment')、差分ゼロでも記録が残る
 * - 在庫行が無い場所では実数分のロット・在庫行を作る
 * - 権限は stocktakes.manage、冪等キー必須
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let managerToken = '';
let viewerToken = '';
let idemSeq = 0;
let locationId = 0;
let productId = 0;
let emptyProductId = 0;

async function mintToken(sub: string, email: string, privateKey: KeyLike): Promise<string> {
  return new SignJWT({ email, name: sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function api(
  path: string,
  token: string,
  init: { method?: string; body?: unknown; key?: string | null } = {},
): Promise<ApiResult> {
  idemSeq += 1;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.key !== null) headers['Idempotency-Key'] = init.key ?? `count-${idemSeq}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: init.method ?? 'GET',
    headers,
    body,
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
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

async function lotQuantities(pid: number): Promise<Record<string, number>> {
  const { results } = await testEnv.DB.prepare(
    `SELECT l.lot_code AS lotCode, s.quantity FROM stocks s JOIN lots l ON l.id = s.lot_id
      WHERE l.product_id = ?1 AND s.location_id = ?2 ORDER BY l.lot_code`,
  )
    .bind(pid, locationId)
    .all<{ lotCode: string; quantity: number }>();
  const out: Record<string, number> = {};
  for (const r of results) out[r.lotCode] = r.quantity;
  return out;
}

async function adjustMovements(pid: number): Promise<{ lotCode: string; change: number; before: number; after: number; reason: string }[]> {
  const { results } = await testEnv.DB.prepare(
    `SELECT l.lot_code AS lotCode, mv.quantity_change AS change, mv.quantity_before AS before,
            mv.quantity_after AS after, mv.reason AS reason
       FROM stock_movements mv
       JOIN stocks s ON s.id = mv.stock_id
       JOIN lots l ON l.id = s.lot_id
      WHERE l.product_id = ?1 AND mv.type = 'ADJUST'
      ORDER BY mv.id`,
  )
    .bind(pid)
    .all<{ lotCode: string; change: number; before: number; after: number; reason: string }>();
  return results;
}

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
       VALUES (2, 'sub-manager', 'manager@example.com', 'Manager', 'active', ?1, ?1),
              (3, 'sub-viewer', 'viewer@example.com', 'Viewer', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
       VALUES (1, 'WH1', '本社倉庫', 1, ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (2, 'INVENTORY_MANAGER', NULL, 1), (3, 'VIEWER', NULL, 1)`,
    ),
  ]);
  managerToken = await mintToken('sub-manager', 'manager@example.com', privateKey);
  viewerToken = await mintToken('sub-viewer', 'viewer@example.com', privateKey);

  const loc = await api('/api/v1/master/locations', managerToken, {
    method: 'POST',
    body: { warehouseId: 1, code: 'A-1', name: '棚A-1' },
  });
  expect(loc.status).toBe(201);
  locationId = loc.body.id;

  const prod = await api('/api/v1/master/products', managerToken, {
    method: 'POST',
    body: { sku: 'SKU-COUNT', name: '数える商品', unit: '個' },
  });
  expect(prod.status).toBe(201);
  productId = prod.body.id;

  const empty = await api('/api/v1/master/products', managerToken, {
    method: 'POST',
    body: { sku: 'SKU-COUNT-EMPTY', name: '在庫なし商品', unit: '個' },
  });
  expect(empty.status).toBe(201);
  emptyProductId = empty.body.id;

  // LOT-B (期限が早い) 5 個、LOT-A (期限が遅い) 10 個 = 合計 15
  const inB = await api('/api/v1/movements/inbound', managerToken, {
    method: 'POST',
    body: { locationId, productId, lotCode: 'LOT-B', expiryDate: '2027-06-01', quantity: 5 },
  });
  expect(inB.status).toBe(201);
  const inA = await api('/api/v1/movements/inbound', managerToken, {
    method: 'POST',
    body: { locationId, productId, lotCode: 'LOT-A', expiryDate: '2028-01-01', quantity: 10 },
  });
  expect(inA.status).toBe(201);
});

describe('個数記録 (実数調整)', () => {
  it('減分は FEFO 順 (期限の早いロットから) に引かれ、ADJUST で記録される', async () => {
    const res = await api('/api/v1/stocks/count', managerToken, {
      method: 'POST',
      body: { productId, locationId, countedQuantity: 12 },
    });
    expect(res.status).toBe(200);
    expect(res.body.previousQuantity).toBe(15);
    expect(res.body.countedQuantity).toBe(12);
    expect(res.body.delta).toBe(-3);
    expect(await lotQuantities(productId)).toEqual({ 'LOT-A': 10, 'LOT-B': 2 });
    const moves = await adjustMovements(productId);
    expect(moves).toEqual([
      { lotCode: 'LOT-B', change: -3, before: 5, after: 2, reason: 'count-adjustment' },
    ]);
  });

  it('増分は FEFO で最後に消費されるロット (期限が最も遅いもの) に寄る', async () => {
    const res = await api('/api/v1/stocks/count', managerToken, {
      method: 'POST',
      body: { productId, locationId, countedQuantity: 20 },
    });
    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(8);
    expect(await lotQuantities(productId)).toEqual({ 'LOT-A': 18, 'LOT-B': 2 });
  });

  it('差分ゼロでも「数えて一致」が 0 変化の ADJUST として残る', async () => {
    const before = (await adjustMovements(productId)).length;
    const res = await api('/api/v1/stocks/count', managerToken, {
      method: 'POST',
      body: { productId, locationId, countedQuantity: 20 },
    });
    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(0);
    expect(await lotQuantities(productId)).toEqual({ 'LOT-A': 18, 'LOT-B': 2 });
    const moves = await adjustMovements(productId);
    expect(moves.length).toBe(before + 1);
    expect(moves[moves.length - 1]!.change).toBe(0);
  });

  it('実数 0 で全ロットが 0 になる (FEFO 順に全量調整)', async () => {
    const res = await api('/api/v1/stocks/count', managerToken, {
      method: 'POST',
      body: { productId, locationId, countedQuantity: 0 },
    });
    expect(res.status).toBe(200);
    expect(res.body.delta).toBe(-20);
    expect(await lotQuantities(productId)).toEqual({ 'LOT-A': 0, 'LOT-B': 0 });
  });

  it('在庫行が無い場所では実数分のロットと在庫行が作られる', async () => {
    const res = await api('/api/v1/stocks/count', managerToken, {
      method: 'POST',
      body: { productId: emptyProductId, locationId, countedQuantity: 7 },
    });
    expect(res.status).toBe(200);
    expect(res.body.previousQuantity).toBe(0);
    expect(res.body.delta).toBe(7);
    const lots = await lotQuantities(emptyProductId);
    const codes = Object.keys(lots);
    expect(codes.length).toBe(1);
    expect(codes[0]!).toMatch(/^実数調整-\d{8}$/);
    expect(lots[codes[0]!]).toBe(7);
    const moves = await adjustMovements(emptyProductId);
    expect(moves.length).toBe(1);
    expect(moves[0]!.change).toBe(7);
    expect(moves[0]!.before).toBe(0);
    expect(moves[0]!.after).toBe(7);
  });

  it('冪等キーの再送では二重に調整されない', async () => {
    const body = { productId, locationId, countedQuantity: 4 };
    const first = await api('/api/v1/stocks/count', managerToken, { method: 'POST', body, key: 'count-idem-1' });
    expect(first.status).toBe(200);
    expect(first.body.delta).toBe(4);
    const second = await api('/api/v1/stocks/count', managerToken, { method: 'POST', body, key: 'count-idem-1' });
    expect(second.status).toBe(200);
    expect(second.body.documentId).toBe(first.body.documentId);
    const avail = await api(`/api/v1/products/${productId}/availability`, managerToken);
    expect(avail.body.totals.quantity).toBe(4);
  });

  it('stocktakes.manage の無いロールは 403', async () => {
    const res = await api('/api/v1/stocks/count', viewerToken, {
      method: 'POST',
      body: { productId, locationId, countedQuantity: 1 },
    });
    expect(res.status).toBe(403);
  });

  it('負の実数と冪等キー欠落は 400', async () => {
    const neg = await api('/api/v1/stocks/count', managerToken, {
      method: 'POST',
      body: { productId, locationId, countedQuantity: -1 },
    });
    expect(neg.status).toBe(400);
    const noKey = await api('/api/v1/stocks/count', managerToken, {
      method: 'POST',
      body: { productId, locationId, countedQuantity: 1 },
      key: null,
    });
    expect(noKey.status).toBe(400);
  });

  it('他店舗の商品・場所は対象にできない', async () => {
    const res = await api('/api/v1/stocks/count', managerToken, {
      method: 'POST',
      body: { productId: 99999, locationId, countedQuantity: 1 },
    });
    expect(res.status).toBe(400);
  });
});
