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

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** セッションを発行してトークン本体を返す (DB にはハッシュのみ) */
export async function createSession(db: D1Database, userId: number): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64Url(bytes);
  const now = Date.now();
  const tokenHash = await hashSessionToken(token);
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(tokenHash, userId, now + SESSION_TTL_MS, now)
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

export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE_SEC}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Cookie ヘッダから session トークンを取り出す。無ければ null */
export function readSessionToken(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]*)`));
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

/**
 * Cookie のセッションからユーザーを解決する。無効・期限切れ・無効化ユーザー
 * は null (期限切れ行はついでに削除する)。users 行が無い場合も null で、
 * 呼び出し側は 401 に倒す (セッション経由では users を新規作成しない)。
 */
export async function resolveSessionUser(db: D1Database, request: Request): Promise<AuthUser | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const tokenHash = await hashSessionToken(token);
  const row = await db
    .prepare(
      `SELECT u.id, u.external_id, u.email, u.display_name, u.status,
              s.expires_at AS expires_at, s.store_id AS session_store_id
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?1`,
    )
    .bind(tokenHash)
    .first<SessionUserRow & { expires_at: number; session_store_id: number | null }>();
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
    return null;
  }
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
    viaSession: true,
  };
}

/** ログアウト: Cookie に対応するセッション行を削除する */
export async function destroySession(db: D1Database, request: Request): Promise<void> {
  const token = readSessionToken(request);
  if (!token) return;
  await db
    .prepare('DELETE FROM sessions WHERE token_hash = ?1')
    .bind(await hashSessionToken(token))
    .run();
}
