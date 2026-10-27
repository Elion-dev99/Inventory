/**
 * Web Push 送信 (外部ライブラリなし、WebCrypto のみで実装)。
 *
 * - VAPID (RFC 8292): ES256 JWT を秘密鍵 JWK で署名し、
 *   Authorization: vapid t=<jwt>, k=<公開鍵> を付ける。
 * - ペイロード暗号化 (RFC 8291 + RFC 8188 aes128gcm):
 *   ECDH (P-256 一時鍵) で共有秘密を作り、auth secret を salt とした
 *   HKDF で IKM を導出、レコード salt で CEK / nonce を導出して AES-128-GCM 暗号化。
 *
 * VAPID の env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY_JWK / VAPID_SUBJECT) が
 * 未設定なら送信はスキップする (お知らせ自体は通常どおり動く)。
 * 送信失敗で呼び出し側のリクエストを落とすことはしない。
 */

import {
  isLiveAnnouncement,
  targetUserIds,
  type AnnouncementRow,
} from './announcements';

export interface PushEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY_JWK?: string;
  VAPID_SUBJECT?: string;
}

export interface PushSubscriptionRow {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

// ---------------------------------------------------------------- base64url

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const textEncoder = new TextEncoder();
const ascii = (s: string): Uint8Array => textEncoder.encode(s);

// ---------------------------------------------------------------- HKDF (RFC 5869)

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data as BufferSource));
  // 型定義側の ArrayBuffer 表記の差異を避けるため、ArrayBuffer 裏付けの配列へコピーして返す
  const out = new Uint8Array(sig.length);
  out.set(sig);
  return out;
}

/** HKDF-Expand のみ (Extract は呼び出し側で hmacSha256 を使う) */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let prev: Uint8Array = new Uint8Array(0);
  let produced = 0;
  for (let counter = 1; produced < length; counter++) {
    prev = await hmacSha256(prk, concatBytes(prev, info, new Uint8Array([counter])));
    const take = Math.min(prev.length, length - produced);
    out.set(prev.subarray(0, take), produced);
    produced += take;
  }
  return out;
}

// ---------------------------------------------------------------- VAPID

export interface VapidKeys {
  privateKey: CryptoKey;
  /** raw 形式 (0x04 || X || Y、65 バイト) の公開鍵 */
  publicKeyBytes: Uint8Array;
}

/**
 * env から VAPID 鍵を読む。未設定・不正な場合は null (送信スキップ)。
 * 公開鍵は秘密鍵 JWK の x/y から組み立てるため、署名鍵と必ず一致する。
 */
export async function loadVapidKeys(env: PushEnv): Promise<VapidKeys | null> {
  const raw = env.VAPID_PRIVATE_KEY_JWK;
  if (!raw) return null;
  try {
    const jwk = JSON.parse(raw) as JsonWebKey;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y || !jwk.d) return null;
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const publicKeyBytes = concatBytes(
      new Uint8Array([0x04]),
      base64UrlDecode(jwk.x),
      base64UrlDecode(jwk.y),
    );
    return { privateKey, publicKeyBytes };
  } catch {
    return null;
  }
}

/** VAPID JWT (ES256)。exp は 12 時間以内 (RFC 8292 の上限) */
export async function createVapidJwt(
  keys: VapidKeys,
  audience: string,
  subject: string,
  now: number = Date.now(),
): Promise<string> {
  const header = base64UrlEncode(ascii(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = base64UrlEncode(
    ascii(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: subject,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.privateKey,
      ascii(signingInput) as BufferSource,
    ),
  );
  // WebCrypto の ECDSA 署名は IEEE P1363 (r || s) 形式で、JWS の要求と一致する
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

// ---------------------------------------------------------------- ペイロード暗号化 (RFC 8291)

/**
 * 購読者の公開鍵 (p256dh) と auth secret でペイロードを aes128gcm 暗号化する。
 * 戻り値はそのまま Push サービスへ送る本文 (salt | rs | keyid 長 | 一時公開鍵 | 暗号文)。
 */
export async function encryptPushPayload(
  recipientPublicKeyB64: string,
  authSecretB64: string,
  plaintext: string,
): Promise<Uint8Array> {
  const uaPublic = base64UrlDecode(recipientPublicKeyB64);
  const authSecret = base64UrlDecode(authSecretB64);

  const ephemeral = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', ephemeral.publicKey)) as ArrayBuffer,
  );
  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // workers-types では $public と表記されるが、実行時 (標準 WebCrypto) は public
      { name: 'ECDH', public: uaKey } as never,
      ephemeral.privateKey,
      256,
    ),
  );

  // RFC 8291 §3.3: auth secret を salt に IKM を導出する
  const keyInfo = concatBytes(ascii('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const prkKey = await hmacSha256(authSecret, ecdhSecret);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // RFC 8188: レコード salt から CEK と nonce を導出する
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand(
    prk,
    concatBytes(ascii('Content-Encoding: aes128gcm'), new Uint8Array([0])),
    16,
  );
  const nonce = await hkdfExpand(
    prk,
    concatBytes(ascii('Content-Encoding: nonce'), new Uint8Array([0])),
    12,
  );

  const cekKey = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ]);
  // 単一レコード前提: 末尾に区切りバイト 0x02 を付ける
  const data = concatBytes(textEncoder.encode(plaintext), new Uint8Array([0x02]));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, cekKey, data as BufferSource),
  );

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concatBytes(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// ---------------------------------------------------------------- 送信

export interface PushRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** 1 購読分のリクエストを組み立てる。VAPID 未設定なら null */
export async function buildPushRequest(
  env: PushEnv,
  subscription: Pick<PushSubscriptionRow, 'endpoint' | 'p256dh' | 'auth'>,
  payloadJson: string,
  now: number = Date.now(),
): Promise<PushRequest | null> {
  const keys = await loadVapidKeys(env);
  if (!keys) return null;
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await createVapidJwt(
    keys,
    audience,
    env.VAPID_SUBJECT || 'mailto:admin@example.com',
    now,
  );
  const body = await encryptPushPayload(subscription.p256dh, subscription.auth, payloadJson);
  return {
    url: subscription.endpoint,
    headers: {
      Authorization: `vapid t=${jwt}, k=${base64UrlEncode(keys.publicKeyBytes)}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
    },
    body,
  };
}

export type PushSendResult = 'sent' | 'gone' | 'failed' | 'skipped';

/**
 * 1 購読へ送信する。Push サービスが 404/410 を返したら購読を削除する。
 * 失敗は握りつぶして結果だけ返す (呼び出し側を落とさない)。
 */
export async function sendPushToSubscription(
  db: D1Database,
  env: PushEnv,
  subscription: PushSubscriptionRow,
  payloadJson: string,
): Promise<PushSendResult> {
  try {
    const request = await buildPushRequest(env, subscription, payloadJson);
    if (!request) return 'skipped';
    const res = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body as BodyInit,
    });
    if (res.status === 404 || res.status === 410) {
      await db
        .prepare('DELETE FROM push_subscriptions WHERE id = ?1')
        .bind(subscription.id)
        .run();
      return 'gone';
    }
    if (res.status >= 200 && res.status < 300) return 'sent';
    console.error(`push send failed: endpoint=${request.url} status=${res.status}`);
    return 'failed';
  } catch (err) {
    console.error('push send error', err);
    return 'failed';
  }
}

/** 指定ユーザー全員の全購読へ送信し、成功件数を返す */
export async function sendPushToUsers(
  db: D1Database,
  env: PushEnv,
  userIds: readonly number[],
  payload: Record<string, unknown>,
): Promise<number> {
  if (userIds.length === 0) return 0;
  const placeholders = userIds.map((_, i) => `?${i + 1}`).join(', ');
  const rows = await db
    .prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${placeholders}) ORDER BY id`)
    .bind(...userIds)
    .all<PushSubscriptionRow>();
  const payloadJson = JSON.stringify(payload);
  let sent = 0;
  for (const sub of rows.results) {
    if ((await sendPushToSubscription(db, env, sub, payloadJson)) === 'sent') sent++;
  }
  return sent;
}

/** お知らせの対象ユーザー (全店舗宛 or 店舗所属) の購読へ送信する */
export async function sendPushForAnnouncement(
  db: D1Database,
  env: PushEnv,
  announcement: AnnouncementRow,
): Promise<number> {
  const userIds = await targetUserIds(db, announcement.store_id);
  return sendPushToUsers(db, env, userIds, {
    // 通知の構造: 種別をタイトルの先頭に出す (重要は 【重要】、通常は 【お知らせ】)
    title: (announcement.priority === 'important' ? '【重要】' : '【お知らせ】') + announcement.title,
    body: announcement.body.slice(0, 300),
    url: '/app',
    announcementId: announcement.id,
    important: announcement.priority === 'important',
  });
}

/**
 * 作成・更新直後の即時送信。push=1・掲載中・未送信のときだけ送り、
 * 処理済みとして push_sent_at を記録する。VAPID 未設定なら何もしない
 * (鍵が設定された後の scheduled 実行で拾えるよう、記録もしない)。
 */
export async function maybeSendAnnouncementPush(
  db: D1Database,
  env: PushEnv,
  announcement: AnnouncementRow,
  now: number = Date.now(),
): Promise<boolean> {
  if (announcement.push !== 1 || announcement.push_sent_at !== null) return false;
  if (!isLiveAnnouncement(announcement, now)) return false;
  if ((await loadVapidKeys(env)) === null) return false;
  await sendPushForAnnouncement(db, env, announcement);
  await db
    .prepare('UPDATE announcements SET push_sent_at = ?1 WHERE id = ?2 AND push_sent_at IS NULL')
    .bind(now, announcement.id)
    .run();
  return true;
}

/**
 * scheduled (Cron) ハンドラの本体: 掲載開始済みで未送信の push=1 を送る。
 * テストからはこの関数を直接呼ぶ。migration 未適用の環境では 0 を返す。
 */
export async function runScheduledAnnouncementPushes(
  db: D1Database,
  env: PushEnv,
  now: number = Date.now(),
): Promise<number> {
  if ((await loadVapidKeys(env)) === null) return 0;
  let rows: AnnouncementRow[];
  try {
    const res = await db
      .prepare(
        `SELECT * FROM announcements
          WHERE push = 1 AND push_sent_at IS NULL
            AND starts_at <= ?1 AND (ends_at IS NULL OR ends_at > ?1)
          ORDER BY starts_at ASC, id ASC LIMIT 50`,
      )
      .bind(now)
      .all<AnnouncementRow>();
    rows = res.results;
  } catch {
    return 0; // テーブル未作成 (migration 未適用) 環境では何もしない
  }
  let processed = 0;
  for (const row of rows) {
    await sendPushForAnnouncement(db, env, row);
    await db
      .prepare('UPDATE announcements SET push_sent_at = ?1 WHERE id = ?2 AND push_sent_at IS NULL')
      .bind(now, row.id)
      .run();
    processed++;
  }
  return processed;
}
