import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  actorId: bigint | null;
  action: string;
  targetType: string;
  targetId: string;
  payload?: Prisma.InputJsonValue;
}

/** 監査ログ (追記専用)。在庫変動・承認・CSV 出力などの重要操作を記録する */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        payload: entry.payload ?? undefined,
      },
    });
  }
}
