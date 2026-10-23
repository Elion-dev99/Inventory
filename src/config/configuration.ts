export interface AppConfig {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  oidc: {
    issuerUrl: string;
    audience: string;
    jwksUrl: string;
    clientId: string;
  };
}

export default (): AppConfig => {
  const issuerUrl = process.env.OIDC_ISSUER_URL ?? '';
  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    oidc: {
      issuerUrl,
      audience: process.env.OIDC_AUDIENCE ?? 'inventory-system',
      jwksUrl:
        process.env.OIDC_JWKS_URL ??
        (issuerUrl ? `${issuerUrl.replace(/\/$/, '')}/.well-known/jwks.json` : ''),
      clientId: process.env.OIDC_CLIENT_ID ?? 'inventory-system',
    },
  };
};
