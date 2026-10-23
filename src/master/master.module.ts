import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MasterController } from './master.controller';
import { MasterService } from './master.service';

@Module({
  imports: [AuthModule],
  controllers: [MasterController],
  providers: [MasterService],
  exports: [MasterService],
})
export class MasterModule {}
