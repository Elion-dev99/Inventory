import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
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
import { createSession } from '../../workers/src/lib/session';

/**
 * 全体管理 Worker (inventory-admin-workers) の結合テスト。
 * 店舗アプリから分離した全体管理だけを対象にする:
 * - 未認証は 401、それ以外のパス (店舗アプリの資産) は 404
 * - 全体管理者でないユーザーは /auth/callback でログイン自体を拒否される
 *   (セッションを発行しない)
 * - 全体管理者はログインでき、セッションは scope='platform'・有効期限 2 時間
 * - 店舗の作成・停止/再開・統計・割当・機能フラグが一通り動く
 * - scope='app' のセッション (店舗アプリ用) では admin API が使えない
 * Google の JWKS とトークン交換は fetch 差し替えで模擬し、認可コードで
 * 返す ID トークンを切り替える (admin-code / staff-code)。
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';
const ADMIN_NONCE = 'nonce-admin-1';
const STAFF_NONCE = 'nonce-staff-1';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let adminCookie = '';

async function mintToken(
  sub: string,
  email: string,
  privateKey: KeyLike,
  nonce: string,
): Promise<string> {
  return new SignJWT({ email, name: sub, nonce })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function setCookieOf(res: Response): string {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  const list = typeof anyHeaders.getSetCookie === 'function' ? anyHeaders.getSetCookie() : [];
  if (list.length > 0) return list.join(', ');
  return res.headers.get('set-cookie') ?? '';
}

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
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
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
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

  const adminIdToken = await mintToken('sub-platform-admin', 'platform@example.com', privateKey, ADMIN_NONCE);
  const staffIdToken = await mintToken('sub-staff', 'staff@example.com', privateKey, STAFF_NONCE);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const rawBody = init?.body;
      const body =
        typeof rawBody === 'string'
          ? rawBody
          : rawBody instanceof URLSearchParams
            ? rawBody.toString()
            : '';
      const code = new URLSearchParams(body).get('code');
      const idToken = code === 'staff-code' ? staffIdToken : adminIdToken;
      return new Response(JSON.stringify({ id_token: idToken }), {
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
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-platform-admin', 'platform@example.com', 'Platform', 'active', ?1, ?1),
              (2, 'sub-staff', 'staff@example.com', 'Staff', 'active', ?1, ?1),
              (3, 'sub-new', 'new@example.com', 'New', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, NULL),
              (2, 'INVENTORY_STAFF', NULL, 1)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
       VALUES (1, 'WH-A', 'A倉庫', 1, ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, store_id, created_at, updated_at)
       VALUES (1, 'SKU-1', 'テスト品', '個', 0, 0, 1, ?1, ?1)`,
    ).bind(now),
  ]);
});

describe('全体管理 Worker (分離後)', () => {
  it('未認証は 401、コンソール画面だけは 200 で返る', async () => {
    const stores = await api('/api/platform/stores');
    expect(stores.status).toBe(401);
    const me = await api('/api/platform/me');
    expect(me.status).toBe(401);

    const page = await SELF.fetch('https://example.com/');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('全体管理');
    expect(html).toContain('/api/platform/stores');
  });

  it('店舗アプリ側のパスは存在しない (404)', async () => {
    for (const path of ['/app', '/platform', '/api/v1/me', '/api/v1/platform/stores', '/login']) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it('全体管理者でないユーザーはログイン自体を拒否され、セッションが発行されない', async () => {
    const res = await SELF.fetch('https://example.com/auth/callback?code=staff-code', {
      headers: { Cookie: `oauth_nonce=${STAFF_NONCE}` },
    });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain('全体管理者');
    expect(setCookieOf(res)).not.toContain('admin_session=');

    const sessions = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE user_id = 2 AND scope = 'platform'",
    ).first<{ n: number }>();
    expect(sessions?.n).toBe(0);
  });

  it('全体管理者はログインでき、セッションは platform スコープ・有効期限 2 時間', async () => {
    const res = await SELF.fetch('https://example.com/auth/callback?code=admin-code', {
      headers: { Cookie: `oauth_nonce=${ADMIN_NONCE}` },
    });
    expect(res.status).toBe(200);
    const setCookie = setCookieOf(res);
    expect(setCookie).toContain('admin_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Max-Age=7200');

    const match = setCookie.match(/admin_session=([^;,]+)/);
    if (!match?.[1]) throw new Error(`admin_session cookie not found in: ${setCookie}`);
    adminCookie = match[1];

    const row = await testEnv.DB.prepare(
      'SELECT scope, expires_at, created_at FROM sessions WHERE user_id = 1',
    ).first<{ scope: string; expires_at: number; created_at: number }>();
    expect(row?.scope).toBe('platform');
    expect((row?.expires_at ?? 0) - (row?.created_at ?? 0)).toBe(2 * 60 * 60 * 1000);
  });

  it('全体管理者は店舗の作成・停止/再開・統計・割当・機能フラグができる', async () => {
    const me = await api('/api/platform/me', { cookie: adminCookie });
    expect(me.status).toBe(200);
    expect(me.body.isPlatformAdmin).toBe(true);
    expect(me.body.email).toBe('platform@example.com');

    const roles = await api('/api/platform/roles', { cookie: adminCookie });
    expect(roles.status).toBe(200);
    expect((roles.body.roles as { code: string }[]).map((r) => r.code)).toContain('SYSTEM_ADMIN');

    const list = await api('/api/platform/stores', { cookie: adminCookie });
    expect(list.status).toBe(200);
    expect((list.body as unknown as { code: string }[]).map((s) => s.code)).toContain('DGOSK');

    const created = await api('/api/platform/stores', {
      cookie: adminCookie,
      method: 'POST',
      body: { code: 'STORE-X', name: '店舗X' },
    });
    expect(created.status).toBe(201);
    const storeX = created.body.id as number;

    const dup = await api('/api/platform/stores', {
      cookie: adminCookie,
      method: 'POST',
      body: { code: 'STORE-X', name: '重複' },
    });
    expect(dup.status).toBe(409);

    const suspended = await api(`/api/platform/stores/${storeX}`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { status: 'suspended' },
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('suspended');
    const resumed = await api(`/api/platform/stores/${storeX}`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { status: 'active' },
    });
    expect(resumed.body.status).toBe('active');

    const stats = await api('/api/platform/stores/1/stats', { cookie: adminCookie });
    expect(stats.status).toBe(200);
    expect(stats.body.users).toBe(1); // 店舗1の担当 (user 2)
    expect(stats.body.products).toBe(1);

    const users = await api('/api/platform/users', { cookie: adminCookie });
    expect(users.status).toBe(200);
    const platformUser = (users.body as unknown as { id: number; assignments: unknown[] }[]).find((u) => u.id === 1);
    expect(platformUser?.assignments).toEqual([
      { roleCode: 'SYSTEM_ADMIN', warehouseId: null, storeId: null },
    ]);

    // 割当: 新規ユーザー (user 3) を店舗X の担当にする
    const assigned = await api('/api/platform/users/3/assignments', {
      cookie: adminCookie,
      method: 'PUT',
      body: { assignments: [{ roleCode: 'INVENTORY_STAFF', warehouseId: null, storeId: storeX }] },
    });
    expect(assigned.status).toBe(200);
    const roleRow = await testEnv.DB.prepare(
      'SELECT role_code, store_id FROM user_roles WHERE user_id = 3',
    ).first<{ role_code: string; store_id: number }>();
    expect(roleRow?.role_code).toBe('INVENTORY_STAFF');
    expect(roleRow?.store_id).toBe(storeX);

    // 全体割当は SYSTEM_ADMIN 以外に付けられない
    const badPlatform = await api('/api/platform/users/3/assignments', {
      cookie: adminCookie,
      method: 'PUT',
      body: { assignments: [{ roleCode: 'INVENTORY_MANAGER', warehouseId: null, storeId: null }] },
    });
    expect(badPlatform.status).toBe(422);

    // 機能フラグ (店舗ごと)
    const features = await api('/api/platform/stores/1/features', { cookie: adminCookie });
    expect(features.status).toBe(200);
    const off = await api('/api/platform/stores/1/features/transfers', {
      cookie: adminCookie,
      method: 'PUT',
      body: { enabled: false },
    });
    expect(off.status).toBe(200);
    const flag = await testEnv.DB.prepare(
      "SELECT enabled FROM feature_flags WHERE store_id = 1 AND key = 'transfers'",
    ).first<{ enabled: number }>();
    expect(flag?.enabled).toBe(0);
  });

  it("店舗アプリのセッション (scope='app') では admin API が使えない", async () => {
    // 店舗アプリが発行する app スコープのセッション (全体管理者 user 1 用でも不可)
    const appToken = await createSession(testEnv.DB, 1);
    const viaAdminCookie = await api('/api/platform/stores', { cookie: appToken });
    expect(viaAdminCookie.status).toBe(401);

    // platform セッションを店舗アプリの Cookie 名で送っても使えない
    const res = await SELF.fetch('https://example.com/api/platform/stores', {
      headers: { Cookie: `session=${adminCookie}` },
    });
    expect(res.status).toBe(401);
  });

  it('platform スコープでも全体管理者でなければ 403', async () => {
    // ログイン拒否をすり抜けた形 (割当が後から外れた等) を直接セッションで再現する
    const staffPlatformToken = await createSession(testEnv.DB, 2, { scope: 'platform' });
    const stores = await api('/api/platform/stores', { cookie: staffPlatformToken });
    expect(stores.status).toBe(403);
    const me = await api('/api/platform/me', { cookie: staffPlatformToken });
    expect(me.status).toBe(200);
    expect(me.body.isPlatformAdmin).toBe(false);
  });

  it('ログアウトするとセッションが無効になる', async () => {
    const res = await SELF.fetch('https://example.com/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(200);
    expect(setCookieOf(res)).toContain('admin_session=');
    expect(setCookieOf(res)).toContain('Max-Age=0');

    const after = await api('/api/platform/stores', { cookie: adminCookie });
    expect(after.status).toBe(401);
  });
});

/**
 * コンソール拡張 (概要 / ユーザー管理 / 監査 / 店舗詳細 / システム) のテスト。
 * 前の describe の最終テストで管理者セッションはログアウト済みなので、
 * ここでは改めてログインし直す。
 */
describe('全体管理コンソール拡張', () => {
  let admin2 = '';

  beforeAll(async () => {
    const res = await SELF.fetch('https://example.com/auth/callback?code=admin-code', {
      headers: { Cookie: `oauth_nonce=${ADMIN_NONCE}` },
    });
    expect(res.status).toBe(200);
    const match = setCookieOf(res).match(/admin_session=([^;,]+)/);
    if (!match?.[1]) throw new Error('admin_session cookie not found');
    admin2 = match[1];

    // 概要の在庫・移動集計用に、店舗1へ保管場所・ロット・在庫・移動を 1 件ずつ入れる
    const now = Date.now();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
         VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1)`,
      ).bind(now),
      testEnv.DB.prepare(
        `INSERT INTO lots (id, product_id, lot_code, received_at, store_id, created_at, updated_at)
         VALUES (1, 1, 'LOT-1', ?1, 1, ?1, ?1)`,
      ).bind(now),
      testEnv.DB.prepare(
        `INSERT INTO stocks (id, location_id, lot_id, quantity, store_id, created_at, updated_at)
         VALUES (1, 1, 1, 10, 1, ?1, ?1)`,
      ).bind(now),
      testEnv.DB.prepare(
        `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, store_id, created_at)
         VALUES ('doc-ov-1', 1, 'IN', 10, 0, 10, 1, 1, ?1)`,
      ).bind(now),
    ]);
  });

  it('概要 API: 合計・店舗サマリ・全体監査フィードが返る', async () => {
    const res = await api('/api/platform/overview', { cookie: admin2 });
    expect(res.status).toBe(200);
    const totals = res.body.totals as Record<string, number>;
    expect(totals.stores).toBe(2); // DGOSK + STORE-X (前の describe で作成)
    expect(totals.users).toBe(3);
    expect(totals.products).toBe(1);
    expect(totals.stockRecords).toBe(1);
    expect(totals.movements30d).toBe(1);

    const summaries = res.body.storeSummaries as Record<string, unknown>[];
    const dgosk = summaries.find((s) => s.code === 'DGOSK');
    expect(dgosk?.users).toBe(1);
    expect(dgosk?.products).toBe(1);
    expect(dgosk?.stockRecords).toBe(1);

    const feed = res.body.recentPlatformAudit as Record<string, unknown>[];
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.every((a) => a.storeId === null)).toBe(true);
    expect(feed.map((a) => a.action)).toContain('platform.user_roles.update');
    expect(feed[0]?.actorEmail).toBe('platform@example.com');
  });

  it('ユーザー一覧: status・最終ログイン・割当サマリと q 検索', async () => {
    const res = await api('/api/platform/users', { cookie: admin2 });
    expect(res.status).toBe(200);
    const users = res.body as unknown as Record<string, unknown>[];
    const admin = users.find((u) => u.id === 1) as Record<string, unknown>;
    expect(admin.status).toBe('active');
    expect(typeof admin.lastLoginAt).toBe('number'); // ログイン済みなのでセッションがある
    expect((admin.assignmentSummary as Record<string, unknown>).isPlatformAdmin).toBe(true);

    const staff = users.find((u) => u.id === 2) as Record<string, unknown>;
    expect((staff.assignmentSummary as Record<string, unknown>).isPlatformAdmin).toBe(false);
    expect((staff.assignmentSummary as Record<string, unknown>).storeCount).toBe(1);

    const fresh = users.find((u) => u.id === 3) as Record<string, unknown>;
    expect(fresh.lastLoginAt).toBeNull(); // 一度もログインしていない

    const searched = await api('/api/platform/users?q=staff@', { cookie: admin2 });
    const found = searched.body as unknown as Record<string, unknown>[];
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(2);
    const byName = await api('/api/platform/users?q=Plat', { cookie: admin2 });
    expect((byName.body as unknown as Record<string, unknown>[]).map((u) => u.id)).toEqual([1]);
  });

  it('ユーザー停止: 全セッション削除と締め出し、再有効化、自分・最後の管理者は 422', async () => {
    // user 2 に両スコープのセッションを作る
    await createSession(testEnv.DB, 2);
    await createSession(testEnv.DB, 2, { scope: 'platform' });

    const disabled = await api('/api/platform/users/2/status', {
      cookie: admin2,
      method: 'PUT',
      body: { status: 'disabled' },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('disabled');
    const sessions = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE user_id = 2',
    ).first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    const row = await testEnv.DB.prepare('SELECT status FROM users WHERE id = 2').first<{ status: string }>();
    expect(row?.status).toBe('disabled');

    // 自分自身は停止できない
    const selfDisable = await api('/api/platform/users/1/status', {
      cookie: admin2,
      method: 'PUT',
      body: { status: 'disabled' },
    });
    expect(selfDisable.status).toBe(422);
    expect(selfDisable.body.error).toBe('LOCKOUT_PREVENTION');

    // 不正な値・存在しないユーザーは拒否
    const bad = await api('/api/platform/users/2/status', {
      cookie: admin2,
      method: 'PUT',
      body: { status: 'banned' },
    });
    expect(bad.status).toBe(400);
    const missing = await api('/api/platform/users/999/status', {
      cookie: admin2,
      method: 'PUT',
      body: { status: 'disabled' },
    });
    expect(missing.status).toBe(404);

    const enabled = await api('/api/platform/users/2/status', {
      cookie: admin2,
      method: 'PUT',
      body: { status: 'active' },
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.status).toBe('active');
  });

  it('セッション失効: revoke-sessions と revoke-all (自分は残る)', async () => {
    await createSession(testEnv.DB, 3);
    await createSession(testEnv.DB, 3, { scope: 'platform' });
    const revoked = await api('/api/platform/users/3/revoke-sessions', {
      cookie: admin2,
      method: 'POST',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(2);
    const userRow = await testEnv.DB.prepare('SELECT status FROM users WHERE id = 3').first<{ status: string }>();
    expect(userRow?.status).toBe('active'); // 状態は変わらない

    await createSession(testEnv.DB, 2);
    await createSession(testEnv.DB, 3);
    const all = await api('/api/platform/revoke-all-sessions', { cookie: admin2, method: 'POST' });
    expect(all.status).toBe(200);
    expect((all.body.revoked as number) >= 2).toBe(true);
    // 呼び出し元 (admin2) のセッションは残っている
    const stillValid = await api('/api/platform/stores', { cookie: admin2 });
    expect(stillValid.status).toBe(200);
    const others = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM sessions WHERE user_id IN (2, 3)',
    ).first<{ n: number }>();
    expect(others?.n).toBe(0);
  });

  it('監査 API: 店舗・全体・ユーザー・キーワードで絞り込める', async () => {
    const platformOnly = await api('/api/platform/audit-logs?storeId=platform', { cookie: admin2 });
    expect(platformOnly.status).toBe(200);
    const pItems = platformOnly.body.items as Record<string, unknown>[];
    expect(pItems.length).toBeGreaterThan(0);
    expect(pItems.every((a) => a.storeId === null)).toBe(true);
    expect(pItems.some((a) => a.action === 'platform.user.status')).toBe(true);

    const store1 = await api('/api/platform/audit-logs?storeId=1', { cookie: admin2 });
    const sItems = store1.body.items as Record<string, unknown>[];
    expect(sItems.length).toBeGreaterThan(0);
    expect(sItems.every((a) => a.storeId === 1)).toBe(true);
    expect(sItems.some((a) => a.action === 'feature_flag.update')).toBe(true);
    expect(sItems[0]?.storeName).toBe('DGOSK');

    const byUser = await api('/api/platform/audit-logs?userId=1', { cookie: admin2 });
    const uItems = byUser.body.items as Record<string, unknown>[];
    expect(uItems.length).toBeGreaterThan(0);
    expect(uItems.every((a) => a.actorId === 1)).toBe(true);

    const byKeyword = await api('/api/platform/audit-logs?q=user_roles', { cookie: admin2 });
    const kItems = byKeyword.body.items as Record<string, unknown>[];
    expect(kItems.length).toBeGreaterThan(0);
    expect(kItems.every((a) => String(a.action).includes('user_roles'))).toBe(true);

    const limited = await api('/api/platform/audit-logs?limit=1', { cookie: admin2 });
    expect((limited.body.items as unknown[])).toHaveLength(1);
    expect(limited.body.limit).toBe(1);
    expect((limited.body.total as number) > 1).toBe(true);
  });

  it('店舗詳細 API: 倉庫・割当ユーザー・直近監査が返る', async () => {
    const res = await api('/api/platform/stores/1/detail', { cookie: admin2 });
    expect(res.status).toBe(200);
    expect((res.body.store as Record<string, unknown>).code).toBe('DGOSK');
    const warehouses = res.body.warehouses as Record<string, unknown>[];
    expect(warehouses.map((w) => w.code)).toContain('WH-A');
    const users = res.body.users as Record<string, unknown>[];
    const staffAssign = users.find((u) => u.userId === 2);
    expect(staffAssign?.roleCode).toBe('INVENTORY_STAFF');
    expect(staffAssign?.email).toBe('staff@example.com');
    expect(Array.isArray(res.body.recentAudit)).toBe(true);

    const missing = await api('/api/platform/stores/999/detail', { cookie: admin2 });
    expect(missing.status).toBe(404);
  });

  it('システム API: 行数・有効セッション・maintenance の読み書き', async () => {
    const sys = await api('/api/platform/system', { cookie: admin2 });
    expect(sys.status).toBe(200);
    const tables = sys.body.tables as Record<string, number>;
    expect(tables.stores).toBe(2);
    expect(tables.users).toBe(3);
    expect(tables.products).toBe(1);
    expect(tables.stocks).toBe(1);
    expect(tables.audit_logs).toBeGreaterThan(0);
    expect(sys.body.activeSessions as number).toBeGreaterThan(0);
    expect((sys.body.maintenance as Record<string, unknown>).on).toBe(false);

    const put = await api('/api/platform/settings/maintenance', {
      cookie: admin2,
      method: 'PUT',
      body: { on: true, message: 'テスト告知文' },
    });
    expect(put.status).toBe(200);
    expect(put.body.on).toBe(true);
    expect(put.body.message).toBe('テスト告知文');

    const sys2 = await api('/api/platform/system', { cookie: admin2 });
    const m2 = sys2.body.maintenance as Record<string, unknown>;
    expect(m2.on).toBe(true);
    expect(m2.message).toBe('テスト告知文');

    const off = await api('/api/platform/settings/maintenance', {
      cookie: admin2,
      method: 'PUT',
      body: { on: false },
    });
    expect(off.status).toBe(200);
    expect(off.body.on).toBe(false);
    const badBody = await api('/api/platform/settings/maintenance', {
      cookie: admin2,
      method: 'PUT',
      body: { on: 'yes' },
    });
    expect(badBody.status).toBe(400);
  });

  it('全店舗エクスポート: stores と platform_settings を含む', async () => {
    const res = await SELF.fetch('https://example.com/api/platform/export.json', {
      headers: { Cookie: `admin_session=${admin2}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    const data = (await res.json()) as {
      exportedAt: string;
      tables: Record<string, Record<string, unknown>[]>;
    };
    expect(data.tables.stores?.length).toBe(2);
    expect(data.tables.stores?.map((s) => s.code)).toContain('STORE-X');
    expect(data.tables.users?.length).toBe(3);
    expect(Array.isArray(data.tables.platform_settings)).toBe(true);
    expect(data.tables.platform_settings?.some((r) => r.key === 'maintenance')).toBe(true);
    expect(data.tables.sessions).toBeUndefined(); // セッションは含めない
  });
});

/**
 * メンテナンスウィンドウ (migration 0011) のテスト:
 * 作成と検証エラー (422)、extend (null→設定・加算・weekly は 422)、
 * end/cancel、一覧の状態判定、監査が残ること、/system への反映。
 * 前の describe の管理者セッションは生きているとは限らないため、ここでも
 * ログインし直す。
 */
describe('メンテナンスウィンドウ', () => {
  let admin3 = '';
  const HOUR_MS = 3_600_000;

  interface WindowBody {
    id: number;
    kind: string;
    level: string;
    features: string[];
    storeId: number | null;
    storeName: string | null;
    startsAt: number | null;
    endsAt: number | null;
    cancelledAt: number | null;
    state: string;
    occurrenceStartsAt: number | null;
    occurrenceEndsAt: number | null;
  }

  async function listWindows(): Promise<{
    active: WindowBody[];
    scheduled: WindowBody[];
    recent: WindowBody[];
  }> {
    const res = await api('/api/platform/maintenance', { cookie: admin3 });
    expect(res.status).toBe(200);
    return res.body as unknown as {
      active: WindowBody[];
      scheduled: WindowBody[];
      recent: WindowBody[];
    };
  }

  beforeAll(async () => {
    const res = await SELF.fetch('https://example.com/auth/callback?code=admin-code', {
      headers: { Cookie: `oauth_nonce=${ADMIN_NONCE}` },
    });
    expect(res.status).toBe(200);
    const match = setCookieOf(res).match(/admin_session=([^;,]+)/);
    if (!match?.[1]) throw new Error('admin_session cookie not found');
    admin3 = match[1];
    await testEnv.DB.prepare('DELETE FROM maintenance_windows').run();
  });

  it('作成と一覧の状態判定 (実施中/予定/履歴)', async () => {
    const now = Date.now();
    const active = await api('/api/platform/maintenance/windows', {
      cookie: admin3,
      method: 'POST',
      body: {
        kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR_MS,
        level: 'features', features: ['transfers'], message: '枠テスト',
      },
    });
    expect(active.status).toBe(201);
    expect(active.body.state).toBe('active');
    expect(active.body.occurrenceEndsAt).toBe(now + HOUR_MS);
    const activeId = active.body.id as number;

    const future = await api('/api/platform/maintenance/windows', {
      cookie: admin3,
      method: 'POST',
      body: { kind: 'once', startsAt: now + 2 * HOUR_MS, endsAt: null, level: 'read_only' },
    });
    expect(future.status).toBe(201);
    expect(future.body.state).toBe('scheduled');

    const weekly = await api('/api/platform/maintenance/windows', {
      cookie: admin3,
      method: 'POST',
      body: { kind: 'weekly', weekday: 1, startMinute: 60, endMinute: 240, level: 'full', storeId: 1 },
    });
    expect(weekly.status).toBe(201);
    expect(weekly.body.state).toBe('scheduled');
    expect(weekly.body.storeName).toBe('DGOSK');

    const past = await api('/api/platform/maintenance/windows', {
      cookie: admin3,
      method: 'POST',
      body: { kind: 'once', startsAt: now - 3 * HOUR_MS, endsAt: now - 2 * HOUR_MS, level: 'read_only' },
    });
    expect(past.status).toBe(201);
    expect(past.body.state).toBe('finished');

    const list = await listWindows();
    expect(list.active.map((w) => w.id)).toEqual([activeId]);
    expect(list.scheduled.length).toBe(2);
    expect(list.recent.length).toBe(1);
    expect(list.recent[0]?.state).toBe('finished');

    // /system の maintenance にも実施中が反映される (従来設定は off のまま)
    const sys = await api('/api/platform/system', { cookie: admin3 });
    expect((sys.body.maintenance as Record<string, unknown>).on).toBe(true);
  });

  it('作成の検証エラーは 422', async () => {
    const now = Date.now();
    const badRange = await api('/api/platform/maintenance/windows', {
      cookie: admin3, method: 'POST',
      body: { kind: 'once', startsAt: now + HOUR_MS, endsAt: now + HOUR_MS, level: 'read_only' },
    });
    expect(badRange.status).toBe(422);

    const noFeatures = await api('/api/platform/maintenance/windows', {
      cookie: admin3, method: 'POST',
      body: { kind: 'once', startsAt: now, endsAt: null, level: 'features', features: [] },
    });
    expect(noFeatures.status).toBe(422);

    const unknownFeature = await api('/api/platform/maintenance/windows', {
      cookie: admin3, method: 'POST',
      body: { kind: 'once', startsAt: now, endsAt: null, level: 'features', features: ['nope'] },
    });
    expect(unknownFeature.status).toBe(422);

    const badWeekly = await api('/api/platform/maintenance/windows', {
      cookie: admin3, method: 'POST',
      body: { kind: 'weekly', weekday: 2, startMinute: 600, endMinute: 600, level: 'read_only' },
    });
    expect(badWeekly.status).toBe(422);

    const missingStart = await api('/api/platform/maintenance/windows', {
      cookie: admin3, method: 'POST',
      body: { kind: 'once', level: 'read_only' },
    });
    expect(missingStart.status).toBe(422);

    const badShape = await api('/api/platform/maintenance/windows', {
      cookie: admin3, method: 'POST',
      body: { kind: 'daily', level: 'read_only' },
    });
    expect(badShape.status).toBe(400);
  });

  it('extend: 終了未定→設定、設定済み→加算、weekly は 422', async () => {
    const now = Date.now();
    const open = await api('/api/platform/maintenance/windows', {
      cookie: admin3, method: 'POST',
      body: { kind: 'once', startsAt: now - 60_000, endsAt: null, level: 'read_only' },
    });
    expect(open.status).toBe(201);
    const openId = open.body.id as number;

    const before = Date.now();
    const ext1 = await api(`/api/platform/maintenance/windows/${openId}/extend`, {
      cookie: admin3, method: 'POST', body: { minutes: 30 },
    });
    expect(ext1.status).toBe(200);
    const ends1 = ext1.body.endsAt as number;
    expect(ends1).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(ends1).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 1000);

    const ext2 = await api(`/api/platform/maintenance/windows/${openId}/extend`, {
      cookie: admin3, method: 'POST', body: { minutes: 60 },
    });
    expect(ext2.status).toBe(200);
    expect(ext2.body.endsAt).toBe(ends1 + 60 * 60_000);

    const weekly = await api('/api/platform/maintenance/windows', {
      cookie: admin3, method: 'POST',
      body: { kind: 'weekly', weekday: 3, startMinute: 0, endMinute: 120, level: 'read_only' },
    });
    const weeklyId = weekly.body.id as number;
    const extWeekly = await api(`/api/platform/maintenance/windows/${weeklyId}/extend`, {
      cookie: admin3, method: 'POST', body: { minutes: 30 },
    });
    expect(extWeekly.status).toBe(422);

    const missing = await api('/api/platform/maintenance/windows/99999/extend', {
      cookie: admin3, method: 'POST', body: { minutes: 30 },
    });
    expect(missing.status).toBe(404);
  });

  it('end: 実施中の once は即時終了、未来の once と weekly は取消になる', async () => {
    const now = Date.now();
    const list0 = await listWindows();
    const activeOnce = list0.active.find((w) => w.kind === 'once');
    if (!activeOnce) throw new Error('active once window not found');
    const ended = await api(`/api/platform/maintenance/windows/${activeOnce.id}/end`, {
      cookie: admin3, method: 'POST',
    });
    expect(ended.status).toBe(200);
    expect(ended.body.state).toBe('finished');
    expect((ended.body.endsAt as number)).toBeLessThanOrEqual(Date.now());
    expect(ended.body.cancelledAt).toBeNull();

    const future = await api('/api/platform/maintenance/windows', {
      cookie: admin3, method: 'POST',
      body: { kind: 'once', startsAt: now + 5 * HOUR_MS, endsAt: null, level: 'read_only' },
    });
    const futureId = future.body.id as number;
    const cancelled = await api(`/api/platform/maintenance/windows/${futureId}/end`, {
      cookie: admin3, method: 'POST',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');
    expect(cancelled.body.cancelledAt).not.toBeNull();

    const weekly = await api('/api/platform/maintenance/windows', {
      cookie: admin3, method: 'POST',
      body: { kind: 'weekly', weekday: 4, startMinute: 0, endMinute: 60, level: 'read_only' },
    });
    const weeklyId = weekly.body.id as number;
    const cancelledWeekly = await api(`/api/platform/maintenance/windows/${weeklyId}/end`, {
      cookie: admin3, method: 'POST',
    });
    expect(cancelledWeekly.body.state).toBe('cancelled');

    // 残っている実施中を片付けると /system の maintenance は off に戻る
    const rest = await listWindows();
    for (const w of rest.active) {
      await api(`/api/platform/maintenance/windows/${w.id}/end`, { cookie: admin3, method: 'POST' });
    }
    const sys = await api('/api/platform/system', { cookie: admin3 });
    expect((sys.body.maintenance as Record<string, unknown>).on).toBe(false);
  });

  it('監査ログに create / extend / end が残る', async () => {
    const res = await api('/api/platform/audit-logs?q=platform.maintenance&limit=50', { cookie: admin3 });
    expect(res.status).toBe(200);
    const rows = (res.body as unknown as { rows: { action: string }[] }).rows ??
      (res.body as unknown as { items: { action: string }[] }).items ?? [];
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('platform.maintenance.create');
    expect(actions).toContain('platform.maintenance.extend');
    expect(actions).toContain('platform.maintenance.end');
  });
});
