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
import maintenanceWindowsSql from '../migrations/0011_maintenance_windows.sql?raw';
import maintenanceExtrasSql from '../migrations/0012_maintenance_extras.sql?raw';
import announcementsSql from '../migrations/0013_announcements.sql?raw';

/**
 * 全体管理者の匿名化 (店舗側で素性を隠す) の結合テスト。
 *
 * - 全体管理者 (全体割当のみ) は店舗側のユーザー一覧に出ず、ロール付与の対象にもならない
 * - 監査ログ・履歴・承認・お知らせでは全体管理者の操作者 ID が伏せられ、
 *   監査ログでは「システム管理者」と表示される
 * - エクスポートに全体管理者の users 行・全体割当が含まれない
 * - 現在店舗の割当も持つ全体管理者は、その店舗では通常のメンバーとして表示される
 * - 全体管理者本人の閲覧 (/me・各管理 API) は従来通り
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

const PLATFORM_EMAIL = 'platform@example.com';
const PLATFORM_NAME = 'Platform Boss';
const PLATFORM_SUB = 'sub-platform';

let platformToken = '';
let storeAdminToken = '';
let staffToken = '';
let idemSeq = 0;

async function mintToken(
  sub: string,
  email: string,
  name: string,
  privateKey: KeyLike,
): Promise<string> {
  return new SignJWT({ email, name })
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
      'Idempotency-Key': `privacy-test-${idemSeq}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

interface AuditItem {
  id: number;
  actorId: number | null;
  actorLabel: string | null;
  action: string;
}
interface AuditPage {
  items: AuditItem[];
  total: number;
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
    ...statementsOf(sessionScopeSql),
    ...statementsOf(platformSettingsSql),
    ...statementsOf(maintenanceWindowsSql),
    ...statementsOf(maintenanceExtrasSql),
    ...statementsOf(announcementsSql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, '${PLATFORM_SUB}', '${PLATFORM_EMAIL}', '${PLATFORM_NAME}', 'active', ?1, ?1),
              (2, 'sub-store-admin', 'sadmin@example.com', 'Store Admin', 'active', ?1, ?1),
              (3, 'sub-staff', 'staff@example.com', 'Staff One', 'active', ?1, ?1),
              (4, 'sub-dual', 'dual@example.com', 'Dual Member', 'active', ?1, ?1)`,
    ).bind(now),
    // 1 = 全体管理者 (全体割当のみ)、2 = 店舗管理者、3 = 通常スタッフ、
    // 4 = 全体割当 + 店舗1の割当を持つ (店舗1では通常メンバー扱い)
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, NULL),
              (2, 'SYSTEM_ADMIN', NULL, 1),
              (3, 'INVENTORY_STAFF', NULL, 1),
              (4, 'SYSTEM_ADMIN', NULL, NULL),
              (4, 'INVENTORY_MANAGER', NULL, 1)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at) VALUES (1, 'WH1', '本社倉庫', 1, ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at) VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, store_id, created_at, updated_at)
       VALUES (1, 'SKU-1', 'テスト品', '個', 0, 0, 1, ?1, ?1)`,
    ).bind(now),
    // 全体管理コンソールから投稿された想定の全店舗向けお知らせ (投稿者 = 全体管理者)
    testEnv.DB.prepare(
      `INSERT INTO announcements (id, store_id, title, body, priority, starts_at, ends_at, push, push_sent_at, created_by, created_at, updated_at)
       VALUES (1, NULL, '全店舗向けお知らせ', '本文', 'normal', ?1, NULL, 0, NULL, 1, ?2, ?2),
              (2, 1, '店舗向けお知らせ', '本文', 'normal', ?1, NULL, 0, NULL, 2, ?2, ?2)`,
    ).bind(now - 1000, now),
  ]);

  platformToken = await mintToken(PLATFORM_SUB, PLATFORM_EMAIL, PLATFORM_NAME, privateKey);
  storeAdminToken = await mintToken('sub-store-admin', 'sadmin@example.com', 'Store Admin', privateKey);
  staffToken = await mintToken('sub-staff', 'staff@example.com', 'Staff One', privateKey);
  const dualToken = await mintToken('sub-dual', 'dual@example.com', 'Dual Member', privateKey);

  // 操作の素材: 全体管理者・スタッフ・店舗割当持ち全体管理者がそれぞれ入庫する
  for (const [token, lotCode] of [
    [platformToken, 'LOT-PLATFORM'],
    [staffToken, 'LOT-STAFF'],
    [dualToken, 'LOT-DUAL'],
  ] as const) {
    const res = await api('/api/v1/movements/inbound', token, {
      method: 'POST',
      body: { locationId: 1, productId: 1, lotCode, quantity: 5 },
    });
    expect(res.status).toBe(201);
  }
  // 全体管理者が権限マトリクスを変更する (監査にだけ残る操作)
  const matrix = await api('/api/v1/admin/role-permissions/VIEWER', platformToken, {
    method: 'PUT',
    body: { permissions: ['stocks.read', 'alerts.read', 'master.read'] },
  });
  expect(matrix.status).toBe(200);

  // マイナス在庫申請の素材 (申請者 = 全体管理者 / スタッフ)
  const stock = await testEnv.DB.prepare('SELECT id FROM stocks WHERE location_id = 1 ORDER BY id ASC')
    .first<{ id: number }>();
  expect(stock).not.toBeNull();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO negative_stock_approvals (stock_id, quantity, reason, status, requested_by, store_id, created_at, updated_at)
       VALUES (?1, 1, '全体管理者の申請', 'pending', 1, 1, ?2, ?2),
              (?1, 1, 'スタッフの申請', 'pending', 3, 1, ?2, ?2)`,
    ).bind(stock!.id, now),
  ]);
});

describe('全体管理者の匿名化 (店舗側)', () => {
  it('ユーザー一覧に全体管理者が出ず、店舗割当を持つ全体管理者は通常表示される', async () => {
    const res = await api('/api/v1/admin/users', storeAdminToken);
    expect(res.status).toBe(200);
    const text = await res.text();
    const users = JSON.parse(text) as { id: number; email: string; displayName: string }[];
    expect(users.map((u) => u.id).sort()).toEqual([2, 3, 4]);
    // 名前・メール・外部 ID のいずれも漏れない
    expect(text).not.toContain(PLATFORM_EMAIL);
    expect(text).not.toContain(PLATFORM_NAME);
    expect(text).not.toContain(PLATFORM_SUB);
    // 通常ユーザーと店舗メンバー (全体割当 + 店舗割当) は従来通り見える
    expect(users.find((u) => u.id === 3)?.email).toBe('staff@example.com');
    expect(users.find((u) => u.id === 4)?.email).toBe('dual@example.com');
  });

  it('全体管理者本人にはユーザー一覧が従来通り見える', async () => {
    const res = await api('/api/v1/admin/users', platformToken);
    expect(res.status).toBe(200);
    const users = (await res.json()) as { id: number; email: string }[];
    expect(users.map((u) => u.id).sort()).toEqual([1, 2, 3, 4]);
    expect(users.find((u) => u.id === 1)?.email).toBe(PLATFORM_EMAIL);
  });

  it('店舗管理者は全体管理者にロールを付けられず (404)、通常ユーザーは変更できる', async () => {
    const hidden = await api('/api/v1/admin/users/1/roles', storeAdminToken, {
      method: 'PUT',
      body: { assignments: [{ roleCode: 'VIEWER', warehouseId: null }] },
    });
    expect(hidden.status).toBe(404);

    const visible = await api('/api/v1/admin/users/3/roles', storeAdminToken, {
      method: 'PUT',
      body: { assignments: [{ roleCode: 'INVENTORY_STAFF', warehouseId: null }] },
    });
    expect(visible.status).toBe(200);
  });

  it('監査ログでは全体管理者の操作が「システム管理者」に匿名化され、行自体は残る', async () => {
    const res = await api('/api/v1/admin/audit-logs', storeAdminToken);
    expect(res.status).toBe(200);
    const text = await res.text();
    const page = JSON.parse(text) as AuditPage;
    expect(text).not.toContain(PLATFORM_EMAIL);
    // 全体管理者の ID はどの行にも出ない
    expect(page.items.every((a) => a.actorId !== 1)).toBe(true);
    // 全体管理者の操作行は残り、ラベルで匿名化される
    const platformOps = page.items.filter((a) => a.actorLabel === 'システム管理者');
    expect(platformOps.length).toBeGreaterThanOrEqual(2);
    expect(platformOps.every((a) => a.actorId === null)).toBe(true);
    expect(page.items.some((a) => a.action === 'role_permissions.update' && a.actorLabel === 'システム管理者')).toBe(true);
    // 通常ユーザーの操作は従来通り ID で見える
    expect(page.items.some((a) => a.action === 'stock.inbound' && a.actorId === 3 && a.actorLabel === null)).toBe(true);
    // 店舗割当を持つ全体管理者 (id=4) の操作は匿名化されない
    expect(page.items.some((a) => a.action === 'stock.inbound' && a.actorId === 4)).toBe(true);
  });

  it('監査ログは全体管理者本人には従来通り見える', async () => {
    const res = await api('/api/v1/admin/audit-logs', platformToken);
    expect(res.status).toBe(200);
    const page = (await res.json()) as AuditPage;
    expect(page.items.some((a) => a.action === 'role_permissions.update' && a.actorId === 1 && a.actorLabel === null)).toBe(true);
  });

  it('履歴 (movements) でも全体管理者の actorId が伏せられる', async () => {
    const res = await api('/api/v1/movements', storeAdminToken);
    expect(res.status).toBe(200);
    const items = (await res.json()) as { lotCode: string; actorId: number | null }[];
    expect(items.find((m) => m.lotCode === 'LOT-PLATFORM')?.actorId).toBeNull();
    expect(items.find((m) => m.lotCode === 'LOT-STAFF')?.actorId).toBe(3);
    expect(items.find((m) => m.lotCode === 'LOT-DUAL')?.actorId).toBe(4);
  });

  it('マイナス在庫申請では全体管理者の申請者 ID が伏せられる', async () => {
    const res = await api('/api/v1/negative-approvals', storeAdminToken);
    expect(res.status).toBe(200);
    const items = (await res.json()) as { reason: string; requestedBy: number | null }[];
    expect(items.find((a) => a.reason === '全体管理者の申請')?.requestedBy).toBeNull();
    expect(items.find((a) => a.reason === 'スタッフの申請')?.requestedBy).toBe(3);
  });

  it('お知らせでは全体管理者の投稿者 ID が伏せられる (閲覧・管理の両方)', async () => {
    const res = await api('/api/v1/announcements', storeAdminToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { title: string; createdBy: number | null }[] };
    expect(body.items.find((a) => a.title === '全店舗向けお知らせ')?.createdBy).toBeNull();
    expect(body.items.find((a) => a.title === '店舗向けお知らせ')?.createdBy).toBe(2);

    const admin = await api('/api/v1/admin/announcements', storeAdminToken);
    expect(admin.status).toBe(200);
    const adminBody = (await admin.json()) as { items: { title: string; createdBy: number | null }[] };
    expect(adminBody.items.find((a) => a.title === '全店舗向けお知らせ')?.createdBy).toBeNull();
    expect(adminBody.items.find((a) => a.title === '店舗向けお知らせ')?.createdBy).toBe(2);
  });

  it('エクスポートに全体管理者の users 行と全体割当が含まれない', async () => {
    const res = await api('/api/v1/admin/export.json', storeAdminToken);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as { tables: Record<string, Record<string, unknown>[]> };
    // 15 テーブル構成は不変
    expect(Object.keys(body.tables)).toHaveLength(15);
    const users = body.tables.users ?? [];
    expect(users.map((u) => u.id)).not.toContain(1);
    expect(users.map((u) => u.email)).toContain('sadmin@example.com');
    const roles = body.tables.user_roles ?? [];
    expect(roles.every((r) => r.user_id !== 1)).toBe(true);
    expect(text).not.toContain(PLATFORM_EMAIL);
    expect(text).not.toContain(PLATFORM_SUB);
  });

  it('エクスポートは全体管理者本人には従来通り含まれる', async () => {
    const res = await api('/api/v1/admin/export.json', platformToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tables: Record<string, Record<string, unknown>[]> };
    expect((body.tables.users ?? []).map((u) => u.email)).toContain(PLATFORM_EMAIL);
    expect((body.tables.user_roles ?? []).some((r) => r.user_id === 1)).toBe(true);
  });

  it('/api/v1/me は全体管理者本人の情報を従来通り返す', async () => {
    const res = await api('/api/v1/me', platformToken);
    expect(res.status).toBe(200);
    const me = (await res.json()) as { id: number; email: string; displayName: string };
    expect(me.id).toBe(1);
    expect(me.email).toBe(PLATFORM_EMAIL);
    expect(me.displayName).toBe(PLATFORM_NAME);
  });
});
