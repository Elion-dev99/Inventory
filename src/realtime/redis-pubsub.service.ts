import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const STOCK_EVENTS_CHANNEL = 'stock-events';

export interface StockChangedEvent {
  type: 'stock.changed';
  stockIds: string[];
  documentId?: string;
}

/**
 * Redis Pub/Sub 配信基盤 (基本設計 7章)。
 * アプリはステートレスな複数インスタンス前提のため、イベントは Redis 経由で全インスタンスへ配り、
 * 各インスタンスが自分の WebSocket 接続へ中継する。正本は DB であり、配信は差分通知に限る。
 * Outbox テーブルからの発行 (outbox_events -> publish) はワーカー実装が未実装 (README 参照)。
 */
@Injectable()
export class RedisPubSubService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisPubSubService.name);
  private publisher!: Redis;
  private subscriber!: Redis;
  /** Gateway が登録する中継ハンドラ */
  onEvent: ((event: unknown) => void) | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.get<string>('redisUrl') ?? 'redis://localhost:6379';
    this.publisher = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this.subscriber = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
    void this.subscriber.subscribe(STOCK_EVENTS_CHANNEL).catch((e: unknown) => {
      this.logger.warn(`Redis subscribe failed (continuing without realtime): ${String(e)}`);
    });
    this.subscriber.on('message', (_channel: string, message: string) => {
      try {
        this.onEvent?.(JSON.parse(message));
      } catch {
        this.logger.warn('Received non-JSON realtime event; ignored');
      }
    });
  }

  async publish(event: StockChangedEvent): Promise<void> {
    await this.publisher.publish(STOCK_EVENTS_CHANNEL, JSON.stringify(event));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.publisher?.quit(), this.subscriber?.quit()]);
  }
}
