import { ForbiddenException, Injectable } from '@nestjs/common';
import type { RoleAssignment, RoleCode } from './roles';

/**
 * RBAC + 倉庫スコープ判定 (基本設計 6章)。
 * 判定順序は 認証 (401) -> ロール (403) -> 倉庫スコープ (403/404) を前提とし、
 * 本サービスはロールとスコープの純粋判定のみを担う。
 */
@Injectable()
export class AccessControlService {
  hasRole(assignments: RoleAssignment[], ...roles: RoleCode[]): boolean {
    return assignments.some((a) => roles.includes(a.roleCode));
  }

  /** 指定倉庫に届く割当があるか (スコープ null = 全倉庫) */
  canAccessWarehouse(assignments: RoleAssignment[], warehouseId: bigint): boolean {
    return assignments.some(
      (a) => a.warehouseId === null || a.warehouseId === warehouseId,
    );
  }

  /** ロールを持ち、かつ対象倉庫のスコープ内であること */
  canPerform(
    assignments: RoleAssignment[],
    warehouseId: bigint,
    ...roles: RoleCode[]
  ): boolean {
    return assignments.some(
      (a) =>
        roles.includes(a.roleCode) &&
        (a.warehouseId === null || a.warehouseId === warehouseId),
    );
  }

  assertWarehouseAccess(assignments: RoleAssignment[], warehouseId: bigint): void {
    if (!this.canAccessWarehouse(assignments, warehouseId)) {
      // スコープ外データは存在自体を漏らさない方針の API では 404 に読み替えること
      throw new ForbiddenException('Out of warehouse scope');
    }
  }

  /** ユーザーが到達可能な倉庫 ID 一覧 (null を含む場合は全倉庫 = null を返す) */
  reachableWarehouseIds(assignments: RoleAssignment[]): bigint[] | null {
    if (assignments.some((a) => a.warehouseId === null)) return null;
    return [...new Set(assignments.map((a) => a.warehouseId).filter((id): id is bigint => id !== null))];
  }
}
