import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../env';
import type { RoleAssignment, RoleCode } from './access';
import { ApiError, unauthorized } from './errors';

type Jwks = ReturnType<typeof createRemoteJWKSet>;

/**
 * OIDC アクセストークン検証 (NestJS 版 oidc-auth.guard と同方針)。
 * - 認証は IdP へ全面委任し、アプリ独自のパスワード認証は作らない (要件 Q5)。
 * - Bearer トークンの署名 (JWKS)・iss・aud を検証し、クレームから users を同期して
 *   user_roles (DB が正) を解決する。
 * - 多要素認証 (Face ID / パスキー) は IdP 側で担保される (amr クレームで確認可能。
 *   検証の必須化は Phase 2)。
 * - OIDC_ISSUER_URL 未設定なら業務 API はすべて 401 (ヘルスチェックのみ公開)。
 */

const jwksCache = new Map<string, Jwks>();

function getJwks(jwksUrl: string): Jwks {
  let jwks = jwksCache.get(jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl));
    jwksCache.set(jwksUrl, jwks);
  }
  return jwks;
}

export interface AuthUser {
  userId: number;
  externalId: string;
  email: string;
  displayName: string;
  assignments: RoleAssignment[];
}

interface UserRow {
  id: number;
  status: string;
}

interface AssignmentRow {
  role_code: string;
  warehouse_id: number | null;
}

/** クレームから users を同期し、ロール割当を解決する (Nest 版 UsersService 相当) */
export async function syncUserAndAssignments(
  db: D1Database,
  claims: { sub: string; email: string; displayName: string },
): Promise<AuthUser> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO users (external_id, email, display_name, status, last_login_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?4, ?4)
       ON CONFLICT (external_id) DO UPDATE SET
         email = excluded.email,
         display_name = excluded.display_name,
         last_login_at = excluded.last_login_at,
         updated_at = excluded.updated_at`,
    )
    .bind(claims.sub, claims.email, claims.displayName, now)
    .run();

  const user = await db
    .prepare('SELECT id, status FROM users WHERE external_id = ?1')
    .bind(claims.sub)
    .first<UserRow>();
  if (!user) throw unauthorized('User sync failed');
  if (user.status !== 'active') throw unauthorized('User is disabled');

  const { results } = await db
    .prepare('SELECT role_code, warehouse_id FROM user_roles WHERE user_id = ?1')
    .bind(user.id)
    .all<AssignmentRow>();

  return {
    userId: user.id,
    externalId: claims.sub,
    email: claims.email,
    displayName: claims.displayName,
    assignments: results.map((r) => ({
      roleCode: r.role_code as RoleCode,
      warehouseId: r.warehouse_id,
    })),
  };
}

/** ID トークン / アクセストークンを JWKS で検証してペイロードを返す */
export async function verifyToken(env: Env, token: string): Promise<JWTPayload> {
  const issuer = env.OIDC_ISSUER_URL ?? '';
  if (!issuer) {
    throw new ApiError(401, 'OIDC_NOT_CONFIGURED', 'OIDC is not configured (OIDC_ISSUER_URL)');
  }
  const jwksUrl =
    env.OIDC_JWKS_URL ?? `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
  const audience = env.OIDC_AUDIENCE ?? 'inventory-system';
  try {
    const verified = await jwtVerify(token, getJwks(jwksUrl), { issuer, audience });
    return verified.payload;
  } catch {
    throw unauthorized('Invalid access token');
  }
}

/** 検証済みペイロードから users を同期し、ロール割当を解決する */
export async function syncUserFromPayload(env: Env, payload: JWTPayload): Promise<AuthUser> {
  if (!payload.sub) throw unauthorized('Invalid access token (no sub)');
  const email =
    typeof payload.email === 'string' && payload.email.length > 0
      ? payload.email
      : `${payload.sub}@no-email`;
  const displayName = typeof payload.name === 'string' ? payload.name : '';
  return syncUserAndAssignments(env.DB, { sub: payload.sub, email, displayName });
}

export async function authenticate(request: Request, env: Env): Promise<AuthUser> {
  const issuer = env.OIDC_ISSUER_URL ?? '';
  if (!issuer) {
    throw new ApiError(401, 'OIDC_NOT_CONFIGURED', 'OIDC is not configured (OIDC_ISSUER_URL)');
  }
  const url = new URL(request.url);
  const header = request.headers.get('authorization');
  // WebSocket はブラウザから Authorization ヘッダを付けられないため、
  // /realtime では access_token クエリも受け付ける (README 参照)。
  const queryToken = url.searchParams.get('access_token');
  const token = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : queryToken ?? undefined;
  if (!token) throw unauthorized('Bearer token is required');

  const payload = await verifyToken(env, token);
  return syncUserFromPayload(env, payload);
}

/** ロール割当が 1 件も無いユーザーは業務 API を使えない */
export function assertHasAssignments(user: AuthUser): void {
  if (user.assignments.length === 0) {
    throw new ApiError(403, 'FORBIDDEN', 'No role assignments for this user');
  }
}
