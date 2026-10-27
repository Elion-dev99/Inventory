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
import generalizationSql from '../migrations/0020_generalization.sql?raw';

/**
 * 設定の汎用化 (0020) の結合テスト。
 * 店舗設定 (通貨・タイムゾーン)、理由コードのマスタ化と検証、
 * 部門マスタ、商品カテゴリ (作成・絞り込み・削除時の未分類化) を検証する。
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

async function apiList(
  path: string,
  opts: { token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>[] }> {
  const res = await api(path, opts);
  return { status: res.status, body: res.body as unknown as Record<string, unknown>[] };
}

function nextKey(): string {
  keySeq += 1;
  return `generalization-test-${keySeq}`;
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
    ...statementsOf(generalizationSql),
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
         VALUES (1, 1, 'A1', 'A1棚', ?1, ?1), (2, 2, 'B1', 'B1棚', ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO products (id, sku, name, unit, barcode, safety_stock, requires_expiry, store_id, created_at, updated_at)
         VALUES (1, 'SKU-A', '商品A', '個', NULL, 0, 0, 1, ?1, ?1),
                (2, 'SKU-B', '商品B', '個', NULL, 0, 0, 1, ?1, ?1)`,
      )
      .bind(now),
    testEnv.DB
      .prepare(
        `INSERT INTO lots (id, product_id, lot_code, expiry_date, received_at, store_id, created_at, updated_at)
         VALUES (1, 1, 'LOT-1', NULL, ?2, 1, ?1, ?1)`,
      )
      .bind(now, now - 1000),
    testEnv.DB
      .prepare(
        `INSERT INTO stocks (id, location_id, lot_id, quantity, version, store_id, created_at, updated_at)
         VALUES (1, 1, 1, 10, 1, 1, ?1, ?1)`,
      )
      .bind(now),
  ]);
});

describe('店舗設定', () => {
  it('既定値は JPY / Asia/Tokyo', async () => {
    const res = await api('/api/v1/settings', { token: tokenMgr });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ currency: 'JPY', timezone: 'Asia/Tokyo' });
  });

  it('更新できて /me にも反映される', async () => {
    const put = await api('/api/v1/settings', {
      token: tokenMgr,
      method: 'PUT',
      body: { currency: 'USD', timezone: 'America/New_York' },
    });
    expect(put.status).toBe(200);
    expect(put.body.currency).toBe('USD');
    const me = await api('/api/v1/me', { token: tokenMgr });
    expect((me.body.settings as { currency: string }).currency).toBe('USD');
    const back = await api('/api/v1/settings', {
      token: tokenMgr,
      method: 'PUT',
      body: { currency: 'JPY', timezone: 'Asia/Tokyo' },
    });
    expect(back.status).toBe(200);
  });

  it('未対応の通貨と不正なタイムゾーンは 400', async () => {
    const cur = await api('/api/v1/settings', {
      token: tokenMgr,
      method: 'PUT',
      body: { currency: 'XXX' },
    });
    expect(cur.status).toBe(400);
    const tz = await api('/api/v1/settings', {
      token: tokenMgr,
      method: 'PUT',
      body: { timezone: 'Nowhere/Place' },
    });
    expect(tz.status).toBe(400);
  });

  it('閲覧者は更新できない (403)', async () => {
    const res = await api('/api/v1/settings', {
      token: tokenViewer,
      method: 'PUT',
      body: { currency: 'EUR' },
    });
    expect(res.status).toBe(403);
  });
});

describe('理由コードのマスタ化', () => {
  it('初期値は従来の 4 コード (種別ごと)', async () => {
    const res = await apiList('/api/v1/master/reason-codes?kind=return', { token: tokenViewer });
    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.code)).toEqual(['damaged', 'expired', 'defective', 'other']);
    expect(res.body[0]!.label).toBe('破損');
  });

  it('従来コードで返品できる / 未知のコードは 400', async () => {
    const ok = await api('/api/v1/movements/return', {
      token: tokenMgr,
      method: 'POST',
      key: nextKey(),
      body: { locationId: 1, productId: 1, lotCode: 'LOT-1', quantity: 1, reasonCode: 'damaged', reason: '破損で戻り' },
    });
    expect(ok.status).toBe(201);
    const bad = await api('/api/v1/movements/return', {
      token: tokenMgr,
      method: 'POST',
      key: nextKey(),
      body: { locationId: 1, productId: 1, lotCode: 'LOT-1', quantity: 1, reasonCode: 'water_damage', reason: '水濡れ' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('INVALID_REASON_CODE');
  });

  it('コードを追加すると使えるようになり、重複は 409', async () => {
    const created = await api('/api/v1/master/reason-codes', {
      token: tokenMgr,
      method: 'POST',
      body: { kind: 'return', code: 'water_damage', label: '水濡れ' },
    });
    expect(created.status).toBe(201);
    const dup = await api('/api/v1/master/reason-codes', {
      token: tokenMgr,
      method: 'POST',
      body: { kind: 'return', code: 'water_damage', label: '水濡れ2' },
    });
    expect(dup.status).toBe(409);
    const use = await api('/api/v1/movements/return', {
      token: tokenMgr,
      method: 'POST',
      key: nextKey(),
      body: { locationId: 1, productId: 1, lotCode: 'LOT-1', quantity: 1, reasonCode: 'water_damage', reason: '水濡れで戻り' },
    });
    expect(use.status).toBe(201);
  });

  it('無効化したコードは使えなくなる (種別は独立)', async () => {
    const list = await apiList('/api/v1/master/reason-codes?kind=return&all=1', { token: tokenMgr });
    const damaged = list.body.find((r) => r.code === 'damaged')!;
    const put = await api(`/api/v1/master/reason-codes/${damaged.id}`, {
      token: tokenMgr,
      method: 'PUT',
      body: { isActive: false },
    });
    expect(put.status).toBe(200);
    const bad = await api('/api/v1/movements/return', {
      token: tokenMgr,
      method: 'POST',
      key: nextKey(),
      body: { locationId: 1, productId: 1, lotCode: 'LOT-1', quantity: 1, reasonCode: 'damaged', reason: '破損で戻り' },
    });
    expect(bad.status).toBe(400);
    // 廃棄側の damaged は有効なまま
    const disposal = await api('/api/v1/movements/disposal', {
      token: tokenMgr,
      method: 'POST',
      key: nextKey(),
      body: { productId: 1, quantity: 1, reasonCode: 'damaged', reason: '破損のため廃棄' },
    });
    expect(disposal.status).toBe(201);
  });

  it('閲覧者はコードを追加できない (403)', async () => {
    const res = await api('/api/v1/master/reason-codes', {
      token: tokenViewer,
      method: 'POST',
      body: { kind: 'return', code: 'x_code', label: 'x' },
    });
    expect(res.status).toBe(403);
  });
});

describe('部門マスタ', () => {
  it('追加・重複拒否・無効化ができる', async () => {
    const created = await api('/api/v1/master/departments', {
      token: tokenMgr,
      method: 'POST',
      body: { name: '販売部' },
    });
    expect(created.status).toBe(201);
    const dup = await api('/api/v1/master/departments', {
      token: tokenMgr,
      method: 'POST',
      body: { name: '販売部' },
    });
    expect(dup.status).toBe(409);
    const list = await apiList('/api/v1/master/departments', { token: tokenMgr });
    expect(list.body.map((d) => d.name)).toContain('販売部');
    const put = await api(`/api/v1/master/departments/${created.body.id}`, {
      token: tokenMgr,
      method: 'PUT',
      body: { isActive: false },
    });
    expect(put.status).toBe(200);
    const active = await apiList('/api/v1/master/departments', { token: tokenMgr });
    expect(active.body.map((d) => d.name)).not.toContain('販売部');
    const all = await apiList('/api/v1/master/departments?all=1', { token: tokenMgr });
    expect(all.body.map((d) => d.name)).toContain('販売部');
  });

  it('部門名は消費の履歴にそのまま残る (スナップショット)', async () => {
    const res = await api('/api/v1/movements/consumption', {
      token: tokenMgr,
      method: 'POST',
      key: nextKey(),
      body: { productId: 1, quantity: 1, department: '販売部', purpose: 'テスト消費' },
    });
    expect(res.status).toBe(201);
  });
});

describe('商品カテゴリ', () => {
  let categoryId = 0;

  it('カテゴリを作って商品に付け、一覧で名前と絞り込みが効く', async () => {
    const created = await api('/api/v1/master/categories', {
      token: tokenMgr,
      method: 'POST',
      body: { name: '消耗品' },
    });
    expect(created.status).toBe(201);
    categoryId = created.body.id as number;
    const product = await api('/api/v1/master/products', {
      token: tokenMgr,
      method: 'POST',
      body: { sku: 'SKU-C', name: '商品C', unit: '個', categoryId },
    });
    expect(product.status).toBe(201);
    const list = await apiList('/api/v1/master/products?take=50', { token: tokenMgr });
    const c = list.body.find((p) => p.sku === 'SKU-C')!;
    expect(c.categoryId).toBe(categoryId);
    expect(c.categoryName).toBe('消耗品');
    const filtered = await apiList(`/api/v1/master/products?categoryId=${categoryId}`, { token: tokenMgr });
    expect(filtered.body.map((p) => p.sku)).toEqual(['SKU-C']);
    const none = await apiList('/api/v1/master/products?categoryId=none&take=50', { token: tokenMgr });
    expect(none.body.map((p) => p.sku)).not.toContain('SKU-C');
    expect(none.body.map((p) => p.sku)).toContain('SKU-A');
  });

  it('存在しないカテゴリや他店舗のカテゴリは 400', async () => {
    const bad = await api('/api/v1/master/products', {
      token: tokenMgr,
      method: 'POST',
      body: { sku: 'SKU-D', name: '商品D', unit: '個', categoryId: 99999 },
    });
    expect(bad.status).toBe(400);
    const cross = await api('/api/v1/master/products', {
      token: tokenMgrB,
      method: 'POST',
      body: { sku: 'SKU-E', name: '商品E', unit: '個', categoryId },
    });
    expect(cross.status).toBe(400);
  });

  it('カテゴリを消すと商品は未分類に戻る', async () => {
    const del = await api(`/api/v1/master/categories/${categoryId}`, {
      token: tokenMgr,
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    const list = await apiList('/api/v1/master/products?take=50', { token: tokenMgr });
    const c = list.body.find((p) => p.sku === 'SKU-C')!;
    expect(c.categoryId).toBeNull();
    const cats = await apiList('/api/v1/master/categories', { token: tokenMgr });
    expect(cats.body.map((x) => x.id)).not.toContain(categoryId);
  });
});
