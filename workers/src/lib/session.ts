import type { AuthUser } from './auth';
import type { RoleCode } from './access';

/**
 * ログインセッション (Cookie) — /auth/callback で Google ログインが成功した
 * ブラウザ向けに発行する。API 認証は Bearer (OIDC) が優先で、Bearer が無い
 * リクエストでは Cookie の session を引く (src/lib/auth.ts の authenticate)。
 *
 * 設計:
 * - トークンは 32 バイト乱数の base64url。DB には SHA-256 ハッシュのみ保存。
 * - 有効期限は 8 時間 (絶対期限。スライディング更新はしない)。
 * - Cookie は HttpOnly / Secure / SameSite=Lax。JS からは読めないため、
 *   フロントエンド (/app) は Cookie の有無を知らず /api/v1/me の成否で判定する。
 */

export const SESSION_COOKIE_NAME = 'session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE_MAX_AGE_SEC = SESSION_TTL_MS / 1000;

/**
 * セッションのスコープ (migration 0009)。
 * - 'app': 店舗アプリ用 (Cookie 名 session、有効期限 8 時間)
 * - 'platform': 全体管理 Worker (inventory-admin-workers) 用。
 *   Cookie 名も分け (admin_session)、有効期限は 2 時間と短くする。
 *   スコープが違うセッションは互いに受け付けない。
 */
export type SessionScope = 'app' | 'platform';
export const PLATFORM_SESSION_COOKIE_NAME = 'admin_session';
export const PLATFORM_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const PLATFORM_SESSION_COOKIE_MAX_AGE_SEC = PLATFORM_SESSION_TTL_MS / 1000;

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface CreateSessionOptions {
  /** 既定は 'app' (店舗アプリ)。全体管理 Worker は 'platform' を指定する */
  scope?: SessionScope;
  /** 有効期限 (ミリ秒)。既定はスコープごとの標準値 */
  ttlMs?: number;
}

/** セッションを発行してトークン本体を返す (DB にはハッシュのみ) */
export async function createSession(
  db: D1Database,
  userId: number,
  options: CreateSessionOptions = {},
): Promise<string> {
  const scope = options.scope ?? 'app';
  const ttlMs = options.ttlMs ?? (scope === 'platform' ? PLATFORM_SESSION_TTL_MS : SESSION_TTL_MS);
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64Url(bytes);
  const now = Date.now();
  const tokenHash = await hashSessionToken(token);
  if (scope === 'platform') {
    // scope 列 (migration 0009) が必須。店舗の自動選択も行わない。
    await db
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, expires_at, created_at, scope) VALUES (?1, ?2, ?3, ?4, ?5)',
      )
      .bind(tokenHash, userId, now + ttlMs, now, scope)
      .run();
    return token;
  }
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(tokenHash, userId, now + ttlMs, now)
    .run();
  // 入れる店舗が 1 つだけなら、その店舗を選択済みにして発行する
  // (複数店舗に所属する場合は未選択のままにし、/app が選択画面を出す)
  try {
    const { results } = await db
      .prepare('SELECT role_code, store_id FROM user_roles WHERE user_id = ?1')
      .bind(userId)
      .all<{ role_code: string; store_id: number | null }>();
    const platform = results.some((r) => r.role_code === 'SYSTEM_ADMIN' && r.store_id === null);
    let storeIds: number[];
    if (platform) {
      const { results: stores } = await db.prepare('SELECT id FROM stores ORDER BY id ASC').all<{ id: number }>();
      storeIds = stores.map((s) => s.id);
    } else {
      storeIds = [
        ...new Set(results.map((r) => r.store_id).filter((id): id is number => id !== null)),
      ];
    }
    if (storeIds.length === 1) {
      await db
        .prepare('UPDATE sessions SET store_id = ?1 WHERE token_hash = ?2')
        .bind(storeIds[0], tokenHash)
        .run();
    }
  } catch {
    // stores / store_id 未適用の環境では自動選択を諦める (解決時に動的判定する)
  }
  return token;
}

/** セッションに「現在店舗」を保存する。対象セッションが無ければ何もしない */
export async function setSessionStore(db: D1Database, request: Request, storeId: number): Promise<void> {
  const token = readSessionToken(request);
  if (!token) return;
  await db
    .prepare('UPDATE sessions SET store_id = ?1 WHERE token_hash = ?2')
    .bind(storeId, await hashSessionToken(token))
    .run();
}

export interface SessionCookieOptions {
  /** Cookie 名。既定は店舗アプリ用 (session)。全体管理は admin_session */
  name?: string;
  /** Max-Age (秒)。既定は Cookie 名に対応する標準値 */
  maxAgeSec?: number;
}

export function sessionCookieHeader(token: string, options: SessionCookieOptions = {}): string {
  const name = options.name ?? SESSION_COOKIE_NAME;
  const maxAgeSec =
    options.maxAgeSec ??
    (name === PLATFORM_SESSION_COOKIE_NAME
      ? PLATFORM_SESSION_COOKIE_MAX_AGE_SEC
      : SESSION_COOKIE_MAX_AGE_SEC);
  return `${name}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookieHeader(name: string = SESSION_COOKIE_NAME): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Cookie ヘッダから session トークンを取り出す。無ければ null */
export function readSessionToken(request: Request, name: string = SESSION_COOKIE_NAME): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  const value = match?.[1];
  return value ? decodeURIComponent(value) : null;
}

interface SessionUserRow {
  id: number;
  external_id: string;
  email: string;
  display_name: string;
  status: string;
}

interface AssignmentRow {
  role_code: string;
  warehouse_id: number | null;
  store_id: number | null;
}

export interface ResolveSessionOptions {
  /** 読む Cookie 名。既定は店舗アプリ用 (session) */
  cookieName?: string;
  /**
   * 受け付けるスコープ。既定は 'app'。店舗アプリは platform スコープの
   * セッションを無効として扱い、全体管理 Worker は app スコープを
   * 受け付けない (スコープ不一致は未認証として null を返す)。
   */
  scope?: SessionScope;
}

type SessionRow = SessionUserRow & {
  expires_at: number;
  session_store_id: number | null;
  scope: string;
};

/**
 * Cookie のセッションからユーザーを解決する。無効・期限切れ・無効化ユーザー・
 * スコープ不一致は null (期限切れ行はついでに削除する)。users 行が無い場合も
 * null で、呼び出し側は 401 に倒す (セッション経由では users を新規作成しない)。
 * scope 列が無い環境 (migration 0009 未適用) では全セッションを 'app' として
 * 扱う従来動作にフォールバックする。
 */
export async function resolveSessionUser(
  db: D1Database,
  request: Request,
  options: ResolveSessionOptions = {},
): Promise<AuthUser | null> {
  const cookieName = options.cookieName ?? SESSION_COOKIE_NAME;
  const expectedScope = options.scope ?? 'app';
  const token = readSessionToken(request, cookieName);
  if (!token) return null;
  const tokenHash = await hashSessionToken(token);
  let row: SessionRow | null;
  try {
    row = await db
      .prepare(
        `SELECT u.id, u.external_id, u.email, u.display_name, u.status,
                s.expires_at AS expires_at, s.store_id AS session_store_id,
                s.scope AS scope
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?1`,
      )
      .bind(tokenHash)
      .first<SessionRow>();
  } catch {
    const legacy = await db
      .prepare(
        `SELECT u.id, u.external_id, u.email, u.display_name, u.status,
                s.expires_at AS expires_at, s.store_id AS session_store_id
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?1`,
      )
      .bind(tokenHash)
      .first<SessionUserRow & { expires_at: number; session_store_id: number | null }>();
    row = legacy ? { ...legacy, scope: 'app' } : null;
  }
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
    return null;
  }
  // スコープが違うセッションは、この Worker では未認証として扱う
  if (row.scope !== expectedScope) return null;
  if (row.status !== 'active') return null;

  const { results } = await db
    .prepare('SELECT role_code, warehouse_id, store_id FROM user_roles WHERE user_id = ?1')
    .bind(row.id)
    .all<AssignmentRow>();

  return {
    userId: row.id,
    externalId: row.external_id,
    email: row.email,
    displayName: row.display_name,
    assignments: results.map((r) => ({
      roleCode: r.role_code as RoleCode,
      warehouseId: r.warehouse_id,
      storeId: r.store_id,
    })),
    sessionStoreId: row.session_store_id,
    sessionScope: row.scope === 'platform' ? 'platform' : 'app',
    viaSession: true,
  };
}

/** ログアウト: Cookie に対応するセッション行を削除する */
export async function destroySession(
  db: D1Database,
  request: Request,
  cookieName: string = SESSION_COOKIE_NAME,
): Promise<void> {
  const token = readSessionToken(request, cookieName);
  if (!token) return;
  await db
    .prepare('DELETE FROM sessions WHERE token_hash = ?1')
    .bind(await hashSessionToken(token))
    .run();
}
