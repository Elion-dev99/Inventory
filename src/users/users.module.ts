import { Module } from '@nestjs/common';
import { AccessControlService } from './access-control.service';
import { UsersService } from './users.service';

@Module({
  providers: [UsersService, AccessControlService],
  exports: [UsersService, AccessControlService],
})
export class UsersModule {}
