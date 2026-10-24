/**
 * 全体管理 Worker のバインディング定義。
 * DB は店舗アプリと共有する同じ D1。Durable Objects は不要
 * (全体管理は在庫の書き込みをしないため Coordinator を経由しない)。
 */
export interface AdminEnv {
  DB: D1Database;
  /** IdP の issuer URL。未設定ならログイン・API は使えない */
  OIDC_ISSUER_URL?: string;
  /** 検証する audience (vars の既定値あり) */
  OIDC_AUDIENCE?: string;
  /** 省略時は {OIDC_ISSUER_URL}/.well-known/jwks.json */
  OIDC_JWKS_URL?: string;
  OIDC_CLIENT_ID?: string;
  /** Google OAuth のクライアントシークレット (Secret)。認可コード交換でのみ使用 */
  GOOGLE_CLIENT_SECRET?: string;
}
