import { env, SELF } from 'cloudflare:test';
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
import invitesSql from '../migrations/0021_invites.sql?raw';
import { createSession } from '../src/lib/session';
import { syncUserAndAssignments } from '../src/lib/auth';

/**
 * 招待リンク・参加リクエスト (保留エリア) とユーザー名設定 (0021) の結合テスト。
 *
 * ユーザー: 1 = 全体管理者、2 = 店舗2の SYSTEM_ADMIN、3 = 店舗2の
 * INVENTORY_MANAGER (admin.users なし)、4 = 割当なし (招待される人 A)、
 * 5 = 割当なし (招待される人 B)。
 */

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

let cookieAdmin = '';
let cookieManager = '';
let cookieA = '';
let cookieB = '';
let inviteToken = '';
let inviteId = 0;

async function api(
  path: string,
  opts: { cookie?: string; method?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `session=${opts.cookie}`;
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
    ...statementsOf(invitesSql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }

  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO stores (id, code, name, status, created_at, updated_at)
       VALUES (2, 'S1', 'Store One', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-platform', 'platform@example.com', 'Platform', 'active', ?1, ?1),
              (2, 'sub-admin', 'admin@example.com', 'Admin', 'active', ?1, ?1),
              (3, 'sub-manager', 'manager@example.com', 'Manager', 'active', ?1, ?1),
              (4, 'sub-invitee-a', 'a@example.com', 'InviteeA', 'active', ?1, ?1),
              (5, 'sub-invitee-b', 'b@example.com', 'InviteeB', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, NULL),
              (2, 'SYSTEM_ADMIN', NULL, 2),
              (3, 'INVENTORY_MANAGER', NULL, 2)`,
    ),
  ]);

  cookieAdmin = await createSession(testEnv.DB, 2);
  cookieManager = await createSession(testEnv.DB, 3);
  cookieA = await createSession(testEnv.DB, 4);
  cookieB = await createSession(testEnv.DB, 5);
});

describe('招待リンクの発行と一覧', () => {
  it('admin.users が無いユーザーは発行できない (403)', async () => {
    const res = await api('/api/v1/admin/invites', { cookie: cookieManager, method: 'POST', body: {} });
    expect(res.status).toBe(403);
  });

  it('未認証は 401', async () => {
    const res = await api('/api/v1/admin/invites', { method: 'POST', body: {} });
    expect(res.status).toBe(401);
  });

  it('店舗管理者は発行できる (トークン・URL・7日期限)', async () => {
    const res = await api('/api/v1/admin/invites', {
      cookie: cookieAdmin,
      method: 'POST',
      body: { memo: '新規スタッフ用' },
    });
    expect(res.status).toBe(200);
    inviteToken = res.body.token as string;
    inviteId = res.body.id as number;
    expect(inviteToken.length).toBe(64);
    expect(res.body.url).toBe(`https://example.com/invite/${inviteToken}`);
    const expiresAt = res.body.expiresAt as number;
    expect(expiresAt - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(expiresAt - Date.now()).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
    expect(await countRows('SELECT COUNT(*) AS n FROM store_invites WHERE id = ?1', inviteId)).toBe(1);
  });

  it('一覧に状態つきで返り、QR は SVG で返る', async () => {
    const list = await api('/api/v1/admin/invites', { cookie: cookieAdmin });
    expect(list.status).toBe(200);
    const items = list.body as unknown as Record<string, unknown>[];
    expect(items.length).toBe(1);
    expect(items[0].status).toBe('active');
    expect(items[0].acceptedCount).toBe(0);

    const res = await SELF.fetch(`https://example.com/api/v1/admin/invites/${inviteId}/qr`, {
      headers: { Cookie: `session=${cookieAdmin}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/svg+xml');
    expect(await res.text()).toContain('<svg');
  });

  it('/invite/:token は有効ならアプリへ転送、無効なら 404 ページ', async () => {
    const ok = await SELF.fetch(`https://example.com/invite/${inviteToken}`, { redirect: 'manual' });
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe(`/app?invite=${inviteToken}`);
    const ng = await SELF.fetch('https://example.com/invite/deadbeefdeadbeefdeadbeefdeadbeef', {
      redirect: 'manual',
    });
    expect(ng.status).toBe(404);
    expect(await ng.text()).toContain('招待リンクが無効です');
  });
});

describe('参加リクエスト (保留) と付与・却下', () => {
  it('受付で保留に入り、me.pendingStores に出る (冪等)', async () => {
    const res = await api('/api/v1/invites/accept', { cookie: cookieA, method: 'POST', body: { token: inviteToken } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect((res.body.store as Record<string, unknown>).name).toBe('Store One');
    expect(await countRows('SELECT COUNT(*) AS n FROM store_pending_members WHERE store_id = 2 AND user_id = 4')).toBe(1);

    const me = await api('/api/v1/me', { cookie: cookieA });
    const pending = me.body.pendingStores as Record<string, unknown>[];
    expect(pending.length).toBe(1);
    expect(pending[0].storeName).toBe('Store One');

    const again = await api('/api/v1/invites/accept', { cookie: cookieA, method: 'POST', body: { token: inviteToken } });
    expect(again.body.status).toBe('already_pending');
    const inv = await testEnv.DB.prepare('SELECT accepted_count AS n FROM store_invites WHERE id = ?1')
      .bind(inviteId)
      .first<{ n: number }>();
    expect(inv?.n).toBe(1);
  });

  it('同じリンクから別の人もリクエストできる', async () => {
    const res = await api('/api/v1/invites/accept', { cookie: cookieB, method: 'POST', body: { token: inviteToken } });
    expect(res.body.status).toBe('pending');
    const inv = await testEnv.DB.prepare('SELECT accepted_count AS n FROM store_invites WHERE id = ?1')
      .bind(inviteId)
      .first<{ n: number }>();
    expect(inv?.n).toBe(2);
  });

  it('所属済みのユーザーは already_member', async () => {
    const res = await api('/api/v1/invites/accept', { cookie: cookieAdmin, method: 'POST', body: { token: inviteToken } });
    expect(res.body.status).toBe('already_member');
  });

  it('保留一覧は管理者だけが見られる', async () => {
    const list = await api('/api/v1/admin/pending-members', { cookie: cookieAdmin });
    expect(list.status).toBe(200);
    const rows = list.body as unknown as Record<string, unknown>[];
    expect(rows.map((r) => r.userId).sort()).toEqual([4, 5]);
    const denied = await api('/api/v1/admin/pending-members', { cookie: cookieManager });
    expect(denied.status).toBe(403);
  });

  it('未知のロールは 422、付与で割当ができ保留が消える', async () => {
    const bad = await api('/api/v1/admin/pending-members/4/grant', {
      cookie: cookieAdmin,
      method: 'POST',
      body: { roleCode: 'NOPE' },
    });
    expect(bad.status).toBe(422);

    const res = await api('/api/v1/admin/pending-members/4/grant', {
      cookie: cookieAdmin,
      method: 'POST',
      body: { roleCode: 'INVENTORY_STAFF' },
    });
    expect(res.status).toBe(200);
    expect(
      await countRows(
        "SELECT COUNT(*) AS n FROM user_roles WHERE user_id = 4 AND store_id = 2 AND role_code = 'INVENTORY_STAFF'",
      ),
    ).toBe(1);
    expect(await countRows('SELECT COUNT(*) AS n FROM store_pending_members WHERE user_id = 4')).toBe(0);

    const me = await api('/api/v1/me', { cookie: cookieA });
    expect((me.body.assignments as unknown[]).length).toBe(1);
    expect((me.body.pendingStores as unknown[]).length).toBe(0);

    const again = await api('/api/v1/admin/pending-members/4/grant', {
      cookie: cookieAdmin,
      method: 'POST',
      body: { roleCode: 'VIEWER' },
    });
    expect(again.status).toBe(404);
  });

  it('却下で保留が消え、再却下は 404', async () => {
    const res = await api('/api/v1/admin/pending-members/5', { cookie: cookieAdmin, method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await countRows('SELECT COUNT(*) AS n FROM store_pending_members WHERE user_id = 5')).toBe(0);
    const again = await api('/api/v1/admin/pending-members/5', { cookie: cookieAdmin, method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});

describe('招待の取り消し・期限切れ・本人の取り消し', () => {
  it('取り消したリンクは受付も入口も拒否される', async () => {
    const created = await api('/api/v1/admin/invites', { cookie: cookieAdmin, method: 'POST', body: {} });
    const token2 = created.body.token as string;
    const id2 = created.body.id as number;
    const del = await api(`/api/v1/admin/invites/${id2}`, { cookie: cookieAdmin, method: 'DELETE' });
    expect(del.status).toBe(200);
    const accept = await api('/api/v1/invites/accept', { cookie: cookieB, method: 'POST', body: { token: token2 } });
    expect(accept.status).toBe(400);
    expect(accept.body.error).toBe('INVITE_REVOKED');
    const entry = await SELF.fetch(`https://example.com/invite/${token2}`, { redirect: 'manual' });
    expect(entry.status).toBe(404);
    const again = await api(`/api/v1/admin/invites/${id2}`, { cookie: cookieAdmin, method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  it('期限切れのリンクは INVITE_EXPIRED', async () => {
    const now = Date.now();
    await testEnv.DB.prepare(
      'INSERT INTO store_invites (store_id, token, memo, created_by, expires_at, created_at) VALUES (2, ?1, NULL, 2, ?2, ?3)',
    )
      .bind('expired-token-0123456789abcdef0123456789abcdef0123456789abcdef', now - 1000, now - 8 * 24 * 60 * 60 * 1000)
      .run();
    const res = await api('/api/v1/invites/accept', {
      cookie: cookieB,
      method: 'POST',
      body: { token: 'expired-token-0123456789abcdef0123456789abcdef0123456789abcdef' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVITE_EXPIRED');
  });

  it('存在しないトークンは 404 INVITE_NOT_FOUND', async () => {
    const res = await api('/api/v1/invites/accept', {
      cookie: cookieB,
      method: 'POST',
      body: { token: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('INVITE_NOT_FOUND');
  });

  it('本人の取り消しで保留が消える', async () => {
    const created = await api('/api/v1/admin/invites', { cookie: cookieAdmin, method: 'POST', body: {} });
    const token3 = created.body.token as string;
    const accept = await api('/api/v1/invites/accept', { cookie: cookieB, method: 'POST', body: { token: token3 } });
    expect(accept.body.status).toBe('pending');
    const del = await api('/api/v1/me/pending/2', { cookie: cookieB, method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await countRows('SELECT COUNT(*) AS n FROM store_pending_members WHERE user_id = 5')).toBe(0);
    const again = await api('/api/v1/me/pending/2', { cookie: cookieB, method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});

describe('ユーザー名 (表示名) の設定', () => {
  it('PATCH /api/v1/me で設定でき、me に反映される', async () => {
    const res = await api('/api/v1/me', { cookie: cookieA, method: 'PATCH', body: { displayName: '新しい名前' } });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('新しい名前');
    const row = await testEnv.DB.prepare('SELECT display_name, display_name_custom FROM users WHERE id = 4')
      .first<{ display_name: string; display_name_custom: number }>();
    expect(row?.display_name).toBe('新しい名前');
    expect(row?.display_name_custom).toBe(1);
    const me = await api('/api/v1/me', { cookie: cookieA });
    expect(me.body.displayName).toBe('新しい名前');
  });

  it('空文字と長すぎる名前は 400', async () => {
    const empty = await api('/api/v1/me', { cookie: cookieA, method: 'PATCH', body: { displayName: '  ' } });
    expect(empty.status).toBe(400);
    const long = await api('/api/v1/me', { cookie: cookieA, method: 'PATCH', body: { displayName: 'あ'.repeat(51) } });
    expect(long.status).toBe(400);
  });

  it('カスタム名は Google ログイン同期で上書きされない', async () => {
    const synced = await syncUserAndAssignments(testEnv.DB, {
      sub: 'sub-invitee-a',
      email: 'a@example.com',
      displayName: 'Google Name',
    });
    expect(synced.displayName).toBe('新しい名前');
  });

  it('カスタムでない名前は従来どおり Google 側で同期される', async () => {
    const synced = await syncUserAndAssignments(testEnv.DB, {
      sub: 'sub-manager',
      email: 'manager@example.com',
      displayName: 'Manager Renamed',
    });
    expect(synced.displayName).toBe('Manager Renamed');
  });
});
