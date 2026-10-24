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
