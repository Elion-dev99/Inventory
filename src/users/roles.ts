/** ロールコード (基本設計 3章 / 6章)。DB の roles.code と一致させる */
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
  warehouseId: bigint | null;
}
