import { Container, getContainer } from "@cloudflare/containers";

/**
 * 在庫管理システム — Cloudflare Containers 用の入口 Worker。
 *
 * 役割はリクエストを NestJS コンテナ (ルートの Dockerfile、port 3000) へ中継することだけ。
 * アプリ本体のロジックはすべてコンテナ側にあり、この Worker はステートレスな中継に徹する。
 *
 * 環境変数 (DATABASE_URL など) は Worker の Secret として登録し (wrangler secret put)、
 * コンテナ起動時に InventoryContainer のコンストラクタ経由でコンテナへ渡す。
 * 手順は同ディレクトリの README.md を参照。
 */
export interface Env {
  INVENTORY_CONTAINER: DurableObjectNamespace<InventoryContainer>;
  /** Neon の pooled 接続文字列 (必須 Secret) */
  DATABASE_URL?: string;
  /** Upstash の接続文字列 rediss://... (必須 Secret) */
  REDIS_URL?: string;
  /** OIDC (IdP 未確定のため汎用設定)。IdP 確定後に Secret 登録する */
  OIDC_ISSUER_URL?: string;
  OIDC_AUDIENCE?: string;
  /** 省略時はアプリ側が {OIDC_ISSUER_URL}/.well-known/jwks.json を使う */
  OIDC_JWKS_URL?: string;
  OIDC_CLIENT_ID?: string;
}

export class InventoryContainer extends Container<Env> {
  /** NestJS が待ち受けるポート (src/main.ts の PORT と一致させる) */
  override defaultPort = 3000;
  /** 最終リクエストから 10 分でスリープさせ、従量課金を抑える */
  override sleepAfter = "10m";

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env);
    // envVars はコンテナ起動時にのみ読み込まれる。
    // Secret を更新しても起動中のコンテナには反映されないため、更新時はコンテナの再起動が必要 (README 参照)。
    const envVars: Record<string, string> = {
      NODE_ENV: "production",
      PORT: "3000",
    };
    // 未設定の任意項目は「空文字で上書き」にならないよう、設定されているものだけを含める。
    if (env.DATABASE_URL) envVars.DATABASE_URL = env.DATABASE_URL;
    if (env.REDIS_URL) envVars.REDIS_URL = env.REDIS_URL;
    if (env.OIDC_ISSUER_URL) envVars.OIDC_ISSUER_URL = env.OIDC_ISSUER_URL;
    if (env.OIDC_AUDIENCE) envVars.OIDC_AUDIENCE = env.OIDC_AUDIENCE;
    if (env.OIDC_JWKS_URL) envVars.OIDC_JWKS_URL = env.OIDC_JWKS_URL;
    if (env.OIDC_CLIENT_ID) envVars.OIDC_CLIENT_ID = env.OIDC_CLIENT_ID;
    this.envVars = envVars;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 必須 Secret が無い状態でコンテナを起動すると、アプリが DB 接続エラーで落ちて
    // 原因の分かりにくい 5xx になるため、中継前に明示的に弾く (値は一切返さない)。
    if (!env.DATABASE_URL || !env.REDIS_URL) {
      return new Response(
        JSON.stringify({
          status: "error",
          message:
            "Required secrets are not configured. Set DATABASE_URL and REDIS_URL with `wrangler secret put` (see cloudflare/README.md).",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }

    //
    // 現行の Socket.IO (src/realtime) は Redis Adapter (@socket.io/redis-adapter) を導入しておらず、
    // Redis Pub/Sub はアプリ独自のイベント中継にしか使っていない。
    // そのため WebSocket のセッション (同一 sid の接続とポーリング) は同一インスタンスに
    // 張り付く必要があり、全リクエストを単一インスタンス (getContainer のデフォルト) へ寄せる。
    //
    // 以下を満たしたら getRandom へ切り替える:
    // 1. @socket.io/redis-adapter を導入し、Socket.IO のセッション/ブロードキャストを
    // インスタンス間で共有できるようにする
    // 2. 下記の行を `await getRandom(env.INVENTORY_CONTAINER, 3)` に置換する
    // (第2引数は wrangler.jsonc の max_instances と揃える)
    const container = getContainer(env.INVENTORY_CONTAINER);
    return container.fetch(request);
  },
} satisfies ExportedHandler<Env>;
