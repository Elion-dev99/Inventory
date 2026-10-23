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

// ---------------------------------------------------------------- 権限 (permission)
// ロールは「権限の束」にすぎず、実効権限は role_permissions (D1) を正として
// リクエストごとに解決する。管理画面 / 管理 API から自由に変更できる。
// role_permissions が空 (未適用・未投入) の環境では DEFAULT_ROLE_PERMISSIONS に
// フォールバックし、移行前のロール直書き判定と同一の挙動を保つ。

export const Permission = {
  STOCKS_READ: 'stocks.read',
  ALERTS_READ: 'alerts.read',
  MOVEMENTS_INBOUND: 'movements.inbound',
  MOVEMENTS_CONSUME: 'movements.consume',
  MASTER_READ: 'master.read',
  MASTER_WRITE: 'master.write',
  NEGATIVE_REQUEST: 'negative.request',
  NEGATIVE_DECIDE: 'negative.decide',
  STOCKTAKES_MANAGE: 'stocktakes.manage',
  ADMIN_USERS: 'admin.users',
  ADMIN_PERMISSIONS: 'admin.permissions',
} as const;

export type PermissionKey = (typeof Permission)[keyof typeof Permission];

export interface PermissionDef {
  key: PermissionKey;
  label: string;
  description: string;
}

/** 権限カタログ (migrations/0003_permissions.sql の seed と一致させること) */
export const PERMISSION_CATALOG: readonly PermissionDef[] = [
  { key: Permission.STOCKS_READ, label: '在庫参照', description: '在庫一覧・詳細の参照' },
  { key: Permission.ALERTS_READ, label: 'アラート参照', description: '期限・不足・マイナス在庫アラートの参照' },
  { key: Permission.MOVEMENTS_INBOUND, label: '入庫', description: '入庫の登録' },
  { key: Permission.MOVEMENTS_CONSUME, label: '消費', description: '社内消費 (FEFO 出庫) の登録' },
  { key: Permission.MASTER_READ, label: 'マスタ参照', description: '商品・倉庫・保管場所・ロットの一覧参照' },
  { key: Permission.MASTER_WRITE, label: 'マスタ登録・編集', description: '商品・倉庫・保管場所・ロットの登録' },
  { key: Permission.NEGATIVE_REQUEST, label: 'マイナス在庫申請', description: 'マイナス在庫の例外申請の作成' },
  { key: Permission.NEGATIVE_DECIDE, label: 'マイナス在庫承認', description: 'マイナス在庫申請の承認・却下' },
  { key: Permission.STOCKTAKES_MANAGE, label: '棚卸し管理', description: '棚卸しの開始・終了' },
  { key: Permission.ADMIN_USERS, label: 'ユーザー管理', description: 'ユーザー一覧の参照とロール付与の変更' },
  { key: Permission.ADMIN_PERMISSIONS, label: '権限管理', description: 'ロール×権限マトリクスの変更' },
];

export const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSION_CATALOG.map((p) => p.key));

export const ALL_ROLE_CODES: readonly RoleCode[] = [
  RoleCode.SYSTEM_ADMIN,
  RoleCode.INVENTORY_MANAGER,
  RoleCode.INVENTORY_STAFF,
  RoleCode.VIEWER,
  RoleCode.AUDITOR,
];

const ALL_PERMISSIONS = PERMISSION_CATALOG.map((p) => p.key);

/**
 * 既定のロール×権限マトリクス。権限キー導入前の各エンドポイントの許可ロールを
 * 忠実に移行したもの (読み取り系は従来「割当があれば可」だったため全ロールに付与)。
 * role_permissions が空の場合のフォールバックであり、seed の正本でもある。
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<RoleCode, readonly PermissionKey[]>> = {
  [RoleCode.SYSTEM_ADMIN]: ALL_PERMISSIONS,
  [RoleCode.INVENTORY_MANAGER]: [
    Permission.STOCKS_READ,
    Permission.ALERTS_READ,
    Permission.MOVEMENTS_INBOUND,
    Permission.MOVEMENTS_CONSUME,
    Permission.MASTER_READ,
    Permission.MASTER_WRITE,
    Permission.NEGATIVE_REQUEST,
    Permission.NEGATIVE_DECIDE,
    Permission.STOCKTAKES_MANAGE,
  ],
  [RoleCode.INVENTORY_STAFF]: [
    Permission.STOCKS_READ,
    Permission.ALERTS_READ,
    Permission.MOVEMENTS_INBOUND,
    Permission.MOVEMENTS_CONSUME,
    Permission.MASTER_READ,
    Permission.NEGATIVE_REQUEST,
  ],
  [RoleCode.VIEWER]: [Permission.STOCKS_READ, Permission.ALERTS_READ, Permission.MASTER_READ],
  [RoleCode.AUDITOR]: [Permission.STOCKS_READ, Permission.ALERTS_READ, Permission.MASTER_READ],
};

export type RolePermissionMap = ReadonlyMap<RoleCode, ReadonlySet<PermissionKey>>;

export function defaultRolePermissionMap(): RolePermissionMap {
  return new Map(
    ALL_ROLE_CODES.map((role) => [role, new Set(DEFAULT_ROLE_PERMISSIONS[role])] as const),
  );
}

export interface RolePermissionRow {
  role_code: string;
  permission_key: string;
}

/**
 * role_permissions の行から実効マトリクスを組み立てる。
 * 行が 1 件も無い場合は既定マトリクスを返す (未適用環境でのフォールバック)。
 * カタログに無いキーや未知のロールは無視する。
 */
export function resolveRolePermissions(rows: readonly RolePermissionRow[]): RolePermissionMap {
  if (rows.length === 0) return defaultRolePermissionMap();
  const map = new Map<RoleCode, Set<PermissionKey>>();
  for (const role of ALL_ROLE_CODES) map.set(role, new Set());
  for (const row of rows) {
    if (!ALL_ROLE_CODES.includes(row.role_code as RoleCode)) continue;
    if (!PERMISSION_KEYS.has(row.permission_key)) continue;
    map.get(row.role_code as RoleCode)?.add(row.permission_key as PermissionKey);
  }
  return map;
}

/** 割当ロールの和集合としての実効権限 */
export function permissionsOf(
  assignments: readonly RoleAssignment[],
  rolePermissions: RolePermissionMap,
): Set<PermissionKey> {
  const out = new Set<PermissionKey>();
  for (const a of assignments) {
    const perms = rolePermissions.get(a.roleCode);
    if (perms) for (const p of perms) out.add(p);
  }
  return out;
}

/** いずれかの割当ロールが権限を持つか (スコープは見ない) */
export function hasPermission(
  assignments: readonly RoleAssignment[],
  rolePermissions: RolePermissionMap,
  permission: PermissionKey,
): boolean {
  return assignments.some((a) => rolePermissions.get(a.roleCode)?.has(permission) === true);
}

/** 権限を持ち、かつ対象倉庫のスコープ内である割当があるか (権限 AND スコープ) */
export function canPerformPermission(
  assignments: readonly RoleAssignment[],
  rolePermissions: RolePermissionMap,
  warehouseId: number,
  permission: PermissionKey,
): boolean {
  return assignments.some(
    (a) =>
      rolePermissions.get(a.roleCode)?.has(permission) === true &&
      (a.warehouseId === null || a.warehouseId === warehouseId),
  );
}
