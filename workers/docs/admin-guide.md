# 管理者ガイド — 在庫管理システム (Workers + D1 版)

システム管理者向けの運用手順です。日常業務の手順は
[利用者マニュアル](user-manual.md)、デプロイ手順と API 仕様は
[README](../README.md) を参照してください。

## 管理の全体像

- ロールと権限は D1 のデータが正です。変更は再デプロイなしで即時反映されます。
- 管理操作は主に 2 か所から行います。
  - 画面: `/admin/permissions`（権限マトリクスとユーザーのロール付与）
  - 画面: `/app` の「監査ログ」ビュー（監査ログ閲覧とデータエクスポート）
- 管理操作には権限が要ります: ユーザー管理・監査・エクスポートは
  `admin.users`、権限マトリクスの変更は `admin.permissions` です。
- 変更はすべて監査ログに記録されます（後述）。

## ユーザーとロール付与

### ユーザーが作られるタイミング

ユーザーは、Google ログインが成功するか、認証付き API に初めてアクセス
したときに `users` へ自動で作成（同期）されます。**ロールの割当は自動では
付きません**。割当が 1 件も無いユーザーは業務 API がすべて 403 になります。

### ロール付与の手順

1. 対象の人に一度ログインしてもらいます（`users` に行ができる）。
2. `/admin/permissions` の「ユーザーとロール付与」で、対象ユーザーを選びます。
3. ロールと倉庫スコープを指定して割当を追加し、「このユーザーを保存」を
   押します。倉庫ID を空欄にすると全倉庫が対象になります。
4. 割当を外す場合は「削除」してから保存します。

API では `GET /api/v1/admin/users`（一覧と割当）と
`PUT /api/v1/admin/users/:userId/roles`（割当の置き換え）でも行えます。

### ロールと倉庫スコープの考え方

- ロールは「権限の束」です（次節）。ユーザーは複数の割当を持てます
  （例: 本社倉庫は INVENTORY_STAFF、第二倉庫は VIEWER）。
- 倉庫スコープ（`user_roles.warehouse_id`）は、その割当が届く倉庫を絞ります。
  NULL は全倉庫です。スコープ外の倉庫の在庫は一覧に出ず、詳細は 404 に
  なります（存在自体を漏らしません）。

### 最初の管理者がいない場合（復旧）

管理 API を使える人が誰もいなくなった場合は、D1 へ直接割当を入れる
方法だけが残ります。手順は README の「最初のユーザーにロールを
割り当てる」を参照してください（`wrangler d1 execute --remote`）。

## 権限マトリクスの変更

### 変更手順

1. `/admin/permissions` を開きます（`admin.permissions` が必要）。
2. ロール × 権限のチェックボックスを変更し、「マトリクスを保存」を押します
   （全ロール分が順に保存されます）。
3. 変更は即時反映されます。対象ユーザーの次回リクエストから新しい権限で
   判定されます（再ログインは不要です）。

API では `GET /api/v1/admin/permissions`（カタログと現在のマトリクス）と
`PUT /api/v1/admin/role-permissions/:roleCode`（body `{ permissions: [...] }`
で置き換え）でも行えます。

### 注意点

- **締め出し防止**: SYSTEM_ADMIN から `admin.permissions` を外す変更は
  422 (`LOCKOUT_PREVENTION`) で拒否されます。権限管理できる人がいなくなる
  変更だけは仕組みとして防いでいます。それ以外の変更は自由ですが、
  付与漏れも即時反映されるため、業務時間中の変更は慎重に行ってください。
- 既定のマトリクスは `migrations/0003_permissions.sql`（+ 0005 の
  `movements.transfer`）で投入されます。`role_permissions` が空の環境では
  コード側の既定値にフォールバックしますが、その場合は画面から保存
  できません（マイグレーション適用が前提です）。
- 権限キー 12 種の一覧と既定マトリクスは README の「権限」の節が正本です。

## 監査ログ

### 記録される操作

在庫の変更と管理操作は `audit_logs` に記録されます。主な action:

| action | 内容 |
|---|---|
| `stock.inbound` / `stock.consume` / `stock.transfer` | 入庫 / 消費 / 移動（伝票 ID などの payload つき） |
| `stocktake.start` / `stocktake.finish` / `stocktake.decide` | 棚卸しの開始 / 終了 / 差異承認・差し戻し |
| `negative_approval.approved` / `negative_approval.rejected` | マイナス在庫申請の承認 / 却下 |
| `role_permissions.update` | 権限マトリクスの変更（対象ロールと新しい権限集合） |
| `user_roles.update` | ユーザーのロール付与の変更（対象ユーザーと新しい割当） |

### 閲覧

- 画面: `/app` の「監査ログ」ビュー（`admin.users` がある場合のみ表示）。
  実行者（ユーザーID）、アクション、期間で絞り込み、ページングできます。
- API: `GET /api/v1/admin/audit-logs`（`admin.users`）。
  クエリは `actor`（ユーザーID）、`action`（完全一致）、`from` / `to`
  （created_at のミリ秒範囲）、`limit`（既定 50、最大 200）/ `offset`。
  応答は `{ items, total, limit, offset }` で、新しい順です。各 item の
  `payload` は JSON として解釈された値が返ります。

## データエクスポート

### 画面から

`/app` の「監査ログ」ビューにある「データをエクスポート (JSON)」ボタンで、
主要テーブルの全データを 1 つの JSON ファイルとしてダウンロードできます
（`admin.users` が必要）。障害調査や移行の材料に使えます。

### API

`GET /api/v1/admin/export.json`（`admin.users`）。
応答は `{ exportedAt, tables: { テーブル名: [行...] } }` です。

### 対象と除外

対象は 15 テーブルです: users / roles / user_roles / warehouses / locations /
products / lots / stocks / stock_movements / stocktakes / stocktake_lines /
negative_stock_approvals / audit_logs / permissions / role_permissions。

次は含めません。

| テーブル | 含めない理由 |
|---|---|
| `sessions` | ログインセッションのトークンハッシュ。認証情報であり、業務データの復旧にも不要（復旧後は再ログインで足りる） |
| `idempotency_keys` | 冪等リプレイ用の配送状態。過去のリクエストへの応答を保持するだけで、業務データそのものではない |
| `write_guards` | batch 原子性を担保するための内部の一時状態。通常は空で、復旧対象ではない |

## バックアップと復旧

### バックアップ（D1 の丸ごとエクスポート）

DB 全体のバックアップは wrangler の SQL エクスポートを使います
（`workers/` で実行。認証は `wrangler login` 済みのもの）。

```bash
npx wrangler d1 export inventory-system --remote --output=backup-YYYYMMDD.sql
```

- 推奨頻度: **週に 1 回**を目安にし、棚卸しの前・権限やマスタの大きな
  変更の前にも取得してください。日次の在庫更新が数千件規模に近づいたら
  頻度の見直しを検討してください。
- 保管先の例: 社内の共有ストレージやオブジェクトストレージに、日付つき
  ファイル名で世代を残す（最低でも直近 4 世代）。エクスポートには個人
  情報（メールアドレス等）が含まれるため、アクセス権の管理された場所に
  置いてください。
- 上記の `export.json` は参照・調査用の簡易エクスポートで、スキーマを
  含まないため、復旧の正本は SQL エクスポートです。

自動バックアップの仕組みは実装していません。定期実行は、運用担当の
カレンダー登録や、別途 cron 環境（Cloudflare Cron Triggers 等）での
自動化を検討してください。

### 復旧の考え方

1. 障害の種類を切り分けます。アプリ側だけの問題なら再デプロイ、データの
   問題なら DB 復旧を検討します。
2. DB を戻す場合は、新しい D1 データベースを作成し、バックアップ SQL を
   流し込みます。

   ```bash
   npx wrangler d1 create inventory-system-restored
   npx wrangler d1 execute inventory-system-restored --remote --file=backup-YYYYMMDD.sql
   ```

3. `wrangler.jsonc` の `database_id` を新しい DB に差し替えて
   `npx wrangler deploy` します（既存 DB への上書き import は、失敗時の
   切り戻しができないため推奨しません）。
4. 復旧後は全員に再ログインしてもらいます（セッションは引き継がれません）。
   バックアップ取得時点より後の変更は失われる前提で、棚卸しや入出庫の
   実績と突き合わせてから運用を再開してください。

## 無料枠の監視と有料移行の判断

### 無料枠の上限（Workers Free）

| 項目 | 上限 |
|---|---|
| Workers リクエスト | 100,000 / 日 |
| D1 読み取り | 5,000,000 行 / 日 |
| D1 書き込み | 100,000 行 / 日 |
| D1 保存容量 | 合計 5 GB |

1 回の在庫更新で台帳・監査・冪等記録まで含めて十数行を書くため、
書き込み枠から見た実用上限は 1 日あたり数千件程度の在庫更新です。

### 見る場所

Cloudflare ダッシュボードで次を確認します。

- Workers & Pages → 対象 Worker（inventory-system-workers）→ Metrics:
  リクエスト数とエラー率。
- 同じ画面の Observability / Logs: エラーの内容（有効化済み）。
- Workers & Pages → D1 → 対象 DB（inventory-system）: 読み取り・書き込み
  行数と保存容量の推移。

書き込み行数が上限に対して恒常的に高くなってきたら、頻繁にアラートや
履歴を参照する使い方を見直すか、有料化を検討してください。

### 有料移行の判断

次のいずれかに当てはまったら移行を検討します。

- 書き込み・リクエストが無料枠の上限に恒常的に近づく。
- 拠点数・SKU 数・同時利用者数が増え、D1 の単一 DB 前提が窮屈になる。
- バックアップの自動化や監査の長期保存など、無料枠の範囲を超える
  運用要件が出てくる。

移行先の候補として、リポジトリには NestJS + PostgreSQL + Redis 版
（有料・大規模版）が残してあります。Workers Paid ($5/月〜) + Cloudflare
Containers + 外部マネージド DB/Redis への移行パスは README と
`cloudflare/` のドキュメントを参照してください。業務要件（権限・FEFO・
マイナス承認・棚卸し全面停止）は両版で同一に設計されています。

## 初期データ投入

- 商品・倉庫・保管場所・ロットは `/app` の「マスタ管理」から登録します
  （`master.write` が必要）。編集は各行の「編集」ボタンからフォームで
  行います。削除は論理削除です。
- 商品の一括登録は「マスタ管理」の CSV インポートが使えます
  （ヘッダ `sku,name,unit,requires_expiry`、既存 SKU はスキップ）。
- 最初の管理者の付与だけは D1 への直接操作が必要です（README の
  「最初のユーザーにロールを割り当てる」参照）。以降は画面で完結します。

## IdP (Google ログイン) の設定場所

- Google Cloud 側: OAuth クライアント（プロジェクト `inventory-512517`）。
  承認済みリダイレクト URI は `/auth/callback`、JavaScript 生成元は
  Worker のオリジンです。
- Worker 側: `wrangler.jsonc` の vars に `OIDC_ISSUER_URL`
  （`https://accounts.google.com`）、`OIDC_JWKS_URL`
  （`https://www.googleapis.com/oauth2/v3/certs`）、`OIDC_AUDIENCE` /
  `OIDC_CLIENT_ID`（OAuth クライアント ID）があります。
- クライアントシークレットは Worker の Secret `GOOGLE_CLIENT_SECRET`
  として登録します（認可コードの交換でのみ使用）。コードやドキュメントに
  値そのものを書かないでください。
- IdP を変更する場合は、発行者 URL・JWKS・audience を新しい IdP の値に
  差し替えます。ユーザーは `users.external_id`（sub）で識別されるため、
  IdP を替えると別ユーザーとして扱われる点に注意してください。

## トラブルシュート（管理者向け）

| 症状 | 確認すること |
|---|---|
| 全員が 401 になる | `OIDC_ISSUER_URL` の設定と IdP 側の状態。未設定だと health 以外すべて 401 になる仕様です |
| 特定ユーザーだけ 403 | `user_roles` の割当があるか、対象操作の権限がそのロールのマトリクスに入っているか、倉庫スコープが対象倉庫に届いているか |
| 権限を変更したのに反映されない | 画面の保存が成功したか（エラー表示の確認）。`role_permissions` が空の環境では保存自体ができないため、マイグレーション 0003 の適用を確認してください |
| 在庫更新がすべて 423 | 棚卸しが実施中、または差異承認待ちで止まっています。棚卸しを終了（必要なら差異承認）してください |
| ログイン直後に 401 に戻る | セッションの期限切れ（8 時間）、または `sessions`（0004）が未適用の可能性。マイグレーション適用状況を確認してください |
