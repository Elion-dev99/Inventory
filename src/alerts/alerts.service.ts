import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isExpired } from '../inventory/fefo';

export interface StockAlert {
  type: 'LOW_STOCK' | 'EXPIRING' | 'EXPIRED';
  stockId: string;
  productId: string;
  sku: string;
  quantity: number;
  expiryDate: Date | null;
}

/**
 * アラート (雛形): 低在庫・期限接近・期限切れを stocks から導出する。
 * 規模上の注意: 5万 SKU / stocks 数十万行を前提に、本番では集計クエリ + インデックスで実装し、
 * 定期バッチでアラートテーブルへ materialize する方式を詳細設計で検討すること。
 */
@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  async listAlerts(now: Date = new Date()): Promise<StockAlert[]> {
    const stocks = await this.prisma.stock.findMany({
      include: { lot: { include: { product: true } } },
      take: 1000,
    });
    const alerts: StockAlert[] = [];
    for (const stock of stocks) {
      const product = stock.lot.product;
      const base = {
        stockId: stock.id.toString(),
        productId: product.id.toString(),
        sku: product.sku,
        quantity: stock.quantity,
        expiryDate: stock.lot.expiryDate,
      };
      if (isExpired(stock.lot.expiryDate, now)) {
        alerts.push({ type: 'EXPIRED', ...base });
        continue;
      }
      if (stock.lot.expiryDate && product.expiryAlertDays) {
        const alertAt = new Date(stock.lot.expiryDate);
        alertAt.setUTCDate(alertAt.getUTCDate() - product.expiryAlertDays);
        if (now >= alertAt) alerts.push({ type: 'EXPIRING', ...base });
      }
      if (stock.quantity <= product.safetyStock) {
        alerts.push({ type: 'LOW_STOCK', ...base });
      }
    }
    return alerts;
  }
}
