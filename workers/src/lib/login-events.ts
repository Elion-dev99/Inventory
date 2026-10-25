/**
 * ログイン履歴と新しい端末の通知 (migration 0017)。
 *
 * - Google / パスキーの全ログインを login_events に記録する。
 * - 端末の同一判定は「UA から正規化したラベル + IP」。初めて見る
 *   組み合わせなら、そのユーザーにプッシュ購読がある場合に Web Push で
 *   知らせる (送信は既存の lib/push.ts を再利用)。
 * - 記録・通知の失敗でログイン自体を止めることはしない (呼び出し側でも
 *   例外を握るが、この関数自体も失敗を返り値に倒す)。
 */

import { sendPushToUsers, type PushEnv } from './push';
import { deviceLabelFromUserAgent } from './webauthn';

export type LoginMethod = 'google' | 'passkey';

/** リクエストからクライアント IP を取る (Cloudflare の付与ヘッダ優先) */
export function clientIp(request: Request): string | null {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || null;
  return null;
}

export type LoginNotifyFn = (
  db: D1Database,
  env: PushEnv,
  userIds: readonly number[],
  payload: Record<string, unknown>,
) => Promise<number>;

export interface LoginEventResult {
  recorded: boolean;
  isNewDevice: boolean;
  deviceLabel: string;
}

/**
 * ログインを記録し、新しい端末なら本人へプッシュ通知する。
 * notify はテスト差し替え用 (既定は sendPushToUsers)。
 */
export async function recordLoginEvent(
  db: D1Database,
  env: PushEnv,
  input: { userId: number; method: LoginMethod; ip: string | null; userAgent: string | null },
  notify: LoginNotifyFn = sendPushToUsers,
): Promise<LoginEventResult> {
  const deviceLabel = deviceLabelFromUserAgent(input.userAgent);
  try {
    const prior = await db
      .prepare(
        `SELECT id FROM login_events
          WHERE user_id = ?1 AND device_label = ?2 AND (ip = ?3 OR (ip IS NULL AND ?3 IS NULL))
          LIMIT 1`,
      )
      .bind(input.userId, deviceLabel, input.ip)
      .first<{ id: number }>();
    const isNewDevice = prior === null;
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO login_events (user_id, method, ip, user_agent, device_label, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(input.userId, input.method, input.ip, input.userAgent, deviceLabel, now)
      .run();
    if (isNewDevice) {
      try {
        await notify(db, env, [input.userId], {
          title: 'ログイン通知',
          body: `新しい端末からログインがありました (${deviceLabel}、${new Date(now).toLocaleString('ja-JP')})`,
          url: '/app',
        });
      } catch (e) {
        console.error('new device push failed', e);
      }
    }
    return { recorded: true, isNewDevice, deviceLabel };
  } catch (e) {
    // login_events 未適用 (0017 前) の環境では記録を諦める
    console.error('recordLoginEvent failed', e);
    return { recorded: false, isNewDevice: false, deviceLabel };
  }
}
