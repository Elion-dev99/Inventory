import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import initSql from '../migrations/0001_init.sql?raw';
import seedSql from '../migrations/0002_seed_roles.sql?raw';
import permissionsSql from '../migrations/0003_permissions.sql?raw';
import sessionsSql from '../migrations/0004_sessions.sql?raw';
import businessSql from '../migrations/0005_business_completion.sql?raw';

/**
 * 運用系の管理 API の結合テスト (商品化ステップ5):
 * - GET /api/v1/admin/audit-logs (監査ログ閲覧: フィルタとページング、admin.users 必須)
 * - GET /api/v1/admin/export.json (主要テーブルの一括エクスポートと除外テーブルの確認)
 * 実 D1 (miniflare) に 0001〜0005 を適用し、テスト用 OIDC トークンで HTTP 経路を通す。
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
let auditBaselineAt = 0;

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
  bearer: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  idemSeq += 1;
  return SELF.fetch(`https://example.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: 'Bearer ' + bearer,
      'Content-Type': 'application/json',
      'Idempotency-Key': `ops-test-${idemSeq}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

interface AuditItem {
  id: number;
  actorId: number | null;
  action: string;
  targetType: string;
  targetId: string;
  payload: unknown;
  createdAt: number;
}
interface AuditPage {
  items: AuditItem[];
  total: number;
  limit: number;
  offset: number;
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
  ]) {
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

  // 監査ログの素材を作る: 入庫 (stock.inbound) と権限変更 (role_permissions.update)、ロール付与 (user_roles.update)
  auditBaselineAt = Date.now() - 1000;
  const inbound = await api('/api/v1/movements/inbound', adminToken, {
    method: 'POST',
    body: { locationId: 1, productId: 1, lotCode: 'LOT-OPS', quantity: 5 },
  });
  expect(inbound.status).toBe(201);
  const matrix = await api('/api/v1/admin/role-permissions/VIEWER', adminToken, {
    method: 'PUT',
    body: { permissions: ['stocks.read', 'alerts.read', 'master.read'] },
  });
  expect(matrix.status).toBe(200);
  const roles = await api('/api/v1/admin/users/2/roles', adminToken, {
    method: 'PUT',
    body: { assignments: [{ roleCode: 'VIEWER', warehouseId: null }] },
  });
  expect(roles.status).toBe(200);
});

describe('GET /api/v1/admin/audit-logs (監査ログ閲覧)', () => {
  it('admin.users が無いユーザーは 403、未認証は 401', async () => {
    const denied = await api('/api/v1/admin/audit-logs', viewerToken);
    expect(denied.status).toBe(403);
    const anon = await SELF.fetch('https://example.com/api/v1/admin/audit-logs');
    expect(anon.status).toBe(401);
  });

  it('新しい順に返り、total と payload (JSON) が含まれる', async () => {
    const res = await api('/api/v1/admin/audit-logs', adminToken);
    expect(res.status).toBe(200);
    const page = (await res.json()) as AuditPage;
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.items.length).toBe(page.total);
    for (let i = 1; i < page.items.length; i++) {
      expect(page.items[i - 1]?.id ?? 0).toBeGreaterThan(page.items[i]?.id ?? 0);
    }
    const matrixLog = page.items.find((a) => a.action === 'role_permissions.update');
    expect(matrixLog?.actorId).toBe(1);
    expect(matrixLog?.targetType).toBe('role');
    expect(matrixLog?.targetId).toBe('VIEWER');
    expect((matrixLog?.payload as { permissions: string[] }).permissions).toEqual([
      'stocks.read',
      'alerts.read',
      'master.read',
    ]);
    expect(page.items.some((a) => a.action === 'stock.inbound')).toBe(true);
    expect(page.items.some((a) => a.action === 'user_roles.update')).toBe(true);
  });

  it('actor / action / 期間でフィルタできる', async () => {
    const byAction = (await (
      await api('/api/v1/admin/audit-logs?action=role_permissions.update', adminToken)
    ).json()) as AuditPage;
    expect(byAction.total).toBe(1);
    expect(byAction.items[0]?.action).toBe('role_permissions.update');

    const byActor = (await (
      await api('/api/v1/admin/audit-logs?actor=1', adminToken)
    ).json()) as AuditPage;
    expect(byActor.total).toBeGreaterThanOrEqual(3);
    expect(byActor.items.every((a) => a.actorId === 1)).toBe(true);

    const noActor = (await (
      await api('/api/v1/admin/audit-logs?actor=999', adminToken)
    ).json()) as AuditPage;
    expect(noActor.total).toBe(0);

    const inRange = (await (
      await api(`/api/v1/admin/audit-logs?from=${auditBaselineAt}&to=${Date.now() + 1000}`, adminToken)
    ).json()) as AuditPage;
    expect(inRange.total).toBeGreaterThanOrEqual(3);

    const future = (await (
      await api(`/api/v1/admin/audit-logs?from=${Date.now() + 60_000}`, adminToken)
    ).json()) as AuditPage;
    expect(future.total).toBe(0);
  });

  it('limit / offset でページングできる', async () => {
    const first = (await (
      await api('/api/v1/admin/audit-logs?limit=2&offset=0', adminToken)
    ).json()) as AuditPage;
    expect(first.limit).toBe(2);
    expect(first.offset).toBe(0);
    expect(first.items).toHaveLength(2);
    expect(first.total).toBeGreaterThanOrEqual(3);

    const second = (await (
      await api('/api/v1/admin/audit-logs?limit=2&offset=2', adminToken)
    ).json()) as AuditPage;
    expect(second.items.length).toBeGreaterThanOrEqual(1);
    const ids = new Set([...first.items, ...second.items].map((a) => a.id));
    expect(ids.size).toBe(first.items.length + second.items.length);
  });
});

describe('GET /api/v1/admin/export.json (データエクスポート)', () => {
  it('admin.users が無いユーザーは 403', async () => {
    const denied = await api('/api/v1/admin/export.json', viewerToken);
    expect(denied.status).toBe(403);
  });

  it('主要 15 テーブルを返し、内部テーブルは含めない', async () => {
    const res = await api('/api/v1/admin/export.json', adminToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      exportedAt: number;
      tables: Record<string, Record<string, unknown>[]>;
    };
    expect(body.exportedAt).toBeGreaterThan(0);
    const expected = [
      'users',
      'roles',
      'user_roles',
      'warehouses',
      'locations',
      'products',
      'lots',
      'stocks',
      'stock_movements',
      'stocktakes',
      'stocktake_lines',
      'negative_stock_approvals',
      'audit_logs',
      'permissions',
      'role_permissions',
    ];
    expect(Object.keys(body.tables).sort()).toEqual([...expected].sort());
    // 認証情報と内部状態はエクスポート対象外
    expect(body.tables.sessions).toBeUndefined();
    expect(body.tables.idempotency_keys).toBeUndefined();
    expect(body.tables.write_guards).toBeUndefined();

    // 実データが入っている
    const rowsOf = (name: string): Record<string, unknown>[] => body.tables[name] ?? [];
    expect(rowsOf('users').map((u) => u.email)).toContain('admin@example.com');
    expect(rowsOf('products').map((p) => p.sku)).toContain('SKU-1');
    expect(rowsOf('roles')).toHaveLength(5);
    expect(rowsOf('permissions')).toHaveLength(12);
    expect(rowsOf('stocks')).toHaveLength(1);
    expect(rowsOf('stock_movements').some((m) => m.type === 'IN')).toBe(true);
    expect(rowsOf('audit_logs').some((a) => a.action === 'stock.inbound')).toBe(true);
    expect(rowsOf('role_permissions').length).toBeGreaterThan(0);
  });
});
