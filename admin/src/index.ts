import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AdminEnv } from './env';
import type { Env as WorkersEnv } from '../../workers/src/env';
import {
  syncUserFromPayload,
  verifyToken,
  type AuthUser,
} from '../../workers/src/lib/auth';
import {
  ALL_ROLE_CODES,
  isPlatformAdmin,
  RoleCode,
} from '../../workers/src/lib/access';
import { getStore } from '../../workers/src/lib/stores';
import {
  clearSessionCookieHeader,
  createSession,
  destroySession,
  hashSessionToken,
  PLATFORM_SESSION_COOKIE_NAME,
  readSessionToken,
  resolveSessionUser,
  sessionCookieHeader,
} from '../../workers/src/lib/session';
import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  getFeatures,
} from '../../workers/src/lib/features';
import {
  activeOccurrence,
  featureMapFromEntries,
  LEGACY_FEATURE_EXPANSION,
  LEGACY_FEATURE_KEYS,
  loadMaintenanceWindows,
  MAINTENANCE_FEATURE_KEYS,
  MAINTENANCE_WRITE_STAGE_KEYS,
  nextOccurrence,
  normalizeWindow,
  type MaintenanceFeatureMap,
  type MaintenanceFeatureStage,
  type MaintenanceWindow,
  type MaintenanceWindowRow,
} from '../../workers/src/lib/maintenance';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from '../../workers/src/lib/errors';
import { CONSOLE_HTML } from './console';

/**
 * 在庫管理システム — 全体管理 (プラットフォーム管理) 専用 Worker。
 *
 * 店舗アプリ (inventory-system-workers) から分離した別プロジェクト。
 * 店舗ではなくシステム全体 (全店舗) を扱う管理機能だけを提供する:
 * - GET  /                        全体管理コンソール画面
 * - GET  /auth/login, /auth/callback
 *   Google 認可コードフロー。全体管理者 (SYSTEM_ADMIN かつ store_id NULL の
 *   割当を持つユーザー) 以外はログイン自体を拒否し、セッションを発行しない。
 * - /api/platform/*               全体管理 API (platform スコープのセッション必須)
 * - POST /api/auth/logout
 * - それ以外はすべて 404
 *
 * セッションは店舗アプリと分離する: Cookie 名は admin_session、
 * sessions.scope = 'platform'、有効期限は 2 時間。店舗アプリのセッション
 * (scope = 'app') ではこの Worker の API を使えず、逆も同様。
 * DB (D1) は店舗アプリと共有し、割当・店舗・機能フラグを直接読み書きする。
 */

type Variables = { user: AuthUser };
type AppContext = Context<{ Bindings: AdminEnv; Variables: Variables }>;

const app = new Hono<{ Bindings: AdminEnv; Variables: Variables }>();

function user(c: AppContext): AuthUser {
  return c.get('user');
}

/** workers 側 lib (verifyToken / syncUserFromPayload) は店舗アプリの Env 型を取るため変換する */
function asWorkersEnv(env: AdminEnv): WorkersEnv {
  return env as unknown as WorkersEnv;
}

// ------------------------------------------------------------ ユーティリティ

async function parseJson(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest('Request body must be JSON');
  }
}

function parseWith<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return result.data;
}

/** ロール一覧 (roles テーブルが空なら既知の 5 ロールで代替。店舗アプリと同実装) */
async function listRoles(c: AppContext): Promise<{ code: string; name: string }[]> {
  try {
    const { results } = await c.env.DB.prepare('SELECT code, name FROM roles ORDER BY code ASC').all<{
      code: string;
      name: string;
    }>();
    if (results.length > 0) return results;
  } catch {
    // roles 未投入の環境ではフォールバックする
  }
  return ALL_ROLE_CODES.map((code) => ({ code, name: code }));
}

// ------------------------------------------------------------ 認証 (Google 認可コードフロー)

// ログイン開始 (サーバー側リダイレクト)。店舗アプリと同じクライアント ID を使う。
app.get('/auth/login', (c) => {
  const clientId = c.env.OIDC_CLIENT_ID ?? '';
  if (!clientId) return c.text('OIDC is not configured', 503);
  const nonce = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: new URL('/auth/callback', c.req.url).toString(),
    response_type: 'code',
    scope: 'openid email profile',
    nonce,
    state: nonce,
    prompt: 'select_account',
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      'Set-Cookie': `oauth_nonce=${nonce}; Path=/; Max-Age=600; SameSite=Lax`,
    },
  });
});

// OAuth リダイレクト受け口。店舗アプリとの違いは2点:
// 1) 全体管理者の割当が無いユーザーはログイン自体を拒否する (セッションを発行しない)
// 2) 発行するセッションは platform スコープ (Cookie 名 admin_session、有効期限 2 時間)
app.get('/auth/callback', async (c) => {
  const page = (title: string, body: string, status: 200 | 400 | 403 | 500 = 200) =>
    c.html(
      `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | 全体管理</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.7;">
<h1>${title}</h1>
${body}
</body>
</html>`,
      status,
    );

  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  if (oauthError) return page('ログインに失敗しました', `<p>Google からエラーが返されました: ${oauthError}</p>`, 400);
  if (!code) return page('ログインに失敗しました', '<p>認可コードが返されませんでした。</p>', 400);

  const clientId = c.env.OIDC_CLIENT_ID ?? '';
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    return page('サーバー設定が不足しています', '<p>GOOGLE_CLIENT_SECRET が未設定です。</p>', 500);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: new URL('/auth/callback', c.req.url).toString(),
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    return page('ログインに失敗しました', `<p>トークン交換に失敗しました (HTTP ${tokenRes.status})。</p>`, 400);
  }
  const tokenJson = (await tokenRes.json()) as { id_token?: string };
  if (!tokenJson.id_token) {
    return page('ログインに失敗しました', '<p>ID トークンが返されませんでした。</p>', 400);
  }

  let authUser: AuthUser;
  try {
    const payload = await verifyToken(asWorkersEnv(c.env), tokenJson.id_token);
    const cookieNonce = (c.req.header('cookie') ?? '').match(/(?:^|;\s*)oauth_nonce=([^;]*)/)?.[1] ?? '';
    if (cookieNonce && payload.nonce !== cookieNonce) {
      return page('ログインに失敗しました', '<p>nonce が一致しません。もう一度ログインしてください。</p>', 400);
    }
    authUser = await syncUserFromPayload(asWorkersEnv(c.env), payload);
  } catch {
    return page('ログインに失敗しました', '<p>ID トークンの検証に失敗しました。</p>', 400);
  }

  // 全体管理者だけがこの Worker にログインできる。割当が無いユーザーは
  // ここで弾き、セッションは発行しない (コンソール API も同じ判定で守る)。
  if (!isPlatformAdmin(authUser.assignments)) {
    return page(
      'ログインできません',
      `<p>${authUser.email} には全体管理者の権限がありません。全体管理は、システム全体の管理者 (全体管理者) だけが利用できます。</p><p>店舗内の操作は店舗アプリから行ってください。</p>`,
      403,
    );
  }

  const sessionToken = await createSession(c.env.DB, authUser.userId, { scope: 'platform' });
  const res = page(
    'ログインしました',
    `<p>メールアドレス: ${authUser.email}</p><p>全体管理者としてログインしました (セッションの有効期限は2時間です)。</p><p><a href="/">全体管理コンソールを開く</a></p>`,
  );
  res.headers.append('Set-Cookie', sessionCookieHeader(sessionToken, { name: PLATFORM_SESSION_COOKIE_NAME }));
  return res;
});

/** ログアウト: platform スコープのセッションを破棄し、Cookie 自体も失効させる */
app.post('/api/auth/logout', async (c) => {
  try {
    await destroySession(c.env.DB, c.req.raw, PLATFORM_SESSION_COOKIE_NAME);
  } catch {
    // sessions テーブル未適用の環境では破棄するものが無い
  }
  return c.json({ loggedOut: true }, 200, {
    'Set-Cookie': clearSessionCookieHeader(PLATFORM_SESSION_COOKIE_NAME),
  });
});

// ------------------------------------------------------------ 全体管理コンソール画面
app.get('/', (c) => c.html(CONSOLE_HTML));

// ------------------------------------------------------------ 全体管理 API
// 全エンドポイントで「platform スコープのセッション」必須 (401)。
// さらに各ハンドラで全体管理者の割当を検証する (403)。

app.use('/api/platform/*', async (c, next) => {
  let sessionUser: AuthUser | null = null;
  try {
    sessionUser = await resolveSessionUser(c.env.DB, c.req.raw, {
      cookieName: PLATFORM_SESSION_COOKIE_NAME,
      scope: 'platform',
    });
  } catch {
    // sessions テーブル未適用など。未認証に倒す
  }
  if (!sessionUser) throw unauthorized('Login required');
  c.set('user', sessionUser);
  return next();
});

/**
 * 全体管理者チェック (プラットフォーム API のガード)。
 * 権限キーではなく「SYSTEM_ADMIN かつ store_id NULL の割当」で判定する。
 */
function requirePlatformAdmin(c: AppContext): void {
  if (user(c).assignments.length === 0 || !isPlatformAdmin(user(c).assignments)) {
    throw forbidden('Platform admin only');
  }
}

/** 自分の情報。コンソール画面がログイン状態と全体管理者かどうかを判定するために使う */
app.get('/api/platform/me', (c) => {
  const me = user(c);
  return c.json({
    id: me.userId,
    email: me.email,
    displayName: me.displayName,
    isPlatformAdmin: isPlatformAdmin(me.assignments),
  });
});

/** ロール一覧 (割当編集 UI のセレクト用) */
app.get('/api/platform/roles', async (c) => {
  requirePlatformAdmin(c);
  return c.json({ roles: await listRoles(c) });
});

interface StoreDbRow {
  id: number;
  code: string;
  name: string;
  status: string;
  created_at: number;
  updated_at: number;
}

function storeJson(r: StoreDbRow): Record<string, unknown> {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function storeRow(c: AppContext, id: number): Promise<StoreDbRow> {
  const row = await c.env.DB.prepare('SELECT * FROM stores WHERE id = ?1')
    .bind(id)
    .first<StoreDbRow>();
  if (!row) throw notFound('Store not found');
  return row;
}

async function platformAudit(
  c: AppContext,
  action: string,
  targetType: string,
  targetId: string,
  payload: unknown,
  storeId: number | null,
): Promise<void> {
  await c.env.DB.prepare(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(user(c).userId, action, targetType, targetId, JSON.stringify(payload), storeId, Date.now())
    .run();
}

app.get('/api/platform/stores', async (c) => {
  requirePlatformAdmin(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM stores ORDER BY id ASC').all<StoreDbRow>();
  return c.json(results.map(storeJson));
});

const createStoreBodySchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
});

app.post('/api/platform/stores', async (c) => {
  requirePlatformAdmin(c);
  const dto = parseWith(createStoreBodySchema, await parseJson(c));
  const now = Date.now();
  let res: D1Result;
  try {
    res = await c.env.DB.prepare(
      `INSERT INTO stores (code, name, status, created_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?3)`,
    )
      .bind(dto.code, dto.name, now)
      .run();
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Store with this code already exists');
  }
  const id = Number(res.meta.last_row_id);
  await platformAudit(c, 'platform.store.create', 'store', String(id), { code: dto.code, name: dto.name }, id);
  return c.json(storeJson(await storeRow(c, id)), 201);
});

const updateStoreBodySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

app.put('/api/platform/stores/:id', async (c) => {
  requirePlatformAdmin(c);
  const id = Number(c.req.param('id'));
  const row = await storeRow(c, id);
  const dto = parseWith(updateStoreBodySchema, await parseJson(c));
  const name = dto.name ?? row.name;
  const status = dto.status ?? row.status;
  await c.env.DB.prepare('UPDATE stores SET name = ?1, status = ?2, updated_at = ?3 WHERE id = ?4')
    .bind(name, status, Date.now(), id)
    .run();
  await platformAudit(c, 'platform.store.update', 'store', String(id), { name, status }, id);
  return c.json(storeJson(await storeRow(c, id)));
});

app.get('/api/platform/stores/:id/stats', async (c) => {
  requirePlatformAdmin(c);
  const id = Number(c.req.param('id'));
  await storeRow(c, id);
  const since = Date.now() - 30 * 86_400_000;
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(DISTINCT user_id) FROM user_roles WHERE store_id = ?1) AS users,
       (SELECT COUNT(*) FROM products WHERE store_id = ?1 AND deleted_at IS NULL) AS products,
       (SELECT COUNT(*) FROM stocks WHERE store_id = ?1) AS stockRecords,
       (SELECT COUNT(*) FROM stock_movements WHERE store_id = ?1 AND created_at >= ?2) AS movements30d`,
  )
    .bind(id, since)
    .first<{ users: number; products: number; stockRecords: number; movements30d: number }>();
  return c.json({
    storeId: id,
    users: row?.users ?? 0,
    products: row?.products ?? 0,
    stockRecords: row?.stockRecords ?? 0,
    movementsLast30Days: row?.movements30d ?? 0,
  });
});

const featureFlagBodySchema = z.object({ enabled: z.boolean() });

/** 機能フラグの upsert (店舗単位)。監査ログにも店舗を記録する */
async function upsertFeatureFlag(
  c: AppContext,
  storeId: number,
  key: string,
  enabled: boolean,
): Promise<void> {
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO feature_flags (store_id, key, enabled, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(store_id, key) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(storeId, key, enabled ? 1 : 0, user(c).userId, now),
    c.env.DB
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at)
         VALUES (?1, 'feature_flag.update', 'feature_flag', ?2, ?3, ?4, ?5)`,
      )
      .bind(user(c).userId, key, JSON.stringify({ enabled, storeId, via: 'platform' }), storeId, now),
  ]);
}

app.get('/api/platform/stores/:id/features', async (c) => {
  requirePlatformAdmin(c);
  const id = Number(c.req.param('id'));
  await storeRow(c, id);
  const features = await getFeatures(c.env.DB, id);
  return c.json({
    storeId: id,
    features: FEATURE_CATALOG.map((f) => ({ key: f.key, label: f.label, enabled: features[f.key] === true })),
  });
});

app.put('/api/platform/stores/:id/features/:key', async (c) => {
  requirePlatformAdmin(c);
  const id = Number(c.req.param('id'));
  await storeRow(c, id);
  const key = c.req.param('key');
  if (!FEATURE_KEYS.has(key)) {
    throw new ApiError(422, 'UNKNOWN_FEATURE', `Unknown feature key: ${key}`);
  }
  const dto = parseWith(featureFlagBodySchema, await parseJson(c));
  await upsertFeatureFlag(c, id, key, dto.enabled);
  return c.json({ storeId: id, key, enabled: dto.enabled });
});

/**
 * 全ユーザーと、全店舗・全体を含む全割当の一覧 (全体管理用)。
 * 各ユーザーに状態・最終ログイン (セッション発行の最新 created_at)・
 * 割当サマリ (全体管理者か、所属店舗数) を含める。クエリ q で名前・メール検索。
 */
app.get('/api/platform/users', async (c) => {
  requirePlatformAdmin(c);
  const q = (c.req.query('q') ?? '').trim();
  const like = `%${q}%`;
  const { results: users } = await c.env.DB.prepare(
    `SELECT id, external_id AS externalId, email, display_name AS displayName, status,
            (SELECT MAX(created_at) FROM sessions WHERE user_id = users.id) AS lastLoginAt
       FROM users
      WHERE ?1 = '' OR email LIKE ?2 OR display_name LIKE ?2
      ORDER BY id ASC`,
  )
    .bind(q, like)
    .all<{
      id: number;
      externalId: string;
      email: string;
      displayName: string;
      status: string;
      lastLoginAt: number | null;
    }>();
  const { results: roleRows } = await c.env.DB.prepare(
    'SELECT user_id AS userId, role_code AS roleCode, warehouse_id AS warehouseId, store_id AS storeId FROM user_roles ORDER BY id ASC',
  ).all<{ userId: number; roleCode: string; warehouseId: number | null; storeId: number | null }>();
  const byUser = new Map<number, { roleCode: string; warehouseId: number | null; storeId: number | null }[]>();
  for (const r of roleRows) {
    const list = byUser.get(r.userId) ?? [];
    list.push({ roleCode: r.roleCode, warehouseId: r.warehouseId, storeId: r.storeId });
    byUser.set(r.userId, list);
  }
  return c.json(
    users.map((u) => {
      const assignments = byUser.get(u.id) ?? [];
      return {
        ...u,
        assignments,
        assignmentSummary: {
          isPlatformAdmin: assignments.some(
            (a) => a.roleCode === RoleCode.SYSTEM_ADMIN && a.storeId === null,
          ),
          storeCount: new Set(
            assignments.map((a) => a.storeId).filter((id): id is number => id !== null),
          ).size,
        },
      };
    }),
  );
});

const platformAssignmentsBodySchema = z.object({
  assignments: z.array(
    z.object({
      roleCode: z.string().min(1),
      warehouseId: z.union([z.number().int().positive(), z.null()]),
      storeId: z.union([z.number().int().positive(), z.null()]),
    }),
  ),
});

/**
 * 割当の横断編集 (全体管理用)。ユーザーの全割当を置き換える。
 * storeId = null は全体割当で、SYSTEM_ADMIN のみ許可する。倉庫スコープは
 * その店舗の倉庫だけに付けられる。最後の全体管理者を消す変更は 422。
 */
app.put('/api/platform/users/:userId/assignments', async (c) => {
  requirePlatformAdmin(c);
  const userId = Number(c.req.param('userId'));
  if (!Number.isInteger(userId) || userId <= 0) throw notFound('User not found');
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ id: number }>();
  if (!target) throw notFound('User not found');
  const dto = parseWith(platformAssignmentsBodySchema, await parseJson(c));
  const roles = await listRoles(c);
  const knownRoles = new Set(roles.map((r) => r.code));

  const seen = new Set<string>();
  const assignments = dto.assignments.filter((a) => {
    const key = `${a.roleCode}:${a.warehouseId ?? 'null'}:${a.storeId ?? 'null'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const a of assignments) {
    if (!knownRoles.has(a.roleCode)) {
      throw new ApiError(422, 'UNKNOWN_ROLE', `Unknown role: ${a.roleCode}`);
    }
    if (a.storeId === null) {
      // 全体割当は全体管理者の印そのものなので SYSTEM_ADMIN 以外には付けない
      if (a.roleCode !== RoleCode.SYSTEM_ADMIN) {
        throw new ApiError(422, 'PLATFORM_ASSIGNMENT_ROLE', 'Platform assignment (storeId=null) requires SYSTEM_ADMIN');
      }
      if (a.warehouseId !== null) {
        throw new ApiError(422, 'PLATFORM_ASSIGNMENT_WAREHOUSE', 'Platform assignment cannot have a warehouse scope');
      }
    } else {
      const store = await getStore(c.env.DB, a.storeId);
      if (!store) {
        throw new ApiError(422, 'STORE_NOT_FOUND', `Store not found: ${a.storeId}`);
      }
    }
    if (a.warehouseId !== null) {
      const wh = await c.env.DB.prepare('SELECT id, store_id FROM warehouses WHERE id = ?1 AND deleted_at IS NULL')
        .bind(a.warehouseId)
        .first<{ id: number; store_id: number }>();
      if (!wh) {
        throw new ApiError(422, 'WAREHOUSE_NOT_FOUND', `Warehouse not found: ${a.warehouseId}`);
      }
      if (a.storeId !== null && wh.store_id !== a.storeId) {
        throw new ApiError(422, 'WAREHOUSE_STORE_MISMATCH', `Warehouse ${a.warehouseId} does not belong to store ${a.storeId}`);
      }
    }
  }

  // 締め出し防止: 全体管理者が 1 人もいなくなる変更は拒否する
  const hasPlatform = assignments.some((a) => a.roleCode === RoleCode.SYSTEM_ADMIN && a.storeId === null);
  if (!hasPlatform) {
    const others = await c.env.DB.prepare(
      `SELECT COUNT(DISTINCT user_id) AS n FROM user_roles
        WHERE role_code = 'SYSTEM_ADMIN' AND store_id IS NULL AND user_id <> ?1`,
    )
      .bind(userId)
      .first<{ n: number }>();
    const targetIsPlatform = user(c).userId === userId
      ? true
      : ((
          await c.env.DB.prepare(
            `SELECT COUNT(*) AS n FROM user_roles
              WHERE user_id = ?1 AND role_code = 'SYSTEM_ADMIN' AND store_id IS NULL`,
          )
            .bind(userId)
            .first<{ n: number }>()
        )?.n ?? 0) > 0;
    if (targetIsPlatform && (others?.n ?? 0) === 0) {
      throw new ApiError(
        422,
        'LOCKOUT_PREVENTION',
        'At least one platform admin must remain (lockout prevention)',
      );
    }
  }

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?1').bind(userId),
    ...assignments.map((a) =>
      c.env.DB
        .prepare('INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id) VALUES (?1, ?2, ?3, ?4)')
        .bind(userId, a.roleCode, a.warehouseId, a.storeId),
    ),
  ];
  await c.env.DB.batch(stmts);
  await platformAudit(c, 'platform.user_roles.update', 'user', String(userId), { assignments }, null);
  return c.json({ userId, assignments });
});

// ------------------------------------------------------------ 概要

/** audit_logs.payload (JSON 文字列) を表示用にパースする。壊れていれば文字列のまま */
function parsePayload(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface AuditFeedRow {
  id: number;
  actorId: number | null;
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: string;
  payload: string | null;
  storeId: number | null;
  storeName: string | null;
  createdAt: number;
}

const AUDIT_FEED_SELECT = `SELECT a.id, a.actor_id AS actorId, u.email AS actorEmail,
         u.display_name AS actorName, a.action, a.target_type AS targetType,
         a.target_id AS targetId, a.payload, a.store_id AS storeId,
         s.name AS storeName, a.created_at AS createdAt
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_id
    LEFT JOIN stores s ON s.id = a.store_id`;

function auditFeedJson(r: AuditFeedRow): Record<string, unknown> {
  return { ...r, payload: parsePayload(r.payload) };
}

/**
 * 概要: 全店舗横断の件数サマリ、全体操作の直近監査 (store_id IS NULL)、
 * 店舗ごとのサマリ。コンソールの「概要」セクションが使う。
 */
app.get('/api/platform/overview', async (c) => {
  requirePlatformAdmin(c);
  const since = Date.now() - 30 * 86_400_000;
  const totals = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM stores) AS stores,
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL) AS products,
       (SELECT COUNT(*) FROM stocks) AS stockRecords,
       (SELECT COUNT(*) FROM stock_movements WHERE created_at >= ?1) AS movements30d`,
  )
    .bind(since)
    .first<{ stores: number; users: number; products: number; stockRecords: number; movements30d: number }>();
  const { results: recentAudit } = await c.env.DB.prepare(
    `${AUDIT_FEED_SELECT} WHERE a.store_id IS NULL ORDER BY a.id DESC LIMIT 10`,
  ).all<AuditFeedRow>();
  const { results: summaries } = await c.env.DB.prepare(
    `SELECT s.id, s.code, s.name, s.status,
       (SELECT COUNT(DISTINCT user_id) FROM user_roles WHERE store_id = s.id) AS users,
       (SELECT COUNT(*) FROM products WHERE store_id = s.id AND deleted_at IS NULL) AS products,
       (SELECT COUNT(*) FROM stocks WHERE store_id = s.id) AS stockRecords
     FROM stores s ORDER BY s.id ASC`,
  ).all<{
    id: number;
    code: string;
    name: string;
    status: string;
    users: number;
    products: number;
    stockRecords: number;
  }>();
  return c.json({
    totals: {
      stores: totals?.stores ?? 0,
      users: totals?.users ?? 0,
      products: totals?.products ?? 0,
      stockRecords: totals?.stockRecords ?? 0,
      movements30d: totals?.movements30d ?? 0,
    },
    recentPlatformAudit: recentAudit.map(auditFeedJson),
    storeSummaries: summaries,
  });
});

// ------------------------------------------------------------ ユーザーの状態・セッション

const userStatusBodySchema = z.object({ status: z.enum(['active', 'disabled']) });

async function platformUserRow(c: AppContext, userId: number): Promise<{ id: number; status: string }> {
  if (!Number.isInteger(userId) || userId <= 0) throw notFound('User not found');
  const row = await c.env.DB.prepare('SELECT id, status FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ id: number; status: string }>();
  if (!row) throw notFound('User not found');
  return row;
}

/**
 * ユーザーの有効化 / 停止。停止すると店舗アプリ・全体管理の両方で
 * ログインできなくなり、既存セッションも全て削除して即時締め出す。
 * 自分自身の停止と、最後の全体管理者の停止は 422 LOCKOUT_PREVENTION。
 */
app.put('/api/platform/users/:userId/status', async (c) => {
  requirePlatformAdmin(c);
  const userId = Number(c.req.param('userId'));
  const target = await platformUserRow(c, userId);
  const dto = parseWith(userStatusBodySchema, await parseJson(c));
  if (dto.status === 'disabled' && target.status !== 'disabled') {
    if (userId === user(c).userId) {
      throw new ApiError(422, 'LOCKOUT_PREVENTION', 'You cannot disable your own account');
    }
    const targetIsPlatformAdmin =
      ((await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM user_roles
          WHERE user_id = ?1 AND role_code = 'SYSTEM_ADMIN' AND store_id IS NULL`,
      )
        .bind(userId)
        .first<{ n: number }>())?.n ?? 0) > 0;
    if (targetIsPlatformAdmin) {
      const others = await c.env.DB.prepare(
        `SELECT COUNT(DISTINCT ur.user_id) AS n
           FROM user_roles ur JOIN users u ON u.id = ur.user_id
          WHERE ur.role_code = 'SYSTEM_ADMIN' AND ur.store_id IS NULL
            AND ur.user_id <> ?1 AND u.status = 'active'`,
      )
        .bind(userId)
        .first<{ n: number }>();
      if ((others?.n ?? 0) === 0) {
        throw new ApiError(
          422,
          'LOCKOUT_PREVENTION',
          'At least one active platform admin must remain (lockout prevention)',
        );
      }
    }
    await c.env.DB.batch([
      c.env.DB
        .prepare('UPDATE users SET status = ?1, updated_at = ?2 WHERE id = ?3')
        .bind(dto.status, Date.now(), userId),
      c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
    ]);
  } else if (dto.status !== target.status) {
    await c.env.DB
      .prepare('UPDATE users SET status = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(dto.status, Date.now(), userId)
      .run();
  }
  await platformAudit(c, 'platform.user.status', 'user', String(userId), { status: dto.status }, null);
  return c.json({ userId, status: dto.status });
});

/** そのユーザーの全セッションを失効させる (状態は変えない) */
app.post('/api/platform/users/:userId/revoke-sessions', async (c) => {
  requirePlatformAdmin(c);
  const userId = Number(c.req.param('userId'));
  await platformUserRow(c, userId);
  const res = await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId).run();
  const revoked = res.meta.changes ?? 0;
  await platformAudit(c, 'platform.user.revoke_sessions', 'user', String(userId), { revoked }, null);
  return c.json({ userId, revoked });
});

// ------------------------------------------------------------ 監査 (全店舗横断)

/**
 * 全店舗横断の監査ログ。storeId='platform' で全体操作 (store_id IS NULL) のみ、
 * 数値で店舗指定、userId で実行者、q で action・payload の部分一致検索。
 */
app.get('/api/platform/audit-logs', async (c) => {
  requirePlatformAdmin(c);
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const storeId = c.req.query('storeId');
  if (storeId === 'platform') {
    conditions.push('a.store_id IS NULL');
  } else if (storeId !== undefined && storeId !== '') {
    const n = Number(storeId);
    if (!Number.isInteger(n)) throw badRequest('storeId must be an integer or "platform"');
    conditions.push('a.store_id = ?');
    params.push(n);
  }
  const userId = c.req.query('userId');
  if (userId !== undefined && userId !== '') {
    const n = Number(userId);
    if (!Number.isInteger(n)) throw badRequest('userId must be a user id (integer)');
    conditions.push('a.actor_id = ?');
    params.push(n);
  }
  const q = c.req.query('q');
  if (q !== undefined && q !== '') {
    conditions.push('(a.action LIKE ? OR a.payload LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const limitRaw = Number(c.req.query('limit') ?? 100);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 100;
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs a${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const { results } = await c.env.DB.prepare(
    `${AUDIT_FEED_SELECT}${where} ORDER BY a.id DESC LIMIT ?`,
  )
    .bind(...params, limit)
    .all<AuditFeedRow>();
  return c.json({ items: results.map(auditFeedJson), total: totalRow?.n ?? 0, limit });
});

// ------------------------------------------------------------ 店舗詳細

/** 店舗詳細: 店舗本体・倉庫・割当ユーザー (ロールつき)・その店舗の直近監査 */
app.get('/api/platform/stores/:id/detail', async (c) => {
  requirePlatformAdmin(c);
  const id = Number(c.req.param('id'));
  const store = await storeRow(c, id);
  const { results: warehouses } = await c.env.DB.prepare(
    'SELECT id, code, name FROM warehouses WHERE store_id = ?1 AND deleted_at IS NULL ORDER BY id ASC',
  )
    .bind(id)
    .all<{ id: number; code: string; name: string }>();
  const { results: storeUsers } = await c.env.DB.prepare(
    `SELECT ur.user_id AS userId, u.email, u.display_name AS displayName, u.status,
            ur.role_code AS roleCode, ur.warehouse_id AS warehouseId
       FROM user_roles ur JOIN users u ON u.id = ur.user_id
      WHERE ur.store_id = ?1 ORDER BY ur.id ASC`,
  )
    .bind(id)
    .all<{
      userId: number;
      email: string;
      displayName: string;
      status: string;
      roleCode: string;
      warehouseId: number | null;
    }>();
  const { results: recentAudit } = await c.env.DB.prepare(
    `${AUDIT_FEED_SELECT} WHERE a.store_id = ?1 ORDER BY a.id DESC LIMIT 10`,
  )
    .bind(id)
    .all<AuditFeedRow>();
  return c.json({
    store: storeJson(store),
    warehouses,
    users: storeUsers,
    recentAudit: recentAudit.map(auditFeedJson),
  });
});

// ------------------------------------------------------------ システム

const SYSTEM_TABLES = [
  'stores',
  'users',
  'products',
  'stocks',
  'stock_movements',
  'audit_logs',
  'sessions',
  'purchase_orders',
] as const;

async function tableCount(db: D1Database, table: string): Promise<number> {
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** platform_settings の maintenance を読む (テーブルが無い環境では OFF) */
async function readMaintenanceSetting(
  db: D1Database,
): Promise<{ on: boolean; message: string | null }> {
  try {
    const row = await db
      .prepare('SELECT value FROM platform_settings WHERE key = ?1')
      .bind('maintenance')
      .first<{ value: string | null }>();
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { on?: unknown; message?: unknown };
      return {
        on: parsed.on === true,
        message: typeof parsed.message === 'string' && parsed.message.length > 0 ? parsed.message : null,
      };
    }
  } catch {
    // platform_settings 未適用の環境では OFF として扱う
  }
  return { on: false, message: null };
}

/** システム状態: 主要テーブルの行数、有効セッション数、メンテナンス状態 */
app.get('/api/platform/system', async (c) => {
  requirePlatformAdmin(c);
  const tables: Record<string, number> = {};
  for (const table of SYSTEM_TABLES) {
    tables[table] = await tableCount(c.env.DB, table);
  }
  let activeSessions = 0;
  try {
    const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?1')
      .bind(Date.now())
      .first<{ n: number }>();
    activeSessions = row?.n ?? 0;
  } catch {
    activeSessions = 0;
  }
  // 従来の形 ({ on, message }) を保ちつつ、windows 由来の実施中も on に反映する
  const legacy = await readMaintenanceSetting(c.env.DB);
  let maintenance = legacy;
  if (!legacy.on) {
    const now = Date.now();
    const windows = await loadMaintenanceWindows(c.env.DB);
    for (const w of windows) {
      if (activeOccurrence(w, now)) {
        maintenance = { on: true, message: w.message };
        break;
      }
    }
  }
  return c.json({ tables, activeSessions, maintenance });
});

const maintenanceBodySchema = z.object({
  on: z.boolean(),
  message: z.string().max(500).optional(),
});

/**
 * メンテナンスモードの切り替え。店舗アプリは platform_settings を読んで
 * 書き込み系 API を 503 で止め、/app に告知バナーを出す (workers 側連動)。
 */
app.put('/api/platform/settings/maintenance', async (c) => {
  requirePlatformAdmin(c);
  const dto = parseWith(maintenanceBodySchema, await parseJson(c));
  const value = JSON.stringify({ on: dto.on, message: dto.message ?? '' });
  await c.env.DB
    .prepare(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ('maintenance', ?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(value, user(c).userId, new Date().toISOString())
    .run();
  await platformAudit(
    c,
    'platform.maintenance.update',
    'platform_settings',
    'maintenance',
    { on: dto.on },
    null,
  );
  return c.json({ on: dto.on, message: dto.message ?? '' });
});

// ------------------------------------------------------------ メンテナンスウィンドウ

/**
 * メンテナンス枠 (maintenance_windows) の管理。評価ロジック (JST の曜日・
 * 時刻解釈、occurrence 展開) は店舗アプリと共有の lib を使い、解釈を一致させる。
 */

function maintenanceWindowJson(
  w: MaintenanceWindow,
  storeName: string | null,
  now: number,
): Record<string, unknown> {
  let state: 'active' | 'scheduled' | 'finished' | 'cancelled' = 'finished';
  let occurrenceStartsAt: number | null = null;
  let occurrenceEndsAt: number | null = null;
  if (w.cancelledAt !== null) {
    state = 'cancelled';
  } else {
    const occ = activeOccurrence(w, now);
    if (occ) {
      state = 'active';
      occurrenceStartsAt = occ.startsAt;
      occurrenceEndsAt = occ.endsAt;
    } else {
      const next = nextOccurrence(w, now);
      if (next) {
        state = 'scheduled';
        occurrenceStartsAt = next.startsAt;
        occurrenceEndsAt = next.endsAt;
      }
    }
  }
  return {
    id: w.id,
    kind: w.kind,
    level: w.level,
    features: w.features,
    storeId: w.storeId,
    storeName,
    message: w.message,
    startsAt: w.startsAt,
    endsAt: w.endsAt,
    weekday: w.weekday,
    startMinute: w.startMinute,
    endMinute: w.endMinute,
    createdBy: w.createdBy,
    createdAt: w.createdAt,
    cancelledAt: w.cancelledAt,
    emergency: w.emergency,
    reason: w.reason,
    extendCount: w.extendCount,
    state,
    occurrenceStartsAt,
    occurrenceEndsAt,
  };
}

/** 緊急枠の最長 (作成・延長後とも starts_at から 4 時間まで) */
const EMERGENCY_MAX_MS = 4 * 60 * 60_000;

interface WindowReport {
  /** 予定の長さ (分)。単発で終了が決まっている場合のみ */
  plannedMinutes: number | null;
  /** 実際に止まっていた長さ (分)。終了済みの単発のみ */
  actualMinutes: number | null;
  extendCount: number;
  /** 503 で拒否した件数 (maintenance_rejections の集計) */
  rejections: number;
  rejectionsByFeature: Record<string, number>;
}

/** maintenance_rejections を window ごとに集計する (テーブルが無い環境では空) */
async function rejectionStats(
  db: D1Database,
  windowIds: number[],
): Promise<Map<number, { total: number; byFeature: Record<string, number> }>> {
  const out = new Map<number, { total: number; byFeature: Record<string, number> }>();
  if (windowIds.length === 0) return out;
  try {
    const { results } = await db
      .prepare(
        `SELECT window_id, feature_key, SUM(blocked_count) AS n FROM maintenance_rejections
          WHERE window_id IN (${windowIds.map(() => '?').join(',')})
          GROUP BY window_id, feature_key`,
      )
      .bind(...windowIds)
      .all<{ window_id: number; feature_key: string; n: number }>();
    for (const r of results) {
      const entry = out.get(r.window_id) ?? { total: 0, byFeature: {} };
      entry.total += r.n;
      entry.byFeature[r.feature_key] = r.n;
      out.set(r.window_id, entry);
    }
  } catch {
    // migration 0012 未適用の環境では集計なし
  }
  return out;
}

/** 履歴表示用の実施レポートを作る */
function windowReport(
  w: MaintenanceWindow,
  stats: { total: number; byFeature: Record<string, number> } | undefined,
  now: number,
): WindowReport {
  let plannedMinutes: number | null = null;
  let actualMinutes: number | null = null;
  if (w.kind === 'once' && w.startsAt !== null) {
    if (w.endsAt !== null) plannedMinutes = Math.round((w.endsAt - w.startsAt) / 60_000);
    const endedAt = w.cancelledAt ?? w.endsAt;
    if (endedAt !== null && endedAt <= now && endedAt > w.startsAt) {
      actualMinutes = Math.round((endedAt - w.startsAt) / 60_000);
    }
  }
  return {
    plannedMinutes,
    actualMinutes,
    extendCount: w.extendCount,
    rejections: stats?.total ?? 0,
    rejectionsByFeature: stats?.byFeature ?? {},
  };
}

async function storeNameMap(c: AppContext): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const { results } = await c.env.DB.prepare('SELECT id, name FROM stores').all<{
      id: number;
      name: string;
    }>();
    for (const r of results) map.set(r.id, r.name);
  } catch {
    // stores 未適用の環境では名前なしで返す
  }
  return map;
}

async function maintenanceWindowById(c: AppContext, id: number): Promise<MaintenanceWindow> {
  const row = await c.env.DB.prepare('SELECT * FROM maintenance_windows WHERE id = ?1')
    .bind(id)
    .first<MaintenanceWindowRow>();
  const w = row ? normalizeWindow(row) : null;
  if (!w) throw notFound('Maintenance window not found');
  return w;
}

function windowJsonFor(
  w: MaintenanceWindow,
  names: Map<number, string>,
  now: number,
): Record<string, unknown> {
  return maintenanceWindowJson(w, w.storeId !== null ? (names.get(w.storeId) ?? null) : null, now);
}

/** メンテナンス一覧: 実施中 / 予定 / 直近の履歴 (終了・取消 20 件、実施レポートつき) */
app.get('/api/platform/maintenance', async (c) => {
  requirePlatformAdmin(c);
  const now = Date.now();
  const names = await storeNameMap(c);
  const windows = await loadMaintenanceWindows(c.env.DB);
  const items = windows.map((w) => windowJsonFor(w, names, now));
  const byOccurrence = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    ((a.occurrenceStartsAt as number | null) ?? Number.MAX_SAFE_INTEGER) -
    ((b.occurrenceStartsAt as number | null) ?? Number.MAX_SAFE_INTEGER);
  const recentWindows = windows
    .filter((w) => {
      const item = items.find((i) => i.id === w.id);
      return item?.state === 'finished' || item?.state === 'cancelled';
    })
    .sort((a, b) => {
      const ka = a.cancelledAt ?? a.endsAt ?? a.createdAt;
      const kb = b.cancelledAt ?? b.endsAt ?? b.createdAt;
      return kb - ka;
    })
    .slice(0, 20);
  const stats = await rejectionStats(c.env.DB, recentWindows.map((w) => w.id));
  return c.json({
    active: items.filter((i) => i.state === 'active').sort(byOccurrence),
    scheduled: items.filter((i) => i.state === 'scheduled').sort(byOccurrence),
    recent: recentWindows.map((w) => ({
      ...windowJsonFor(w, names, now),
      report: windowReport(w, stats.get(w.id), now),
    })),
  });
});

/** features の入力形式: 旧形式の配列 (全キー 'full') と新形式の段階マップの両対応 */
const featuresInputSchema = z.union([
  z.array(z.string()),
  z.record(z.string(), z.enum(['write', 'full'])),
]);

function invalidWindow(message: string): ApiError {
  return new ApiError(422, 'INVALID_WINDOW', message);
}

/**
 * features 入力 (配列 or { key: stage } マップ) を検証して実効マップにする。
 * 未知キーは 422、'write' を持てない機能への 'write' 指定も 422。
 * 旧キーは新キーへ展開する (lib の featureMapFromEntries)。
 */
function normalizeFeaturesInput(raw: unknown): MaintenanceFeatureMap {
  const entries: [string, MaintenanceFeatureStage][] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === 'string') entries.push([v, 'full']);
    }
  } else if (raw !== null && typeof raw === 'object') {
    for (const [key, stage] of Object.entries(raw as Record<string, unknown>)) {
      entries.push([key, stage === 'write' ? 'write' : 'full']);
    }
  }
  if (entries.length === 0) {
    throw invalidWindow('features level requires at least one feature');
  }
  for (const [key, stage] of entries) {
    if (!MAINTENANCE_FEATURE_KEYS.has(key) && !LEGACY_FEATURE_KEYS.has(key)) {
      throw invalidWindow(`Unknown feature: ${key}`);
    }
    if (stage === 'write') {
      const targets = MAINTENANCE_FEATURE_KEYS.has(key)
        ? [key]
        : [...(LEGACY_FEATURE_EXPANSION[key] ?? [])];
      if (targets.some((t) => !MAINTENANCE_WRITE_STAGE_KEYS.has(t))) {
        throw invalidWindow(`Feature does not support write-only stop: ${key}`);
      }
    }
  }
  const map = featureMapFromEntries(entries);
  if (Object.keys(map).length === 0) {
    throw invalidWindow('features level requires at least one feature');
  }
  return map;
}

const createWindowBodySchema = z.object({
  kind: z.enum(['once', 'weekly']),
  startsAt: z.number().int().positive().optional(),
  endsAt: z.number().int().positive().nullable().optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  startMinute: z.number().int().min(0).max(1439).optional(),
  endMinute: z.number().int().min(1).max(2880).optional(),
  level: z.enum(['read_only', 'features', 'full']),
  features: featuresInputSchema.optional(),
  storeId: z.number().int().positive().nullable().optional(),
  message: z.string().max(500).nullable().optional(),
  emergency: z.boolean().optional(),
  reason: z.string().max(500).nullable().optional(),
});

/** メンテナンス枠の作成。意味的な検証違反は 422 */
app.post('/api/platform/maintenance/windows', async (c) => {
  requirePlatformAdmin(c);
  const dto = parseWith(createWindowBodySchema, await parseJson(c));
  const invalid = invalidWindow;

  const featureMap = dto.level === 'features' ? normalizeFeaturesInput(dto.features) : null;

  let startsAt: number | null = null;
  let endsAt: number | null = null;
  let weekday: number | null = null;
  let startMinute: number | null = null;
  let endMinute: number | null = null;
  if (dto.kind === 'once') {
    if (dto.startsAt === undefined) throw invalid('startsAt is required for once windows');
    startsAt = dto.startsAt;
    endsAt = dto.endsAt ?? null;
    if (endsAt !== null && endsAt <= startsAt) throw invalid('endsAt must be after startsAt');
  } else {
    if (dto.weekday === undefined || dto.startMinute === undefined || dto.endMinute === undefined) {
      throw invalid('weekday, startMinute and endMinute are required for weekly windows');
    }
    if (dto.endMinute <= dto.startMinute) throw invalid('endMinute must be after startMinute');
    weekday = dto.weekday;
    startMinute = dto.startMinute;
    endMinute = dto.endMinute;
  }
  if (dto.storeId !== undefined && dto.storeId !== null) {
    await storeRow(c, dto.storeId); // 無ければ 404
  }

  // 緊急枠: 理由必須・単発のみ・終了必須・最長 4 時間
  const emergency = dto.emergency === true;
  const reason = dto.reason?.trim() ? dto.reason.trim() : null;
  if (emergency) {
    if (!reason) throw invalid('reason is required for emergency windows');
    if (dto.kind !== 'once') throw invalid('emergency windows must be once');
    if (startsAt === null || endsAt === null) {
      throw invalid('emergency windows require both startsAt and endsAt');
    }
    if (endsAt - startsAt > EMERGENCY_MAX_MS) {
      throw invalid('emergency windows are limited to 4 hours');
    }
  }

  const features = featureMap ? JSON.stringify(featureMap) : null;
  const baseBinds: (string | number | null)[] = [
    dto.kind,
    startsAt,
    endsAt,
    weekday,
    startMinute,
    endMinute,
    dto.level,
    features,
    dto.storeId ?? null,
    dto.message ?? null,
    user(c).userId,
    Date.now(),
  ];
  let res: D1Result;
  try {
    res = await c.env.DB.prepare(
      `INSERT INTO maintenance_windows
         (kind, starts_at, ends_at, weekday, start_minute, end_minute, level, features, store_id, message, created_by, created_at, cancelled_at, emergency, reason, extend_count)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13, ?14, 0)`,
    )
      .bind(...baseBinds, emergency ? 1 : 0, reason)
      .run();
  } catch {
    // migration 0012 未適用の DB では緊急列なしで作る (検証は済んでいる)
    res = await c.env.DB.prepare(
      `INSERT INTO maintenance_windows
         (kind, starts_at, ends_at, weekday, start_minute, end_minute, level, features, store_id, message, created_by, created_at, cancelled_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL)`,
    )
      .bind(...baseBinds)
      .run();
  }
  const id = Number(res.meta.last_row_id);
  await platformAudit(
    c,
    'platform.maintenance.create',
    'maintenance_window',
    String(id),
    {
      kind: dto.kind, level: dto.level, startsAt, endsAt, weekday, startMinute, endMinute,
      emergency, reason,
    },
    dto.storeId ?? null,
  );
  const names = await storeNameMap(c);
  const w = await maintenanceWindowById(c, id);
  return c.json(windowJsonFor(w, names, Date.now()), 201);
});

const extendWindowBodySchema = z.object({
  minutes: z.number().int().positive().max(60 * 24 * 30),
});

/** 枠の延長 (once のみ)。ends_at が無ければ現在時刻 + minutes を設定する */
app.post('/api/platform/maintenance/windows/:id/extend', async (c) => {
  requirePlatformAdmin(c);
  const dto = parseWith(extendWindowBodySchema, await parseJson(c));
  const id = Number(c.req.param('id'));
  const w = await maintenanceWindowById(c, id);
  if (w.kind !== 'once') {
    throw new ApiError(422, 'WEEKLY_NOT_EXTENDABLE', 'Weekly windows cannot be extended');
  }
  if (w.cancelledAt !== null) {
    throw new ApiError(422, 'WINDOW_CANCELLED', 'Window is already cancelled');
  }
  const now = Date.now();
  const endsAt =
    w.endsAt === null ? now + dto.minutes * 60_000 : w.endsAt + dto.minutes * 60_000;
  // 緊急枠は延長後も開始から 4 時間を超えられない
  if (w.emergency && w.startsAt !== null && endsAt - w.startsAt > EMERGENCY_MAX_MS) {
    throw new ApiError(422, 'EMERGENCY_TOO_LONG', 'Emergency windows are limited to 4 hours from start');
  }
  await c.env.DB.prepare('UPDATE maintenance_windows SET ends_at = ?1 WHERE id = ?2')
    .bind(endsAt, id)
    .run();
  try {
    await c.env.DB.prepare(
      'UPDATE maintenance_windows SET extend_count = COALESCE(extend_count, 0) + 1 WHERE id = ?1',
    )
      .bind(id)
      .run();
  } catch {
    // migration 0012 未適用の環境では回数を数えない
  }
  await platformAudit(
    c,
    'platform.maintenance.extend',
    'maintenance_window',
    String(id),
    { minutes: dto.minutes, endsAt, extendCount: w.extendCount + 1 },
    w.storeId,
  );
  const names = await storeNameMap(c);
  const updated = await maintenanceWindowById(c, id);
  return c.json(windowJsonFor(updated, names, Date.now()));
});

/**
 * 枠の終了/取消。実施中の once は ends_at = 現在時刻で即時終了し、
 * weekly と未来の once は cancelled_at で無効化する。
 */
app.post('/api/platform/maintenance/windows/:id/end', async (c) => {
  requirePlatformAdmin(c);
  const id = Number(c.req.param('id'));
  const w = await maintenanceWindowById(c, id);
  const now = Date.now();
  const isActiveOnce = w.kind === 'once' && activeOccurrence(w, now) !== null;
  const alreadyFinished =
    w.kind === 'once' && w.cancelledAt === null && w.endsAt !== null && w.endsAt <= now;
  let mode: 'end' | 'cancel' | 'none' = 'none';
  if (isActiveOnce) {
    await c.env.DB.prepare('UPDATE maintenance_windows SET ends_at = ?1 WHERE id = ?2')
      .bind(now, id)
      .run();
    mode = 'end';
  } else if (w.cancelledAt === null && !alreadyFinished) {
    await c.env.DB.prepare('UPDATE maintenance_windows SET cancelled_at = ?1 WHERE id = ?2')
      .bind(now, id)
      .run();
    mode = 'cancel';
  }
  if (mode !== 'none') {
    await platformAudit(
      c,
      'platform.maintenance.end',
      'maintenance_window',
      String(id),
      { mode },
      w.storeId,
    );
  }
  const names = await storeNameMap(c);
  const updated = await maintenanceWindowById(c, id);
  return c.json(windowJsonFor(updated, names, Date.now()));
});

const previewBodySchema = z.object({
  level: z.enum(['read_only', 'features', 'full']),
  features: featuresInputSchema.optional(),
  storeId: z.number().int().positive().nullable().optional(),
  startsAt: z.number().int().positive().optional(),
  endsAt: z.number().int().positive().nullable().optional(),
});

/**
 * 機能グループと監査 action の対応 (preview の操作件数集計用)。
 * マスタ編集や CSV などは監査ログに操作が残らないため常に 0 になる近似。
 */
const PREVIEW_OPS_ACTIONS: Record<string, string[]> = {
  inbound: ['stock.inbound'],
  outbound: ['stock.consume', 'negative_approval.approved', 'negative_approval.rejected'],
  transfers: ['stock.transfer'],
  stocktakes: ['stocktake.start', 'stocktake.finish', 'stocktake.decide'],
  purchase_orders: ['purchase_order.create', 'purchase_order.receive'],
  suppliers: [],
  csv_export: [],
  csv_import: [],
  master_products: [],
  master_locations: [],
  analytics: [],
  alerts: [],
  login: [],
};

/**
 * 影響プレビュー: 保存前に「誰が・何が止まるか」を集計する。
 * - affectedUsers: 対象店舗の割当ユーザー数 (全店舗なら全ユーザー数)
 * - activeSessions: セッションは店舗に紐づかないため、対象ユーザーの
 *   有効セッション数で近似する (スコープは区別しない)
 * - recentOps: 選択グループごとの直近 7 日の関連操作件数 (監査ログの
 *   action 対応づけによる近似。対応 action が無いグループは 0)
 * - overlaps: 時間が重なる既存 window (once は区間の重なり、weekly は
 *   区間内の次回 occurrence で判定する近似)
 */
app.post('/api/platform/maintenance/preview', async (c) => {
  requirePlatformAdmin(c);
  const dto = parseWith(previewBodySchema, await parseJson(c));
  const db = c.env.DB;
  const storeId = dto.storeId ?? null;
  if (storeId !== null) await storeRow(c, storeId); // 無ければ 404

  let affectedUsers = 0;
  try {
    const row = storeId
      ? await db
          .prepare('SELECT COUNT(DISTINCT user_id) AS n FROM user_roles WHERE store_id = ?1')
          .bind(storeId)
          .first<{ n: number }>()
      : await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    affectedUsers = row?.n ?? 0;
  } catch {
    affectedUsers = 0;
  }

  const now = Date.now();
  let activeSessions = 0;
  try {
    const row = storeId
      ? await db
          .prepare(
            `SELECT COUNT(*) AS n FROM sessions
              WHERE expires_at > ?1
                AND user_id IN (SELECT user_id FROM user_roles WHERE store_id = ?2)`,
          )
          .bind(now, storeId)
          .first<{ n: number }>()
      : await db
          .prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?1')
          .bind(now)
          .first<{ n: number }>();
    activeSessions = row?.n ?? 0;
  } catch {
    activeSessions = 0;
  }

  // 対象グループ: features レベルは選択分、それ以外は全グループ
  let targetKeys: string[];
  if (dto.level === 'features' && dto.features !== undefined) {
    targetKeys = Object.keys(normalizeFeaturesInput(dto.features));
  } else {
    targetKeys = Object.keys(PREVIEW_OPS_ACTIONS);
  }
  const since = now - 7 * 86_400_000;
  const recentOps: Record<string, number> = {};
  for (const key of targetKeys) {
    const actions = PREVIEW_OPS_ACTIONS[key] ?? [];
    if (actions.length === 0) {
      recentOps[key] = 0;
      continue;
    }
    try {
      const placeholders = actions.map(() => '?').join(',');
      const row = storeId
        ? await db
            .prepare(
              `SELECT COUNT(*) AS n FROM audit_logs
                WHERE created_at >= ? AND store_id = ? AND action IN (${placeholders})`,
            )
            .bind(since, storeId, ...actions)
            .first<{ n: number }>()
        : await db
            .prepare(
              `SELECT COUNT(*) AS n FROM audit_logs
                WHERE created_at >= ? AND action IN (${placeholders})`,
            )
            .bind(since, ...actions)
            .first<{ n: number }>();
      recentOps[key] = row?.n ?? 0;
    } catch {
      recentOps[key] = 0;
    }
  }

  let overlaps: Record<string, unknown>[] = [];
  if (dto.startsAt !== undefined) {
    const start = dto.startsAt;
    const end = dto.endsAt ?? null;
    const names = await storeNameMap(c);
    const windows = await loadMaintenanceWindows(db);
    const hit: MaintenanceWindow[] = [];
    for (const w of windows) {
      if (w.cancelledAt !== null) continue;
      // 店舗が重ならない枠は影響しない (片方が全店舗なら重なる)
      if (storeId !== null && w.storeId !== null && w.storeId !== storeId) continue;
      if (w.kind === 'once') {
        if (w.startsAt === null) continue;
        const wEnd = w.endsAt ?? Number.POSITIVE_INFINITY;
        if (w.startsAt < (end ?? Number.POSITIVE_INFINITY) && wEnd > start) hit.push(w);
      } else {
        const next = nextOccurrence(w, start - 1);
        if (next && (end === null || next.startsAt < end)) hit.push(w);
      }
    }
    overlaps = hit.map((w) => windowJsonFor(w, names, now));
  }

  return c.json({ affectedUsers, activeSessions, recentOps, overlaps });
});

// ------------------------------------------------------------ メンテナンスプリセット

const PRESETS_SETTING_KEY = 'maintenance_presets';

interface MaintenancePreset {
  id: string;
  name: string;
  level: string;
  features: MaintenanceFeatureMap | null;
  storeId: number | null;
  message: string | null;
}

/** 未保存時に GET で返す既定の雛形 (保存はしない) */
const DEFAULT_MAINTENANCE_PRESETS: MaintenancePreset[] = [
  {
    id: 'default-monthly-stocktake',
    name: '月次棚卸し',
    level: 'features',
    features: { stocktakes: 'full' },
    storeId: null,
    message: '棚卸しのため停止中',
  },
  {
    id: 'default-sunday-night',
    name: '日曜深夜の定期',
    level: 'read_only',
    features: null,
    storeId: null,
    message: '定期メンテナンス',
  },
  {
    id: 'default-emergency-full',
    name: '緊急全面停止',
    level: 'full',
    features: null,
    storeId: null,
    message: null,
  },
  {
    id: 'default-purchase-close',
    name: '発注締め処理',
    level: 'features',
    features: { purchase_orders: 'write' },
    storeId: null,
    message: null,
  },
];

/** 保存済みプリセットを読む。未保存・破損時は null (= 既定を返す) */
async function readStoredPresets(db: D1Database): Promise<MaintenancePreset[] | null> {
  try {
    const row = await db
      .prepare('SELECT value FROM platform_settings WHERE key = ?1')
      .bind(PRESETS_SETTING_KEY)
      .first<{ value: string | null }>();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: MaintenancePreset[] = [];
    for (const p of parsed) {
      if (p === null || typeof p !== 'object') continue;
      const rec = p as Record<string, unknown>;
      if (typeof rec.id !== 'string' || typeof rec.name !== 'string') continue;
      out.push({
        id: rec.id,
        name: rec.name,
        level: typeof rec.level === 'string' ? rec.level : 'read_only',
        features:
          rec.features !== null && typeof rec.features === 'object'
            ? (rec.features as MaintenanceFeatureMap)
            : null,
        storeId: typeof rec.storeId === 'number' ? rec.storeId : null,
        message: typeof rec.message === 'string' ? rec.message : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}

async function writeStoredPresets(
  c: AppContext,
  presets: MaintenancePreset[],
): Promise<void> {
  await c.env.DB.prepare(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  )
    .bind(PRESETS_SETTING_KEY, JSON.stringify(presets), user(c).userId, new Date().toISOString())
    .run();
}

/** プリセット一覧 (未保存時は既定 4 件) */
app.get('/api/platform/maintenance/presets', async (c) => {
  requirePlatformAdmin(c);
  const stored = await readStoredPresets(c.env.DB);
  return c.json({ presets: stored ?? DEFAULT_MAINTENANCE_PRESETS });
});

const createPresetBodySchema = z.object({
  // 名前必須は下の手動チェックで 422 にする (他の業務検証と揃える)
  name: z.string().max(100).optional(),
  level: z.enum(['read_only', 'features', 'full']),
  features: featuresInputSchema.optional(),
  storeId: z.number().int().positive().nullable().optional(),
  message: z.string().max(500).nullable().optional(),
});

/** プリセット保存。まだ何も保存していない場合は既定 4 件も一緒に残す */
app.post('/api/platform/maintenance/presets', async (c) => {
  requirePlatformAdmin(c);
  const dto = parseWith(createPresetBodySchema, await parseJson(c));
  const name = (dto.name ?? '').trim();
  if (!name) throw invalidWindow('preset name is required');
  if (dto.storeId !== undefined && dto.storeId !== null) {
    await storeRow(c, dto.storeId); // 無ければ 404
  }
  const features = dto.level === 'features' ? normalizeFeaturesInput(dto.features) : null;
  const preset: MaintenancePreset = {
    id: crypto.randomUUID(),
    name,
    level: dto.level,
    features,
    storeId: dto.storeId ?? null,
    message: dto.message ?? null,
  };
  const stored = await readStoredPresets(c.env.DB);
  const list = [...(stored ?? DEFAULT_MAINTENANCE_PRESETS), preset];
  await writeStoredPresets(c, list);
  await platformAudit(c, 'platform.maintenance.preset.create', 'maintenance_preset', preset.id, {
    name,
    level: dto.level,
  }, preset.storeId);
  return c.json({ presets: list }, 201);
});

/** プリセット削除 */
app.delete('/api/platform/maintenance/presets/:id', async (c) => {
  requirePlatformAdmin(c);
  const id = c.req.param('id');
  const stored = await readStoredPresets(c.env.DB);
  const base = stored ?? DEFAULT_MAINTENANCE_PRESETS;
  const list = base.filter((p) => p.id !== id);
  if (list.length === base.length) throw notFound('Preset not found');
  await writeStoredPresets(c, list);
  await platformAudit(c, 'platform.maintenance.preset.delete', 'maintenance_preset', id, {}, null);
  return c.json({ presets: list });
});

/** 全セッション失効 (呼び出し元 = 操作中の全体管理者自身のセッションは残す) */
app.post('/api/platform/revoke-all-sessions', async (c) => {
  requirePlatformAdmin(c);
  const token = readSessionToken(c.req.raw, PLATFORM_SESSION_COOKIE_NAME);
  let res: D1Result;
  if (token) {
    const hash = await hashSessionToken(token);
    res = await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash <> ?1').bind(hash).run();
  } else {
    res = await c.env.DB.prepare('DELETE FROM sessions').run();
  }
  const revoked = res.meta.changes ?? 0;
  await platformAudit(c, 'platform.sessions.revoke_all', 'session', 'all', { revoked }, null);
  return c.json({ revoked });
});

/**
 * 全データエクスポート (全体管理用)。店舗アプリの export と同形式だが
 * 店舗スコープを外し、stores と platform_settings も含める。
 * sessions・idempotency_keys・write_guards は店舗側と同様に含めない。
 */
const PLATFORM_EXPORT_TABLES = [
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
  'stores',
  'feature_flags',
  'suppliers',
  'purchase_orders',
  'purchase_order_lines',
  'platform_settings',
] as const;

app.get('/api/platform/export.json', async (c) => {
  requirePlatformAdmin(c);
  const tables: Record<string, unknown[]> = {};
  for (const table of PLATFORM_EXPORT_TABLES) {
    try {
      const { results } = await c.env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all();
      tables[table] = results;
    } catch {
      tables[table] = [];
    }
  }
  return c.json({ exportedAt: Date.now(), tables }, 200, {
    'Content-Disposition': 'attachment; filename="inventory-platform-export.json"',
  });
});

// ---------------------------------------------------------------- エラー

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
  console.error('Unhandled error', err);
  return c.json({ statusCode: 500, error: 'INTERNAL', message: 'Internal error' }, 500);
});

app.notFound((c) => c.json({ statusCode: 404, error: 'NOT_FOUND', message: 'Route not found' }, 404));

export default app;
