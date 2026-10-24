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
import { createSession } from '../src/lib/session';
import { clearMaintenanceCache } from '../src/lib/maintenance';

/**
 * 全体管理コンソールとの連動 (店舗アプリ側) の結合テスト:
 * - platform_settings テーブルが無い DB (migration 0010 未適用) では
 *   メンテナンス OFF として扱い、既存動作を壊さない
 * - メンテナンス ON では /api/v1/ 配下の非 GET が 503 MAINTENANCE、
 *   GET は通常通り、/me に maintenance が含まれ、logout は例外として通る
 * - 停止ユーザー (users.status != 'active') は Bearer・Cookie ともに 401
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let adminToken = '';
let idemSeq = 0;

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

async function bearer(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${adminToken}`, ...(init.headers ?? {}) },
  });
}

async function inbound(lotCode: string): Promise<Response> {
  idemSeq += 1;
  return bearer('/api/v1/movements/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `access-test-${idemSeq}` },
    body: JSON.stringify({ locationId: 1, productId: 1, lotCode, quantity: 3 }),
  });
}

async function setMaintenance(on: boolean, message: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ('maintenance', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify({ on, message }), new Date().toISOString())
    .run();
  clearMaintenanceCache();
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  adminToken = await mintToken('sub-admin', 'admin@example.com', privateKey);

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

  // 0010 はここでは適用しない (未適用 DB での後方互換を先に検証する)
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

describe('全体管理との連動 (停止ユーザー / メンテナンス)', () => {
  it('platform_settings が無い DB では maintenance OFF として通常動作する', async () => {
    const created = await inbound('LOT-NOTABLE');
    expect(created.status).toBe(201);

    const meRes = await bearer('/api/v1/me');
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { maintenance: { on: boolean; message: string | null } };
    expect(me.maintenance.on).toBe(false);
    expect(me.maintenance.message).toBeNull();
  });

  it('メンテナンス ON: POST は 503、GET は通常、/me に告知、logout は通る', async () => {
    for (const stmt of statementsOf(platformSettingsSql)) {
      await testEnv.DB.prepare(stmt).run();
    }
    await setMaintenance(true, '定期メンテナンス中です');

    const blocked = await inbound('LOT-MAINT');
    expect(blocked.status).toBe(503);
    const blockedBody = (await blocked.json()) as { error: string; message: string };
    expect(blockedBody.error).toBe('MAINTENANCE');
    expect(blockedBody.message).toBe('定期メンテナンス中です');

    const stocks = await bearer('/api/v1/stocks');
    expect(stocks.status).toBe(200);

    const me = (await (await bearer('/api/v1/me')).json()) as {
      maintenance: { on: boolean; message: string | null };
    };
    expect(me.maintenance.on).toBe(true);
    expect(me.maintenance.message).toBe('定期メンテナンス中です');

    // 告知文が空なら既定文言になる
    await setMaintenance(true, '');
    const meDefault = (await (await bearer('/api/v1/me')).json()) as {
      maintenance: { on: boolean; message: string | null };
    };
    expect(meDefault.maintenance.message).toBe('メンテナンス中です。しばらくしてから再度お試しください。');
    const blockedDefault = await inbound('LOT-MAINT2');
    expect(blockedDefault.status).toBe(503);
    expect(((await blockedDefault.json()) as { message: string }).message).toBe(
      'メンテナンス中です。しばらくしてから再度お試しください。',
    );

    // ログアウトだけはメンテナンス中でも通る
    const sessionToken = await createSession(testEnv.DB, 1);
    const logout = await SELF.fetch('https://example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: { Cookie: `session=${sessionToken}` },
    });
    expect(logout.status).toBe(200);
  });

  it('メンテナンス OFF に戻すと書き込みが再開する', async () => {
    await setMaintenance(false, '');
    const created = await inbound('LOT-RESUMED');
    expect(created.status).toBe(201);
    const me = (await (await bearer('/api/v1/me')).json()) as {
      maintenance: { on: boolean };
    };
    expect(me.maintenance.on).toBe(false);
  });

  it('停止ユーザーは Bearer・Cookie セッションともに 401、再有効化で復帰する', async () => {
    const sessionToken = await createSession(testEnv.DB, 1);
    await testEnv.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = 1").run();

    const viaBearer = await bearer('/api/v1/me');
    expect(viaBearer.status).toBe(401);

    const viaCookie = await SELF.fetch('https://example.com/api/v1/me', {
      headers: { Cookie: `session=${sessionToken}` },
    });
    expect(viaCookie.status).toBe(401);

    const write = await inbound('LOT-DISABLED');
    expect(write.status).toBe(401);

    await testEnv.DB.prepare("UPDATE users SET status = 'active' WHERE id = 1").run();
    const restored = await bearer('/api/v1/me');
    expect(restored.status).toBe(200);
  });
});
