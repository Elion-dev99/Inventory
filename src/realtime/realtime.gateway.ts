import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { RedisPubSubService } from './redis-pubsub.service';

/**
 * WebSocket Gateway (雛形)。
 * - 接続時に OIDC トークンを検証し、権限のある倉庫チャネルだけを購読させること (未実装)。
 * - イベントは差分通知のみ。クライアントは通知を受けて該当行を REST で再取得する。
 * - 切断・再接続時は画面全体を再取得して取りこぼしを補正する前提。
 */
@WebSocketGateway({ namespace: '/realtime', cors: true })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly pubsub: RedisPubSubService) {}

  afterInit(): void {
    this.pubsub.onEvent = (event) => {
      this.server?.emit('stock.changed', event);
    };
  }

  handleConnection(client: Socket): void {
    // TODO: Authorization ヘッダ (または auth ペイロード) の OIDC トークンを検証し、
    // 未認証接続は切断する。倉庫スコープ外のイベントを配信しないこと。
    this.logger.log(`Realtime client connected: ${client.id}`);
  }

  broadcast(event: unknown): void {
    this.server?.emit('stock.changed', event);
  }
}
