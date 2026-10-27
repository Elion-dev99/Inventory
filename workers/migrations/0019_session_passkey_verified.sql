-- セッションに「パスキーで本人確認済みか」を持たせる (全体管理コンソールの
-- パスキー必須モード用)。Google ログインでは 0、パスキーログインと
-- パスキーによるステップアップで 1 になる。
ALTER TABLE sessions ADD COLUMN passkey_verified INTEGER NOT NULL DEFAULT 0;
