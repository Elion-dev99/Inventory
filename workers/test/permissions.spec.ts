import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import initSql from '../migrations/0001_init.sql?raw';
import seedSql from '../migrations/0002_seed_roles.sql?raw';
import permissionsSql from '../migrations/0003_permissions.sql?raw';

/**
 * 権限 (role_permissions) の結合テスト: 実 D1 に 0001〜0003 を適用し、
 * テスト用 RSA 鍵で署名した OIDC トークン (JWKS は fetch 差し替えで供給) で
 * HTTP 経路を通す。権限の付け外しがエンドポイントの可否に即反映されること、
 * 締め出し防止、ユーザーロール付与 API を検証する。
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let adminToken = '';
let viewerToken = '';
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

async function api(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  idemSeq += 1;
  return SELF.fetch(`https://example.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `perm-test-${idemSeq}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const inboundBody = { locationId: 1, productId: 1, lotCode: 'LOT-P', quantity: 3 };

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
  // JWKS をテスト鍵に差し替える (verifyToken は OIDC_JWKS_URL を引く)。
  // このバージョンの vitest-pool-workers に fetchMock が無いため、
  // グローバル fetch を包んで JWKS URL だけテスト用 JWKS を返す。
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

  for (const stmt of [...statementsOf(initSql), ...statementsOf(seedSql), ...statementsOf(permissionsSql)]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-admin', 'admin@example.com', 'Admin', 'active', ?1, ?1),
              (2, 'sub-viewer', 'viewer@example.com', 'Viewer', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL), (2, 'VIEWER', NULL)`,
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

  adminToken = await mintToken('sub-admin', 'admin@example.com', privateKey);
  viewerToken = await mintToken('sub-viewer', 'viewer@example.com', privateKey);
});

describe('権限マトリクスと管理 API (D1 結合)', () => {
  it('既定では VIEWER は入庫できない (403) が在庫参照はできる', async () => {
    const denied = await api('/api/v1/movements/inbound', viewerToken, { method: 'POST', body: inboundBody });
    expect(denied.status).toBe(403);
    const stocks = await api('/api/v1/stocks', viewerToken);
    expect(stocks.status).toBe(200);
  });

  it('GET /admin/permissions は管理系権限が要り、マトリクスを返す', async () => {
    const denied = await api('/api/v1/admin/permissions', viewerToken);
    expect(denied.status).toBe(403);

    const res = await api('/api/v1/admin/permissions', adminToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      permissions: { key: string }[];
      roles: { code: string }[];
      matrix: Record<string, string[]>;
    };
    expect(body.permissions).toHaveLength(11);
    expect(body.roles.map((r) => r.code)).toContain('SYSTEM_ADMIN');
    expect(body.matrix.SYSTEM_ADMIN).toContain('admin.permissions');
    expect(body.matrix.VIEWER).toEqual(['alerts.read', 'master.read', 'stocks.read']);
    expect(body.matrix.INVENTORY_STAFF).toContain('movements.inbound');
    expect(body.matrix.INVENTORY_STAFF).not.toContain('master.write');
  });

  it('VIEWER に movements.inbound を付けると入庫でき、剥がすと 403 に戻る', async () => {
    const granted = await api('/api/v1/admin/role-permissions/VIEWER', adminToken, {
      method: 'PUT',
      body: { permissions: ['stocks.read', 'alerts.read', 'master.read', 'movements.inbound'] },
    });
    expect(granted.status).toBe(200);

    const ok = await api('/api/v1/movements/inbound', viewerToken, { method: 'POST', body: inboundBody });
    expect(ok.status).toBe(201);

    const revoked = await api('/api/v1/admin/role-permissions/VIEWER', adminToken, {
      method: 'PUT',
      body: { permissions: ['stocks.read', 'alerts.read', 'master.read'] },
    });
    expect(revoked.status).toBe(200);

    const denied = await api('/api/v1/movements/inbound', viewerToken, { method: 'POST', body: inboundBody });
    expect(denied.status).toBe(403);

    // 変更が audit_logs に残る
    const audits = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'role_permissions.update' AND target_id = 'VIEWER'",
    ).first<{ n: number }>();
    expect(audits?.n).toBe(2);
  });

  it('未知の権限キーは 422、存在しないロールは 404', async () => {
    const unknownKey = await api('/api/v1/admin/role-permissions/VIEWER', adminToken, {
      method: 'PUT',
      body: { permissions: ['stocks.read', 'nope.key'] },
    });
    expect(unknownKey.status).toBe(422);

    const unknownRole = await api('/api/v1/admin/role-permissions/NOPE', adminToken, {
      method: 'PUT',
      body: { permissions: ['stocks.read'] },
    });
    expect(unknownRole.status).toBe(404);
  });

  it('SYSTEM_ADMIN から admin.permissions を外す変更は 422 で拒否される (締め出し防止)', async () => {
    const res = await api('/api/v1/admin/role-permissions/SYSTEM_ADMIN', adminToken, {
      method: 'PUT',
      body: { permissions: ['stocks.read'] },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('LOCKOUT_PREVENTION');

    // 拒否されたので管理者は依然として操作できる
    const still = await api('/api/v1/admin/permissions', adminToken);
    expect(still.status).toBe(200);
  });

  it('ユーザーロール付与 API で VIEWER を STAFF にすると入庫できる', async () => {
    const usersRes = await api('/api/v1/admin/users', adminToken);
    expect(usersRes.status).toBe(200);
    const users = (await usersRes.json()) as { id: number; assignments: { roleCode: string }[] }[];
    expect(users.find((u) => u.id === 2)?.assignments).toEqual([
      { roleCode: 'VIEWER', warehouseId: null },
    ]);

    const put = await api('/api/v1/admin/users/2/roles', adminToken, {
      method: 'PUT',
      body: { assignments: [{ roleCode: 'INVENTORY_STAFF', warehouseId: null }] },
    });
    expect(put.status).toBe(200);

    const ok = await api('/api/v1/movements/inbound', viewerToken, { method: 'POST', body: inboundBody });
    expect(ok.status).toBe(201);

    const audits = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'user_roles.update' AND target_id = '2'",
    ).first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('ユーザーロール付与 API のバリデーション (未知ロール 422 / 不在ユーザー 404 / 不在倉庫 422)', async () => {
    const unknownRole = await api('/api/v1/admin/users/2/roles', adminToken, {
      method: 'PUT',
      body: { assignments: [{ roleCode: 'NOPE', warehouseId: null }] },
    });
    expect(unknownRole.status).toBe(422);

    const noUser = await api('/api/v1/admin/users/9999/roles', adminToken, {
      method: 'PUT',
      body: { assignments: [] },
    });
    expect(noUser.status).toBe(404);

    const noWarehouse = await api('/api/v1/admin/users/2/roles', adminToken, {
      method: 'PUT',
      body: { assignments: [{ roleCode: 'VIEWER', warehouseId: 9999 }] },
    });
    expect(noWarehouse.status).toBe(422);

    // バリデーション失敗で割当は変わっていない
    const after = await testEnv.DB.prepare(
      'SELECT role_code FROM user_roles WHERE user_id = 2',
    ).all<{ role_code: string }>();
    expect(after.results.map((r) => r.role_code)).toEqual(['INVENTORY_STAFF']);
  });

  it('管理 API は admin 権限の無いユーザーからは使えない', async () => {
    // user 2 は INVENTORY_STAFF (admin 系なし)
    const users = await api('/api/v1/admin/users', viewerToken);
    expect(users.status).toBe(403);
    const put = await api('/api/v1/admin/role-permissions/VIEWER', viewerToken, {
      method: 'PUT',
      body: { permissions: ['stocks.read'] },
    });
    expect(put.status).toBe(403);
  });
});
