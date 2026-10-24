# 全体管理 Worker (inventory-admin-workers)

在庫管理システムの全体管理 (プラットフォーム管理) 専用 Worker。
店舗アプリ (`../workers/`, inventory-system-workers) から分離した別プロジェクトで、
店舗ではなくシステム全体 (全店舗) の管理だけを行う。

- 店舗の一覧・作成・停止/再開、店舗別統計
- ユーザー × 店舗の割当の横断編集
- 店舗ごとの機能フラグ

DB (D1 `inventory-system`) は店舗アプリと共有する。共有コード
(権限・割当・セッション・機能フラグ) は `../workers/src/lib/` を相対 import して使う。

## 店舗アプリとの分離方針

| 項目 | 店舗アプリ | 全体管理 (本 Worker) |
| --- | --- | --- |
| Worker 名 | inventory-system-workers | inventory-admin-workers |
| ログイン | 全ユーザー (Google 認可コードフロー) | **全体管理者だけ** (割当が無いユーザーはログイン自体を拒否) |
| セッション Cookie | `session` | `admin_session` |
| セッション scope (DB) | `app` | `platform` |
| セッション有効期限 | 8 時間 | 2 時間 |

スコープが違うセッションは互いに受け付けない。店舗アプリ側には全体管理の
画面 (`/platform`) も API (`/api/v1/platform/*`) も存在せず 404 になる。

## デプロイ手順 (本番)

1. **migration 0009 を本番 D1 に適用する** (店舗アプリ・本 Worker 共通の前提)
   - `../workers/migrations/0009_session_scope.sql` (sessions.scope の追加)
2. **Google Cloud で本 Worker のコールバック URI を許可する** (必須・未実施だとログイン不可)
   - Google Cloud プロジェクト `inventory-512517` の OAuth クライアント
     (店舗アプリと同じクライアント ID) の「承認済みリダイレクト URI」に
     `https://inventory-admin-workers.<workers.dev サブドメイン>/auth/callback`
     を追加する。あわせて「承認済み JavaScript オリジン」に
     `https://inventory-admin-workers.<workers.dev サブドメイン>` の追加も推奨。
3. **Secret を設定する**
   - `GOOGLE_CLIENT_SECRET`: 店舗アプリと同じ値 (認可コード交換用)
   - vars (OIDC_ISSUER_URL / OIDC_JWKS_URL / OIDC_AUDIENCE / OIDC_CLIENT_ID) は
     `wrangler.jsonc` に店舗アプリと同じ公開値を入れてある
4. デプロイする (`npm run deploy`、またはメイン担当のデプロイ経路)
5. 店舗アプリを再デプロイして `/platform` と `/api/v1/platform/*` を消す
   (順序は 2→3→4 の後に店舗アプリ側を更新すると、移行中も全体管理が使える)

## ローカル開発

```sh
npm ci
npm test        # vitest (cloudflare:test)。実 D1 に 0001〜0009 を適用して検証
npm run typecheck
npm run dev     # wrangler dev (ローカル D1 には別途 migration 適用が必要)
```

## 注意

- 本 Worker は在庫の書き込みをしないため Durable Objects (Coordinator) は使わない。
- 全体管理者 = `user_roles` に `SYSTEM_ADMIN` かつ `store_id IS NULL` の割当を
  持つユーザー。最後の全体管理者を消す割当変更は 422 (LOCKOUT_PREVENTION) で拒否する。
- 全体操作は `audit_logs` に記録する (対象店舗がある操作は store_id = 対象店舗、
  店舗横断の操作は store_id = NULL)。
