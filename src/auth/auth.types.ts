/** OIDC のクレームから組み立てる、アプリ内の認証済みユーザー表現 */
export interface AuthenticatedUser {
  /** アプリ内 users.id (文字列化した BigInt) */
  userId: string;
  /** IdP の sub クレーム */
  externalId: string;
  email?: string;
  displayName?: string;
}
