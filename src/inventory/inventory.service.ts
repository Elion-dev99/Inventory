import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { proposeFefoAllocation, type FefoCandidate, type FefoProposal } from './fefo';

export interface StockQuery {
  locationId?: bigint;
  productId?: bigint;
  skip?: number;
  take?: number;
}

/**
 * 在庫照会と FEFO 提案。
 * 利用可能数 = quantity そのもの (引当は MVP 範囲外のため reserved の概念がない)。
 * 期限切れ分は利用可能から除外して扱う (消費ブロックは MovementsService 側でも担保)。
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  listStocks(query: StockQuery) {
    return this.prisma.stock.findMany({
      where: {
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.productId ? { lot: { productId: query.productId } } : {}),
      },
      include: { lot: { include: { product: true } }, location: true },
      skip: query.skip ?? 0,
      take: Math.min(query.take ?? 50, 200),
      orderBy: { id: 'asc' },
    });
  }

  /** 指定商品 (任意で保管場所) に対する FEFO 提案 (消費画面の初期表示用) */
  async previewFefo(
    productId: bigint,
    quantity: number,
    locationId?: bigint,
  ): Promise<FefoProposal> {
    const stocks = await this.prisma.stock.findMany({
      where: {
        lot: { productId },
        ...(locationId ? { locationId } : {}),
      },
      include: { lot: true },
    });
    const candidates: FefoCandidate[] = stocks.map((s) => ({
      stockId: s.id,
      lotId: s.lotId,
      expiryDate: s.lot.expiryDate,
      quantity: s.quantity,
      receivedAt: s.lot.receivedAt,
    }));
    return proposeFefoAllocation(candidates, quantity);
  }
}
