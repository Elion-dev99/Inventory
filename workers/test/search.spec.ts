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

/**
 * 横断検索 GET /api/v1/search の結合テスト。
 * 商品・保管場所・入出庫履歴を現在の店舗の中だけから探すこと、
 * 並び順 (バーコード完全一致を先頭)、LIKE エスケープ、権限を検証する。
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

let tokenA = '';
let tokenB = '';
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
  return `search-test-${keySeq}`;
}

function inbound(token: string, locationId: number, productId: number, quantity: number) {
  return api('/api/v1/movements/inbound', {
    token,
    method: 'POST',
    key: nextKey(),
    body: { locationId, productId, lotCode: 'L-1', quantity },
  });
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

interface SearchBody {
  query: string;
  products: { id: number; sku: string; name: string; barcode: string | null; totalQuantity: number; locationCount: number }[];
  locations: { id: number; code: string; name: string; warehouseName: string; stockCount: number }[];
  movements: { id: number; productName: string; locationName: string }[];
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
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB
      .prepare(
        `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
         VALUES (2, 'sub-staff-a', 'a@example.com', 'StaffA', 'active', ?1, ?1),
                (3, 'sub-staff-b', 'b@example.com', 'StaffB', 'active', ?1, ?1),
                (4, 'sub-viewer-a', 'viewer@example.com', 'ViewerA', 'active', ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO stores (id, code, name, status, created_at, updated_at)
         VALUES (2, 'STORE-B', '店舗B', 'active', ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (2, 'INVENTORY_STAFF', NULL, 1),
              (3, 'INVENTORY_STAFF', NULL, 2),
              (4, 'VIEWER', NULL, 1)`,
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
         VALUES (1, 1, '1F', '1階倉庫', ?1, ?1), (2, 1, '2F', '2階倉庫', ?1, ?1),
                (3, 2, 'B1', 'B倉庫棚', ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO products (id, sku, name, unit, barcode, safety_stock, requires_expiry, store_id, created_at, updated_at)
         VALUES (1, 'SKU-001', 'ティッシュ', '箱', '4901111111111', 0, 0, 1, ?1, ?1),
                (2, 'SKU-002', 'ティッシュペーパー詰替', '袋', NULL, 0, 0, 1, ?1, ?1),
                (3, 'SKU-001', 'ティッシュ', '箱', '4901111111111', 0, 0, 2, ?1, ?1)`,
      )
      .bind(now),
  ]);

  tokenA = await mintToken('sub-staff-a', 'a@example.com', privateKey);
  tokenB = await mintToken('sub-staff-b', 'b@example.com', privateKey);
  tokenViewer = await mintToken('sub-viewer-a', 'viewer@example.com', privateKey);

  // 在庫と履歴を用意する (店舗A: 商品1×10 / 商品2×3、店舗B: 商品3×7)
  expect((await inbound(tokenA, 1, 1, 10)).status).toBe(201);
  expect((await inbound(tokenA, 2, 2, 3)).status).toBe(201);
  expect((await inbound(tokenB, 3, 3, 7)).status).toBe(201);
});

describe('横断検索 /api/v1/search', () => {
  it('商品・履歴が現在の店舗の中だけから見つかり、在庫合計が付く', async () => {
    const res = await api('/api/v1/search?q=' + encodeURIComponent('ティッシュ'), { token: tokenA });
    expect(res.status).toBe(200);
    const body = res.body as unknown as SearchBody;
    expect(body.query).toBe('ティッシュ');
    // 店舗Bの同名商品 (id=3) は混ざらない
    expect(body.products.map((p) => p.id)).toEqual([1, 2]);
    expect(body.products[0]!.totalQuantity).toBe(10);
    expect(body.products[0]!.locationCount).toBe(1);
    expect(body.products[1]!.totalQuantity).toBe(3);
    // 履歴も店舗Aの分だけ
    expect(body.movements.length).toBe(2);
    expect(body.movements.every((m) => m.productName.includes('ティッシュ'))).toBe(true);
    expect(body.locations).toEqual([]);
  });

  it('バーコード完全一致で該当商品が先頭に来る', async () => {
    const res = await api('/api/v1/search?q=4901111111111', { token: tokenA });
    expect(res.status).toBe(200);
    const body = res.body as unknown as SearchBody;
    expect(body.products.length).toBe(1);
    expect(body.products[0]!.id).toBe(1);
  });

  it('保管場所は名前・コードから見つかり、在庫のある件数が付く', async () => {
    const res = await api('/api/v1/search?q=' + encodeURIComponent('倉庫'), { token: tokenA });
    expect(res.status).toBe(200);
    const body = res.body as unknown as SearchBody;
    // 店舗Bの「B倉庫棚」は混ざらない
    expect(body.locations.map((l) => l.id)).toEqual([1, 2]);
    expect(body.locations[0]!.warehouseName).toBe('A倉庫');
    expect(body.locations[0]!.stockCount).toBe(1);
    const byCode = await api('/api/v1/search?q=2F', { token: tokenA });
    expect((byCode.body as unknown as SearchBody).locations.map((l) => l.id)).toEqual([2]);
  });

  it('q が無い・空白だけなら 400', async () => {
    expect((await api('/api/v1/search', { token: tokenA })).status).toBe(400);
    expect((await api('/api/v1/search?q=' + encodeURIComponent('  '), { token: tokenA })).status).toBe(400);
  });

  it('LIKE のワイルドカードは文字として扱う (% で全件にならない)', async () => {
    const res = await api('/api/v1/search?q=' + encodeURIComponent('%'), { token: tokenA });
    expect(res.status).toBe(200);
    const body = res.body as unknown as SearchBody;
    expect(body.products).toEqual([]);
    expect(body.locations).toEqual([]);
    expect(body.movements).toEqual([]);
  });

  it('take で各グループの件数を絞れる', async () => {
    const res = await api('/api/v1/search?q=' + encodeURIComponent('ティッシュ') + '&take=1', { token: tokenA });
    const body = res.body as unknown as SearchBody;
    expect(body.products.length).toBe(1);
    expect(body.movements.length).toBe(1);
  });

  it('stocks.read を持たないロールは 403', async () => {
    // VIEWER から stocks.read を外した状態にする (このファイル専用の DB)
    await testEnv.DB.prepare(
      "DELETE FROM role_permissions WHERE role_code = 'VIEWER' AND permission_key = 'stocks.read'",
    ).run();
    const res = await api('/api/v1/search?q=' + encodeURIComponent('ティッシュ'), { token: tokenViewer });
    expect(res.status).toBe(403);
  });
});
