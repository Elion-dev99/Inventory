import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, jwtVerify, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import initSql from '../migrations/0001_init.sql?raw';
import seedSql from '../migrations/0002_seed_roles.sql?raw';
import permissionsSql from '../migrations/0003_permissions.sql?raw';
import sessionsSql from '../migrations/0004_sessions.sql?raw';
import businessSql from '../migrations/0005_business_completion.sql?raw';
import featuresSql from '../migrations/0006_feature_flags.sql?raw';
import purchasingSql from '../migrations/0007_purchasing_analytics.sql?raw';
import multiStoreSql from '../migrations/0008_multi_store.sql?raw';
import sessionScopeSql from '../migrations/0009_session_scope.sql?raw';
import platformSettingsSql from '../migrations/0010_platform_settings.sql?raw';
import maintenanceWindowsSql from '../migrations/0011_maintenance_windows.sql?raw';
import maintenanceExtrasSql from '../migrations/0012_maintenance_extras.sql?raw';
import announcementsSql from '../migrations/0013_announcements.sql?raw';
import { createSession } from '../src/lib/session';
import { base64UrlDecode, base64UrlEncode, runScheduledAnnouncementPushes } from '../src/lib/push';

/**
 * お知らせ + Web プッシュ通知の結合テスト (migration 0013)。
 *
 * ユーザー: 1 = 全体管理者、2 = 店舗1の在庫管理者 (announcements.write あり)、
 * 3 = 店舗1のスタッフ (write なし)、4 = 店舗2のスタッフ、5 = 店舗1の SYSTEM_ADMIN。
 * VAPID 鍵はテスト用に生成して env へ差し込み、Push サービスへの fetch は
 * 差し替えて暗号文を捕捉し、購読側の秘密鍵で復号して検証する。
 */

interface TestEnv {
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY_JWK?: string;
  VAPID_SUBJECT?: string;
}
const testEnv = env as unknown as TestEnv;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let cookiePlatform = '';
let cookieManager = '';
let cookieStaff = '';
let cookieStaff2 = '';
let cookieStoreAdmin = '';

let vapidPublicKey: KeyLike;
let vapidPublicKeyB64 = '';

interface CapturedPush {
  url: string;
  authorization: string;
  body: Uint8Array;
}
const capturedPushes: CapturedPush[] = [];

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  path: string,
  opts: { cookie?: string; method?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers.Cookie = `session=${opts.cookie}`;
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** D1 exec() はコメントのみの行を処理できないため、除いてから文単位で流す */
function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface AnnouncementItem {
  id: number;
  storeId: number | null;
  title: string;
  read?: boolean;
  readCount?: number;
  targetUsers?: number;
  pushSentAt: number | null;
}

function itemsOf(res: ApiResult): AnnouncementItem[] {
  return (res.body.items ?? []) as AnnouncementItem[];
}

async function insertAnnouncement(row: {
  storeId: number | null;
  title: string;
  startsAt: number;
  endsAt?: number | null;
  priority?: string;
  push?: number;
  pushSentAt?: number | null;
}): Promise<number> {
  const now = Date.now();
  const res = await testEnv.DB.prepare(
    `INSERT INTO announcements
       (store_id, title, body, priority, starts_at, ends_at, push, push_sent_at, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 2, ?9, ?9)`,
  )
    .bind(
      row.storeId,
      row.title,
      `${row.title}の本文`,
      row.priority ?? 'normal',
      row.startsAt,
      row.endsAt ?? null,
      row.push ?? 0,
      row.pushSentAt ?? null,
      now,
    )
    .run();
  return Number(res.meta.last_row_id);
}

// ---------------------------------------------------------- プッシュ検証用

interface Subscriber {
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
  p256dh: string;
  authBytes: Uint8Array;
  auth: string;
}

async function makeSubscriber(): Promise<Subscriber> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  const authBytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    privateKey: pair.privateKey,
    publicRaw,
    p256dh: base64UrlEncode(publicRaw),
    authBytes,
    auth: base64UrlEncode(authBytes),
  };
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * RFC 8291 の復号を WebCrypto の HKDF で独立に実装し、push.ts の暗号化と
 * 相互検証する (push.ts の内部関数は使わない)。
 */
async function decryptPushBody(body: Uint8Array, sub: Subscriber): Promise<string> {
  const salt = body.slice(0, 16);
  const idLen = body[20] as number;
  const senderPublic = body.slice(21, 21 + idLen);
  const cipher = body.slice(21 + idLen);
  const senderKey = await crypto.subtle.importKey(
    'raw',
    senderPublic as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: senderKey } as never,
    sub.privateKey,
    256,
  );
  const sharedKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const keyInfo = concatBytes(
    new TextEncoder().encode('WebPush: info'),
    new Uint8Array([0]),
    sub.publicRaw,
    senderPublic,
  );
  const ikm = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: sub.authBytes as BufferSource, info: keyInfo as BufferSource },
    sharedKey,
    256,
  );
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const cek = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: concatBytes(new TextEncoder().encode('Content-Encoding: aes128gcm'), new Uint8Array([0])) as BufferSource,
    },
    ikmKey,
    128,
  );
  const nonce = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: concatBytes(new TextEncoder().encode('Content-Encoding: nonce'), new Uint8Array([0])) as BufferSource,
    },
    ikmKey,
    96,
  );
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, cekKey, cipher as BufferSource),
  );
  // 末尾のパディング (0x00* + 区切り 0x02) を取り除く
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  expect(plain[end - 1]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, end - 1));
}

async function subscribeViaApi(cookie: string, endpoint: string, sub: Subscriber): Promise<void> {
  const res = await api('/api/v1/push/subscribe', {
    cookie,
    method: 'POST',
    body: { endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  // VAPID テスト鍵を生成し、env (バインディング) へ差し込む
  const pair = await generateKeyPair('ES256', { extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  const publicJwk = await exportJWK(pair.publicKey);
  vapidPublicKey = pair.publicKey;
  vapidPublicKeyB64 = base64UrlEncode(
    concatBytes(new Uint8Array([0x04]), base64UrlDecode(publicJwk.x!), base64UrlDecode(publicJwk.y!)),
  );
  testEnv.VAPID_PRIVATE_KEY_JWK = JSON.stringify(privateJwk);
  testEnv.VAPID_PUBLIC_KEY = vapidPublicKeyB64;
  testEnv.VAPID_SUBJECT = 'mailto:test@example.com';

  // Push サービスへの送信を捕捉する (gone は 410 を返して購読切れを模擬)
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('https://push.example.com/')) {
      const body =
        init?.body instanceof Uint8Array
          ? new Uint8Array(init.body)
          : new Uint8Array(await new Request(url, init).arrayBuffer());
      capturedPushes.push({
        url,
        authorization: new Headers(init?.headers).get('Authorization') ?? '',
        body,
      });
      if (url.includes('/gone')) return new Response('gone', { status: 410 });
      return new Response('', { status: 201 });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  for (const stmt of [
    ...statementsOf(initSql),
    ...statementsOf(seedSql),
    ...statementsOf(permissionsSql),
    ...statementsOf(sessionsSql),
    ...statementsOf(businessSql),
    ...statementsOf(featuresSql),
    ...statementsOf(purchasingSql),
    ...statementsOf(multiStoreSql),
    ...statementsOf(sessionScopeSql),
    ...statementsOf(platformSettingsSql),
    ...statementsOf(maintenanceWindowsSql),
    ...statementsOf(maintenanceExtrasSql),
    ...statementsOf(announcementsSql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-platform', 'platform@example.com', 'Platform', 'active', ?1, ?1),
              (2, 'sub-manager', 'manager@example.com', 'Manager', 'active', ?1, ?1),
              (3, 'sub-staff', 'staff@example.com', 'Staff', 'active', ?1, ?1),
              (4, 'sub-staff2', 'staff2@example.com', 'Staff2', 'active', ?1, ?1),
              (5, 'sub-sadmin', 'sadmin@example.com', 'StoreAdmin', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO stores (id, code, name, status, created_at, updated_at)
       VALUES (2, 'STORE-B', '店舗B', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, NULL),
              (2, 'INVENTORY_MANAGER', NULL, 1),
              (3, 'INVENTORY_STAFF', NULL, 1),
              (4, 'INVENTORY_STAFF', NULL, 2),
              (5, 'SYSTEM_ADMIN', NULL, 1)`,
    ),
  ]);

  cookiePlatform = await createSession(testEnv.DB, 1);
  cookieManager = await createSession(testEnv.DB, 2);
  cookieStaff = await createSession(testEnv.DB, 3);
  cookieStaff2 = await createSession(testEnv.DB, 4);
  cookieStoreAdmin = await createSession(testEnv.DB, 5);
  // 全体管理者は店舗 1 を選択しておく (店舗アプリ API は現在店舗が要る)
  const sel = await api('/api/v1/session/store', {
    cookie: cookiePlatform,
    method: 'POST',
    body: { storeId: 1 },
  });
  expect(sel.status).toBe(200);
});

describe('お知らせの閲覧 (期間・対象店舗フィルタと既読)', () => {
  let idStore1 = 0;
  let idAll = 0;
  let idStore2 = 0;

  beforeAll(async () => {
    const now = Date.now();
    idStore1 = await insertAnnouncement({ storeId: 1, title: '店舗1のお知らせ', startsAt: now - 2 * HOUR });
    idAll = await insertAnnouncement({
      storeId: null,
      title: '全店舗のお知らせ',
      startsAt: now - HOUR,
      priority: 'important',
    });
    idStore2 = await insertAnnouncement({ storeId: 2, title: '店舗2のお知らせ', startsAt: now - HOUR });
    await insertAnnouncement({ storeId: 1, title: '未来のお知らせ', startsAt: now + DAY });
    await insertAnnouncement({ storeId: 1, title: '終了したお知らせ', startsAt: now - 2 * DAY, endsAt: now - HOUR });
  });

  it('現在の店舗で見える掲載中だけが新しい順に返り、未読数が付く', async () => {
    const res = await api('/api/v1/announcements', { cookie: cookieStaff });
    expect(res.status).toBe(200);
    const items = itemsOf(res);
    expect(items.map((i) => i.id)).toEqual([idAll, idStore1]);
    expect(items.every((i) => i.read === false)).toBe(true);
    expect(res.body.unreadCount).toBe(2);

    const res2 = await api('/api/v1/announcements', { cookie: cookieStaff2 });
    // 開始時刻が同じ場合は id の新しい順 (後に作られたものが先)
    expect(itemsOf(res2).map((i) => i.id)).toEqual([idStore2, idAll]);
    expect(res2.body.unreadCount).toBe(2);
  });

  it('詳細は見えるものだけ返し、他店舗・期間外は 404', async () => {
    const ok = await api(`/api/v1/announcements/${idAll}`, { cookie: cookieStaff });
    expect(ok.status).toBe(200);
    expect(ok.body.title).toBe('全店舗のお知らせ');
    expect(ok.body.priority).toBe('important');

    const other = await api(`/api/v1/announcements/${idStore2}`, { cookie: cookieStaff });
    expect(other.status).toBe(404);
  });

  it('既読化は冪等で、未読数は自分だけ減る', async () => {
    const read = await api(`/api/v1/announcements/${idStore1}/read`, {
      cookie: cookieStaff,
      method: 'POST',
    });
    expect(read.status).toBe(200);
    expect(read.body.unreadCount).toBe(1);

    const again = await api(`/api/v1/announcements/${idStore1}/read`, {
      cookie: cookieStaff,
      method: 'POST',
    });
    expect(again.body.unreadCount).toBe(1);

    const list = await api('/api/v1/announcements', { cookie: cookieStaff });
    const target = itemsOf(list).find((i) => i.id === idStore1);
    expect(target?.read).toBe(true);

    // 他ユーザー (管理者) の未読数は影響を受けない
    const managerList = await api('/api/v1/announcements', { cookie: cookieManager });
    expect(managerList.body.unreadCount).toBe(2);

    // 見えないお知らせの既読化は 404
    const denied = await api(`/api/v1/announcements/${idStore2}/read`, {
      cookie: cookieStaff,
      method: 'POST',
    });
    expect(denied.status).toBe(404);
  });
});

describe('お知らせの投稿管理 (権限・対象範囲・既読集計)', () => {
  let createdId = 0;

  it('announcements.write が無いユーザーは投稿・管理一覧とも 403', async () => {
    const post = await api('/api/v1/admin/announcements', {
      cookie: cookieStaff,
      method: 'POST',
      body: { title: '権限なし', body: '本文' },
    });
    expect(post.status).toBe(403);
    const list = await api('/api/v1/admin/announcements', { cookie: cookieStaff });
    expect(list.status).toBe(403);
  });

  it('管理者は自店舗宛を投稿でき、readCount と targetUsers が付く', async () => {
    const res = await api('/api/v1/admin/announcements', {
      cookie: cookieManager,
      method: 'POST',
      body: { title: '管理者からの投稿', body: '店舗1向けの本文', storeId: 1 },
    });
    expect(res.status).toBe(201);
    expect(res.body.storeId).toBe(1);
    expect(res.body.readCount).toBe(0);
    // 店舗1の所属ユーザー (2, 3, 5) の 3 人
    expect(res.body.targetUsers).toBe(3);
    createdId = Number(res.body.id);

    const audit = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'announcement.create' AND target_id = ?1`,
    )
      .bind(String(createdId))
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('全店舗宛は SYSTEM_ADMIN のみ、他店舗宛は誰も投稿できない', async () => {
    const byManager = await api('/api/v1/admin/announcements', {
      cookie: cookieManager,
      method: 'POST',
      body: { title: '全体宛 (管理者)', body: '本文', storeId: null },
    });
    expect(byManager.status).toBe(403);

    const otherStore = await api('/api/v1/admin/announcements', {
      cookie: cookieManager,
      method: 'POST',
      body: { title: '他店舗宛', body: '本文', storeId: 2 },
    });
    expect(otherStore.status).toBe(403);

    const byStoreAdmin = await api('/api/v1/admin/announcements', {
      cookie: cookieStoreAdmin,
      method: 'POST',
      body: { title: '全体宛 (店舗管理者)', body: '本文', storeId: null },
    });
    expect(byStoreAdmin.status).toBe(201);
    // 全店舗宛の対象は有効な全ユーザー 5 人だが、店舗側の応答では
    // 全体管理者の存在を見せないため、その分を除いた 4 人になる
    // (全体管理者本人の応答では従来通り 5 人)
    expect(byStoreAdmin.body.targetUsers).toBe(4);

    const byPlatform = await api('/api/v1/admin/announcements', {
      cookie: cookiePlatform,
      method: 'POST',
      body: { title: '全体宛 (全体管理者)', body: '本文', storeId: null },
    });
    expect(byPlatform.status).toBe(201);
  });

  it('管理一覧は掲載前・終了も含み、既読数が集計される', async () => {
    // スタッフが先ほどの投稿を読む
    await api(`/api/v1/announcements/${createdId}/read`, { cookie: cookieStaff, method: 'POST' });
    const list = await api('/api/v1/admin/announcements', { cookie: cookieManager });
    expect(list.status).toBe(200);
    const items = itemsOf(list);
    // 店舗1宛 + 全店舗宛が見え、店舗2宛は見えない
    expect(items.some((i) => i.title === '店舗2のお知らせ')).toBe(false);
    expect(items.some((i) => i.title === '未来のお知らせ')).toBe(true);
    expect(items.some((i) => i.title === '終了したお知らせ')).toBe(true);
    const mine = items.find((i) => i.id === createdId);
    expect(mine?.readCount).toBe(1);
    expect(mine?.targetUsers).toBe(3);
  });

  it('編集・削除は管理範囲内だけ。範囲外は 403', async () => {
    const list = await api('/api/v1/admin/announcements', { cookie: cookieStoreAdmin });
    const allStore = itemsOf(list).find((i) => i.title === '全体宛 (店舗管理者)');
    expect(allStore).toBeTruthy();

    // 在庫管理者は全店舗宛を編集できない
    const denied = await api(`/api/v1/admin/announcements/${allStore!.id}`, {
      cookie: cookieManager,
      method: 'PUT',
      body: { title: '書き換え', body: '本文' },
    });
    expect(denied.status).toBe(403);

    // 自店舗宛は編集できる
    const updated = await api(`/api/v1/admin/announcements/${createdId}`, {
      cookie: cookieManager,
      method: 'PUT',
      body: { title: '管理者からの投稿 (改)', body: '差し替え本文', storeId: 1 },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.title).toBe('管理者からの投稿 (改)');

    const del = await api(`/api/v1/admin/announcements/${createdId}`, {
      cookie: cookieManager,
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    const after = await api('/api/v1/admin/announcements', { cookie: cookieManager });
    expect(itemsOf(after).some((i) => i.id === createdId)).toBe(false);
    // 既読も一緒に消える
    const reads = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS n FROM announcement_reads WHERE announcement_id = ?1',
    )
      .bind(createdId)
      .first<{ n: number }>();
    expect(reads?.n).toBe(0);
  });

  it('権限カタログと既定マトリクスに announcements.write が入る', async () => {
    const res = await api('/api/v1/admin/permissions', { cookie: cookieStoreAdmin });
    expect(res.status).toBe(200);
    const perms = res.body.permissions as { key: string; label: string }[];
    const entry = perms.find((p) => p.key === 'announcements.write');
    expect(entry?.label).toBe('お知らせ投稿');
    const matrix = res.body.matrix as Record<string, string[]>;
    expect(matrix.SYSTEM_ADMIN).toContain('announcements.write');
    expect(matrix.INVENTORY_MANAGER).toContain('announcements.write');
    expect(matrix.INVENTORY_STAFF).not.toContain('announcements.write');
  });

  it('掲載期間の検証: endsAt が startsAt 以下は 422', async () => {
    const now = Date.now();
    const res = await api('/api/v1/admin/announcements', {
      cookie: cookieManager,
      method: 'POST',
      body: { title: '期間不正', body: '本文', startsAt: now, endsAt: now },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('INVALID_PERIOD');
  });
});

describe('機能フラグ OFF のときはお知らせ API が止まる', () => {
  async function setFlag(storeId: number, enabled: boolean): Promise<void> {
    await testEnv.DB.prepare(
      `INSERT INTO feature_flags (store_id, key, enabled, updated_by, updated_at) VALUES (?1, 'announcements', ?2, 1, ?3)
       ON CONFLICT(store_id, key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
      .bind(storeId, enabled ? 1 : 0, Date.now())
      .run();
  }

  it('店舗2で OFF にすると閲覧が 403 FEATURE_DISABLED (店舗1は無事)', async () => {
    await setFlag(2, false);
    try {
      const res = await api('/api/v1/announcements', { cookie: cookieStaff2 });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('FEATURE_DISABLED');
      const ok = await api('/api/v1/announcements', { cookie: cookieStaff });
      expect(ok.status).toBe(200);
    } finally {
      await setFlag(2, true);
    }
  });

  it('店舗1で OFF にすると投稿管理も 403 になる', async () => {
    await setFlag(1, false);
    try {
      const list = await api('/api/v1/admin/announcements', { cookie: cookieManager });
      expect(list.status).toBe(403);
      expect(list.body.error).toBe('FEATURE_DISABLED');
      const post = await api('/api/v1/admin/announcements', {
        cookie: cookieManager,
        method: 'POST',
        body: { title: 'フラグOFF中', body: '本文' },
      });
      expect(post.status).toBe(403);
    } finally {
      await setFlag(1, true);
    }
  });
});

describe('プッシュ購読と公開鍵', () => {
  it('公開鍵が返る (env の VAPID_PUBLIC_KEY)', async () => {
    const res = await api('/api/v1/push/public-key', { cookie: cookieStaff });
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe(vapidPublicKeyB64);
  });

  it('公開鍵が未設定なら 503 PUSH_NOT_CONFIGURED', async () => {
    const saved = testEnv.VAPID_PUBLIC_KEY;
    testEnv.VAPID_PUBLIC_KEY = '';
    try {
      const res = await api('/api/v1/push/public-key', { cookie: cookieStaff });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('PUSH_NOT_CONFIGURED');
    } finally {
      testEnv.VAPID_PUBLIC_KEY = saved;
    }
  });

  it('購読の upsert と解除 (endpoint 単位、所有者の付け替え)', async () => {
    const sub = await makeSubscriber();
    const endpoint = 'https://push.example.com/sub/upsert';
    await subscribeViaApi(cookieStaff, endpoint, sub);

    let rows = await testEnv.DB.prepare(
      'SELECT * FROM push_subscriptions WHERE endpoint = ?1',
    )
      .bind(endpoint)
      .all<{ user_id: number; auth: string }>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0]?.user_id).toBe(3);

    // 同じ endpoint を別ユーザーが登録すると付け替わる (行は増えない)
    await subscribeViaApi(cookieManager, endpoint, sub);
    rows = await testEnv.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?1')
      .bind(endpoint)
      .all<{ user_id: number; auth: string }>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0]?.user_id).toBe(2);

    // 所有者でないユーザーの解除では消えない
    const denied = await api('/api/v1/push/subscribe', {
      cookie: cookieStaff,
      method: 'DELETE',
      body: { endpoint },
    });
    expect(denied.status).toBe(200);
    rows = await testEnv.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?1')
      .bind(endpoint)
      .all();
    expect(rows.results.length).toBe(1);

    const del = await api('/api/v1/push/subscribe', {
      cookie: cookieManager,
      method: 'DELETE',
      body: { endpoint },
    });
    expect(del.status).toBe(200);
    rows = await testEnv.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?1')
      .bind(endpoint)
      .all();
    expect(rows.results.length).toBe(0);
  });
});

describe('プッシュ送信 (暗号化・VAPID・購読切れ削除)', () => {
  const okEndpoint = 'https://push.example.com/sub/ok';
  const goneEndpoint = 'https://push.example.com/sub/gone';
  let okSub: Subscriber;

  beforeAll(async () => {
    okSub = await makeSubscriber();
    const goneSub = await makeSubscriber();
    await subscribeViaApi(cookieStaff, okEndpoint, okSub);
    await subscribeViaApi(cookieStaff, goneEndpoint, goneSub);
  });

  it('掲載中の push=1 は作成時に即送信され、JWT と暗号文が検証できる', async () => {
    capturedPushes.length = 0;
    const res = await api('/api/v1/admin/announcements', {
      cookie: cookieManager,
      method: 'POST',
      body: { title: 'プッシュテスト', body: '暗号化して届く本文', storeId: 1, push: true },
    });
    expect(res.status).toBe(201);
    expect(res.body.pushSentAt).not.toBeNull();

    // スタッフの 2 購読 (ok / gone) へ送られた
    expect(capturedPushes.length).toBe(2);
    const okPush = capturedPushes.find((p) => p.url === okEndpoint);
    expect(okPush).toBeTruthy();

    // VAPID JWT: 署名が公開鍵で検証でき、aud / sub / exp が正しい
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(okPush!.authorization);
    expect(match).toBeTruthy();
    const jwt = String(match![1]);
    expect(match![2]).toBe(vapidPublicKeyB64);
    const verified = await jwtVerify(jwt, vapidPublicKey);
    expect(verified.payload.aud).toBe('https://push.example.com');
    expect(verified.payload.sub).toBe('mailto:test@example.com');
    expect((verified.payload.exp ?? 0) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(12 * 3600);

    // ペイロードは購読側の秘密鍵で復号でき、お知らせの内容が入っている
    const plain = await decryptPushBody(okPush!.body, okSub);
    const payload = JSON.parse(plain) as { title: string; body: string; announcementId: number };
    expect(payload.title).toBe('【お知らせ】プッシュテスト');
    expect(payload.announcementId).toBe(Number(res.body.id));

    // 410 を返した購読は削除され、正常な購読は残る
    const gone = await testEnv.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?1')
      .bind(goneEndpoint)
      .all();
    expect(gone.results.length).toBe(0);
    const ok = await testEnv.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?1')
      .bind(okEndpoint)
      .all();
    expect(ok.results.length).toBe(1);
  });

  it('重要度「重要」のお知らせはタイトルが 【重要】 始まりになる', async () => {
    capturedPushes.length = 0;
    const res = await api('/api/v1/admin/announcements', {
      cookie: cookieManager,
      method: 'POST',
      body: { title: '緊急のお知らせ', body: '重要な本文', storeId: 1, push: true, priority: 'important' },
    });
    expect(res.status).toBe(201);
    const okPush = capturedPushes.find((p) => p.url === okEndpoint);
    expect(okPush).toBeTruthy();
    const plain = await decryptPushBody(okPush!.body, okSub);
    const payload = JSON.parse(plain) as { title: string; important: boolean };
    expect(payload.title).toBe('【重要】緊急のお知らせ');
    expect(payload.important).toBe(true);
  });

  it('掲載前 (未来) の push=1 は作成時に送られない', async () => {
    capturedPushes.length = 0;
    const res = await api('/api/v1/admin/announcements', {
      cookie: cookieManager,
      method: 'POST',
      body: {
        title: '未来のプッシュ',
        body: '本文',
        storeId: 1,
        push: true,
        startsAt: Date.now() + DAY,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.pushSentAt).toBeNull();
    expect(capturedPushes.length).toBe(0);
  });

  it('scheduled: 掲載期間に入った未送信だけを送って push_sent_at を記録する', async () => {
    const now = Date.now();
    const dueId = await insertAnnouncement({
      storeId: 1,
      title: '予約プッシュ (対象)',
      startsAt: now - HOUR,
      push: 1,
    });
    await insertAnnouncement({ storeId: 1, title: '予約プッシュ (未来)', startsAt: now + DAY, push: 1 });
    await insertAnnouncement({ storeId: 1, title: 'プッシュなし', startsAt: now - HOUR, push: 0 });
    await insertAnnouncement({
      storeId: 1,
      title: '送信済み',
      startsAt: now - HOUR,
      push: 1,
      pushSentAt: now - HOUR,
    });

    capturedPushes.length = 0;
    const processed = await runScheduledAnnouncementPushes(testEnv.DB, testEnv, now);
    expect(processed).toBe(1);
    expect(capturedPushes.some((p) => p.url === okEndpoint)).toBe(true);

    const row = await testEnv.DB.prepare('SELECT push_sent_at FROM announcements WHERE id = ?1')
      .bind(dueId)
      .first<{ push_sent_at: number | null }>();
    expect(row?.push_sent_at).toBe(now);

    // 2 回目は対象なし
    const again = await runScheduledAnnouncementPushes(testEnv.DB, testEnv, now);
    expect(again).toBe(0);
  });

  it('VAPID 未設定なら scheduled は何もしない', async () => {
    await insertAnnouncement({
      storeId: 1,
      title: '鍵なしでは送らない',
      startsAt: Date.now() - HOUR,
      push: 1,
    });
    const processed = await runScheduledAnnouncementPushes(testEnv.DB, {}, Date.now());
    expect(processed).toBe(0);
  });
});

describe('Service Worker', () => {
  it('/sw.js が push / notificationclick ハンドラ入りの JS で返る', async () => {
    const res = await SELF.fetch('https://example.com/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/javascript');
    const js = await res.text();
    expect(js).toContain("addEventListener('push'");
    expect(js).toContain('showNotification');
    expect(js).toContain("addEventListener('notificationclick'");
    expect(js).toContain('/app');
  });

  it('/sw.js がアプリシェルのキャッシュ (fetch ハンドラ) を含む', async () => {
    const res = await SELF.fetch('https://example.com/sw.js');
    const js = await res.text();
    expect(js).toContain("addEventListener('fetch'");
    expect(js).toContain('app-shell-');
  });
});

describe('アプリシェルのアセット配信 (読み込み高速化)', () => {
  it('/app の HTML は CSS / JS をハッシュ付き別アセットで参照し、本体を内包しない', async () => {
    const res = await SELF.fetch('https://example.com/app');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/assets/app.css?v=');
    expect(html).toContain('/assets/app.js?v=');
    // JS 本体が HTML に埋め込まれていないこと (固有の API パスで確認)
    expect(html).not.toContain('/api/v1/stocks?take=200');
  });

  it('/assets/app.js と /assets/app.css が immutable キャッシュで返る', async () => {
    const js = await SELF.fetch('https://example.com/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('Content-Type')).toContain('text/javascript');
    expect(js.headers.get('Cache-Control')).toContain('immutable');
    expect((await js.text()).length).toBeGreaterThan(100000);

    const css = await SELF.fetch('https://example.com/assets/app.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('Content-Type')).toContain('text/css');
    expect(css.headers.get('Cache-Control')).toContain('immutable');
    expect((await css.text()).length).toBeGreaterThan(10000);
  });
});
