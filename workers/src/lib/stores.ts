import type { AuthUser } from './auth';
import {
  assignedStoreIds,
  isPlatformAdmin,
  RoleCode,
  storeAssignments,
  type RoleAssignment,
} from './access';
import { ApiError, forbidden } from './errors';

/**
 * 店舗 (テナント) コンテキストの解決。
 *
 * - 店舗はデータ分離の単位で、業務 API はすべて「現在店舗」にスコープする。
 * - 現在店舗はセッションに保存された選択 (sessions.store_id) を優先し、
 *   未選択でも入れる店舗が 1 つだけなら自動選択として解決する。
 * - 全体管理者 (SYSTEM_ADMIN かつ store_id NULL の割当) は全店舗に入れ、
 *   現在店舗では全権限を持つ。停止中 (suspended) の店舗に入れるのも
 *   全体管理者だけ。
 * - 店舗が決まらない場合は 409 STORE_NOT_SELECTED、停止中店舗への
 *   店舗ユーザーのアクセスは 403 STORE_SUSPENDED。
 */

export interface StoreInfo {
  id: number;
  code: string;
  name: string;
  status: 'active' | 'suspended';
}

export interface StoreContext {
  store: StoreInfo;
  /**
   * 現在店舗に対する実効割当。全体管理者は「SYSTEM_ADMIN・全倉庫」の
   * 合成割当になり、権限チェック側で全権限として扱う。
   */
  assignments: RoleAssignment[];
  isPlatformAdmin: boolean;
}

interface StoreDbRow {
  id: number;
  code: string;
  name: string;
  status: string;
}

function toInfo(r: StoreDbRow): StoreInfo {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    status: r.status === 'suspended' ? 'suspended' : 'active',
  };
}

export async function listAllStores(db: D1Database): Promise<StoreInfo[]> {
  const { results } = await db
    .prepare('SELECT id, code, name, status FROM stores ORDER BY id ASC')
    .all<StoreDbRow>();
  return results.map(toInfo);
}

export async function getStore(db: D1Database, storeId: number): Promise<StoreInfo | null> {
  const row = await db
    .prepare('SELECT id, code, name, status FROM stores WHERE id = ?1')
    .bind(storeId)
    .first<StoreDbRow>();
  return row ? toInfo(row) : null;
}

/** そのユーザーが入れる店舗の一覧 (全体管理者は全店舗) */
export async function accessibleStores(db: D1Database, user: AuthUser): Promise<StoreInfo[]> {
  const all = await listAllStores(db);
  if (isPlatformAdmin(user.assignments)) return all;
  const ids = new Set(assignedStoreIds(user.assignments));
  return all.filter((s) => ids.has(s.id));
}

/**
 * 現在店舗の候補を決める (停止チェックなし)。
 * セッション選択が有効ならそれを、無ければ所属店舗が 1 つのときだけ自動選択。
 * 決まらなければ null。
 */
async function pickStore(
  db: D1Database,
  user: AuthUser,
  sessionStoreId: number | null | undefined,
): Promise<{ store: StoreInfo; platform: boolean } | null> {
  const platform = isPlatformAdmin(user.assignments);
  const accessible = await accessibleStores(db, user);
  if (accessible.length === 0) return null;
  let chosen: StoreInfo | undefined;
  if (sessionStoreId !== null && sessionStoreId !== undefined) {
    chosen = accessible.find((s) => s.id === sessionStoreId);
  }
  if (!chosen && accessible.length === 1) chosen = accessible[0];
  if (!chosen) return null;
  return { store: chosen, platform };
}

function buildContext(store: StoreInfo, platform: boolean, user: AuthUser): StoreContext {
  return {
    store,
    assignments: platform
      ? [{ roleCode: RoleCode.SYSTEM_ADMIN, warehouseId: null, storeId: store.id }]
      : storeAssignments(user.assignments, store.id),
    isPlatformAdmin: platform,
  };
}

/**
 * 業務 API 用の厳密な解決。割当が無いユーザーは 403、店舗未選択は 409、
 * 停止中店舗への店舗ユーザーのアクセスは 403 STORE_SUSPENDED。
 */
export async function resolveStoreContext(
  db: D1Database,
  user: AuthUser,
  sessionStoreId: number | null | undefined,
): Promise<StoreContext> {
  if (user.assignments.length === 0) throw forbidden('No role assignments for this user');
  const picked = await pickStore(db, user, sessionStoreId);
  if (!picked) {
    throw new ApiError(409, 'STORE_NOT_SELECTED', 'No store is selected. Select a store first.');
  }
  if (picked.store.status === 'suspended' && !picked.platform) {
    throw new ApiError(403, 'STORE_SUSPENDED', 'This store is suspended.');
  }
  return buildContext(picked.store, picked.platform, user);
}

/**
 * /me などの表示用に使う緩い解決。決まらなければ null を返し、
 * 停止中でも (状態表示のため) コンテキスト自体は返す。
 */
export async function softResolveStoreContext(
  db: D1Database,
  user: AuthUser,
  sessionStoreId: number | null | undefined,
): Promise<StoreContext | null> {
  try {
    const picked = await pickStore(db, user, sessionStoreId);
    if (!picked) return null;
    return buildContext(picked.store, picked.platform, user);
  } catch {
    // stores テーブル未適用の環境では店舗コンテキストなしで表示する
    return null;
  }
}
