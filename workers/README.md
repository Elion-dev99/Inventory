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
- 棚卸し: `stocktakes` が実施中（in_progress）または差異承認待ち（pending_approval）の
  間は、入庫・消費・移動を 423 で拒否します（Coordinator 内でもチェック）。
  例外は棚卸し自身の承認による差異調整だけです。Prisma スキーマの stocktakes に倉庫の
  概念が無いため、NestJS 版と同じく**全体ロック**です。同時実施中・承認待ちは 1 件のみ
  （部分ユニークインデックス）。
- リアルタイム: `GET /api/v1/realtime` が WebSocket を Coordinator へつなぎます。
  在庫変更の確定後に `{ "type": "stock.changed", "stockIds": [...], "documentId": "..." }`
  をブロードキャストします。**再送保証はありません**: 切断中に起きた変更は届かないため、
  クライアントは再接続時に必ず REST (`GET /api/v1/stocks`) で再同期してください。
  ブラウザの WebSocket は Authorization ヘッダを付けられないため、`/realtime` では
  `?access_token=<JWT>` クエリでも認証できます。また Cookie セッション
  (後述) でも認証でき、`/app` はそちらを使います。
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
| GET/POST | `/api/v1/master/products`、`/api/v1/products` | 参照は `master.read`、作成は `master.write` (下記「権限」参照) |
| PUT/DELETE | `/api/v1/master/products/:id`、`/api/v1/products/:id` | 編集・論理削除 (`master.write`)。SKU は変更不可 |
| POST | `/api/v1/master/products/import`、`/api/v1/products/import` | 商品 CSV 一括登録 (`master.write`、下記「CSV」参照) |
| GET/POST | `/api/v1/master/warehouses`、`/api/v1/warehouses` | 同上 |
| PUT/DELETE | `/api/v1/master/warehouses/:id`、`/api/v1/warehouses/:id` | 編集・論理削除 (`master.write`) |
| GET/POST | `/api/v1/master/locations`、`/api/v1/locations` | 同上（倉庫スコープ検証あり） |
| PUT/DELETE | `/api/v1/master/locations/:id`、`/api/v1/locations/:id` | 編集・論理削除 (`master.write`、スコープ検証あり) |
| GET/POST | `/api/v1/master/lots`、`/api/v1/lots` | 同上 |
| PUT/DELETE | `/api/v1/master/lots/:id`、`/api/v1/lots/:id` | 編集は `lotCode` / `expiryDate` のみ・論理削除 (`master.write`) |
| GET | `/api/v1/stocks` (`locationId` / `productId` / `skip` / `take`) | 倉庫スコープで絞り込み |
| GET | `/api/v1/stocks/:id` | スコープ外は 404 |
| GET | `/api/v1/stocks.csv` | 在庫一覧の CSV ダウンロード (`stocks.read`、スコープ適用) |
| POST | `/api/v1/movements/inbound` | `Idempotency-Key` 必須。Coordinator 経由 |
| POST | `/api/v1/movements/consumption` | FEFO。`department` / `purpose` 必須。`negativeApprovalId` 任意 |
| POST | `/api/v1/movements/transfer` | 保管場所間の移動 (`movements.transfer`)。FEFO または `lotId` 指定。Coordinator 経由 |
| POST | `/api/v1/negative-approvals` | 申請（理由必須） |
| GET | `/api/v1/negative-approvals` | 一覧（スコープ内） |
| POST | `/api/v1/negative-approvals/:id/decide` | 承認/却下 (`negative.decide`)。自己承認は 422 |
| POST | `/api/v1/stocktakes` | 開始（全 stocks の帳簿数スナップショット） |
| GET | `/api/v1/stocktakes` | 一覧 |
| GET | `/api/v1/stocktakes/:id` | 詳細（lines: 帳簿数・実数・差異） |
| PUT | `/api/v1/stocktakes/:id/lines/:lineId` | 実数 (`countedQuantity`) の入力。実施中のみ (`stocktakes.manage`) |
| POST | `/api/v1/stocktakes/:id/finish` | 終了。差異が無ければ confirmed、あれば `pending_approval` で停止 |
| POST | `/api/v1/stocktakes/:id/decide` | 差異の承認/差し戻し (`stocktakes.manage`、下記「棚卸しの差異承認」参照) |
| GET | `/api/v1/alerts` | `LOW_STOCK` / `EXPIRING` / `EXPIRED` / `NEGATIVE_STOCK` |
| GET | `/api/v1/movements` (`productId` / `type` / `skip` / `take`) | 入出庫履歴 (`stocks.read`、倉庫スコープで絞り込み) |
| GET | `/api/v1/me` | 自分の id / email / 割当 / 実効権限キー一覧 |
| POST | `/api/v1/auth/logout` | Cookie セッションを破棄 |
| GET | `/api/v1/realtime` | WebSocket アップグレード |

### 在庫移動 (transfer)

`POST /api/v1/movements/transfer` は保管場所間で在庫を移します
(`{ fromLocationId, toLocationId, productId, quantity, lotId? }`)。
`lotId` 未指定なら消費と同じ FEFO 順（期限切れは除外）に引き、`lotId` 指定時は
そのロットのみから引きます。移動先に同一 product × lot の stocks 行があれば
加算、無ければ新規作成します。台帳には `TRANSFER_OUT`（移動元）と
`TRANSFER_IN`（移動先）を同一 `document_id` で記録します
（既存の CHECK 制約の値域をそのまま使用）。
権限は `movements.transfer` に加え、移動元・移動先の両方の倉庫に到達可能で
あること（倉庫スコープ）を Worker 側で判定します。その他の作法（冪等キー
必須、条件付き UPDATE + ガード、batch 原子化、棚卸し中 423）は入庫・消費と
同一で、処理はすべて Coordinator に集約されます。

### 棚卸しの差異承認

1. `POST /stocktakes` で開始し、`PUT /stocktakes/:id/lines/:lineId` で各行の
   実数 (`counted_quantity`) を入力します。実数未入力の行は「差異なし」として
   扱われます。
2. `POST /stocktakes/:id/finish` は、差異が無い行だけなら従来どおり即
   `confirmed`。差異がある場合は status を `pending_approval` にして止めます
   （この間も全面停止 = 423 は継続）。
3. `POST /stocktakes/:id/decide { approve }`:
   - `approve: true` — Coordinator が差異を調整伝票として在庫へ反映します
     （`stock_movements` type `ADJUST`、`quantity_change` = 差分、理由
     `stocktake-adjustment`）。反映は棚卸しロックの対象外（調整専用パス）ですが、
     条件付き UPDATE + ガードの作法は守ります。反映後に `confirmed` になります。
   - `approve: false` — `in_progress` に戻ります（実数は保持）。
   承認は棚卸し開始者本人でも可です（マイナス在庫の自己承認禁止とは別の話）。

### マスタの編集・削除と CSV

- マスタの PUT/DELETE は `master.write` が必要です。削除はすべて論理削除
  (`deleted_at`) で、一覧からは消えますが、参照している在庫・履歴
  (`stock_movements`) には影響しません。商品の SKU は編集できません。
- `GET /api/v1/stocks.csv`: 在庫一覧を CSV (UTF-8 BOM 付き) で返します。
  列は商品コード・商品名・倉庫・保管場所・ロット・期限・数量です。
- `POST /api/v1/master/products/import`: 商品 CSV を一括登録します
  (`multipart/form-data` の `file` フィールド、またはテキストボディ)。
  ヘッダは `sku,name,unit,requires_expiry`（requires_expiry は省略可、`true`/`1`/`yes`
  を真とみなします）。既存 SKU（論理削除済みを含む）はスキップし、行ごとの
  成否を `{ total, created, skipped, failed: [{ line, sku?, reason }] }` で返します。

認証: `Authorization: Bearer <OIDC アクセストークン>`。ユーザーは初回アクセス時に
クレーム (sub / email / name) から `users` へ自動同期されますが、**ロールの割当
(`user_roles`) は自動では付かない**ため、後述の方法で管理者が付与してください。
割当が 1 件も無いユーザーは業務 API がすべて 403 になります。
Bearer が無いリクエストは、後述の Cookie セッションでも認証できます (Bearer が優先)。

## セッション認証とフロントエンド (/app)

ブラウザ向けには、Google ログイン (認可コードフロー) の成功時にログイン
セッションを発行します (`migrations/0004_sessions.sql`、`src/lib/session.ts`)。

- `/auth/login` → Google で認証 → `/auth/callback` がコード交換・ID トークン
  検証・`users` 同期まで行い、結果ページに「アプリを開く」リンクを出します。
  このとき Cookie `session` (HttpOnly / Secure / SameSite=Lax、有効期限 8 時間)
  が発行されます。DB の `sessions` にはトークン本体ではなく SHA-256 ハッシュ
  のみを保存します。
- 以後の API と WebSocket (`/api/v1/realtime`) は Cookie で認証できます。
  ログアウトは `POST /api/v1/auth/logout` でセッション行を削除し Cookie を失効させます。
- セッション経由では `users` を新規作成しません (行が無い・無効化済み・期限切れは 401)。

### 画面 (/app)

Worker から配信する SPA です (`src/app/`。追加のビルド基盤なしで wrangler の
バンドルに載ります)。未ログインで開くと Google ログインへの導線が出ます。

| 画面 | 内容 |
|---|---|
| ダッシュボード | アラート件数と内訳、在庫レコード数・総数量、期限が近い在庫、棚卸し実施中バナー |
| 在庫一覧 | キーワード検索、倉庫・保管場所フィルタ、期限切れ/接近の色分け |
| 入庫 | 商品・ロット・場所・数量・期限を入力して登録 (`Idempotency-Key` は自動付与) |
| 消費 | FEFO で消費し、どのロットから引かれたかを表示。マイナス在庫承認 ID の指定も可 |
| 移動 | 移動元・移動先・商品・数量 (ロット指定任意) を入力し、FEFO の内訳を表示 |
| 履歴 | 入出庫履歴 (種別・変化量・数量の前後・部署/用途)。移動・調整は専用バッジで表示 |
| マスタ管理 | 商品・倉庫・保管場所・ロットの一覧、追加・編集・削除フォーム、商品 CSV インポート |
| マイナス在庫 | 例外申請フォームと承認待ち一覧 (承認/却下) |
| 棚卸し | 開始・実数入力・差異表示・承認/差し戻しと履歴。実施中・承認待ちは他操作が 423 になる旨を表示 |
| アラート | 期限切れ・期限接近・在庫不足・マイナス在庫の一覧 |

メニューとボタンは `/api/v1/me` の実効権限で出し分けます (サーバー側でも
403 になるため、出し分けは UX 改善として)。在庫変更のブロードキャスト
(`stock.changed` など) を WebSocket で受けると表示中データを再取得し、
再接続時も REST で再同期します。

## 権限 (ロールごとに DB で自由に設定可能)

ロールは「権限の束」にすぎません。実効権限は D1 の `role_permissions` を正として
リクエストごとに解決し、各エンドポイントはロール名ではなく権限キーで判定します
(判定は「権限 AND 倉庫スコープ」。スコープは従来どおり `user_roles.warehouse_id`)。
変更は再デプロイなしで即時反映されます。

### 権限カタログ

| キー | 内容 | 主な対象 |
|---|---|---|
| `stocks.read` | 在庫参照 | GET /stocks、/stocks/:id |
| `alerts.read` | アラート参照 | GET /alerts |
| `movements.inbound` | 入庫 | POST /movements/inbound |
| `movements.consume` | 消費 | POST /movements/consumption |
| `movements.transfer` | 在庫移動 | POST /movements/transfer |
| `master.read` | マスタ参照 | GET /master/* (products / warehouses / locations / lots) |
| `master.write` | マスタ登録・編集 | POST /master/*、PUT・DELETE /master/*/:id、POST /master/products/import |
| `negative.request` | マイナス在庫申請 | POST /negative-approvals |
| `negative.decide` | マイナス在庫承認 | POST /negative-approvals/:id/decide |
| `stocktakes.manage` | 棚卸し管理 | POST /stocktakes、PUT /stocktakes/:id/lines/:lineId、/stocktakes/:id/finish、/stocktakes/:id/decide |
| `admin.users` | ユーザー管理 | GET /admin/users、PUT /admin/users/:id/roles |
| `admin.permissions` | 権限管理 | PUT /admin/role-permissions/:roleCode |

権限キーで判定していない読み取りもあります: 承認一覧 (GET /negative-approvals)、
棚卸し一覧 (GET /stocktakes)、リアルタイム接続 (GET /realtime) は従来どおり
「割当が 1 件以上あること」が条件です (表示範囲は倉庫スコープで絞られます)。

### 既定マトリクス

`migrations/0003_permissions.sql` の seed であり、`role_permissions` が空
(マイグレーション未適用・未投入) の環境では `src/lib/access.ts` の
`DEFAULT_ROLE_PERMISSIONS` がフォールバックとして使われます (どちらも同一内容)。
内容は権限キー導入前の各エンドポイントの許可ロールを忠実に移行したものです。

| ロール | 既定の権限 |
|---|---|
| SYSTEM_ADMIN | 全権限 |
| INVENTORY_MANAGER | stocks.read / alerts.read / movements.inbound / movements.consume / movements.transfer / master.read / master.write / negative.request / negative.decide / stocktakes.manage |
| INVENTORY_STAFF | stocks.read / alerts.read / movements.inbound / movements.consume / movements.transfer / master.read / negative.request |
| VIEWER | stocks.read / alerts.read / master.read |
| AUDITOR | stocks.read / alerts.read / master.read |

### 管理 API (いずれも認証必須)

| メソッド | パス | 必要な権限 | 備考 |
|---|---|---|---|
| GET | `/api/v1/admin/permissions` | `admin.permissions` または `admin.users` | カタログ・ロール一覧・現在のマトリクスを返す |
| PUT | `/api/v1/admin/role-permissions/:roleCode` | `admin.permissions` | body `{ permissions: string[] }` で置き換え。未知のキーは 422、存在しないロールは 404 |
| GET | `/api/v1/admin/users` | `admin.users` | ユーザー一覧と各自のロール割当を返す |
| PUT | `/api/v1/admin/users/:userId/roles` | `admin.users` | body `{ assignments: [{ roleCode, warehouseId }] }` で置き換え。未知のロール・存在しない倉庫は 422、存在しないユーザーは 404 |

マトリクスとロール付与の変更はすべて `audit_logs` に記録されます
(action は `role_permissions.update` / `user_roles.update`)。

**締め出し防止**: SYSTEM_ADMIN から `admin.permissions` を外す変更は 422
(`LOCKOUT_PREVENTION`) で拒否されます。権限管理権限を持つロールが消えると
誰もマトリクスを直せなくなるためです。それ以外の変更は自由に行えますが、
変更は即時反映されるため、付与漏れに注意してください。

### 管理画面

`/admin/permissions` に最小の管理画面があります (トップページからもリンク)。
`/login` と同じく localStorage の ID トークンで管理 API を呼びます。

- ロール × 権限のチェックボックスマトリクス (保存ボタンで全ロール分を PUT)
- ユーザー一覧と、ユーザーごとのロール割当の追加・削除・保存 (倉庫ID 空欄 = 全倉庫)

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
`0003_permissions.sql`（権限カタログと既定マトリクス）、`0004_sessions.sql`
（ログインセッション）、`0005_business_completion.sql` も含みます。0005 の内容:
権限 `movements.transfer` の seed（SYSTEM_ADMIN / INVENTORY_MANAGER / INVENTORY_STAFF)、
`stocktakes` の差異承認ステータス `pending_approval` と `decided_by` / `decided_at` 列
（テーブル再作成、既存データは引き継ぎ）、`lots.deleted_at` の追加。

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

最初の管理者が付けば、以降のロール付与と権限マトリクスの変更は管理画面
(`/admin/permissions`) または管理 API から行えます (「権限」の章を参照)。
権限マトリクスは `0003_permissions.sql` の適用が前提です。未適用でも既定
マトリクスで動作しますが、その場合は変更を保存できません。

## ローカル開発・テスト

```bash
npx wrangler d1 migrations apply inventory-system --local
npx wrangler dev
npm test          # vitest (@cloudflare/vitest-pool-workers): 純粋ロジック + D1 結合 + API 疎通
npm run typecheck
```

テストは 8 ファイル・56 件です。`test/coordinator.spec.ts` は実 D1 (miniflare) に
マイグレーションを適用し、Coordinator の RPC 経由で入庫→冪等リプレイ→消費→
在庫不足 409→マイナス承認消費→棚卸し 423 を通す結合テストです。
`test/business.spec.ts` は 0005 適用後の環境で、移動 (FEFO / lot 指定 / 409 / 403 /
423 / 冪等)、棚卸しの実数入力→差異承認→ADJUST 反映と差し戻し、マスタ CRUD、
CSV エクスポート / インポートを通す結合テストです。
`test/permissions.spec.ts` はテスト用 OIDC トークンで HTTP 経路を通し、
権限の付け外しによる可否の変化・締め出し防止・ロール付与 API を検証します。
`test/session.spec.ts` は /auth/callback (トークン交換は fetch 差し替えで模擬) の
セッション発行から、Cookie での API・WebSocket 認証、ログアウトでの無効化までを通します。
`test/access.spec.ts` は権限解決 (DB が正、空なら既定へフォールバック) の単体テストです。

> メモ: `@cloudflare/vitest-pool-workers` は `@cloudflare/vitest-plugin` へ改名が
> 予告されています（現行版で動作確認済み。移行は将来のメンテナンス時に）。
> また `compatibility_date` は同梱 workerd が受理できる上限 (2026-08-01) に
> 合わせています。定期的に引き上げてください。

## 未実装・Phase 2 送り

正直な一覧です。本版の Phase 1 では以下を意図的に省いています。

- マスタの取得 1 件 API と商品バーコード検索（編集・削除・CSV 入出力は実装済み）
- フロントエンドの本格的な作り込み（/app は実務に耐える最小構成。NestJS 版には画面なし）
- リアルタイム配信の再送保証（Outbox 相当）。切断中の変更は再接続時の REST 再同期で吸収する前提
- IdP の amr クレーム検証（Face ID / パスキー MFA の必須化チェック）
- アラートの materialize / 通知（現状は stocks からの導出のみ、上限 1000 件）
- 在庫一覧の本格的な検索（SKU 部分一致・期限ソート等）とページネーションの総件数返却
- CI、負荷テスト、D1 のバックアップ運用手順
