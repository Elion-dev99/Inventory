import { AccessControlService } from './access-control.service';
import { RoleCode, type RoleAssignment } from './roles';

describe('AccessControlService', () => {
  const service = new AccessControlService();
  const staffAtWarehouse1: RoleAssignment[] = [
    { roleCode: RoleCode.INVENTORY_STAFF, warehouseId: 1n },
  ];
  const managerAllWarehouses: RoleAssignment[] = [
    { roleCode: RoleCode.INVENTORY_MANAGER, warehouseId: null },
  ];

  it('スコープ内の倉庫にはアクセスできる', () => {
    expect(service.canAccessWarehouse(staffAtWarehouse1, 1n)).toBe(true);
  });

  it('スコープ外の倉庫にはアクセスできない', () => {
    expect(service.canAccessWarehouse(staffAtWarehouse1, 2n)).toBe(false);
  });

  it('スコープ null (全倉庫) は全倉庫にアクセスできる', () => {
    expect(service.canAccessWarehouse(managerAllWarehouses, 99n)).toBe(true);
  });

  it('canPerform はロールとスコープの両方を要求する', () => {
    expect(
      service.canPerform(staffAtWarehouse1, 1n, RoleCode.INVENTORY_STAFF),
    ).toBe(true);
    expect(
      service.canPerform(staffAtWarehouse1, 1n, RoleCode.INVENTORY_MANAGER),
    ).toBe(false);
    expect(
      service.canPerform(managerAllWarehouses, 5n, RoleCode.INVENTORY_MANAGER),
    ).toBe(true);
  });
});
