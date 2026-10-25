import { env, SELF } from 'cloudflare:test';
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
import maintenanceExtrasSql from '../../workers/migrations/0012_maintenance_extras.sql?raw';
import announcementsSql from '../../workers/migrations/0013_announcements.sql?raw';
import practicalSql from '../../workers/migrations/0014_practical.sql?raw';
import commercialSql from '../../workers/migrations/0015_commercial.sql?raw';
import operationsSql from '../../workers/migrations/0016_operations.sql?raw';
import securitySql from '../../workers/migrations/0017_security.sql?raw';
import plansSql from '../../workers/migrations/0018_plans.sql?raw';
import { createSession } from '../../workers/src/lib/session';

/**
 * 組織・プラン管理 (0018) の結合テスト (全体管理 Worker)。
 * - migration 0018 で DGOSK 組織 (owner) ができ、店舗 1 が紐付いていること
 * - 組織の作成・名前変更・プラン変更と監査ログ
 * - 店舗作成は組織が必須で、プランの店舗数上限を超えるとブロックされる
 * - 割当によるユーザー追加も組織のユーザー上限でブロックされる
 * ユーザー: 1 = 全体管理者、2〜5 = 割当検証用の一般ユーザー
 */

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let adminCookie = '';

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

function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function auditActions(action: string): Promise<{ payload: string | null }[]> {
  const { results } = await testEnv.DB.prepare(
    'SELECT payload FROM audit_logs WHERE action = ?1 ORDER BY id ASC',
  )
    .bind(action)
    .all<{ payload: string | null }>();
  return results;
}

beforeAll(async () => {
  for (const sql of [
    initSql, seedSql, permissionsSql, sessionsSql, businessSql, featuresSql,
    purchasingSql, multiStoreSql, sessionScopeSql, platformSettingsSql,
    maintenanceWindowsSql, maintenanceExtrasSql, announcementsSql, practicalSql,
    commercialSql, operationsSql, securitySql, plansSql,
  ]) {
    for (const stmt of statementsOf(sql)) {
      await testEnv.DB.prepare(stmt).run();
    }
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-platform-admin', 'platform@example.com', 'Platform', 'active', ?1, ?1),
              (2, 'sub-u2', 'u2@example.com', 'U2', 'active', ?1, ?1),
              (3, 'sub-u3', 'u3@example.com', 'U3', 'active', ?1, ?1),
              (4, 'sub-u4', 'u4@example.com', 'U4', 'active', ?1, ?1),
              (5, 'sub-u5', 'u5@example.com', 'U5', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, NULL)`,
    ),
  ]);
  adminCookie = await createSession(testEnv.DB, 1, { scope: 'platform' });
});

describe('組織・プラン管理', () => {
  it('migration で DGOSK 組織 (owner) が店舗 1 に紐付き、一覧に利用状況つきで出る', async () => {
    const res = await api('/api/platform/organizations', { cookie: adminCookie });
    expect(res.status).toBe(200);
    const plans = res.body.plans as { key: string; price: number | null }[];
    expect(plans.map((p) => p.key)).toEqual(['free', 'starter', 'standard', 'pro', 'enterprise', 'owner']);
    expect(plans.find((p) => p.key === 'standard')?.price).toBe(12800);
    const orgs = res.body.organizations as {
      id: number; name: string; planKey: string;
      usage: { stores: number; users: number; skus: number };
    }[];
    const dgosk = orgs.find((o) => o.name === 'DGOSK');
    expect(dgosk).toBeDefined();
    expect(dgosk?.planKey).toBe('owner');
    expect(dgosk?.usage.stores).toBe(1);
  });

  it('組織の作成・名前変更・プラン変更ができ、監査ログに残る', async () => {
    const created = await api('/api/platform/organizations', {
      cookie: adminCookie,
      method: 'POST',
      body: { name: 'TestOrg', planKey: 'free' },
    });
    expect(created.status).toBe(201);
    const orgId = created.body.id as number;
    expect(created.body.planKey).toBe('free');

    const badPlan = await api('/api/platform/organizations', {
      cookie: adminCookie,
      method: 'POST',
      body: { name: 'BadOrg', planKey: 'platinum' },
    });
    expect(badPlan.status).toBe(422);
    expect(badPlan.body.error).toBe('UNKNOWN_PLAN');

    const renamed = await api(`/api/platform/organizations/${orgId}`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { name: 'TestOrg改' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('TestOrg改');

    const changed = await api(`/api/platform/organizations/${orgId}/plan`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { planKey: 'starter' },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.planKey).toBe('starter');

    const creates = await auditActions('platform.organization.create');
    expect(creates.length).toBe(1);
    const changes = await auditActions('platform.organization.plan_changed');
    expect(changes.length).toBe(1);
    const payload = JSON.parse(changes[0]?.payload ?? '{}') as { from: string; to: string };
    expect(payload).toEqual({ from: 'free', to: 'starter' });

    // 後続テストのために free に戻す
    const back = await api(`/api/platform/organizations/${orgId}/plan`, {
      cookie: adminCookie,
      method: 'PUT',
      body: { planKey: 'free' },
    });
    expect(back.status).toBe(200);
    (globalThis as { __testOrgId?: number }).__testOrgId = orgId;
  });

  it('店舗作成は組織が必須で、free の店舗数上限 (1) を超えるとブロックされる', async () => {
    const orgId = (globalThis as { __testOrgId?: number }).__testOrgId as number;

    const noOrg = await api('/api/platform/stores', {
      cookie: adminCookie,
      method: 'POST',
      body: { code: 'NOORG', name: '組織なし' },
    });
    expect(noOrg.status).toBe(400);
    expect(noOrg.body.error).toBe('ORGANIZATION_REQUIRED');

    const badOrg = await api('/api/platform/stores', {
      cookie: adminCookie,
      method: 'POST',
      body: { code: 'BADORG', name: '不明な組織', organizationId: 9999 },
    });
    expect(badOrg.status).toBe(422);
    expect(badOrg.body.error).toBe('ORGANIZATION_NOT_FOUND');

    const first = await api('/api/platform/stores', {
      cookie: adminCookie,
      method: 'POST',
      body: { code: 'TORG-1', name: 'テスト店舗1', organizationId: orgId },
    });
    expect(first.status).toBe(201);
    expect(first.body.organizationId).toBe(orgId);
    const storeId = first.body.id as number;
    (globalThis as { __testStoreId?: number }).__testStoreId = storeId;

    const second = await api('/api/platform/stores', {
      cookie: adminCookie,
      method: 'POST',
      body: { code: 'TORG-2', name: 'テスト店舗2', organizationId: orgId },
    });
    expect(second.status).toBe(403);
    expect(second.body.error).toBe('PLAN_LIMIT_REACHED');
    expect(second.body.resource).toBe('stores');
    expect(second.body.limit).toBe(1);
    expect(second.body.current).toBe(1);

    // 店舗一覧に所属組織とプランが出る
    const list = await api('/api/platform/stores', { cookie: adminCookie });
    const row = (list.body as unknown as { id: number; organization: { name: string; planKey: string } | null }[])
      .find((s) => s.id === storeId);
    expect(row?.organization?.name).toBe('TestOrg改');
    expect(row?.organization?.planKey).toBe('free');

    // owner 組織 (DGOSK) は店舗数無制限
    const orgs = await api('/api/platform/organizations', { cookie: adminCookie });
    const dgosk = (orgs.body.organizations as { id: number; name: string }[]).find((o) => o.name === 'DGOSK');
    const ownerStore = await api('/api/platform/stores', {
      cookie: adminCookie,
      method: 'POST',
      body: { code: 'DGOSK-2', name: 'DGOSK 2号店', organizationId: dgosk?.id },
    });
    expect(ownerStore.status).toBe(201);
  });

  it('割当によるユーザー追加は組織のユーザー上限 (free: 3) でブロックされる', async () => {
    const storeId = (globalThis as { __testStoreId?: number }).__testStoreId as number;
    const assign = (userId: number) =>
      api(`/api/platform/users/${userId}/assignments`, {
        cookie: adminCookie,
        method: 'PUT',
        body: { assignments: [{ roleCode: 'INVENTORY_STAFF', warehouseId: null, storeId }] },
      });
    expect((await assign(2)).status).toBe(200);
    expect((await assign(3)).status).toBe(200);
    expect((await assign(4)).status).toBe(200);
    const over = await assign(5);
    expect(over.status).toBe(403);
    expect(over.body.error).toBe('PLAN_LIMIT_REACHED');
    expect(over.body.resource).toBe('users');
    expect(over.body.limit).toBe(3);
    expect(over.body.current).toBe(3);

    // 既存メンバーの割当変更は増員として数えない
    const change = await api('/api/platform/users/2/assignments', {
      cookie: adminCookie,
      method: 'PUT',
      body: { assignments: [{ roleCode: 'INVENTORY_MANAGER', warehouseId: null, storeId }] },
    });
    expect(change.status).toBe(200);
  });
});
