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
  currentSessionRow,
  destroySession,
  hashSessionToken,
  markSessionStepUp,
  PLATFORM_SESSION_COOKIE_NAME,
  readSessionToken,
  resolveSessionUser,
  sessionCookieHeader,
  STEP_UP_WINDOW_MS,
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
import {
  announcementAdminJson,
  type AnnouncementRow,
} from '../../workers/src/lib/announcements';
import { maybeSendAnnouncementPush } from '../../workers/src/lib/push';
import {
  buildAuditInsert,
  insertAudit,
  verifyAuditChain,
} from '../../workers/src/lib/audit-chain';
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesEqual,
  checkClientData,
  consumeChallenge,
  coseEc2ToJwk,
  issueChallenge,
  parseAttestationObject,
  parseAuthenticatorData,
  parseClientData,
  sha256Bytes,
  verifyAssertionSignature,
  verifyAttestationSignature,
} from '../../workers/src/lib/webauthn';
import { clientIp, recordLoginEvent } from '../../workers/src/lib/login-events';
import {
  createBackup,
  hasBackupsTable,
  listBackups,
  readBackupJson,
  restoreBackup,
  type BackupRow,
} from '../../workers/src/lib/backup';
import {
  exceedsLimit,
  getOrganization,
  hasOrganizationsTable,
  isPlanKey,
  organizationUsage,
  PLAN_CATALOG,
  planDef,
  planLimitError,
  resolveStorePlan,
} from '../../workers/src/lib/plans';
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

// -------------------------------------------------- セキュリティ基盤 (0017)
// 全レスポンスへセキュリティヘッダを付け、/api/ の状態変更リクエストには
// Origin チェックを行う (店舗側と同等。一次防御は Cookie の SameSite=Lax)。
// CSP の緩和点は script-src / style-src の 'unsafe-inline' のみで、
// コンソールの単一 HTML がインラインスクリプトで構成されるため。
const CONSOLE_CSP_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

app.use('*', async (c, next) => {
  if (
    c.req.path.startsWith('/api/') &&
    (c.req.method === 'POST' ||
      c.req.method === 'PUT' ||
      c.req.method === 'DELETE' ||
      c.req.method === 'PATCH')
  ) {
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost === null || originHost !== new URL(c.req.url).host) {
        return c.json(
          { statusCode: 403, error: 'ORIGIN_MISMATCH', message: 'Origin does not match host' },
          403,
        );
      }
    }
  }
  await next();
  try {
    const headers = c.res.headers;
    headers.set('Content-Security-Policy', CONSOLE_CSP_VALUE);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  } catch {
    // ヘッダを変更できないレスポンスでは黙って諦める
  }
});

function user(c: AppContext): AuthUser {
  return c.get('user');
}

/** テーブルに列が存在するか (マイグレーション未適用環境との後方互換用) */
async function hasColumn(c: AppContext, table: string, column: string): Promise<boolean> {
  try {
    const { results } = await c.env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    return results.some((r) => r.name === column);
  } catch {
    return false;
  }
}

/** テーブル自体が存在するか (0017 の passkey 系など) */
async function hasTable(c: AppContext, table: string): Promise<boolean> {
  try {
    const row = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
    )
      .bind(table)
      .first<{ name: string }>();
    return row !== null;
  } catch {
    return false;
  }
}

/**
 * 重要操作の再認証 (ステップアップ、0017)。セッションの step_up_at が
 * 10 分以内でなければ 403 STEP_UP_REQUIRED。ログイン自体が step_up_at を
 * 打つため、ログイン直後はそのまま通る。step_up_at 列が無い環境
 * (0017 未適用) では強制しない (店舗側と同仕様)。
 */
async function requireStepUp(c: AppContext): Promise<void> {
  if (!(await hasColumn(c, 'sessions', 'step_up_at'))) return;
  const session = await currentSessionRow(c.env.DB, c.req.raw, PLATFORM_SESSION_COOKIE_NAME);
  if (!session) return;
  if (session.stepUpAt !== null && Date.now() - session.stepUpAt <= STEP_UP_WINDOW_MS) return;
  throw new ApiError(403, 'STEP_UP_REQUIRED', 'Step-up authentication is required');
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
// ?stepup=1 はステップアップ再認証用: 既存セッションの step_up_at を打ち直す
// ための再ログインで、Google 側にも再認証を強制する (prompt=login)。
app.get('/auth/login', (c) => {
  const clientId = c.env.OIDC_CLIENT_ID ?? '';
  if (!clientId) return c.text('OIDC is not configured', 503);
  const stepup = new URL(c.req.url).searchParams.get('stepup') === '1';
  const nonce = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: new URL('/auth/callback', c.req.url).toString(),
    response_type: 'code',
    scope: 'openid email profile',
    nonce,
    state: nonce,
    prompt: stepup ? 'login' : 'select_account',
  });
  const headers = new Headers({
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  });
  headers.append('Set-Cookie', `oauth_nonce=${nonce}; Path=/; Max-Age=600; SameSite=Lax`);
  if (stepup) {
    // nonce と紐付けて、コールバックで「この往復がステップアップ用か」を判定する
    headers.append('Set-Cookie', `oauth_stepup=${nonce}; Path=/; Max-Age=600; SameSite=Lax`);
  }
  return new Response(null, { status: 302, headers });
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
  let cookieNonce = '';
  try {
    const payload = await verifyToken(asWorkersEnv(c.env), tokenJson.id_token);
    cookieNonce = (c.req.header('cookie') ?? '').match(/(?:^|;\s*)oauth_nonce=([^;]*)/)?.[1] ?? '';
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

  // ログイン履歴と新しい端末の通知 (0017)。失敗してもログインは止めない。
  await recordLoginEvent(c.env.DB, c.env, {
    userId: authUser.userId,
    method: 'google',
    ip: clientIp(c.req.raw),
    userAgent: c.req.header('user-agent') ?? null,
  });

  // ステップアップ再認証の往復: 既存の platform セッションが同じユーザーなら
  // 新規発行せず、そのセッションの step_up_at を打ち直してコンソールへ戻す。
  const stepupNonce = (c.req.header('cookie') ?? '').match(/(?:^|;\s*)oauth_stepup=([^;]*)/)?.[1] ?? '';
  if (stepupNonce && cookieNonce && stepupNonce === cookieNonce) {
    try {
      const sessionUser = await resolveSessionUser(c.env.DB, c.req.raw, {
        cookieName: PLATFORM_SESSION_COOKIE_NAME,
        scope: 'platform',
      });
      if (sessionUser && sessionUser.userId === authUser.userId) {
        await markSessionStepUp(c.env.DB, c.req.raw, PLATFORM_SESSION_COOKIE_NAME);
        const headers = new Headers({ Location: '/' });
        headers.append('Set-Cookie', 'oauth_stepup=; Path=/; Max-Age=0; SameSite=Lax');
        return new Response(null, { status: 302, headers });
      }
    } catch {
      // セッションが引けない場合は通常のログインとして続行する
    }
  }

  const sessionToken = await createSession(c.env.DB, authUser.userId, {
    scope: 'platform',
    userAgent: c.req.header('user-agent') ?? null,
    ip: clientIp(c.req.raw),
  });
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
  // パスキーのログイン開始・検証は未認証で受ける (認証そのものが目的)
  if (
    c.req.path === '/api/platform/auth/passkey/login/options' ||
    c.req.path === '/api/platform/auth/passkey/login/verify'
  ) {
    return next();
  }
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
  organization_id?: number | null;
  orgName?: string | null;
  planKey?: string | null;
}

function storeJson(r: StoreDbRow): Record<string, unknown> {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    organizationId: r.organization_id ?? null,
    organization:
      r.organization_id !== null && r.organization_id !== undefined
        ? { id: r.organization_id, name: r.orgName ?? null, planKey: r.planKey ?? null }
        : null,
  };
}

async function storeRow(c: AppContext, id: number): Promise<StoreDbRow> {
  const row =
    (await hasOrganizationsTable(c.env.DB))
      ? await c.env.DB.prepare(
          `SELECT s.*, o.name AS orgName, o.plan_key AS planKey
             FROM stores s LEFT JOIN organizations o ON o.id = s.organization_id
            WHERE s.id = ?1`,
        )
          .bind(id)
          .first<StoreDbRow>()
      : await c.env.DB.prepare('SELECT * FROM stores WHERE id = ?1').bind(id).first<StoreDbRow>();
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
  // 監査はハッシュチェーン経由で記録する (0017、改ざん検知)。
  // チェーン未適用の環境ではヘルパーが従来形式にフォールバックする。
  await insertAudit(c.env.DB, {
    actorId: user(c).userId,
    action,
    targetType,
    targetId,
    payload,
    storeId,
  });
}

app.get('/api/platform/stores', async (c) => {
  requirePlatformAdmin(c);
  const sql = (await hasOrganizationsTable(c.env.DB))
    ? `SELECT s.*, o.name AS orgName, o.plan_key AS planKey
         FROM stores s LEFT JOIN organizations o ON o.id = s.organization_id
        ORDER BY s.id ASC`
    : 'SELECT * FROM stores ORDER BY id ASC';
  const { results } = await c.env.DB.prepare(sql).all<StoreDbRow>();
  return c.json(results.map(storeJson));
});

const createStoreBodySchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  organizationId: z.number().int().positive().optional(),
});

/**
 * 店舗の作成。0018 適用後は組織への所属が必須で、組織のプランの店舗数
 * 上限を超える作成は 403 PLAN_LIMIT_REACHED でブロックする (先にプランを
 * 上げるのが正規手順)。0018 未適用の環境では従来どおり組織なしで作る。
 */
app.post('/api/platform/stores', async (c) => {
  requirePlatformAdmin(c);
  const dto = parseWith(createStoreBodySchema, await parseJson(c));
  const hasOrgs = await hasOrganizationsTable(c.env.DB);
  let organizationId: number | null = null;
  if (hasOrgs) {
    if (dto.organizationId === undefined) {
      throw new ApiError(400, 'ORGANIZATION_REQUIRED', 'organizationId is required');
    }
    const org = await getOrganization(c.env.DB, dto.organizationId);
    if (!org) throw new ApiError(422, 'ORGANIZATION_NOT_FOUND', `Organization not found: ${dto.organizationId}`);
    const def = planDef(org.planKey);
    if (def.limits.stores !== null) {
      const usage = await organizationUsage(c.env.DB, org.id);
      if (exceedsLimit(def.limits.stores, usage.stores, 1)) {
        throw planLimitError(def.key, 'stores', def.limits.stores, usage.stores);
      }
    }
    organizationId = org.id;
  }
  const now = Date.now();
  let res: D1Result;
  try {
    res = hasOrgs
      ? await c.env.DB.prepare(
          `INSERT INTO stores (code, name, status, organization_id, created_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?4, ?4)`,
        )
          .bind(dto.code, dto.name, organizationId, now)
          .run()
      : await c.env.DB.prepare(
          `INSERT INTO stores (code, name, status, created_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?3)`,
        )
          .bind(dto.code, dto.name, now)
          .run();
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Store with this code already exists');
  }
  const id = Number(res.meta.last_row_id);
  await platformAudit(
    c,
    'platform.store.create',
    'store',
    String(id),
    { code: dto.code, name: dto.name, organizationId },
    id,
  );
  return c.json(storeJson(await storeRow(c, id)), 201);
});

// ------------------------------------------------------------ 組織・プラン

interface OrganizationDbRow {
  id: number;
  name: string;
  plan_key: string;
  created_at: number;
  updated_at: number;
}

async function organizationJson(c: AppContext, r: OrganizationDbRow): Promise<Record<string, unknown>> {
  const def = planDef(r.plan_key);
  return {
    id: r.id,
    name: r.name,
    planKey: r.plan_key,
    plan: { key: def.key, name: def.name, price: def.price, limits: def.limits },
    usage: await organizationUsage(c.env.DB, r.id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function organizationRow(c: AppContext, id: number): Promise<OrganizationDbRow> {
  const row = await c.env.DB.prepare('SELECT * FROM organizations WHERE id = ?1')
    .bind(id)
    .first<OrganizationDbRow>();
  if (!row) throw notFound('Organization not found');
  return row;
}

/** 組織一覧 (利用状況つき) とプランカタログ */
app.get('/api/platform/organizations', async (c) => {
  requirePlatformAdmin(c);
  if (!(await hasOrganizationsTable(c.env.DB))) {
    return c.json({ plans: PLAN_CATALOG, organizations: [] });
  }
  const { results } = await c.env.DB.prepare('SELECT * FROM organizations ORDER BY id ASC').all<OrganizationDbRow>();
  const organizations: Record<string, unknown>[] = [];
  for (const r of results) organizations.push(await organizationJson(c, r));
  return c.json({
    plans: PLAN_CATALOG.map((p) => ({
      key: p.key,
      name: p.name,
      price: p.price,
      limits: p.limits,
      features: p.features,
      modules: p.modules,
    })),
    organizations,
  });
});

const createOrganizationBodySchema = z.object({
  name: z.string().min(1).max(100),
  planKey: z.string().min(1).max(50),
});

app.post('/api/platform/organizations', async (c) => {
  requirePlatformAdmin(c);
  if (!(await hasOrganizationsTable(c.env.DB))) {
    throw new ApiError(503, 'ORGANIZATIONS_NOT_CONFIGURED', 'Organizations are not configured (migration 0018)');
  }
  const dto = parseWith(createOrganizationBodySchema, await parseJson(c));
  if (!isPlanKey(dto.planKey)) {
    throw new ApiError(422, 'UNKNOWN_PLAN', `Unknown plan: ${dto.planKey}`);
  }
  const now = Date.now();
  const res = await c.env.DB.prepare(
    'INSERT INTO organizations (name, plan_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
  )
    .bind(dto.name, dto.planKey, now)
    .run();
  const id = Number(res.meta.last_row_id);
  await platformAudit(c, 'platform.organization.create', 'organization', String(id), { name: dto.name, planKey: dto.planKey }, null);
  return c.json(await organizationJson(c, await organizationRow(c, id)), 201);
});

const renameOrganizationBodySchema = z.object({
  name: z.string().min(1).max(100),
});

app.put('/api/platform/organizations/:id', async (c) => {
  requirePlatformAdmin(c);
  if (!(await hasOrganizationsTable(c.env.DB))) {
    throw new ApiError(503, 'ORGANIZATIONS_NOT_CONFIGURED', 'Organizations are not configured (migration 0018)');
  }
  const id = Number(c.req.param('id'));
  const row = await organizationRow(c, id);
  const dto = parseWith(renameOrganizationBodySchema, await parseJson(c));
  await c.env.DB.prepare('UPDATE organizations SET name = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(dto.name, Date.now(), id)
    .run();
  await platformAudit(c, 'platform.organization.update', 'organization', String(id), { from: row.name, to: dto.name }, null);
  return c.json(await organizationJson(c, await organizationRow(c, id)));
});

const changePlanBodySchema = z.object({
  planKey: z.string().min(1).max(50),
});

/** プラン変更。即時反映され、監査ログに変更前後を記録する */
app.put('/api/platform/organizations/:id/plan', async (c) => {
  requirePlatformAdmin(c);
  if (!(await hasOrganizationsTable(c.env.DB))) {
    throw new ApiError(503, 'ORGANIZATIONS_NOT_CONFIGURED', 'Organizations are not configured (migration 0018)');
  }
  const id = Number(c.req.param('id'));
  const row = await organizationRow(c, id);
  const dto = parseWith(changePlanBodySchema, await parseJson(c));
  if (!isPlanKey(dto.planKey)) {
    throw new ApiError(422, 'UNKNOWN_PLAN', `Unknown plan: ${dto.planKey}`);
  }
  await c.env.DB.prepare('UPDATE organizations SET plan_key = ?1, updated_at = ?2 WHERE id = ?3')
    .bind(dto.planKey, Date.now(), id)
    .run();
  await platformAudit(
    c,
    'platform.organization.plan_changed',
    'organization',
    String(id),
    { from: row.plan_key, to: dto.planKey },
    null,
  );
  return c.json(await organizationJson(c, await organizationRow(c, id)));
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
  const auditStmt = await buildAuditInsert(c.env.DB, {
    actorId: user(c).userId,
    action: 'feature_flag.update',
    targetType: 'feature_flag',
    targetId: key,
    payload: { enabled, storeId, via: 'platform' },
    storeId,
    createdAt: now,
  });
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO feature_flags (store_id, key, enabled, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(store_id, key) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(storeId, key, enabled ? 1 : 0, user(c).userId, now),
    auditStmt,
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

  // プランのユーザー上限 (0018): 新しく組織に加わる場合だけ増員として数える。
  // 既にその組織に所属するユーザーの割当変更は上限チェックの対象外
  if (await hasOrganizationsTable(c.env.DB)) {
    const { results: beforeRows } = await c.env.DB.prepare(
      `SELECT DISTINCT s.organization_id AS orgId
         FROM user_roles ur JOIN stores s ON s.id = ur.store_id
        WHERE ur.user_id = ?1 AND s.organization_id IS NOT NULL`,
    )
      .bind(userId)
      .all<{ orgId: number }>();
    const beforeOrgs = new Set(beforeRows.map((r) => r.orgId));
    const afterOrgs = new Map<number, string>();
    for (const a of assignments) {
      if (a.storeId === null) continue;
      const plan = await resolveStorePlan(c.env.DB, a.storeId);
      if (plan.organization) afterOrgs.set(plan.organization.id, plan.organization.planKey);
    }
    for (const [orgId, planKey] of afterOrgs) {
      if (beforeOrgs.has(orgId)) continue;
      const def = planDef(planKey);
      if (def.limits.users === null) continue;
      const usage = await organizationUsage(c.env.DB, orgId);
      if (exceedsLimit(def.limits.users, usage.users, 1)) {
        throw planLimitError(def.key, 'users', def.limits.users, usage.users);
      }
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

// ------------------------------------------------------------ バックアップ
// スナップショットの生成・復元ロジックは店舗アプリと共有の lib/backup.ts。
// バックアップは業務データ一式の JSON を backups / backup_chunks に保持する。
// 復元は業務テーブルだけを洗い替えし、users / user_roles / sessions には
// 触れない (ロックアウト防止)。復元前に現在の状態を pre-restore として
// 自動保存する。0016 未適用の環境では 503 BACKUP_NOT_CONFIGURED で劣化する。

function backupJson(r: BackupRow): Record<string, unknown> {
  return {
    id: r.id,
    kind: r.kind,
    createdAt: r.created_at,
    createdBy: r.created_by,
    sizeBytes: r.size_bytes,
    note: r.note,
  };
}

async function requireBackupsTable(c: AppContext): Promise<void> {
  if (!(await hasBackupsTable(c.env.DB))) {
    throw new ApiError(503, 'BACKUP_NOT_CONFIGURED', 'Backups are not configured (migration 0016)');
  }
}

/** バックアップ一覧 (新しい順) */
app.get('/api/platform/backups', async (c) => {
  requirePlatformAdmin(c);
  await requireBackupsTable(c);
  const rows = await listBackups(c.env.DB);
  return c.json({ items: rows.map(backupJson) });
});

/** 手動バックアップの作成 */
app.post('/api/platform/backups', async (c) => {
  requirePlatformAdmin(c);
  await requireBackupsTable(c);
  const now = Date.now();
  const id = await createBackup(c.env.DB, {
    kind: 'manual',
    createdBy: user(c).userId,
    note: null,
    nowMs: now,
  });
  const rows = await listBackups(c.env.DB);
  const created = rows.find((r) => r.id === id);
  await platformAudit(c, 'platform.backup.create', 'backup', String(id), {
    sizeBytes: created?.size_bytes ?? null,
  }, null);
  return c.json(created ? backupJson(created) : { id }, 201);
});

/** バックアップのダウンロード (スナップショット JSON そのもの) */
app.get('/api/platform/backups/:id/download', async (c) => {
  requirePlatformAdmin(c);
  await requireBackupsTable(c);
  const id = Number(c.req.param('id'));
  const json = await readBackupJson(c.env.DB, id);
  if (json === null) throw notFound('Backup not found');
  await platformAudit(c, 'platform.backup.download', 'backup', String(id), {}, null);
  let createdAt = Date.now();
  try {
    const parsed = JSON.parse(json) as { createdAt?: number };
    if (typeof parsed.createdAt === 'number') createdAt = parsed.createdAt;
  } catch {
    // ファイル名の日時だけに使うため、壊れていてもダウンロード自体は続ける
  }
  const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
  return c.body(json, 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="inventory-backup-${id}-${stamp}.json"`,
  });
});

/**
 * バックアップからの復元。対象は業務テーブルのみで、復元前に現在の状態を
 * pre-restore バックアップとして自動保存する。完了は監査に残す。
 */
app.post('/api/platform/backups/:id/restore', async (c) => {
  requirePlatformAdmin(c);
  await requireStepUp(c);
  await requireBackupsTable(c);
  const id = Number(c.req.param('id'));
  if ((await readBackupJson(c.env.DB, id)) === null) throw notFound('Backup not found');
  let result: Awaited<ReturnType<typeof restoreBackup>>;
  try {
    result = await restoreBackup(c.env.DB, id, { actorId: user(c).userId, nowMs: Date.now() });
  } catch (e) {
    throw new ApiError(422, 'BACKUP_RESTORE_FAILED', e instanceof Error ? e.message : 'Restore failed');
  }
  await platformAudit(c, 'platform.backup.restore', 'backup', String(id), {
    preRestoreBackupId: result.preRestoreBackupId,
    restoredTables: result.restoredTables,
  }, null);
  return c.json({ restored: true, ...result });
});

// ------------------------------------------------------------ 利用量

/** JST の当月初 (ミリ秒)。移動件数の「当月」集計に使う */
function jstMonthStartMs(nowMs: number): number {
  const JST = 9 * 60 * 60 * 1000;
  const jst = new Date(nowMs + JST);
  return Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1) - JST;
}

/**
 * 利用量: 店舗ごとの件数と DB 全体の実測値 (行数・ページ数ベースのサイズ・
 * 有効セッション数・バックアップ容量)。取得できない指標は出さない。
 */
app.get('/api/platform/usage', async (c) => {
  requirePlatformAdmin(c);
  const db = c.env.DB;
  const now = Date.now();
  const monthStart = jstMonthStartMs(now);
  const countFor = async (sql: string, ...params: number[]): Promise<number> => {
    try {
      const row = await db.prepare(sql).bind(...params).first<{ n: number }>();
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  };

  const { results: storeRows } = await db
    .prepare('SELECT id, code, name FROM stores ORDER BY id ASC')
    .all<{ id: number; code: string; name: string }>();
  const stores: Record<string, unknown>[] = [];
  for (const s of storeRows) {
    stores.push({
      id: s.id,
      code: s.code,
      name: s.name,
      products: await countFor(
        'SELECT COUNT(*) AS n FROM products WHERE store_id = ?1 AND deleted_at IS NULL',
        s.id,
      ),
      stockRows: await countFor('SELECT COUNT(*) AS n FROM stocks WHERE store_id = ?1', s.id),
      movementsThisMonth: await countFor(
        'SELECT COUNT(*) AS n FROM stock_movements WHERE store_id = ?1 AND created_at >= ?2',
        s.id,
        monthStart,
      ),
      users: await countFor(
        'SELECT COUNT(DISTINCT user_id) AS n FROM user_roles WHERE store_id = ?1',
        s.id,
      ),
    });
  }

  // DB 全体の行数: sqlite_master の全テーブルを数える (内部テーブルは除く)
  let totalRows = 0;
  try {
    const { results: tableNames } = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .all<{ name: string }>();
    for (const t of tableNames) {
      totalRows += await countFor(`SELECT COUNT(*) AS n FROM ${t.name}`);
    }
  } catch {
    totalRows = 0;
  }
  // DB サイズ: ページ数 × ページサイズ (D1 では PRAGMA page_count が
  // 許可されず dbstat も無いため通常は取れない。その場合は全テーブルの
  // ペイロード長合計を推定値として返す)
  let pageCount: number | null = null;
  let pageSize: number | null = null;
  try {
    const pc = await db.prepare('PRAGMA page_count').first<Record<string, number>>();
    if (pc) pageCount = Object.values(pc)[0] ?? null;
    const ps = await db.prepare('PRAGMA page_size').first<Record<string, number>>();
    if (ps) pageSize = Object.values(ps)[0] ?? null;
  } catch {
    pageCount = null;
    pageSize = null;
  }
  const sizeBytes = pageCount !== null && pageSize !== null ? pageCount * pageSize : null;
  let sizeEstimateBytes = 0;
  if (sizeBytes === null) {
    try {
      const { results: tableNames } = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
        )
        .all<{ name: string }>();
      for (const t of tableNames) {
        const { results: cols } = await db
          .prepare(`PRAGMA table_info(${t.name})`)
          .all<{ name: string }>();
        if (cols.length === 0) continue;
        const expr = cols
          .map((col) => `COALESCE(LENGTH(CAST("${col.name}" AS BLOB)), 0)`)
          .join(' + ');
        const row = await db
          .prepare(`SELECT COALESCE(SUM(${expr}), 0) AS bytes FROM ${t.name}`)
          .first<{ bytes: number }>();
        sizeEstimateBytes += row?.bytes ?? 0;
      }
    } catch {
      sizeEstimateBytes = 0;
    }
  }

  const activeSessions = await countFor(
    'SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?1',
    now,
  );
  let backupStats = { count: 0, totalBytes: 0 };
  if (await hasBackupsTable(db)) {
    const row = await db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM backups')
      .first<{ n: number; bytes: number }>();
    backupStats = { count: row?.n ?? 0, totalBytes: row?.bytes ?? 0 };
  }

  return c.json({
    generatedAt: now,
    stores,
    database: { totalRows, sizeBytes, sizeEstimateBytes, pageCount, pageSize },
    activeSessions,
    backups: backupStats,
  });
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
  await requireStepUp(c);
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

// ------------------------------------------------- パスキー / ステップアップ / 自分のセッション (0017)
// WebAuthn (Face ID 等) による platform ログイン、重要操作の再認証、
// 自分の platform セッション管理。検証ロジックは店舗側と共有の
// lib/webauthn.ts、ログイン記録は lib/login-events.ts。
// 注意: パスキーは rpId (ホスト名) 単位で束縛されるため、店舗アプリの
// ホストで登録したクレデンシャルはこのコンソールでは使えない。この
// ホスト用に、Google ログイン済みの状態から登録する導線を用意する。
// 失敗は詳細を漏らさない汎用エラーに倒す。

const PASSKEY_FAILED = () =>
  new ApiError(400, 'PASSKEY_VERIFICATION_FAILED', 'Passkey verification failed');

function rpIdOf(c: AppContext): string {
  return new URL(c.req.url).hostname;
}

function originOf(c: AppContext): string {
  return new URL(c.req.url).origin;
}

async function requirePasskeyTables(c: AppContext): Promise<void> {
  if (!(await hasTable(c, 'passkey_credentials')) || !(await hasTable(c, 'webauthn_challenges'))) {
    throw new ApiError(503, 'PASSKEY_NOT_CONFIGURED', 'Passkey is not configured (migration 0017)');
  }
}

const passkeyRegisterVerifySchema = z.object({
  credentialId: z.string().min(1),
  clientDataJSON: z.string().min(1),
  attestationObject: z.string().min(1),
  transports: z.array(z.string()).optional(),
  label: z.string().max(100).optional(),
});

const passkeyAssertionSchema = z.object({
  credentialId: z.string().min(1),
  clientDataJSON: z.string().min(1),
  authenticatorData: z.string().min(1),
  signature: z.string().min(1),
});

interface PasskeyCredentialRow {
  id: number;
  user_id: number;
  credential_id: string;
  public_key_jwk: string;
  sign_count: number;
  transports: string | null;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
}

/**
 * assertion を検証する共通処理 (ログインとステップアップで共用、店舗側と同方式)。
 * 成功したら該当クレデンシャル行を返し、sign_count / last_used_at を更新する。
 */
async function verifyPasskeyAssertion(
  c: AppContext,
  dto: z.infer<typeof passkeyAssertionSchema>,
  purpose: 'login' | 'step_up',
  expectedUserId: number | null,
): Promise<PasskeyCredentialRow> {
  const db = c.env.DB;
  let clientDataBytes: Uint8Array;
  let authenticatorDataBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    clientDataBytes = base64UrlDecode(dto.clientDataJSON);
    authenticatorDataBytes = base64UrlDecode(dto.authenticatorData);
    signatureBytes = base64UrlDecode(dto.signature);
  } catch {
    throw PASSKEY_FAILED();
  }
  let challenge: string;
  try {
    challenge = parseClientData(clientDataBytes).challenge;
  } catch {
    throw PASSKEY_FAILED();
  }
  const challengeRow = await consumeChallenge(db, challenge, purpose);
  if (!challengeRow) throw PASSKEY_FAILED();
  if (expectedUserId !== null && challengeRow.user_id !== expectedUserId) throw PASSKEY_FAILED();

  const credential = await db
    .prepare('SELECT * FROM passkey_credentials WHERE credential_id = ?1')
    .bind(dto.credentialId)
    .first<PasskeyCredentialRow>();
  if (!credential) throw PASSKEY_FAILED();
  if (expectedUserId !== null && credential.user_id !== expectedUserId) throw PASSKEY_FAILED();

  try {
    const clientData = parseClientData(clientDataBytes);
    checkClientData(clientData, { type: 'webauthn.get', challenge, origin: originOf(c) });
    const authData = parseAuthenticatorData(authenticatorDataBytes);
    const expectedRpHash = await sha256Bytes(rpIdOf(c));
    if (!bytesEqual(authData.rpIdHash, expectedRpHash)) throw new Error('rpIdHash mismatch');
    if (!authData.userPresent || !authData.userVerified) throw new Error('UP/UV required');
    // signCount が戻っている assertion は複製の疑いがあるため拒否する。
    // カウンタを持たない authenticator (双方 0) は許容する。
    if (
      (authData.signCount !== 0 || credential.sign_count !== 0) &&
      authData.signCount <= credential.sign_count
    ) {
      throw new Error('signCount regression');
    }
    const clientHash = await sha256Bytes(clientDataBytes);
    const signedData = new Uint8Array(authenticatorDataBytes.length + clientHash.length);
    signedData.set(authenticatorDataBytes, 0);
    signedData.set(clientHash, authenticatorDataBytes.length);
    const jwk = JSON.parse(credential.public_key_jwk) as JsonWebKey;
    const ok = await verifyAssertionSignature(jwk, signatureBytes, signedData);
    if (!ok) throw new Error('signature mismatch');
  } catch {
    throw PASSKEY_FAILED();
  }

  const verifiedCount = parseAuthenticatorData(authenticatorDataBytes).signCount;
  await db
    .prepare('UPDATE passkey_credentials SET sign_count = ?1, last_used_at = ?2 WHERE id = ?3')
    .bind(verifiedCount, Date.now(), credential.id)
    .run();
  return credential;
}

/** このコンソール用パスキー登録の開始 (platform セッション必須) */
app.post('/api/platform/auth/passkey/register/options', async (c) => {
  requirePlatformAdmin(c);
  await requirePasskeyTables(c);
  const me = user(c);
  const challenge = await issueChallenge(c.env.DB, { userId: me.userId, purpose: 'register' });
  const { results } = await c.env.DB.prepare(
    'SELECT credential_id FROM passkey_credentials WHERE user_id = ?1 ORDER BY id ASC',
  )
    .bind(me.userId)
    .all<{ credential_id: string }>();
  return c.json({
    challenge,
    rp: { name: '全体管理コンソール', id: rpIdOf(c) },
    user: {
      id: base64UrlEncode(new TextEncoder().encode(String(me.userId))),
      name: me.email,
      displayName: me.displayName || me.email,
    },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    timeout: 60000,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: results.map((r) => ({ type: 'public-key', id: r.credential_id })),
  });
});

/** このコンソール用パスキー登録の検証・保存 */
app.post('/api/platform/auth/passkey/register/verify', async (c) => {
  requirePlatformAdmin(c);
  await requirePasskeyTables(c);
  const me = user(c);
  const dto = parseWith(passkeyRegisterVerifySchema, await parseJson(c));
  let clientDataBytes: Uint8Array;
  let attestationBytes: Uint8Array;
  try {
    clientDataBytes = base64UrlDecode(dto.clientDataJSON);
    attestationBytes = base64UrlDecode(dto.attestationObject);
  } catch {
    throw PASSKEY_FAILED();
  }
  let challenge: string;
  try {
    challenge = parseClientData(clientDataBytes).challenge;
  } catch {
    throw PASSKEY_FAILED();
  }
  const challengeRow = await consumeChallenge(c.env.DB, challenge, 'register');
  if (!challengeRow || challengeRow.user_id !== me.userId) throw PASSKEY_FAILED();

  try {
    const clientData = parseClientData(clientDataBytes);
    checkClientData(clientData, { type: 'webauthn.create', challenge, origin: originOf(c) });
    const { authData } = parseAttestationObject(attestationBytes);
    const expectedRpHash = await sha256Bytes(rpIdOf(c));
    if (!bytesEqual(authData.rpIdHash, expectedRpHash)) throw new Error('rpIdHash mismatch');
    if (!authData.userPresent || !authData.userVerified) throw new Error('UP/UV required');
    if (!authData.attestedCredentialData) throw new Error('no attested credential data');
    const jwk = coseEc2ToJwk(authData.attestedCredentialData.cosePublicKey);
    if (!(await verifyAttestationSignature(attestationBytes, clientDataBytes, jwk))) {
      throw new Error('attestation signature invalid');
    }
    const credentialId = base64UrlEncode(authData.attestedCredentialData.credentialId);
    if (dto.credentialId !== credentialId) throw new Error('credential id mismatch');
    const now = Date.now();
    const inserted = await c.env.DB.prepare(
      `INSERT INTO passkey_credentials (user_id, credential_id, public_key_jwk, sign_count, transports, label, created_at, last_used_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)`,
    )
      .bind(
        me.userId,
        credentialId,
        JSON.stringify(jwk),
        authData.signCount,
        dto.transports ? JSON.stringify(dto.transports) : null,
        dto.label ?? null,
        now,
      )
      .run();
    return c.json({ id: Number(inserted.meta.last_row_id), credentialId, createdAt: now }, 201);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw PASSKEY_FAILED();
  }
});

/** パスキーログインの開始 (未認証。ユーザー名なし・discoverable) */
app.post('/api/platform/auth/passkey/login/options', async (c) => {
  await requirePasskeyTables(c);
  const challenge = await issueChallenge(c.env.DB, { userId: null, purpose: 'login' });
  return c.json({
    challenge,
    rpId: rpIdOf(c),
    timeout: 60000,
    userVerification: 'required',
  });
});

/**
 * パスキーログインの検証。Google ログインと同じ条件 (全体管理者の割当が
 * あること) を満たす場合のみ platform スコープのセッションを発行する。
 * 割当が無ければ 403 で、セッションは作らない。
 */
app.post('/api/platform/auth/passkey/login/verify', async (c) => {
  await requirePasskeyTables(c);
  const dto = parseWith(passkeyAssertionSchema, await parseJson(c));
  const credential = await verifyPasskeyAssertion(c, dto, 'login', null);
  const target = await c.env.DB.prepare('SELECT id, status FROM users WHERE id = ?1')
    .bind(credential.user_id)
    .first<{ id: number; status: string }>();
  if (!target || target.status !== 'active') throw PASSKEY_FAILED();
  const { results: roleRows } = await c.env.DB.prepare(
    'SELECT role_code, warehouse_id, store_id FROM user_roles WHERE user_id = ?1',
  )
    .bind(target.id)
    .all<{ role_code: string; warehouse_id: number | null; store_id: number | null }>();
  const assignments = roleRows.map((r) => ({
    roleCode: r.role_code as RoleCode,
    warehouseId: r.warehouse_id,
    storeId: r.store_id,
  }));
  if (!isPlatformAdmin(assignments)) {
    throw new ApiError(403, 'PLATFORM_ADMIN_REQUIRED', 'Platform admin only');
  }
  await recordLoginEvent(c.env.DB, c.env, {
    userId: target.id,
    method: 'passkey',
    ip: clientIp(c.req.raw),
    userAgent: c.req.header('user-agent') ?? null,
  });
  const token = await createSession(c.env.DB, target.id, {
    scope: 'platform',
    userAgent: c.req.header('user-agent') ?? null,
    ip: clientIp(c.req.raw),
  });
  return c.json({ ok: true }, 200, {
    'Set-Cookie': sessionCookieHeader(token, { name: PLATFORM_SESSION_COOKIE_NAME }),
  });
});

/** ステップアップ用のチャレンジ発行 (現在の platform セッションに紐付ける) */
app.post('/api/platform/auth/passkey/step-up/options', async (c) => {
  requirePlatformAdmin(c);
  await requirePasskeyTables(c);
  const me = user(c);
  const session = await currentSessionRow(c.env.DB, c.req.raw, PLATFORM_SESSION_COOKIE_NAME);
  const challenge = await issueChallenge(c.env.DB, {
    userId: me.userId,
    purpose: 'step_up',
    sessionId: session?.id ?? null,
  });
  return c.json({
    challenge,
    rpId: rpIdOf(c),
    timeout: 60000,
    userVerification: 'required',
  });
});

/** ステップアップ再認証 (パスキー)。現在のセッションに step_up_at を打つ */
app.post('/api/platform/auth/step-up/passkey', async (c) => {
  requirePlatformAdmin(c);
  await requirePasskeyTables(c);
  const me = user(c);
  const dto = parseWith(passkeyAssertionSchema, await parseJson(c));
  // チャレンジが現在のセッション用に発行されたものかも検証する
  let challengeText: string;
  try {
    challengeText = parseClientData(base64UrlDecode(dto.clientDataJSON)).challenge;
  } catch {
    throw PASSKEY_FAILED();
  }
  const session = await currentSessionRow(c.env.DB, c.req.raw, PLATFORM_SESSION_COOKIE_NAME);
  if (!session) throw PASSKEY_FAILED();
  const challengeRow = await c.env.DB.prepare(
    'SELECT session_id FROM webauthn_challenges WHERE challenge = ?1 AND purpose = ?2',
  )
    .bind(challengeText, 'step_up')
    .first<{ session_id: number | null }>();
  if (!challengeRow || challengeRow.session_id !== session.id) throw PASSKEY_FAILED();
  await verifyPasskeyAssertion(c, dto, 'step_up', me.userId);
  await markSessionStepUp(c.env.DB, c.req.raw, PLATFORM_SESSION_COOKIE_NAME);
  return c.json({ ok: true });
});

/** 自分の有効な platform セッション一覧 (現在のセッションには印を付ける) */
app.get('/api/platform/auth/sessions', async (c) => {
  requirePlatformAdmin(c);
  const me = user(c);
  const token = readSessionToken(c.req.raw, PLATFORM_SESSION_COOKIE_NAME);
  const currentHash = token ? await hashSessionToken(token) : null;
  const hasMeta = await hasColumn(c, 'sessions', 'user_agent');
  const metaCols = hasMeta ? ', user_agent, ip, last_seen_at' : '';
  const { results } = await c.env.DB.prepare(
    `SELECT id, token_hash, created_at, expires_at${metaCols}
       FROM sessions
      WHERE user_id = ?1 AND scope = 'platform' AND expires_at > ?2
      ORDER BY created_at DESC`,
  )
    .bind(me.userId, Date.now())
    .all<Record<string, unknown>>();
  return c.json(
    results.map((r) => ({
      id: Number(r.id),
      createdAt: Number(r.created_at),
      lastSeenAt: r.last_seen_at != null ? Number(r.last_seen_at) : null,
      userAgent: (r.user_agent as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
      current: currentHash !== null && r.token_hash === currentHash,
    })),
  );
});

/** 自分の他の platform セッションを失効させる (現在のセッション自身は対象外) */
app.delete('/api/platform/auth/sessions/:id', async (c) => {
  requirePlatformAdmin(c);
  const me = user(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw notFound('Session not found');
  const row = await c.env.DB.prepare(
    "SELECT id, token_hash FROM sessions WHERE id = ?1 AND user_id = ?2 AND scope = 'platform'",
  )
    .bind(id, me.userId)
    .first<{ id: number; token_hash: string }>();
  if (!row) throw notFound('Session not found');
  const token = readSessionToken(c.req.raw, PLATFORM_SESSION_COOKIE_NAME);
  const currentHash = token ? await hashSessionToken(token) : null;
  if (currentHash !== null && row.token_hash === currentHash) {
    throw new ApiError(400, 'CURRENT_SESSION', 'Current session cannot be revoked here. Use logout.');
  }
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(id).run();
  return c.json({ id, revoked: true });
});

/** 監査ハッシュチェーンの整合性チェック (改ざん検知) */
app.get('/api/platform/audit-integrity', async (c) => {
  requirePlatformAdmin(c);
  const result = await verifyAuditChain(c.env.DB);
  return c.json(result);
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
  'announcements',
  'announcement_reads',
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

// ---------------------------------------------------------------- お知らせ
// 店舗アプリと同じ announcements テーブルへの CRUD。全店舗宛・店舗宛のどちらも
// 作れる (店舗アプリ側の投稿は自店舗宛 + SYSTEM_ADMIN の全店舗宛に制限される)。
// 既読数 (readCount) と対象ユーザー数 (targetUsers) を付けて返す。
// プッシュは workers 側 lib/push.ts を共有し、掲載中なら作成・更新時に即時送信する。
// push_subscriptions は認証情報を含むためエクスポート対象には含めない (上記参照)。

const platformAnnouncementBodySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  priority: z.enum(['normal', 'important']).optional(),
  /** 省略時・null は全店舗宛 */
  storeId: z.number().int().positive().nullable().optional(),
  /** 省略時は即時掲載 (現在時刻) */
  startsAt: z.number().int().positive().optional(),
  /** 省略時・null は無期限 */
  endsAt: z.number().int().positive().nullable().optional(),
  push: z.boolean().optional(),
});

async function platformAnnouncementRow(c: AppContext, id: number): Promise<AnnouncementRow> {
  const row = await c.env.DB.prepare('SELECT * FROM announcements WHERE id = ?1')
    .bind(id)
    .first<AnnouncementRow>();
  if (!row) throw notFound('Announcement not found');
  return row;
}

app.get('/api/platform/announcements', async (c) => {
  requirePlatformAdmin(c);
  const { results } = await c.env.DB
    .prepare('SELECT * FROM announcements ORDER BY created_at DESC, id DESC')
    .all<AnnouncementRow>();
  const items: Awaited<ReturnType<typeof announcementAdminJson>>[] = [];
  for (const row of results) items.push(await announcementAdminJson(c.env.DB, row));
  return c.json({ items });
});

app.post('/api/platform/announcements', async (c) => {
  requirePlatformAdmin(c);
  const dto = parseWith(platformAnnouncementBodySchema, await parseJson(c));
  const storeId = dto.storeId ?? null;
  if (storeId !== null) await storeRow(c, storeId); // 存在しない店舗は 404
  const now = Date.now();
  const startsAt = dto.startsAt ?? now;
  const endsAt = dto.endsAt ?? null;
  if (endsAt !== null && endsAt <= startsAt) {
    throw new ApiError(422, 'INVALID_PERIOD', 'endsAt must be after startsAt');
  }
  const res = await c.env.DB
    .prepare(
      `INSERT INTO announcements
         (store_id, title, body, priority, starts_at, ends_at, push, push_sent_at, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?9)`,
    )
    .bind(
      storeId,
      dto.title,
      dto.body,
      dto.priority ?? 'normal',
      startsAt,
      endsAt,
      dto.push ? 1 : 0,
      user(c).userId,
      now,
    )
    .run();
  const id = Number(res.meta.last_row_id);
  await platformAudit(
    c,
    'platform.announcement.create',
    'announcement',
    String(id),
    { title: dto.title, storeId, priority: dto.priority ?? 'normal', push: dto.push === true },
    storeId,
  );
  const row = await platformAnnouncementRow(c, id);
  // 掲載中なら即時プッシュ (VAPID 未設定環境ではスキップされる)
  await maybeSendAnnouncementPush(c.env.DB, c.env, row, now);
  return c.json(await announcementAdminJson(c.env.DB, await platformAnnouncementRow(c, id)), 201);
});

app.put('/api/platform/announcements/:id', async (c) => {
  requirePlatformAdmin(c);
  const row = await platformAnnouncementRow(c, Number(c.req.param('id')));
  const dto = parseWith(platformAnnouncementBodySchema, await parseJson(c));
  const storeId = dto.storeId === undefined ? row.store_id : dto.storeId;
  if (storeId !== null) await storeRow(c, storeId);
  const now = Date.now();
  const startsAt = dto.startsAt ?? row.starts_at;
  const endsAt = dto.endsAt === undefined ? row.ends_at : dto.endsAt;
  if (endsAt !== null && endsAt <= startsAt) {
    throw new ApiError(422, 'INVALID_PERIOD', 'endsAt must be after startsAt');
  }
  await c.env.DB
    .prepare(
      `UPDATE announcements
          SET store_id = ?1, title = ?2, body = ?3, priority = ?4, starts_at = ?5,
              ends_at = ?6, push = ?7, updated_at = ?8
        WHERE id = ?9`,
    )
    .bind(
      storeId,
      dto.title,
      dto.body,
      dto.priority ?? row.priority,
      startsAt,
      endsAt,
      dto.push === undefined ? row.push : dto.push ? 1 : 0,
      now,
      row.id,
    )
    .run();
  await platformAudit(
    c,
    'platform.announcement.update',
    'announcement',
    String(row.id),
    { title: dto.title, storeId, priority: dto.priority ?? row.priority },
    storeId,
  );
  const fresh = await platformAnnouncementRow(c, row.id);
  await maybeSendAnnouncementPush(c.env.DB, c.env, fresh, now);
  return c.json(await announcementAdminJson(c.env.DB, await platformAnnouncementRow(c, row.id)));
});

app.delete('/api/platform/announcements/:id', async (c) => {
  requirePlatformAdmin(c);
  const row = await platformAnnouncementRow(c, Number(c.req.param('id')));
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM announcement_reads WHERE announcement_id = ?1').bind(row.id),
    c.env.DB.prepare('DELETE FROM announcements WHERE id = ?1').bind(row.id),
  ]);
  await platformAudit(
    c,
    'platform.announcement.delete',
    'announcement',
    String(row.id),
    { title: row.title, storeId: row.store_id },
    row.store_id,
  );
  return c.json({ deleted: true });
});

// ---------------------------------------------------------------- エラー

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
  console.error('Unhandled error', err);
  return c.json({ statusCode: 500, error: 'INTERNAL', message: 'Internal error' }, 500);
});

app.notFound((c) => c.json({ statusCode: 404, error: 'NOT_FOUND', message: 'Route not found' }, 404));

export default app;
