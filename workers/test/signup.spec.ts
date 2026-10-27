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
import { createSession } from '../src/lib/session';

/**
 * 導入の汎用化 (セルフサインアップ + 業種テンプレート + オンボーディング一般化)
 * の結合テスト。
 *
 * ユーザー: 1 = 全体管理者、2 = 店舗1の管理者 (割当あり)、
 * 3 = 割当なし (サインアップ: 小売テンプレート)、4 = 割当なし (既定テンプレ��ト)、
 * 5 = 割当なし (Bearer のみ・セッションなし)。
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

let cookiePlatform = '';
let cookieManager = '';
let cookieNewA = '';
let cookieNewB = '';
let tokenBearerOnly = '';
let storeAId = 0;
let storeBId = 0;

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
  opts: { cookie?: string; token?: string; method?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `session=${opts.cookie}`;
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
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

async function countRows(sql: string, ...params: (string | number)[]): Promise<number> {
  const row = await testEnv.DB.prepare(sql).bind(...params).first<{ n: number }>();
  return row?.n ?? 0;
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

  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-platform', 'platform@example.com', 'Platform', 'active', ?1, ?1),
              (2, 'sub-manager', 'manager@example.com', 'Manager', 'active', ?1, ?1),
              (3, 'sub-new-a', 'newa@example.com', 'NewA', 'active', ?1, ?1),
              (4, 'sub-new-b', 'newb@example.com', 'NewB', 'active', ?1, ?1),
              (5, 'sub-bearer', 'bearer@example.com', 'Bearer', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, NULL),
              (2, 'INVENTORY_MANAGER', NULL, 1)`,
    ),
  ]);

  cookiePlatform = await createSession(testEnv.DB, 1);
  cookieManager = await createSession(testEnv.DB, 2);
  cookieNewA = await createSession(testEnv.DB, 3);
  cookieNewB = await createSession(testEnv.DB, 4);
  tokenBearerOnly = await mintToken('sub-bearer', 'bearer@example.com', privateKey);
});

describe('セルフサインアップ', () => {
  it('テンプレートカタログが返る (5種)', async () => {
    const res = await api('/api/v1/signup/templates', { cookie: cookieNewA });
    expect(res.status).toBe(200);
    const templates = res.body.templates as Record<string, unknown>[];
    expect(templates.map((t) => t.key)).toEqual(['general', 'retail', 'food', 'office', 'warehouse']);
  });

  it('未認証では使えない', async () => {
    const res = await api('/api/v1/signup/templates');
    expect(res.status).toBe(401);
  });

  it('Bearer 認証 (セッションなし) ではサインアップできない', async () => {
    const res = await api('/api/v1/signup', {
      token: tokenBearerOnly,
      method: 'POST',
      body: { organizationName: 'Bearer Org', storeName: 'Bearer Store' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SESSION_REQUIRED');
  });

  it('全体管理者と割当済みユーザーは 409', async () => {
    const byPlatform = await api('/api/v1/signup', {
      cookie: cookiePlatform,
      method: 'POST',
      body: { organizationName: 'X', storeName: 'Y' },
    });
    expect(byPlatform.status).toBe(409);
    expect(byPlatform.body.error).toBe('ALREADY_ASSIGNED');

    const byManager = await api('/api/v1/signup', {
      cookie: cookieManager,
      method: 'POST',
      body: { organizationName: 'X', storeName: 'Y' },
    });
    expect(byManager.status).toBe(409);
  });

  it('未知のテンプレートは 400', async () => {
    const res = await api('/api/v1/signup', {
      cookie: cookieNewA,
      method: 'POST',
      body: { organizationName: 'A Org', storeName: 'A Store', templateKey: 'nope' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_TEMPLATE');
  });

  it('サインアップで組織 (フリー)・店舗・倉庫・管理者割当とテンプレートが作られる', async () => {
    const res = await api('/api/v1/signup', {
      cookie: cookieNewA,
      method: 'POST',
      body: { organizationName: 'A商店', storeName: 'A店', templateKey: 'retail' },
    });
    expect(res.status).toBe(201);
    const org = res.body.organization as Record<string, unknown>;
    const store = res.body.store as Record<string, unknown>;
    const template = res.body.template as Record<string, unknown>;
    expect(org.planKey).toBe('free');
    expect(org.name).toBe('A商店');
    expect(String(store.code)).toMatch(/^S[0-9A-Z]{6}$/);
    expect(store.name).toBe('A店');
    expect(template.key).toBe('retail');
    storeAId = Number(store.id);

    // DB の実状態: 組織のプラン、割当、テンプレート投入分
    const orgRow = await testEnv.DB.prepare('SELECT plan_key FROM organizations WHERE id = ?1')
      .bind(Number(org.id))
      .first<{ plan_key: string }>();
    expect(orgRow?.plan_key).toBe('free');

    const roleCount = await countRows(
      "SELECT COUNT(*) AS n FROM user_roles WHERE user_id = 3 AND role_code = 'SYSTEM_ADMIN' AND store_id = ?1",
      storeAId,
    );
    expect(roleCount).toBe(1);

    expect(
      await countRows('SELECT COUNT(*) AS n FROM product_categories WHERE store_id = ?1 AND deleted_at IS NULL', storeAId),
    ).toBe(5);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM departments WHERE store_id = ?1 AND deleted_at IS NULL', storeAId),
    ).toBe(3);
    // 理由コード: 基本4種 + 小売の追加 (返品 customer_return / 廃棄 unsold)
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM movement_reason_codes WHERE store_id = ?1 AND kind = 'return' AND deleted_at IS NULL",
        storeAId,
      ),
    ).toBe(5);
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM movement_reason_codes WHERE store_id = ?1 AND kind = 'disposal' AND code = 'unsold'",
        storeAId,
      ),
    ).toBe(1);
    // 最初の保管場所 (売場) が既定倉庫の下にできている
    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
          WHERE w.store_id = ?1 AND loc.code = 'FLOOR' AND loc.deleted_at IS NULL`,
        storeAId,
      ),
    ).toBe(1);
  });

  it('サインアップ後は /me で現在店舗が新しい店舗になる', async () => {
    const res = await api('/api/v1/me', { cookie: cookieNewA });
    expect(res.status).toBe(200);
    const current = res.body.currentStore as Record<string, unknown>;
    expect(Number(current.id)).toBe(storeAId);
    const assignments = res.body.assignments as Record<string, unknown>[];
    expect(assignments.length).toBe(1);
  });

  it('2 回目のサインアップは 409', async () => {
    const res = await api('/api/v1/signup', {
      cookie: cookieNewA,
      method: 'POST',
      body: { organizationName: 'Again', storeName: 'Again' },
    });
    expect(res.status).toBe(409);
  });

  it('テンプレート未指定では汎用テンプレートが入る', async () => {
    const res = await api('/api/v1/signup', {
      cookie: cookieNewB,
      method: 'POST',
      body: { organizationName: 'B社', storeName: 'B店' },
    });
    expect(res.status).toBe(201);
    const template = res.body.template as Record<string, unknown>;
    expect(template.key).toBe('general');
    storeBId = Number((res.body.store as Record<string, unknown>).id);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM product_categories WHERE store_id = ?1 AND deleted_at IS NULL', storeBId),
    ).toBe(4);
    // 汎用は理由コードの追加なし (基本4種のみ)
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM movement_reason_codes WHERE store_id = ?1 AND kind = 'return' AND deleted_at IS NULL",
        storeBId,
      ),
    ).toBe(4);
  });
});

describe('オンボーディング一般化 (setup/status)', () => {
  it('新規店舗では settings 項目が含まれ、店舗設定の保存で立つ', async () => {
    let res = await api('/api/v1/setup/status', { cookie: cookieNewA });
    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(5);
    const items = res.body.items as Record<string, boolean>;
    expect(items.settings).toBe(false);
    // テンプレートで最初の保管場所が入っているので locations は最初から完了
    expect(items.locations).toBe(true);
    expect(items.members).toBe(false);

    const put = await api('/api/v1/settings', {
      cookie: cookieNewA,
      method: 'PUT',
      body: { currency: 'JPY', timezone: 'Asia/Tokyo' },
    });
    expect(put.status).toBe(200);

    res = await api('/api/v1/setup/status', { cookie: cookieNewA });
    const items2 = res.body.items as Record<string, boolean>;
    expect(items2.settings).toBe(true);
  });
});
