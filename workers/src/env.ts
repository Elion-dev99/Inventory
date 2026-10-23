/** Worker / Coordinator 共通のバインディング定義 */
export interface Env {
  DB: D1Database;
  INVENTORY_COORDINATOR: DurableObjectNamespace;
  /** IdP の issuer URL (Secret)。未設定なら業務 API は 401 */
  OIDC_ISSUER_URL?: string;
  /** 検証する audience (vars の既定値あり) */
  OIDC_AUDIENCE?: string;
  /** 省略時は {OIDC_ISSUER_URL}/.well-known/jwks.json */
  OIDC_JWKS_URL?: string;
  OIDC_CLIENT_ID?: string;
  /** Google OAuth のクライアントシークレット (Secret)。認可コード交換でのみ使用 */
  GOOGLE_CLIENT_SECRET?: string;
}
