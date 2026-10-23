import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AuthenticatedUser } from './auth.types';

type Jwks = ReturnType<typeof createRemoteJWKSet>;

/**
 * OIDC アクセストークン検証ガード (雛形)。
 * - 認証は IdP へ全面委任し、アプリ独自のパスワード認証は作らない (要件 Q5)。
 * - ここでは Bearer トークンの署名 (JWKS)・iss・aud を検証し、クレームを req.user に載せるだけ。
 * - クレーム -> users テーブルへの同期とロール解決は UsersService / AccessControlService の責務。
 * - 多要素認証 (Face ID / パスキー) は IdP 側で担保され、amr クレームで確認可能 (検証は未実装)。
 */
@Injectable()
export class OidcAuthGuard implements CanActivate {
  private jwks: Jwks | null = null;

  constructor(private readonly config: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; user?: AuthenticatedUser }>();
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token is required');
    }
    const issuer = this.config.get<string>('oidc.issuerUrl') ?? '';
    const audience = this.config.get<string>('oidc.audience');
    const jwksUrl = this.config.get<string>('oidc.jwksUrl') ?? '';
    if (!issuer || !jwksUrl) {
      throw new UnauthorizedException('OIDC is not configured (OIDC_ISSUER_URL)');
    }
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(new URL(jwksUrl));
    }
    try {
      const { payload } = await jwtVerify(header.slice('Bearer '.length), this.jwks, {
        issuer,
        audience,
      });
      req.user = this.mapClaims(payload);
      return true;
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
  }

  private mapClaims(payload: JWTPayload): AuthenticatedUser {
    // NOTE: userId は UsersService.syncFromClaims で解決した users.id を載せる想定。
    // 雛形では sub を暫定値とし、ロールはクレームに含めない (DB の user_roles が正)。
    return {
      userId: typeof payload['app_user_id'] === 'string' ? payload['app_user_id'] : '0',
      externalId: payload.sub ?? '',
      email: typeof payload.email === 'string' ? payload.email : undefined,
      displayName: typeof payload.name === 'string' ? payload.name : undefined,
    };
  }
}
