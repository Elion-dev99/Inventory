# 在庫管理システム — 実装雛形 (スキャフォールド)

社内向け在庫管理システムのバックエンド雛形です。要件定義 v0.2（確定版）と基本設計 v0.1 に基づきます。

- 前提文書: `~/workspace/goals/web/files/web-requirements-v02/` / `~/workspace/goals/web/files/web-basic-design-v01/`
- スタック: TypeScript / NestJS + PostgreSQL + Redis（フロントエンドは TypeScript 想定で、本雛形はバックエンドに集中）
- 規模前提: 拠点6以上 / 同時利用者100名以上 / 5万SKU以上。アプリはステートレスな複数インスタンス前提

## セットアップ

```bash
# 1. 依存関係
npm install
npx prisma generate

# 2. PostgreSQL / Redis
docker compose up -d

# 3. 環境変数
cp .env.example .env   # 値はローカル用。認証情報はコミットしない

# 4. DB スキーマと初期データ (ロール5種)
npx prisma migrate dev
npm run prisma:seed

# 5. 起動
npm run start:dev       # http://localhost:3000/api/v1/health

# 検証
npm run build
npm test
```

> トラブルシュート: 環境によっては `@prisma/engines` のバイナリ取得 (postinstall / generate) が
> ネットワーク要因で失敗することがあります。その場合はミラーを指定してください
> (この開発環境では実際に必要でした):
> `PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma npx prisma generate`
> また postinstall が落ちる環境では `npm install --ignore-scripts` で導入し、上記 generate を別途実行します。

## 設計との対応

| 設計 (基本設計 v0.1) | 実装 |
|---|---|
| モジュラーモノリス (1章) | `src/app.module.ts` に12モジュール相当を集約: auth / users / master / inventory / movements / stocktakes / alerts / audit / realtime / common / prisma / config |
| ER (3章) | `prisma/schema.prisma`。stocks は (location_id, lot_id) 一意 = SKU×保管場所×ロット、`reserved` 列なし、`version` 列あり |
| 倉庫スコープ | 独立テーブルにせず `user_roles.warehouse_id`（NULL = 全倉庫）で実現 (設計判断どおり) |
| 権限 (6章) | `src/users/access-control.service.ts` (RBAC + スコープ判定、単体テストあり) |
| 認証 (Q5) | `src/auth/oidc-auth.guard.ts`。OIDC の JWKS 検証のみ。**独自パスワード認証は作らない**。多要素 (Face ID / パスキー) は IdP 側で担保 |
| FEFO 消費 (5章) | 純粋ロジック `src/inventory/fefo.ts` (テストあり) + `MovementsService.consume` が DB へ適用 |
| トランザクション (要件6章) | 消費は条件付き UPDATE (`quantity >= :q AND version = :v`) + 楽観的ロック、行ロックは id 昇順、残高+台帳+Outbox を同一 Tx |
| 棚卸し全面停止 (Q3) | `StocktakesService.isLocked` + `src/common/guards/stocktake.guard.ts` (更新系を 423 で返す) |
| マイナス在庫の条件付き許可 (Q1) | `negative_stock_approvals` テーブルを用意。自己承認禁止はアプリ層で検証し、DB CHECK でも担保可能 (下記) |
| 冪等性 | `src/common/idempotency/` (サービス + インターセプタ雛形) |
| リアルタイム (7章) | `src/realtime/` WebSocket Gateway + Redis Pub/Sub。配信は差分通知のみ、正本は DB |
| 引当 (Q2) | MVP 範囲外のため、予約 API・`reserved` は実装しない |

## DB 制約の注意 (マイグレーションで追加すること)

Prisma スキーマで表現できない制約は、初回マイグレーションに手書き SQL で追加してください。

- `stocks`: `CHECK (quantity >= 0)` — ただし条件付きマイナス在庫を許す運用では、承認フローと連動する形に読み替えること (schema.prisma のコメント参照)
- `stocktakes`: `CREATE UNIQUE INDEX ... ON stocktakes (status) WHERE status = 'in_progress'` (同時実施1件)
- `negative_stock_approvals`: `CHECK (approved_by IS NULL OR approved_by <> requested_by)` (自己承認禁止)
- 列挙値の CHECK (`stock_movements.type` など)

## 未実装事項 (雛形の範囲外)

- **認証の完全実装**: クレーム→users 同期の呼び出し、ロール検証ガードの各エンドポイント適用、amr クレームによる多要素確認、IdP 製品の確定 (未確定事項)
- **冪等性インターセプタの適用**: 各更新系ルートへの適用、失敗時のキー解放、レスポンス保存の確定
- **Outbox ワーカー**: `outbox_events` を読んで Redis へ publish するポーリングワーカー (現状はイベントを書くところまで)
- **WebSocket の認可**: 接続時のトークン検証と倉庫別チャネル購読
- **マイナス在庫フロー**: 申請・承認・確定 API (テーブルと方針のみ)
- **棚卸し**: 実績入力 API、差異承認フロー、確定時のロール検証
- **移動**: 移動先が別倉庫の場合のスコープ検証
- **アラート**: 集計の最適化と定期バッチ化 (現状は導出のみ)
- **フロントエンド**: 未着手 (TypeScript SPA 想定)
- **テスト**: FEFO と権限判定の単体テストのみ。競合・冪等性・整合性の必須テスト (要件9章) は未実装
- **運用**: CI、監視、バックアップ、負荷テストは未整備。運用環境 (クラウド等) は未確定

## ディレクトリ

```
src/
  auth/        OIDC ガード、CurrentUser
  users/       ユーザー同期、RBAC + 倉庫スコープ判定
  master/      商品・倉庫・保管場所マスタ
  inventory/   在庫照会、FEFO 純粋ロジック
  movements/   入庫・消費・移動
  stocktakes/  棚卸し (全面停止の本体)
  alerts/      低在庫・期限アラート
  audit/       監査ログ
  realtime/    WebSocket Gateway、Redis Pub/Sub
  common/      例外 (409/423)、棚卸しガード、冪等性
  prisma/      PrismaService
prisma/
  schema.prisma
  seed.ts      ロール5種の投入
```
