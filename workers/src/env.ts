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
  /**
   * Web Push (VAPID) 用。いずれも未設定ならプッシュ送信はスキップされ、
   * お知らせ自体は通常どおり動く (公開鍵 API は 503 を返す)。
   * - VAPID_PUBLIC_KEY: Base64url の公開鍵 (raw 65 バイト, vars)
   * - VAPID_PRIVATE_KEY_JWK: 秘密鍵 JWK の JSON 文字列 (Secret)
   * - VAPID_SUBJECT: JWT の sub (mailto: 連絡先, vars)
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY_JWK?: string;
  VAPID_SUBJECT?: string;
  /**
   * 商品画像・検品写真の保存先 R2 バケット (任意)。
   * 未設定の環境では写真系 API は 503 PHOTOS_NOT_CONFIGURED を返し、
   * 画像以外の機能は通常どおり動く。
   */
  IMAGES?: R2Bucket;
}
