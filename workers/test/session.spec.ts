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
import { createSession, hashSessionToken } from '../src/lib/session';

/**
 * セッション認証の結合テスト: 実 D1 に 0001〜0004 を適用し、
 * - /auth/callback (Google のトークン交換は fetch 差し替えで模擬) が
 *   セッション Cookie を発行すること
 * - Cookie で /api/v1/me・/api/v1/stocks・/api/v1/movements・WebSocket が通ること
 * - ログアウトで無効化されること、期限切れ・改ざんトークンが 401 になること
 * - /app が SPA の HTML を返すこと
 * を検証する。Bearer 認証が従来どおり優先されることもあわせて確認する。
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';
const NONCE = 'test-nonce-1234';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let adminToken = '';
let appUserIdToken = '';
let idemSeq = 0;

async function mintToken(
  sub: string,
  email: string,
  privateKey: KeyLike,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({ email, name: sub, ...extra })
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

function sessionCookieFrom(res: Response): string {
  const match = setCookieOf(res).match(/session=([^;,]+)/);
  if (!match?.[1]) throw new Error(`session cookie not found in: ${setCookieOf(res)}`);
  return `session=${match[1]}`;
}

async function fetchWithCookie(path: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: { Cookie: cookie, ...(init.headers ?? {}) },
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

  adminToken = await mintToken('sub-admin', 'admin@example.com', privateKey);
  appUserIdToken = await mintToken('sub-app', 'app@example.com', privateKey, { nonce: NONCE });

  // JWKS と Google トークン交換エンドポイントを fetch 差し替えで模擬する
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ id_token: appUserIdToken }), {
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
       VALUES (1, 'sub-admin', 'admin@example.com', 'Admin', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id) VALUES (1, 'SYSTEM_ADMIN', NULL)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, created_at, updated_at) VALUES (1, 'WH1', '本社倉庫', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at) VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, created_at, updated_at)
       VALUES (1, 'SKU-1', 'テスト品', '個', 0, 0, ?1, ?1)`,
    ).bind(now),
  ]);
});

describe('セッション認証 (D1 結合)', () => {
  it('Bearer は従来どおり通り、/me が実効権限を返す', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/me', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; email: string; permissions: string[] };
    expect(body.id).toBe(1);
    expect(body.email).toBe('admin@example.com');
    expect(body.permissions).toContain('admin.permissions');
    expect(body.permissions).toContain('stocks.read');
  });

  it('/auth/callback がセッション Cookie を発行し、/app へのリンクを出す', async () => {
    const res = await SELF.fetch('https://example.com/auth/callback?code=test-code', {
      headers: { Cookie: `oauth_nonce=${NONCE}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/app');
    const setCookie = setCookieOf(res);
    expect(setCookie).toContain('session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Max-Age=28800');

    // 発行されたセッションはハッシュのみが DB にあり、ユーザーが作られている
    const session = await testEnv.DB.prepare('SELECT user_id, token_hash FROM sessions').first<{
      user_id: number;
      token_hash: string;
    }>();
    expect(session?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const appUser = await testEnv.DB.prepare(
      "SELECT id FROM users WHERE external_id = 'sub-app'",
    ).first<{ id: number }>();
    expect(appUser?.id).toBe(session?.user_id);
  });

  it('Cookie セッションで /me・/stocks・履歴が通り、ロール付与が即反映される', async () => {
    const callbackRes = await SELF.fetch('https://example.com/auth/callback?code=test-code', {
      headers: { Cookie: `oauth_nonce=${NONCE}` },
    });
    const cookie = sessionCookieFrom(callbackRes);

    const meRes = await fetchWithCookie('/api/v1/me', cookie);
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { email: string; assignments: unknown[]; permissions: string[] };
    expect(me.email).toBe('app@example.com');
    expect(me.assignments).toEqual([]);
    expect(me.permissions).toEqual([]);

    // 管理者が Bearer でロールを付与すると、同じセッションでも権限が見える
    const appUser = await testEnv.DB.prepare(
      "SELECT id FROM users WHERE external_id = 'sub-app'",
    ).first<{ id: number }>();
    const grant = await SELF.fetch(`https://example.com/api/v1/admin/users/${appUser?.id}/roles`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments: [{ roleCode: 'INVENTORY_STAFF', warehouseId: null }] }),
    });
    expect(grant.status).toBe(200);

    const me2 = (await (await fetchWithCookie('/api/v1/me', cookie)).json()) as {
      permissions: string[];
    };
    expect(me2.permissions).toContain('movements.inbound');

    const stocks = await fetchWithCookie('/api/v1/stocks', cookie);
    expect(stocks.status).toBe(200);

    // 入庫 (Bearer) の履歴が Cookie 経由でも読める
    idemSeq += 1;
    const inbound = await SELF.fetch('https://example.com/api/v1/movements/inbound', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `session-test-${idemSeq}`,
      },
      body: JSON.stringify({ locationId: 1, productId: 1, lotCode: 'LOT-S', quantity: 5 }),
    });
    expect(inbound.status).toBe(201);
    const movementsRes = await fetchWithCookie('/api/v1/movements', cookie);
    expect(movementsRes.status).toBe(200);
    const movements = (await movementsRes.json()) as { type: string; quantityChange: number; sku: string }[];
    expect(movements.some((m) => m.type === 'IN' && m.quantityChange === 5 && m.sku === 'SKU-1')).toBe(true);

    // ログアウトすると同じ Cookie は使えなくなる
    const logout = await fetchWithCookie('/api/v1/auth/logout', cookie, { method: 'POST' });
    expect(logout.status).toBe(200);
    expect(setCookieOf(logout)).toContain('Max-Age=0');
    const after = await fetchWithCookie('/api/v1/me', cookie);
    expect(after.status).toBe(401);
  });

  it('改ざんトークンと期限切れセッションは 401', async () => {
    const forged = await fetchWithCookie('/api/v1/me', 'session=forged-token-value');
    expect(forged.status).toBe(401);

    const admin = await testEnv.DB.prepare('SELECT id FROM users WHERE id = 1').first<{ id: number }>();
    const expiredToken = 'expired-token-value';
    const now = Date.now();
    await testEnv.DB.prepare(
      'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(await hashSessionToken(expiredToken), admin?.id ?? 1, now - 1000, now - 1000)
      .run();
    const expired = await fetchWithCookie('/api/v1/me', `session=${expiredToken}`);
    expect(expired.status).toBe(401);
  });

  it('createSession で発行した Cookie でも WebSocket が通る', async () => {
    const token = await createSession(testEnv.DB, 1);
    const res = await SELF.fetch('https://example.com/api/v1/realtime', {
      headers: { Upgrade: 'websocket', Cookie: `session=${token}` },
    });
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
    res.webSocket?.accept();
    res.webSocket?.close();

    const denied = await SELF.fetch('https://example.com/api/v1/realtime', {
      headers: { Upgrade: 'websocket' },
    });
    expect(denied.status).toBe(401);
  });

  it('/app は SPA の HTML を 200 で返す', async () => {
    const res = await SELF.fetch('https://example.com/app');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('在庫管理システム');
    expect(html).toContain('id="appBox"');
    expect(html).toContain('/api/v1/me');
  });
});
