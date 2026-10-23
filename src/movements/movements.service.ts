import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StocktakesService } from '../stocktakes/stocktakes.service';
import {
  InsufficientStockException,
  StockConflictException,
} from '../common/exceptions/domain.exceptions';
import { proposeFefoAllocation, type FefoCandidate } from '../inventory/fefo';
import type { ConsumeDto, InboundDto, TransferDto } from './dto/movements.dto';

/**
 * 入庫・消費・移動 (基本設計 5章)。
 * 共通原則:
 * - 1業務操作 = 1トランザクション (残高更新 + 台帳追記 + Outbox を同一 Tx)
 * - 残高は条件付き UPDATE + 楽観的ロック (version) で更新し、更新件数 0 は競合/不足として扱う
 * - 複数行を触る処理は stocks.id 昇順にロックしてデッドロックを防ぐ
 * - 棚卸し実施中は全面停止 (StocktakesService.assertNotLocked)
 */
@Injectable()
export class MovementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stocktakes: StocktakesService,
    private readonly audit: AuditService,
  ) {}

  async inbound(dto: InboundDto, actorId: bigint) {
    await this.stocktakes.assertNotLocked();
    const locationId = BigInt(dto.locationId);
    const productId = BigInt(dto.productId);
    const documentId = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product) throw new BadRequestException('Product not found');
      if (product.requiresExpiry && !dto.expiryDate) {
        throw new BadRequestException('expiryDate is required for this product');
      }
      const lot = await tx.lot.upsert({
        where: { productId_lotCode: { productId, lotCode: dto.lotCode } },
        update: {},
        create: {
          productId,
          lotCode: dto.lotCode,
          expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
        },
      });
      const stock = await tx.stock.upsert({
        where: { locationId_lotId: { locationId, lotId: lot.id } },
        update: { quantity: { increment: dto.quantity }, version: { increment: 1 } },
        create: { locationId, lotId: lot.id, quantity: dto.quantity },
      });
      await tx.stockMovement.create({
        data: {
          documentId,
          stockId: stock.id,
          type: 'IN',
          quantityChange: dto.quantity,
          quantityBefore: stock.quantity - dto.quantity,
          quantityAfter: stock.quantity,
          actorId,
        },
      });
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'stock',
          aggregateId: stock.id.toString(),
          eventType: 'stock.changed',
          payload: { stockId: stock.id.toString(), documentId },
        },
      });
      return { documentId, stockId: stock.id.toString(), quantity: stock.quantity };
    });
  }

  /**
   * 社内消費: FEFO でロットを割り当て、ロットごとに条件付き UPDATE で減算する。
   * 条件付き UPDATE の方針 (基本設計 6.2):
   *   UPDATE stocks SET quantity = quantity - :q, version = version + 1
   *   WHERE id = :id AND version = :v AND quantity >= :q
   * 更新件数 0 は「他者が先に更新した」か「在庫不足」。成功扱いにせずエラーとして返す。
   */
  async consume(dto: ConsumeDto, actorId: bigint) {
    await this.stocktakes.assertNotLocked();
    const productId = BigInt(dto.productId);
    const locationId = dto.locationId ? BigInt(dto.locationId) : undefined;
    const documentId = randomUUID();

    const result = await this.prisma.$transaction(async (tx) => {
      const stocks = await tx.stock.findMany({
        where: { lot: { productId }, ...(locationId ? { locationId } : {}) },
        include: { lot: true },
        orderBy: { id: 'asc' }, // ロック順序を id 昇順に統一 (デッドロック対策)
      });
      // 対象行をロック (SELECT ... FOR UPDATE 相当)
      if (stocks.length > 0) {
        const ids = stocks.map((s) => s.id);
        await tx.$queryRaw`SELECT id FROM stocks WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`;
      }
      const candidates: FefoCandidate[] = stocks.map((s) => ({
        stockId: s.id,
        lotId: s.lotId,
        expiryDate: s.lot.expiryDate,
        quantity: s.quantity,
        receivedAt: s.lot.receivedAt,
      }));
      const proposal = proposeFefoAllocation(candidates, dto.quantity);
      if (proposal.shortfall > 0) {
        throw new InsufficientStockException(
          `Requested ${dto.quantity}, available ${dto.quantity - proposal.shortfall} (expired lots excluded)`,
        );
      }
      const byId = new Map(stocks.map((s) => [s.id.toString(), s]));
      for (const alloc of proposal.allocations) {
        const stock = byId.get(alloc.stockId.toString());
        if (!stock) throw new StockConflictException();
        const updated = await tx.$executeRaw`
          UPDATE stocks
          SET quantity = quantity - ${alloc.quantity},
              version = version + 1,
              updated_at = NOW()
          WHERE id = ${alloc.stockId}
            AND version = ${stock.version}
            AND quantity >= ${alloc.quantity}`;
        if (updated === 0) throw new StockConflictException();
        await tx.stockMovement.create({
          data: {
            documentId,
            stockId: alloc.stockId,
            type: 'OUT',
            quantityChange: -alloc.quantity,
            quantityBefore: stock.quantity,
            quantityAfter: stock.quantity - alloc.quantity,
            actorId,
            department: dto.department,
            purpose: dto.purpose,
            reason: dto.fefoDeviationReason,
          },
        });
      }
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'stock',
          aggregateId: productId.toString(),
          eventType: 'stock.changed',
          payload: { documentId, allocations: proposal.allocations.map((a) => ({
            stockId: a.stockId.toString(),
            quantity: a.quantity,
          })) },
        },
      });
      return { documentId, allocations: proposal.allocations };
    });

    await this.audit.record({
      actorId,
      action: 'stock.consume',
      targetType: 'product',
      targetId: productId.toString(),
      payload: { documentId, quantity: dto.quantity },
    });
    return result;
  }

  /**
   * 倉庫間/場所間移動 (雛形): 移動元 OUT と移動先 IN を 1 トランザクションで発行する。
   * 片方だけ完了する状態を作らない。ロットは移動先でも同一 lot を引き継ぐ。
   */
  async transfer(dto: TransferDto, actorId: bigint) {
    await this.stocktakes.assertNotLocked();
    const stockId = BigInt(dto.stockId);
    const toLocationId = BigInt(dto.toLocationId);
    const documentId = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      const from = await tx.stock.findUnique({ where: { id: stockId } });
      if (!from) throw new BadRequestException('Stock not found');
      const updated = await tx.$executeRaw`
        UPDATE stocks
        SET quantity = quantity - ${dto.quantity}, version = version + 1, updated_at = NOW()
        WHERE id = ${stockId} AND version = ${from.version} AND quantity >= ${dto.quantity}`;
      if (updated === 0) throw new StockConflictException();
      const to = await tx.stock.upsert({
        where: { locationId_lotId: { locationId: toLocationId, lotId: from.lotId } },
        update: { quantity: { increment: dto.quantity }, version: { increment: 1 } },
        create: { locationId: toLocationId, lotId: from.lotId, quantity: dto.quantity },
      });
      await tx.stockMovement.createMany({
        data: [
          {
            documentId, stockId, type: 'TRANSFER_OUT',
            quantityChange: -dto.quantity,
            quantityBefore: from.quantity, quantityAfter: from.quantity - dto.quantity,
            actorId,
          },
          {
            documentId, stockId: to.id, type: 'TRANSFER_IN',
            quantityChange: dto.quantity,
            quantityBefore: to.quantity - dto.quantity, quantityAfter: to.quantity,
            actorId,
          },
        ],
      });
      return { documentId };
    });
  }
}
