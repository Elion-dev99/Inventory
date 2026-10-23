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
import { createSession } from '../src/lib/session';

/**
 * 複数店舗 (テナント) 対応の結合テスト (migration 0008 以降)。
 *
 * - 店舗 1 = DGOSK (migration の seed)、店舗 2 = STORE-B を直接投入する。
 * - ユーザー: 1 = 全体管理者、2 = 店舗A担当、3 = 店舗B担当、
 *   4 = 両店舗所属、5 = 店舗Aの店舗管理者 (SYSTEM_ADMIN / 店舗 1)、
 *   6 = 割当なし (全体コンソールから後で割り当てる)。
 * - 店舗切替や未選択 409 は Cookie セッションで検証する (Bearer には
 *   セッションが無いため)。業務の基本確認はセッション・Bearer 併用。
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let platformToken = '';
let storeAdminToken = '';
let cookiePlatform = '';
let cookieA = '';
let cookieB = '';
let cookieMulti = '';
let keySeq = 0;

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
  body: Record<string, unknown>;
}

async function api(
  path: string,
  opts: { cookie?: string; token?: string; method?: string; body?: unknown; key?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `session=${opts.cookie}`;
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
  return `ms-test-${keySeq}`;
}

function inbound(cookie: string, locationId: number, productId: number, lotCode: string, quantity: number, key?: string) {
  return api('/api/v1/movements/inbound', {
    cookie,
    method: 'POST',
    key: key ?? nextKey(),
    body: { locationId, productId, lotCode, quantity },
  });
}

/** D1 exec() はコメントのみの行を処理できないため、除いてから文単位で流す */
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
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-platform', 'platform@example.com', 'Platform', 'active', ?1, ?1),
              (2, 'sub-staff-a', 'a@example.com', 'StaffA', 'active', ?1, ?1),
              (3, 'sub-staff-b', 'b@example.com', 'StaffB', 'active', ?1, ?1),
              (4, 'sub-multi', 'multi@example.com', 'Multi', 'active', ?1, ?1),
              (5, 'sub-store-admin', 'sadmin@example.com', 'StoreAdmin', 'active', ?1, ?1),
              (6, 'sub-new', 'new@example.com', 'New', 'active', ?1, ?1)`,
    ).bind(now),
    // 店舗 2 (店舗 1 = DGOSK は migration が投入済み)
    testEnv.DB.prepare(
      `INSERT INTO stores (id, code, name, status, created_at, updated_at)
       VALUES (2, 'STORE-B', '店舗B', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, NULL),
              (2, 'INVENTORY_STAFF', NULL, 1),
              (3, 'INVENTORY_STAFF', NULL, 2),
              (4, 'INVENTORY_STAFF', NULL, 1),
              (4, 'INVENTORY_STAFF', NULL, 2),
              (5, 'SYSTEM_ADMIN', NULL, 1)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
       VALUES (1, 'WH-A', 'A倉庫', 1, ?1, ?1), (2, 'WH-B', 'B倉庫', 2, ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
       VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1), (2, 2, 'B-1', '棚B-1', ?1, ?1),
              (3, 1, 'A-2', '棚A-2', ?1, ?1), (4, 2, 'B-2', '棚B-2', ?1, ?1)`,
    ).bind(now),
    // 同じ SKU が店舗ごとに持てることもここで固定する (UNIQUE は店舗スコープ)
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, store_id, created_at, updated_at)
       VALUES (1, 'SKU-SHARED', '共有SKU (店舗A)', '個', 0, 0, 1, ?1, ?1),
              (2, 'SKU-SHARED', '共有SKU (店舗B)', '個', 0, 0, 2, ?1, ?1),
              (3, 'SKU-B-ONLY', '店舗B専用', '個', 0, 0, 2, ?1, ?1)`,
    ).bind(now),
  ]);

  platformToken = await mintToken('sub-platform', 'platform@example.com', privateKey);
  storeAdminToken = await mintToken('sub-store-admin', 'sadmin@example.com', privateKey);
  cookiePlatform = await createSession(testEnv.DB, 1);
  cookieA = await createSession(testEnv.DB, 2);
  cookieB = await createSession(testEnv.DB, 3);
  cookieMulti = await createSession(testEnv.DB, 4);
});

describe('複数店舗 (テナント) 分離', () => {
  it('在庫・商品・履歴は店舗ごとに分離され、他店舗の ID は 404 になる', async () => {
    const inA = await inbound(cookieA, 1, 1, 'LOT-A1', 10);
    expect(inA.status).toBe(201);
    const stockA = inA.body.stockId as number;
    const inB = await inbound(cookieB, 2, 2, 'LOT-B1', 7);
    expect(inB.status).toBe(201);

    // 店舗B の在庫一覧には店舗A の在庫が無い
    const stocksB = await api('/api/v1/stocks?take=200', { cookie: cookieB });
    expect(stocksB.status).toBe(200);
    const rowsB = stocksB.body as unknown as { id: number; productId: number; warehouseId: number }[];
    expect(rowsB.length).toBeGreaterThan(0);
    expect(rowsB.every((r) => r.warehouseId === 2)).toBe(true);
    expect(rowsB.some((r) => r.id === stockA)).toBe(false);

    // 他店舗の stock を ID 指定しても 404 (存在を漏らさない)
    const other = await api(`/api/v1/stocks/${stockA}`, { cookie: cookieB });
    expect(other.status).toBe(404);
    const own = await api(`/api/v1/stocks/${stockA}`, { cookie: cookieA });
    expect(own.status).toBe(200);

    // 商品マスタも店舗ごと (店舗B からは店舗A の商品 id=1 が見えない)
    const productsB = await api('/api/v1/master/products?take=200', { cookie: cookieB });
    const pids = (productsB.body as unknown as { id: number }[]).map((p) => p.id);
    expect(pids).toContain(2);
    expect(pids).toContain(3);
    expect(pids).not.toContain(1);

    // 履歴も店舗ごと
    const movementsB = await api('/api/v1/movements?take=100', { cookie: cookieB });
    const mrows = movementsB.body as unknown as { warehouseId: number }[];
    expect(mrows.length).toBeGreaterThan(0);
    expect(mrows.every((m) => m.warehouseId === 2)).toBe(true);
  });

  it('店舗未選択では業務 API が 409 STORE_NOT_SELECTED、選択後はその店舗で動く', async () => {
    // 両店舗所属のセッションは自動選択されない
    const me = await api('/api/v1/me', { cookie: cookieMulti });
    expect(me.status).toBe(200);
    expect(me.body.currentStore).toBeNull();
    expect((me.body.stores as unknown[]).length).toBe(2);
    expect(me.body.isPlatformAdmin).toBe(false);

    const denied = await api('/api/v1/stocks', { cookie: cookieMulti });
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe('STORE_NOT_SELECTED');

    const stores = await api('/api/v1/stores', { cookie: cookieMulti });
    expect(stores.status).toBe(200);
    expect((stores.body.stores as unknown[]).length).toBe(2);
    expect(stores.body.currentStoreId).toBeNull();

    const selected = await api('/api/v1/session/store', {
      cookie: cookieMulti,
      method: 'POST',
      body: { storeId: 2 },
    });
    expect(selected.status).toBe(200);

    const me2 = await api('/api/v1/me', { cookie: cookieMulti });
    expect((me2.body.currentStore as { id: number }).id).toBe(2);
    const stocks = await api('/api/v1/stocks?take=200', { cookie: cookieMulti });
    expect(stocks.status).toBe(200);
    const rows = stocks.body as unknown as { warehouseId: number }[];
    expect(rows.every((r) => r.warehouseId === 2)).toBe(true);
  });

  it('所属していない店舗への切替は 403', async () => {
    const res = await api('/api/v1/session/store', {
      cookie: cookieA,
      method: 'POST',
      body: { storeId: 2 },
    });
    expect(res.status).toBe(403);
    // 店舗A のセッションは店舗A のまま
    const me = await api('/api/v1/me', { cookie: cookieA });
    expect((me.body.currentStore as { id: number }).id).toBe(1);
  });

  it('棚卸しロックは店舗ごとに独立する', async () => {
    const started = await api('/api/v1/stocktakes', { token: storeAdminToken, method: 'POST' });
    expect(started.status).toBe(201);
    const stocktakeId = started.body.id as number;

    // 店舗A はロックされる
    const blocked = await inbound(cookieA, 1, 1, 'LOT-LOCK', 1);
    expect(blocked.status).toBe(423);
    // 店舗B は影響を受けない
    const okB = await inbound(cookieB, 2, 2, 'LOT-LOCK-B', 3);
    expect(okB.status).toBe(201);

    const finished = await api(`/api/v1/stocktakes/${stocktakeId}/finish`, {
      token: storeAdminToken,
      method: 'POST',
    });
    expect(finished.status).toBe(200);
    const after = await inbound(cookieA, 1, 1, 'LOT-LOCK', 1);
    expect(after.status).toBe(201);
  });

  it('機能フラグは店舗ごとに解決される', async () => {
    const off = await api('/api/v1/platform/stores/1/features/transfers', {
      token: platformToken,
      method: 'PUT',
      body: { enabled: false },
    });
    expect(off.status).toBe(200);

    const featuresA = await api('/api/v1/features', { cookie: cookieA });
    expect((featuresA.body.features as Record<string, boolean>).transfers).toBe(false);
    const featuresB = await api('/api/v1/features', { cookie: cookieB });
    expect((featuresB.body.features as Record<string, boolean>).transfers).toBe(true);

    // 店舗A では移動が FEATURE_DISABLED で止まる
    const transferA = await api('/api/v1/movements/transfer', {
      cookie: cookieA,
      method: 'POST',
      key: nextKey(),
      body: { fromLocationId: 1, toLocationId: 3, productId: 1, quantity: 1 },
    });
    expect(transferA.status).toBe(403);
    expect(transferA.body.error).toBe('FEATURE_DISABLED');

    // 店舗B では移動できる
    const seed = await inbound(cookieB, 2, 2, 'LOT-TR-B', 5);
    expect(seed.status).toBe(201);
    const transferB = await api('/api/v1/movements/transfer', {
      cookie: cookieB,
      method: 'POST',
      key: nextKey(),
      body: { fromLocationId: 2, toLocationId: 4, productId: 2, quantity: 2 },
    });
    expect(transferB.status).toBe(201);

    // 後片付け: 店舗A の移動を戻す
    const on = await api('/api/v1/platform/stores/1/features/transfers', {
      token: platformToken,
      method: 'PUT',
      body: { enabled: true },
    });
    expect(on.status).toBe(200);
  });

  it('全体 API は店舗管理者・担当者には 403、全体管理者には開く', async () => {
    const byStoreAdmin = await api('/api/v1/platform/stores', { token: storeAdminToken });
    expect(byStoreAdmin.status).toBe(403);
    const byStaff = await api('/api/v1/platform/stores', { cookie: cookieA });
    expect(byStaff.status).toBe(403);

    const list = await api('/api/v1/platform/stores', { token: platformToken });
    expect(list.status).toBe(200);
    const stores = list.body as unknown as { id: number; code: string; status: string }[];
    expect(stores.map((s) => s.code)).toEqual(['DGOSK', 'STORE-B']);
    expect(stores.every((s) => s.status === 'active')).toBe(true);

    const stats = await api('/api/v1/platform/stores/1/stats', { token: platformToken });
    expect(stats.status).toBe(200);
    expect(stats.body.users).toBe(3); // 店舗A担当 + 両店舗所属 + 店舗管理者
    expect(stats.body.products).toBeGreaterThanOrEqual(1);
    expect(stats.body.stockRecords).toBeGreaterThanOrEqual(1);
    expect(stats.body.movementsLast30Days).toBeGreaterThanOrEqual(1);

    const users = await api('/api/v1/platform/users', { token: platformToken });
    expect(users.status).toBe(200);
    const platformUser = (users.body as unknown as { id: number; assignments: { storeId: number | null }[] }[]).find(
      (u) => u.id === 1,
    );
    expect(platformUser?.assignments).toEqual([
      { roleCode: 'SYSTEM_ADMIN', warehouseId: null, storeId: null },
    ]);
  });

  it('店舗作成 -> 割当 -> その店舗で業務ができる一連の流れ', async () => {
    const created = await api('/api/v1/platform/stores', {
      token: platformToken,
      method: 'POST',
      body: { code: 'STORE-C', name: '店舗C' },
    });
    expect(created.status).toBe(201);
    const storeC = created.body.id as number;

    const dup = await api('/api/v1/platform/stores', {
      token: platformToken,
      method: 'POST',
      body: { code: 'STORE-C', name: '重複' },
    });
    expect(dup.status).toBe(409);

    const assigned = await api('/api/v1/platform/users/6/assignments', {
      token: platformToken,
      method: 'PUT',
      body: { assignments: [{ roleCode: 'INVENTORY_MANAGER', warehouseId: null, storeId: storeC }] },
    });
    expect(assigned.status).toBe(200);

    // 全体割当は SYSTEM_ADMIN 以外に付けられない
    const badPlatform = await api('/api/v1/platform/users/6/assignments', {
      token: platformToken,
      method: 'PUT',
      body: { assignments: [{ roleCode: 'INVENTORY_MANAGER', warehouseId: null, storeId: null }] },
    });
    expect(badPlatform.status).toBe(422);

    const cookieNew = await createSession(testEnv.DB, 6);
    const me = await api('/api/v1/me', { cookie: cookieNew });
    expect((me.body.currentStore as { id: number }).id).toBe(storeC);

    const warehouse = await api('/api/v1/master/warehouses', {
      cookie: cookieNew,
      method: 'POST',
      body: { code: 'WH-C', name: 'C倉庫' },
    });
    expect(warehouse.status).toBe(201);
    const location = await api('/api/v1/master/locations', {
      cookie: cookieNew,
      method: 'POST',
      body: { warehouseId: warehouse.body.id, code: 'C-1', name: '棚C-1' },
    });
    expect(location.status).toBe(201);
    const product = await api('/api/v1/master/products', {
      cookie: cookieNew,
      method: 'POST',
      body: { sku: 'SKU-C', name: '店舗Cの商品', unit: '個' },
    });
    expect(product.status).toBe(201);
    const stocked = await inbound(cookieNew, location.body.id as number, product.body.id as number, 'LOT-C1', 4);
    expect(stocked.status).toBe(201);
    const stocks = await api('/api/v1/stocks?take=200', { cookie: cookieNew });
    expect((stocks.body as unknown as unknown[]).length).toBe(1);

    // 店舗A からは店舗C の商品が見えない
    const productsA = await api('/api/v1/master/products?take=200', { cookie: cookieA });
    const skusA = (productsA.body as unknown as { sku: string }[]).map((p) => p.sku);
    expect(skusA).not.toContain('SKU-C');
  });

  it('冪等キーは店舗スコープ (同じキーでも店舗が違えば別操作)', async () => {
    const sharedKey = 'ms-shared-key';
    // cookieMulti は店舗 2 を選択中 (前のテストで選択)。まず店舗 1 に切り替える
    const toA = await api('/api/v1/session/store', {
      cookie: cookieMulti,
      method: 'POST',
      body: { storeId: 1 },
    });
    expect(toA.status).toBe(200);
    const inA = await api('/api/v1/movements/inbound', {
      cookie: cookieMulti,
      method: 'POST',
      key: sharedKey,
      body: { locationId: 1, productId: 1, lotCode: 'LOT-IDEM', quantity: 3 },
    });
    expect(inA.status).toBe(201);

    const toB = await api('/api/v1/session/store', {
      cookie: cookieMulti,
      method: 'POST',
      body: { storeId: 2 },
    });
    expect(toB.status).toBe(200);
    // 同じキー・同じユーザーでも、店舗が違えばリプレイにも 422 にもならず新規に適用される
    const inB = await api('/api/v1/movements/inbound', {
      cookie: cookieMulti,
      method: 'POST',
      key: sharedKey,
      body: { locationId: 2, productId: 2, lotCode: 'LOT-IDEM', quantity: 3 },
    });
    expect(inB.status).toBe(201);
    expect(inB.body.stockId).not.toBe(inA.body.stockId);
  });

  it('停止した店舗は店舗ユーザーが使えず、全体管理者だけが入れる', async () => {
    const suspended = await api('/api/v1/platform/stores/2', {
      token: platformToken,
      method: 'PUT',
      body: { status: 'suspended' },
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('suspended');

    const blocked = await api('/api/v1/stocks', { cookie: cookieB });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('STORE_SUSPENDED');

    // 店舗B 所属 (両店舗) の切替も止まる
    const switchBlocked = await api('/api/v1/session/store', {
      cookie: cookieMulti,
      method: 'POST',
      body: { storeId: 2 },
    });
    expect(switchBlocked.status).toBe(403);

    // 全体管理者は停止中でも入って確認できる
    const enter = await api('/api/v1/session/store', {
      cookie: cookiePlatform,
      method: 'POST',
      body: { storeId: 2 },
    });
    expect(enter.status).toBe(200);
    const stocks = await api('/api/v1/stocks?take=200', { cookie: cookiePlatform });
    expect(stocks.status).toBe(200);

    // 再開すると店舗ユーザーが戻れる
    const resumed = await api('/api/v1/platform/stores/2', {
      token: platformToken,
      method: 'PUT',
      body: { status: 'active' },
    });
    expect(resumed.status).toBe(200);
    const after = await api('/api/v1/stocks?take=200', { cookie: cookieB });
    expect(after.status).toBe(200);
  });
});
