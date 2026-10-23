import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { RoleAssignment, RoleCode } from './roles';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * OIDC ログイン時にクレームから users を同期する (雛形)。
   * IdP 側で無効化されたユーザーは status=disabled として即時反映する想定。
   */
  async syncFromClaims(input: {
    externalId: string;
    email: string;
    displayName: string;
  }): Promise<{ id: bigint }> {
    const user = await this.prisma.user.upsert({
      where: { externalId: input.externalId },
      update: { email: input.email, displayName: input.displayName, lastLoginAt: new Date() },
      create: {
        externalId: input.externalId,
        email: input.email,
        displayName: input.displayName,
        lastLoginAt: new Date(),
      },
      select: { id: true },
    });
    return user;
  }

  async getAssignments(userId: bigint): Promise<RoleAssignment[]> {
    const rows = await this.prisma.userRole.findMany({ where: { userId } });
    return rows.map((r) => ({
      roleCode: r.roleCode as RoleCode,
      warehouseId: r.warehouseId,
    }));
  }
}
