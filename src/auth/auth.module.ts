import { Module } from '@nestjs/common';
import { OidcAuthGuard } from './oidc-auth.guard';

@Module({
  providers: [OidcAuthGuard],
  exports: [OidcAuthGuard],
})
export class AuthModule {}
