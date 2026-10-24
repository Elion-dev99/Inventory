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
  PLATFORM_SESSION_COOKIE_NAME,
  resolveSessionUser,
  sessionCookieHeader,
} from '../../workers/src/lib/session';
import {
  FEATURE_CATALOG,
  FEATURE_KEYS,
  getFeatures,
} from '../../workers/src/lib/features';
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

/** 全ユーザーと、全店舗・全体を含む全割当の一覧 (全体管理用) */
app.get('/api/platform/users', async (c) => {
  requirePlatformAdmin(c);
  const { results: users } = await c.env.DB.prepare(
    `SELECT id, external_id AS externalId, email, display_name AS displayName, status
       FROM users ORDER BY id ASC`,
  ).all<{
    id: number;
    externalId: string;
    email: string;
    displayName: string;
    status: string;
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
  return c.json(users.map((u) => ({ ...u, assignments: byUser.get(u.id) ?? [] })));
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

// ---------------------------------------------------------------- エラー

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
  console.error('Unhandled error', err);
  return c.json({ statusCode: 500, error: 'INTERNAL', message: 'Internal error' }, 500);
});

app.notFound((c) => c.json({ statusCode: 404, error: 'NOT_FOUND', message: 'Route not found' }, 404));

export default app;
