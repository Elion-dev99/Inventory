import { Module } from '@nestjs/common';
import { RedisPubSubService } from './redis-pubsub.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  providers: [RedisPubSubService, RealtimeGateway],
  exports: [RedisPubSubService],
})
export class RealtimeModule {}
