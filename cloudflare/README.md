# Cloudflare Containers デプロイ手順書

在庫管理システムの本番運用構成（決定済み）のデプロイ手順です。

| 層 | 採用 | 備考 |
|---|---|---|
| アプリ実行 | Cloudflare Containers | 本ディレクトリの Worker が、リポジトリルートの `Dockerfile` からビルドした NestJS コンテナを起動・中継する |
| PostgreSQL | Neon（外部マネージド） | アプリは pooled 接続、マイグレーションは direct 接続を使う（手順 3） |
| Redis | Upstash（外部マネージド） | リアルタイム配信用 Pub/Sub。TLS の `rediss://` で接続する（手順 4） |
| 認証 | OIDC（IdP 製品は未確定） | `OIDC_*` は IdP 確定後に Secret 登録する（手順 6 は任意項目を後回しでよい） |

前提として、デプロイ作業を行うマシンには **Node.js 20 以上** と **Docker**（`wrangler deploy` が
コンテナイメージをビルドするため）が必要です。以降のコマンドで `cloudflare/` と書いた場合は
本ディレクトリ、`ルート` と書いた場合はリポジトリルート（`inventory-system/`）を指します。

---

## 手順 1: Cloudflare — Workers Paid に加入する

1. [Cloudflare ダッシュボード](https://dash.cloudflare.com/) にログインする
2. 左メニューの「Workers & Pages」→「Plans」から **Workers Paid（$5/月〜）** に加入する
   - Containers は無料プランでは使えません

## 手順 2: ローカル準備と wrangler 認証

```bash
cd cloudflare
npm install
```

認証はどちらか一方を行います。

- 対話ログイン（推奨）: `npx wrangler login` — ブラウザが開くので Cloudflare アカウントで承認する
- API トークン: ダッシュボードの「My Profile → API Tokens」で
  「Edit Cloudflare Workers」テンプレート等からトークンを作成し、環境変数に設定する

  ```bash
  export CLOUDFLARE_API_TOKEN=<発行したトークン>
  ```

  Containers のデプロイには Workers Scripts / Containers / Durable Objects の編集権限が必要です。
  トークンの値はチャットやファイルに残さず、環境変数だけで使ってください。

認証できているか確認:

```bash
npx wrangler whoami
```

## 手順 3: Neon — PostgreSQL を用意する

1. [Neon](https://console.neon.tech/) でプロジェクトを新規作成する
   - リージョンは利用拠点に近いものを選ぶ（例: Asia Pacific / Singapore 等）
   - PostgreSQL のバージョンは 16 以上
2. プロジェクトの「Connection Details」から接続文字列を **2 種類** 控える
   - **Pooled connection**（ホスト名に `-pooler` を含むもの）→ `DATABASE_URL` 用
   - **Direct connection**（pooler を含まないもの）→ `DIRECT_URL` 用
3. 使い分けの理由:
   - アプリ実行時（Prisma Client）は接続数を抑えるため pooled（PgBouncer）を使う
   - `prisma migrate` はプール経由では実行できないため direct 接続が必須
     （`prisma/schema.prisma` の `directUrl` に割り当てている）
   - Prisma から pooler 経由で接続する `DATABASE_URL` には `?pgbouncer=true` を付ける
     （例: `postgresql://<user>:<password>@<host>-pooler.<region>.aws.neon.tech/<db>?sslmode=require&pgbouncer=true`）

## 手順 4: Upstash — Redis を用意する

1. [Upstash Console](https://console.upstash.com/) で Redis データベースを新規作成する
   - リージョンは Neon と同じ/近い地域を選ぶ（アプリ↔DB/Redis の往復遅延を抑えるため）
2. 詳細画面の「Connect」から **Redis の接続文字列** を控える
   - 形式: `rediss://<user>:<password>@<host>:<port>` — 先頭が `redis://` ではなく
     **`rediss://`（TLS）であること** を確認する

## 手順 5: DB マイグレーションと初回シード

デプロイ前に、ローカルから Neon へスキーマと初期データを投入します。
ルートで `.env` を作成し、手順 3 の値を設定してください（`.env` はコミット禁止です）。

```bash
cd <リポジトリルート>
cp .env.example .env
# .env に DATABASE_URL（pooled）と DIRECT_URL（direct）の実値を書く
npx prisma migrate deploy   # DIRECT_URL を使ってマイグレーションを適用
npm run prisma:seed         # 初期データ（ロール 5 種）を投入
```

## 手順 6: Worker へ Secret を登録する

`cloudflare/` ディレクトリで実行します。コマンドごとに値の入力を求められるので、
手順 3 / 4 で控えた実値を貼り付けてください（値はコマンド履歴やファイルに残りません）。

```bash
cd cloudflare
npx wrangler secret put DATABASE_URL   # Neon の pooled 接続文字列
npx wrangler secret put REDIS_URL      # Upstash の rediss:// 接続文字列
```

IdP が確定したら、以下も登録します（未登録でもアプリは起動し、ヘルスチェックは応答します。
ただし認証必須 API はトークン検証ができず 401 になります）。

```bash
npx wrangler secret put OIDC_ISSUER_URL   # 例: https://<idp>/ （末尾スラッシュ含む発行者 URL）
npx wrangler secret put OIDC_AUDIENCE     # 例: inventory-system
npx wrangler secret put OIDC_JWKS_URL     # 任意。省略時は {OIDC_ISSUER_URL}/.well-known/jwks.json を使用
npx wrangler secret put OIDC_CLIENT_ID    # 例: inventory-system
```

登録済み Secret の確認（値そのものは表示されません）:

```bash
npx wrangler secret list
```

> **重要 — Secret 更新時の反映タイミング:**
> コンテナは起動時にのみ環境変数を読み込みます。Secret を更新しても **起動中のコンテナには
> 反映されません**。更新後はコンテナを再起動してください。再起動の方法は「運用メモ」の
> 「コンテナを再起動する」を参照してください。

## 手順 7: デプロイ

```bash
cd cloudflare
npx wrangler deploy
```

- wrangler がルートの `Dockerfile` から linux/amd64 イメージをビルドし、Cloudflare へ push して
  Worker とコンテナ定義をデプロイします（Docker が起動している必要があります）
- 出力に Worker の URL（`https://inventory-system.<アカウントのサブドメイン>.workers.dev`）が表示されます

## 手順 8: デプロイ後の確認

```bash
curl https://inventory-system.<アカウントのサブドメイン>.workers.dev/api/v1/health
# => {"status":"ok"} （HTTP 200）
```

- 初回リクエストはコンテナの起動（コールドスタート）に数十秒かかることがあります
- 認証なしで業務 API を叩くと 401 が返るのが正常です:

  ```bash
  curl -i https://inventory-system.<アカウントのサブドメイン>.workers.dev/api/v1/stocks
  # => HTTP 401
  ```

- ログはダッシュボードの「Workers & Pages → inventory-system → Logs」、
  または `npx wrangler tail` で確認できます（observability は有効化済み）

---

## 運用メモ

### コンテナを再起動する（Secret 更新時など）

```bash
cd cloudflare
npx wrangler containers list          # 稼働中インスタンスを確認
npx wrangler containers delete <INSTANCE_ID>   # 削除すると次回リクエストで新しい環境変数で再作成される
```

無アクセス状態が続くと `sleepAfter`（10 分）で自動的にスリープし、次回リクエスト時に
最新の設定で再起動します。急がない場合は自然なスリープを待っても構いません。

### スケーリング条件（現在はシングルトン）

現在のルーティングは全リクエストを単一インスタンスへ寄せる **シングルトン** です
（`src/index.ts` のコメント参照）。理由は、Socket.IO に Redis Adapter
（`@socket.io/redis-adapter`）が未導入で、WebSocket セッションの親和性が必要なためです。

複数インスタンス化するには:

1. アプリ側に `@socket.io/redis-adapter` を導入し、Socket.IO のセッションと
   ブロードキャストを Redis 経由で共有する
2. `src/index.ts` の `getContainer(env.INVENTORY_CONTAINER)` を
   `await getRandom(env.INVENTORY_CONTAINER, 3)` に置き換える
3. `wrangler.jsonc` の `max_instances`（現在 3）と getRandom の第 2 引数を揃える

### 費用の考え方

- **Cloudflare**: Workers Paid $5/月 + Containers の従量課金
  （メモリ・ディスクは確保量ベース、CPU は実使用ベース。10ms 単位で課金され、
  スリープ中は課金されません）
  - 例: `standard-2`（1 vCPU / 6 GiB / 12 GB）を 24 時間つけっぱなしにすると
    メモリ分だけで月 $40 前後が目安。スリープ（`sleepAfter: "10m"`）が効く運用なら
    大幅に下がります
- **Neon / Upstash**: ともに無料枠があり、小規模な検証は無料枠から開始できます。
  本番規模（5 万 SKU / 同時 100 名前提）では各サービスの有料プランへの移行を前提に
  見積もりしてください
- コストを抑える要点は「使わない時間にコンテナを寝かせる」ことです。常時起動が
  必要な運用になった場合は `sleepAfter` の延長とインスタンスタイプを再検討してください

### よくある詰まりどころ

- `wrangler deploy` が Docker 関連で失敗する → Docker が起動しているか、
  linux/amd64 イメージをビルドできる環境かを確認
- ヘルスチェックが 503 になる → 手順 6 の Secret（`DATABASE_URL` / `REDIS_URL`）が
  未登録です。`npx wrangler secret list` で確認してください
- ヘルスチェックがタイムアウト/502 になる → コンテナ側でアプリが起動に失敗しています。
  `npx wrangler tail` またはダッシュボードの Logs で、Prisma の接続エラー
  （Neon の接続文字列・`pgbouncer=true` の付け忘れ）や Redis の TLS（`rediss://`）を確認してください
- マイグレーションが失敗する → `DIRECT_URL` が direct 接続（pooler でない）文字列に
  なっているかを確認してください
