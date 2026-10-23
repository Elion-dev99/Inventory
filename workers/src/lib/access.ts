/**
 * RBAC + 倉庫スコープ判定 — NestJS 版 src/users/access-control.service.ts の移植。
 * 判定順序は 認証 (401) -> ロール (403) -> 倉庫スコープ (403/404) を前提とし、
 * ここはロールとスコープの純粋判定のみを担う。
 */

export const RoleCode = {
  SYSTEM_ADMIN: 'SYSTEM_ADMIN',
  INVENTORY_MANAGER: 'INVENTORY_MANAGER',
  INVENTORY_STAFF: 'INVENTORY_STAFF',
  VIEWER: 'VIEWER',
  AUDITOR: 'AUDITOR',
} as const;

export type RoleCode = (typeof RoleCode)[keyof typeof RoleCode];

/** user_roles の1割当 (ロール + 倉庫スコープ)。warehouseId = null は全倉庫 */
export interface RoleAssignment {
  roleCode: RoleCode;
  warehouseId: number | null;
}

export function hasRole(assignments: readonly RoleAssignment[], ...roles: RoleCode[]): boolean {
  return assignments.some((a) => roles.includes(a.roleCode));
}

/** 指定倉庫に届く割当があるか (スコープ null = 全倉庫) */
export function canAccessWarehouse(assignments: readonly RoleAssignment[], warehouseId: number): boolean {
  return assignments.some((a) => a.warehouseId === null || a.warehouseId === warehouseId);
}

/** ロールを持ち、かつ対象倉庫のスコープ内であること */
export function canPerform(
  assignments: readonly RoleAssignment[],
  warehouseId: number,
  ...roles: RoleCode[]
): boolean {
  return assignments.some(
    (a) => roles.includes(a.roleCode) && (a.warehouseId === null || a.warehouseId === warehouseId),
  );
}

/** ユーザーが到達可能な倉庫 ID 一覧 (全倉庫に届く場合は null) */
export function reachableWarehouseIds(assignments: readonly RoleAssignment[]): number[] | null {
  if (assignments.some((a) => a.warehouseId === null)) return null;
  return [...new Set(assignments.map((a) => a.warehouseId).filter((id): id is number => id !== null))];
}
