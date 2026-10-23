import { describe, expect, it } from 'vitest';
import {
  canPerformPermission,
  DEFAULT_ROLE_PERMISSIONS,
  hasPermission,
  PERMISSION_CATALOG,
  Permission,
  permissionsOf,
  resolveRolePermissions,
  RoleCode,
  type RoleAssignment,
} from '../src/lib/access';

/**
 * 権限解決の単体テスト。とくに role_permissions が空のときに
 * 既定マトリクスへフォールバックすること (移行前の挙動維持) を固定する。
 */
describe('resolveRolePermissions', () => {
  it('行が空なら既定マトリクスを使う', () => {
    const map = resolveRolePermissions([]);
    for (const def of PERMISSION_CATALOG) {
      expect(map.get(RoleCode.SYSTEM_ADMIN)?.has(def.key)).toBe(true);
    }
    expect(map.get(RoleCode.VIEWER)?.has(Permission.STOCKS_READ)).toBe(true);
    expect(map.get(RoleCode.VIEWER)?.has(Permission.MOVEMENTS_INBOUND)).toBe(false);
    expect(map.get(RoleCode.INVENTORY_STAFF)?.has(Permission.MOVEMENTS_INBOUND)).toBe(true);
    expect(map.get(RoleCode.INVENTORY_STAFF)?.has(Permission.MASTER_WRITE)).toBe(false);
    expect(map.get(RoleCode.INVENTORY_MANAGER)?.has(Permission.NEGATIVE_DECIDE)).toBe(true);
    expect(map.get(RoleCode.INVENTORY_MANAGER)?.has(Permission.ADMIN_PERMISSIONS)).toBe(false);
    expect(map.get(RoleCode.AUDITOR)?.has(Permission.ALERTS_READ)).toBe(true);
  });

  it('既定マトリクスはカタログのキーだけから成る', () => {
    const keys = new Set(PERMISSION_CATALOG.map((p) => p.key));
    for (const role of Object.values(RoleCode)) {
      for (const key of DEFAULT_ROLE_PERMISSIONS[role]) {
        expect(keys.has(key)).toBe(true);
      }
    }
  });

  it('行があれば DB を正とし、未知のロール・キーは無視する', () => {
    const map = resolveRolePermissions([
      { role_code: 'VIEWER', permission_key: 'movements.inbound' },
      { role_code: 'VIEWER', permission_key: 'unknown.key' },
      { role_code: 'NOPE', permission_key: 'stocks.read' },
    ]);
    expect([...(map.get(RoleCode.VIEWER) ?? [])]).toEqual(['movements.inbound']);
    // 行が存在する以上、他ロールは「空」であり既定には戻らない
    expect(map.get(RoleCode.SYSTEM_ADMIN)?.size).toBe(0);
  });
});

describe('権限判定 (権限 AND 倉庫スコープ)', () => {
  const map = resolveRolePermissions([]);
  const staffAllWarehouses: RoleAssignment[] = [{ roleCode: RoleCode.INVENTORY_STAFF, warehouseId: null }];
  const staffWarehouse1: RoleAssignment[] = [{ roleCode: RoleCode.INVENTORY_STAFF, warehouseId: 1 }];

  it('hasPermission はロールの和集合で判定する', () => {
    expect(hasPermission(staffWarehouse1, map, Permission.MOVEMENTS_INBOUND)).toBe(true);
    expect(hasPermission(staffWarehouse1, map, Permission.MASTER_WRITE)).toBe(false);
    const mixed: RoleAssignment[] = [
      { roleCode: RoleCode.VIEWER, warehouseId: null },
      { roleCode: RoleCode.INVENTORY_MANAGER, warehouseId: 2 },
    ];
    expect(hasPermission(mixed, map, Permission.NEGATIVE_DECIDE)).toBe(true);
    expect(permissionsOf(mixed, map).has(Permission.STOCKTAKES_MANAGE)).toBe(true);
  });

  it('canPerformPermission はスコープ外の倉庫を弾く', () => {
    expect(canPerformPermission(staffAllWarehouses, map, 99, Permission.MOVEMENTS_CONSUME)).toBe(true);
    expect(canPerformPermission(staffWarehouse1, map, 1, Permission.MOVEMENTS_CONSUME)).toBe(true);
    expect(canPerformPermission(staffWarehouse1, map, 2, Permission.MOVEMENTS_CONSUME)).toBe(false);
    // スコープ内でも権限が無ければ不可
    expect(canPerformPermission(staffWarehouse1, map, 1, Permission.MASTER_WRITE)).toBe(false);
  });
});
