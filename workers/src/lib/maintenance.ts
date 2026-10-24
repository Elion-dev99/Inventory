/**
 * メンテナンスモード (全体管理の platform_settings)。
 *
 * 全体管理 Worker が platform_settings(key='maintenance') に
 * {"on":bool,"message":string} の JSON を保存し、店舗アプリはそれを読んで
 * 書き込み系 API を 503 で止める。読み取りは平常どおり許可し、/app には
 * 告知バナーを出す (src/index.ts の /api/v1/me が状態を返す)。
 *
 * platform_settings テーブルが無い DB (migration 0010 未適用) では
 * 常に OFF として扱い、既存動作を壊さない。
 * 参照頻度が高いためモジュール内に 30 秒キャッシュする
 * (全体管理側の変更は最大 30 秒遅れて反映される)。
 */

export interface MaintenanceState {
  on: boolean;
  /** 管理者が設定した告知文。未設定なら null (表示側が既定文言を使う) */
  message: string | null;
}

export const MAINTENANCE_SETTING_KEY = 'maintenance';
export const DEFAULT_MAINTENANCE_MESSAGE =
  'メンテナンス中です。しばらくしてから再度お試しください。';
const CACHE_TTL_MS = 30_000;

let cache: { at: number; state: MaintenanceState } | null = null;

/** テスト用: キャッシュを破棄して次回読み直させる */
export function clearMaintenanceCache(): void {
  cache = null;
}

export async function getMaintenance(db: D1Database): Promise<MaintenanceState> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.state;
  let state: MaintenanceState = { on: false, message: null };
  try {
    const row = await db
      .prepare('SELECT value FROM platform_settings WHERE key = ?1')
      .bind(MAINTENANCE_SETTING_KEY)
      .first<{ value: string | null }>();
    if (row?.value) {
      const parsed = JSON.parse(row.value) as { on?: unknown; message?: unknown };
      state = {
        on: parsed.on === true,
        message:
          typeof parsed.message === 'string' && parsed.message.length > 0
            ? parsed.message
            : null,
      };
    }
  } catch {
    // テーブル未作成・値が壊れている場合は OFF として扱う
    state = { on: false, message: null };
  }
  cache = { at: now, state };
  return state;
}

/** 表示・エラー応答に使う実効メッセージ (カスタム文が無ければ既定文言) */
export function maintenanceMessage(state: MaintenanceState): string {
  return state.message ?? DEFAULT_MAINTENANCE_MESSAGE;
}
