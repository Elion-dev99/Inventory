import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { IdempotencyService } from './idempotency.service';

interface AuthedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  user?: { userId: string };
}

/**
 * 雛形: POST の Idempotency-Key を検証し、保存済みレスポンスがあれば replay する。
 * 未実装: レスポンス保存は成功時のみ・非同期で行う (失敗時のキー解放ポリシーは詳細設計で確定)。
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idempotency: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.method !== 'POST') return next.handle();

    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      throw new BadRequestException('Idempotency-Key header is required for this endpoint.');
    }
    const userId = req.user?.userId;
    if (!userId) return next.handle(); // 認証前エンドポイントでは適用しない

    const userIdBig = BigInt(userId);
    return from(this.idempotency.findStored(key, userIdBig)).pipe(
      switchMap((stored) => {
        if (stored) return of(stored.body);
        return next.handle().pipe(
          tap((body) => {
            void this.idempotency
              .store(key, userIdBig, req.url, this.idempotency.hashRequest(req.body), {
                status: 201,
                body,
              })
              .catch(() => undefined);
          }),
        );
      }),
    );
  }
}
