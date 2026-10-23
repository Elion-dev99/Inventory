import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  StockConflictException,
  StocktakeLockedException,
} from '../common/exceptions/domain.exceptions';

/**
 * 棚卸し (要件 Q3): 実施中は全範囲の入出庫・消費・移動を全面停止する。
 * 同時 in_progress は 1 件のみ (DB の部分ユニークインデックス + 本サービスの検証)。
 */
@Injectable()
export class StocktakesService {
  constructor(private readonly prisma: PrismaService) {}

  /** StocktakeGuard (STOCKTAKE_LOCK_CHECKER) の実装 */
  async isLocked(): Promise<boolean> {
    const count = await this.prisma.stocktake.count({
      where: { status: 'in_progress' },
    });
    return count > 0;
  }

  async assertNotLocked(): Promise<void> {
    if (await this.isLocked()) throw new StocktakeLockedException();
  }

  /** 棚卸し開始: 全 stocks の帳簿数をスナップショットする */
  async start(actorId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.stocktake.count({ where: { status: 'in_progress' } });
      if (existing > 0) throw new StocktakeLockedException('Another stocktake is already in progress');
      const stocktake = await tx.stocktake.create({
        data: { startedBy: actorId, status: 'in_progress' },
      });
      const stocks = await tx.stock.findMany({ select: { id: true, quantity: true } });
      if (stocks.length > 0) {
        await tx.stocktakeLine.createMany({
          data: stocks.map((s) => ({
            stocktakeId: stocktake.id,
            stockId: s.id,
            bookQuantity: s.quantity,
          })),
        });
      }
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'stocktake',
          aggregateId: stocktake.id.toString(),
          eventType: 'stocktake.started',
          payload: { stocktakeId: stocktake.id.toString() },
        },
      });
      return stocktake;
    });
  }

  /**
   * 棚卸し確定 (雛形): 実績入力済みの行について差異を ADJUST 伝票として台帳化し残高へ反映する。
   * 未実装: 差異の承認フロー (在庫管理者のみ確定可) のロール検証はコントローラ層で追加すること。
   */
  async confirm(stocktakeId: bigint, actorId: bigint) {
    return this.prisma.$transaction(async (tx) => {
      const stocktake = await tx.stocktake.findUnique({ where: { id: stocktakeId } });
      if (!stocktake || stocktake.status !== 'in_progress') {
        throw new NotFoundException('In-progress stocktake not found');
      }
      const lines = await tx.stocktakeLine.findMany({
        where: { stocktakeId, countedQuantity: { not: null } },
      });
      const documentId = randomUUID();
      for (const line of lines) {
        const counted = line.countedQuantity ?? line.bookQuantity;
        const diff = counted - line.bookQuantity;
        if (diff === 0) continue;
        const updated = await tx.$executeRaw`
          UPDATE stocks
          SET quantity = quantity + ${diff}, version = version + 1, updated_at = NOW()
          WHERE id = ${line.stockId} AND quantity + ${diff} >= 0`;
        if (updated === 0) {
          throw new StockConflictException('Adjustment would make stock negative');
        }
        await tx.stockMovement.create({
          data: {
            documentId,
            stockId: line.stockId,
            type: 'ADJUST',
            quantityChange: diff,
            quantityBefore: line.bookQuantity,
            quantityAfter: counted,
            actorId,
            reason: 'stocktake',
          },
        });
      }
      return tx.stocktake.update({
        where: { id: stocktakeId },
        data: { status: 'confirmed', confirmedAt: new Date() },
      });
    });
  }
}
