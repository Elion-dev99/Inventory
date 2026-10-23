# 在庫管理システム — Cloudflare Workers + D1 版（無料・PCレス運用版）

Cloudflare の無料枠だけで、PC を常時起動せずに運用するための版です。
リポジトリルートの NestJS 版（PostgreSQL / Redis）と `cloudflare/` の Containers 版は
「有料・大規模版」として残してあり、本版はそれらに手を入れていません。

| 層 | 本版 (Workers + D1) | NestJS 版 |
|---|---|---|
| アプリ実行 | Cloudflare Workers (Hono) | NestJS (Node.js サーバー / Containers) |
| DB | D1 (SQLite) | PostgreSQL (Prisma) |
| 整合性の担保 | 単一 Durable Object `InventoryCoordinator` の直列処理 + D1 `batch()` | DB トランザクション + 条件付き UPDATE + 楽観的ロック |
| リアルタイム | Coordinator の WebSocket (Hibernation API) | Redis Pub/Sub + Socket.IO |
| 認証 | OIDC の JWT 検証 (jose / JWKS)。IdP 側で SSO + Face ID (パスキー) MFA | 同左 |
| 運用コスト | 無料枠内なら $0 | Workers Paid $5/月〜 + 外部 DB/Redis |

業務要件は両版で同一です（社内向け、主フローは入庫と社内消費、ロット＋有効期限と
FEFO、マイナス在庫は管理者承認＋理由必須＋自己承認禁止、棚卸し中は全面停止 (423)、
引当は対象外、RBAC 5 ロール＋倉庫スコープ）。

## 構成

```
ブラウザ / クライアント
        | HTTPS / WebSocket
        v
Worker (Hono, src/index.ts)
  - 認証 (OIDC JWT 検証 -> users 同期 -> user_roles 解決)
  - マスタ・参照系 API (D1 を直接読む)
  - 在庫の書き込みは一切しない
        | RPC (在庫更新系) / fetch (WebSocket)
        v
InventoryCoordinator (Durable Object, src/coordinator.ts)  ※単一インスタンス 'global'
  - 在庫の全書き込みを直列処理する唯一の窓口
  - 入庫 / 消費 (FEFO) / マイナス承認の例外消費 / 棚卸し開始・終了
  - 確定後に接続中クライアントへ stock.changed をブロードキャスト
        |
        v
D1 (SQLite) — stocks / stock_movements / negative_stock_approvals / stocktakes ほか
```

### 整合性設計（要点）

- D1 には対話的トランザクションが無いので、在庫の全書き込みは単一の Durable Object
  `InventoryCoordinator` を経由させます。DO はリクエストを直列に処理するため、
  「読み取り → FEFO 配分 → 条件付き UPDATE → 台帳記録」を競合なく実行できます。
  Coordinator 以外は `stocks` / `stock_movements` へ書き込みません。
- 更新は D1 の `batch()` で原子的に実行します。在庫の条件付き UPDATE
  （`quantity >= 必要数 AND version = 期待値`、version は +1）、`stock_movements` への
  append、`audit_logs` への記録、`idempotency_keys` への結果保存を 1 バッチにまとめます。
- 各 UPDATE の直後には `write_guards` へのガード行を置き、「更新後の行が期待どおり
  存在するか」を EXISTS で検証します。条件が外れていれば `ok` が NULL になり、
  NOT NULL 制約違反で **batch 全体がロールバック**します（中途半端な状態は残りません）。
  batch 成功後も各文の `meta.changes` を検証し、想定外は 409 を返します。
- 冪等性: 更新系 API は `Idempotency-Key` ヘッダ必須。同一キー＋同一ユーザーの再送には
  保存済みレスポンスを返します（同じキーで異なる本文は 422）。
- マイナス在庫: 通常は在庫不足を 409 で返します。例外は、消費リクエストに
  `negativeApprovalId` を付け、承認済み・未使用の `negative_stock_approvals` が
  ある場合のみ、承認数量の範囲で Coordinator の専用パスが許可します。
  使用した承認は同一 batch で使用済み（movement_id 記録）になります。
  結果としてマイナスになった在庫は `GET /api/v1/alerts` の `NEGATIVE_STOCK` に出ます。
- 棚卸し: `stocktakes` が実施中（in_progress）の間は、入庫・消費を 423 で拒否します
  （Coordinator 内でもチェック）。Prisma スキーマの stocktakes に倉庫の概念が無いため、
  NestJS 版と同じく**全体ロック**です。同時実施中は 1 件のみ（部分ユニークインデックス）。
- リアルタイム: `GET /api/v1/realtime` が WebSocket を Coordinator へつなぎます。
  在庫変更の確定後に `{ "type": "stock.changed", "stockIds": [...], "documentId": "..." }`
  をブロードキャストします。**再送保証はありません**: 切断中に起きた変更は届かないため、
  クライアントは再接続時に必ず REST (`GET /api/v1/stocks`) で再同期してください。
  ブラウザの WebSocket は Authorization ヘッダを付けられないため、`/realtime` では
  `?access_token=<JWT>` クエリでも認証できます。
- `outbox_events` テーブルは作っていません。NestJS 版の Outbox は「DB 確定とイベント
  発行の原子性」のための仕組みですが、本版では確定とブロードキャストが同じ DO の
  処理内で直結しているため不要と判断しました。再送保証が必要になったら Phase 2 で
  D1 にイベント表＋再送ワーカーを足します。

## 無料枠と規模の天井（重要）

無料枠の上限が、そのまま本版の規模の天井です。当初要件の大規模前提
（拠点 6 以上 / 同時 100 名以上 / 5 万 SKU 以上）には届きません。

| サービス | 無料枠 (Workers Free) |
|---|---|
| Workers リクエスト | 100,000 / 日、CPU 10 ms / リクエスト |
| D1 読み取り | 5,000,000 行 / 日 |
| D1 書き込み | 100,000 行 / 日 |
| D1 保存容量 | 合計 5 GB |
| Durable Objects (SQLite) | D1 と同じ読み書き・容量の枠を共有 |

1 回の入庫・消費は台帳・監査・冪等記録まで含めて十数行の書き込みになるため、
書き込み枠から逆算すると **1 日あたり数千件程度の在庫更新が実用上の上限**です。
小規模な拠点・試験運用・個人利用の範囲を想定した版として使ってください。

## API

パスは NestJS 版と互換（`/api/v1` 配下）。エラー形式も同じ
`{ statusCode, error, message }` です。主要なエラーコード:
409 `INSUFFICIENT_STOCK` / `STOCK_CONFLICT`、423 `STOCKTAKE_IN_PROGRESS`、
422 `SELF_APPROVAL_FORBIDDEN` / `IDEMPOTENCY_KEY_REUSED`。

| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/v1/health` | 認証不要 |
| GET/POST | `/api/v1/master/products`、`/api/v1/products` | 作成は管理者・在庫管理者 |
| GET/POST | `/api/v1/master/warehouses`、`/api/v1/warehouses` | 同上 |
| GET/POST | `/api/v1/master/locations`、`/api/v1/locations` | 同上（倉庫スコープ検証あり） |
| GET/POST | `/api/v1/master/lots`、`/api/v1/lots` | 同上 |
| GET | `/api/v1/stocks` (`locationId` / `productId` / `skip` / `take`) | 倉庫スコープで絞り込み |
| GET | `/api/v1/stocks/:id` | スコープ外は 404 |
| POST | `/api/v1/movements/inbound` | `Idempotency-Key` 必須。Coordinator 経由 |
| POST | `/api/v1/movements/consumption` | FEFO。`department` / `purpose` 必須。`negativeApprovalId` 任意 |
| POST | `/api/v1/negative-approvals` | 申請（理由必須） |
| GET | `/api/v1/negative-approvals` | 一覧（スコープ内） |
| POST | `/api/v1/negative-approvals/:id/decide` | 承認/却下。在庫管理者・管理者のみ。自己承認は 422 |
| POST | `/api/v1/stocktakes` | 開始（全 stocks の帳簿数スナップショット） |
| GET | `/api/v1/stocktakes` | 一覧 |
| POST | `/api/v1/stocktakes/:id/finish` | 終了（confirmed） |
| GET | `/api/v1/alerts` | `LOW_STOCK` / `EXPIRING` / `EXPIRED` / `NEGATIVE_STOCK` |
| GET | `/api/v1/realtime` | WebSocket アップグレード |

認証: `Authorization: Bearer <OIDC アクセストークン>`。ユーザーは初回アクセス時に
クレーム (sub / email / name) から `users` へ自動同期されますが、**ロールの割当
(`user_roles`) は自動では付かない**ため、後述の方法で管理者が付与してください。
割当が 1 件も無いユーザーは業務 API がすべて 403 になります。

## デプロイ手順

前提: Node.js 20 以上。作業ディレクトリは本ディレクトリ (`workers/`) です。

```bash
npm install   # .npmrc の legacy-peer-deps=true が必要 (npm の peer 解決バグ回避)
```

### 1. Cloudflare にログイン

```bash
npx wrangler login
npx wrangler whoami
```

### 2. D1 データベースを作成し、database_id を差し替える

```bash
npx wrangler d1 create inventory-system
```

出力された `database_id` を `wrangler.jsonc` のプレースホルダ
(`00000000-0000-0000-0000-000000000000`) と差し替えてください。

### 3. マイグレーションを適用 (リモート)

```bash
npx wrangler d1 migrations apply inventory-system --remote
```

`migrations/0001_init.sql`（スキーマ）と `0002_seed_roles.sql`（ロール 5 種）が適用されます。

### 4. OIDC の Secret を登録

```bash
npx wrangler secret put OIDC_ISSUER_URL   # 例: https://<idp>/ (発行者 URL)
# 任意: JWKS の場所が {issuer}/.well-known/jwks.json でない場合のみ
npx wrangler secret put OIDC_JWKS_URL
```

`OIDC_AUDIENCE` / `OIDC_CLIENT_ID` は `wrangler.jsonc` の vars に既定値
(`inventory-system`) が入っています。IdP 側の登録値と合わせてください。
**OIDC_ISSUER_URL 未設定の間は、ヘルスチェック以外の全 API が 401 になります**
（誤って無認証で公開しないための仕様です）。

### 5. デプロイ

```bash
npx wrangler deploy
```

### 6. 確認

```bash
curl https://inventory-system-workers.<アカウントのサブドメイン>.workers.dev/api/v1/health
# => {"status":"ok"}
```

### 7. 最初のユーザーにロールを割り当てる

対象ユーザーが一度でも API にアクセスすると `users` に行ができます
（トークン検証が通れば割当なしで 403 になる状態）。その後、D1 へ直接割当を入れます:

```bash
# ユーザー確認
npx wrangler d1 execute inventory-system --remote \
  --command "SELECT id, external_id, email FROM users"
# 全倉庫スコープでシステム管理者を付与する例
npx wrangler d1 execute inventory-system --remote \
  --command "INSERT INTO user_roles (user_id, role_code, warehouse_id) VALUES (<users.id>, 'SYSTEM_ADMIN', NULL)"
```

## ローカル開発・テスト

```bash
npx wrangler d1 migrations apply inventory-system --local
npx wrangler dev
npm test          # vitest (@cloudflare/vitest-pool-workers): 純粋ロジック + D1 結合 + API 疎通
npm run typecheck
```

テストは 4 ファイル・23 件です。`test/coordinator.spec.ts` は実 D1 (miniflare) に
マイグレーションを適用し、Coordinator の RPC 経由で入庫→冪等リプレイ→消費→
在庫不足 409→マイナス承認消費→棚卸し 423 を通す結合テストです。

> メモ: `@cloudflare/vitest-pool-workers` は `@cloudflare/vitest-plugin` へ改名が
> 予告されています（現行版で動作確認済み。移行は将来のメンテナンス時に）。
> また `compatibility_date` は同梱 workerd が受理できる上限 (2026-08-01) に
> 合わせています。定期的に引き上げてください。

## 未実装・Phase 2 送り

正直な一覧です。本版の Phase 1 では以下を意図的に省いています。

- マスタ CRUD の完全版（取得 1 件・更新・削除、商品バーコード検索など）
- 倉庫間・場所間の移動 (transfer) API
- 棚卸しの実数入力 API と差異の承認フロー（現状は開始＝スナップショット、
  終了＝confirmed のみ。差異の ADJUST 反映は未実装）
- フロントエンド（画面は NestJS 版含め未着手）
- リアルタイム配信の再送保証（Outbox 相当）。切断中の変更は再接続時の REST 再同期で吸収する前提
- IdP の amr クレーム検証（Face ID / パスキー MFA の必須化チェック）
- ユーザー管理 API（ロール割当の付与・変更は当面 D1 への直接操作）
- アラートの materialize / 通知（現状は stocks からの導出のみ、上限 1000 件）
- 在庫一覧の本格的な検索（SKU 部分一致・期限ソート等）とページネーションの総件数返却
- CI、負荷テスト、D1 のバックアップ運用手順
