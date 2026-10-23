import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * 冪等性 (基本設計 4章): 更新系 API は Idempotency-Key を必須とする。
 * 同一キー + 同一ユーザーの再送には初回結果を返し、二重処理を防ぐ。
 * ここでは記録の照会/保存のみを担い、実際の replay は IdempotencyInterceptor が行う。
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  hashRequest(body: unknown): string {
    return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
  }

  async findStored(key: string, userId: bigint): Promise<StoredResponse | null> {
    const record = await this.prisma.idempotencyKey.findUnique({
      where: { key_userId: { key, userId } },
    });
    if (!record || record.responseStatus === null) return null;
    return { status: record.responseStatus, body: record.responseBody };
  }

  async store(
    key: string,
    userId: bigint,
    endpoint: string,
    requestHash: string,
    response: StoredResponse,
  ): Promise<void> {
    await this.prisma.idempotencyKey.create({
      data: {
        key,
        userId,
        endpoint,
        requestHash,
        responseStatus: response.status,
        responseBody: response.body as object,
      },
    });
  }
}
