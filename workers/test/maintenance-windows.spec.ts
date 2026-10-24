import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import windowsSql from '../migrations/0011_maintenance_windows.sql?raw';
import extrasSql from '../migrations/0012_maintenance_extras.sql?raw';
import { createSession } from '../src/lib/session';
import {
  activeOccurrence,
  clearMaintenanceCache,
  nextOccurrence,
  type MaintenanceWindow,
} from '../src/lib/maintenance';

/**
 * メンテナンスウィンドウ (migration 0011) の結合テスト:
 * - lib の occurrence 判定 (once の境界、weekly の JST 曜日・翌日跨ぎ)
 * - once / weekly / 店舗指定の有効判定と強制 (read_only / features / full)
 * - features は対象だけ 503 (analytics の GET も遮断)、対象外は通常動作
 * - 全体管理者 (store_id NULL の SYSTEM_ADMIN) は強制の対象外
 * - /me の maintenance.active / upcoming
 * - 従来の platform_settings 即時設定との合算 (重い方が勝つ)
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';
const HOUR = 3_600_000;

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let storeAdminToken = '';
let platformToken = '';
let store2StaffToken = '';
let staffIdToken = '';
let platformIdToken = '';
let idemSeq = 0;

async function mintToken(sub: string, email: string, privateKey: KeyLike): Promise<string> {
  return new SignJWT({ email, name: sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
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

async function req(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

async function inbound(
  token: string,
  locationId: number,
  productId: number,
  lotCode: string,
): Promise<Response> {
  idemSeq += 1;
  return req(token, '/api/v1/movements/inbound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `mw-test-${idemSeq}` },
    body: JSON.stringify({ locationId, productId, lotCode, quantity: 5 }),
  });
}

async function consume(token: string, productId: number, quantity: number): Promise<Response> {
  idemSeq += 1;
  return req(token, '/api/v1/movements/consumption', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `mw-test-${idemSeq}` },
    body: JSON.stringify({ productId, quantity, department: '製造部', purpose: 'テスト消費' }),
  });
}

async function transfer(token: string): Promise<Response> {
  idemSeq += 1;
  return req(token, '/api/v1/movements/transfer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `mw-test-${idemSeq}` },
    body: JSON.stringify({ fromLocationId: 1, toLocationId: 2, productId: 1, quantity: 1 }),
  });
}

interface WindowInput {
  kind: 'once' | 'weekly';
  startsAt?: number | null;
  endsAt?: number | null;
  weekday?: number | null;
  startMinute?: number | null;
  endMinute?: number | null;
  level: 'read_only' | 'features' | 'full';
  features?: string[] | Record<string, string>;
  storeId?: number | null;
  message?: string | null;
}

async function insertWindow(w: WindowInput): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO maintenance_windows
       (kind, starts_at, ends_at, weekday, start_minute, end_minute, level, features, store_id, message, created_by, created_at, cancelled_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, NULL)`,
  )
    .bind(
      w.kind,
      w.startsAt ?? null,
      w.endsAt ?? null,
      w.weekday ?? null,
      w.startMinute ?? null,
      w.endMinute ?? null,
      w.level,
      w.features ? JSON.stringify(w.features) : null,
      w.storeId ?? null,
      w.message ?? null,
      Date.now(),
    )
    .run();
  clearMaintenanceCache();
}

async function resetWindows(): Promise<void> {
  await testEnv.DB.prepare('DELETE FROM maintenance_windows').run();
  await testEnv.DB.prepare("DELETE FROM platform_settings WHERE key = 'maintenance'").run();
  clearMaintenanceCache();
}

async function setLegacy(on: boolean, message: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ('maintenance', ?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify({ on, message }), new Date().toISOString())
    .run();
  clearMaintenanceCache();
}

interface MeMaintenance {
  active: {
    level: string;
    features: Record<string, string>;
    endsAt: number | null;
    message: string;
  } | null;
  upcoming: {
    startsAt: number;
    endsAt: number | null;
    level: string;
    features: Record<string, string>;
    phase: string;
  } | null;
  lastEnded: { endsAt: number; level: string; features: Record<string, string> } | null;
}

async function meMaintenance(token: string): Promise<MeMaintenance> {
  const res = await req(token, '/api/v1/me');
  expect(res.status).toBe(200);
  const me = (await res.json()) as { maintenance: MeMaintenance };
  return me.maintenance;
}

function baseWindow(partial: Partial<MaintenanceWindow>): MaintenanceWindow {
  return {
    id: 1,
    kind: 'once',
    startsAt: null,
    endsAt: null,
    weekday: null,
    startMinute: null,
    endMinute: null,
    level: 'read_only',
    features: {},
    storeId: null,
    message: null,
    createdBy: 1,
    createdAt: 0,
    cancelledAt: null,
    emergency: false,
    reason: null,
    extendCount: 0,
    ...partial,
  };
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  storeAdminToken = await mintToken('sub-store-admin', 'sadmin@example.com', privateKey);
  platformToken = await mintToken('sub-platform', 'platform@example.com', privateKey);
  store2StaffToken = await mintToken('sub-store2-staff', 's2staff@example.com', privateKey);
  staffIdToken = storeAdminToken;
  platformIdToken = platformToken;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const rawBody = init?.body;
      const bodyText =
        typeof rawBody === 'string'
          ? rawBody
          : rawBody instanceof URLSearchParams
            ? rawBody.toString()
            : '';
      const code = new URLSearchParams(bodyText).get('code');
      const idToken = code === 'platform-code' ? platformIdToken : staffIdToken;
      return new Response(JSON.stringify({ id_token: idToken }), {
        headers: { 'Content-Type': 'application/json' },
      });
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
    ...statementsOf(windowsSql),
    ...statementsOf(extrasSql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-store-admin', 'sadmin@example.com', 'StoreAdmin', 'active', ?1, ?1),
              (4, 'sub-platform', 'platform@example.com', 'Platform', 'active', ?1, ?1),
              (5, 'sub-store2-staff', 's2staff@example.com', 'Store2Staff', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO stores (id, code, name, status, created_at, updated_at)
       VALUES (2, 'STORE2', '店舗2', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, 1),
              (4, 'SYSTEM_ADMIN', NULL, NULL),
              (5, 'INVENTORY_STAFF', NULL, 2)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
       VALUES (1, 'WH1', '本社倉庫', 1, ?1, ?1),
              (2, 'WH2', '店舗2倉庫', 2, ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
       VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1),
              (2, 1, 'A-2', '棚A-2', ?1, ?1),
              (3, 2, 'B-1', '棚B-1', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, store_id, created_at, updated_at)
       VALUES (1, 'SKU-1', 'テスト品', '個', 0, 0, 1, ?1, ?1),
              (2, 'SKU-2', '店舗2品', '個', 0, 0, 2, ?1, ?1)`,
    ).bind(now),
  ]);
});

beforeEach(async () => {
  await resetWindows();
});

describe('occurrence 判定 (lib)', () => {
  // 2026-10-24 (土) 00:30 JST = 2026-10-23 15:30 UTC
  const SAT_0030_JST = Date.UTC(2026, 9, 23, 15, 30, 0);

  it('weekly: 前日開始・翌日跨ぎの枠が土曜未明に有効になる', () => {
    const w = baseWindow({ kind: 'weekly', weekday: 5, startMinute: 1380, endMinute: 1560 });
    const occ = activeOccurrence(w, SAT_0030_JST);
    expect(occ).not.toBeNull();
    // 金曜 23:00 JST 開始、土曜 02:00 JST 終了
    expect(occ?.startsAt).toBe(Date.UTC(2026, 9, 23, 14, 0, 0));
    expect(occ?.endsAt).toBe(Date.UTC(2026, 9, 23, 17, 0, 0));
    // 土曜 02:00 JST ちょうどでは終了している
    expect(activeOccurrence(w, Date.UTC(2026, 9, 23, 17, 0, 0))).toBeNull();
    // 金曜 22:59 JST ではまだ始まっていない
    expect(activeOccurrence(w, Date.UTC(2026, 9, 23, 13, 59, 0))).toBeNull();
  });

  it('weekly: 当日枠の次回開始を返す', () => {
    const w = baseWindow({ kind: 'weekly', weekday: 6, startMinute: 60, endMinute: 120 });
    expect(activeOccurrence(w, SAT_0030_JST)).toBeNull();
    const next = nextOccurrence(w, SAT_0030_JST);
    expect(next?.startsAt).toBe(Date.UTC(2026, 9, 23, 16, 0, 0)); // 土曜 01:00 JST
    expect(next?.endsAt).toBe(Date.UTC(2026, 9, 23, 17, 0, 0));
    // 実施中の枠は nextOccurrence では返らない
    const running = baseWindow({ kind: 'weekly', weekday: 6, startMinute: 0, endMinute: 120 });
    expect(activeOccurrence(running, SAT_0030_JST)).not.toBeNull();
    expect(nextOccurrence(running, SAT_0030_JST)?.startsAt).toBe(
      Date.UTC(2026, 9, 30, 15, 0, 0), // 翌週土曜 00:00 JST
    );
  });

  it('once: 開始・終了の境界と取消', () => {
    const now = SAT_0030_JST;
    const w = baseWindow({ startsAt: now - 1000, endsAt: now + 1000 });
    expect(activeOccurrence(w, now)).toEqual({ startsAt: now - 1000, endsAt: now + 1000 });
    expect(activeOccurrence(baseWindow({ startsAt: now - 2000, endsAt: now - 1000 }), now)).toBeNull();
    expect(activeOccurrence(baseWindow({ startsAt: now + 1000, endsAt: now + 2000 }), now)).toBeNull();
    expect(nextOccurrence(baseWindow({ startsAt: now + 1000, endsAt: null }), now)).toEqual({
      startsAt: now + 1000,
      endsAt: null,
    });
    expect(
      activeOccurrence(baseWindow({ startsAt: now - 1000, endsAt: null, cancelledAt: now - 500 }), now),
    ).toBeNull();
    // 終了未定 (endsAt null) は開始後は無期限に有効
    expect(activeOccurrence(baseWindow({ startsAt: now - 1000, endsAt: null }), now + 365 * 86_400_000)).not.toBeNull();
  });
});

describe('メンテナンスウィンドウ強制 (API)', () => {
  it('once read_only (有効中): 書き込み 503・読み取り可・/me に active、終了後は再開', async () => {
    const now = Date.now();
    const endsAt = now + HOUR;
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt, level: 'read_only', message: '定期メンテナンス',
    });

    const blocked = await inbound(storeAdminToken, 1, 1, 'LOT-MW-RO');
    expect(blocked.status).toBe(503);
    const body = (await blocked.json()) as { error: string; level: string; endsAt: number; message: string };
    expect(body.error).toBe('MAINTENANCE');
    expect(body.level).toBe('read_only');
    expect(body.endsAt).toBe(endsAt);
    expect(body.message).toBe('定期メンテナンス');

    const stocks = await req(storeAdminToken, '/api/v1/stocks');
    expect(stocks.status).toBe(200);

    const m = await meMaintenance(storeAdminToken);
    expect(m.active?.level).toBe('read_only');
    expect(m.active?.endsAt).toBe(endsAt);
    expect(m.upcoming).toBeNull();

    // 枠を取り消すと書き込みが再開する
    await testEnv.DB.prepare('UPDATE maintenance_windows SET cancelled_at = ?1')
      .bind(Date.now())
      .run();
    clearMaintenanceCache();
    const ok = await inbound(storeAdminToken, 1, 1, 'LOT-MW-RO2');
    expect(ok.status).toBe(201);
    expect((await meMaintenance(storeAdminToken)).active).toBeNull();
  });

  it('once は未来なら upcoming (24時間以内)、期限切れは無効', async () => {
    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now + HOUR, endsAt: now + 2 * HOUR, level: 'full',
    });
    await insertWindow({
      kind: 'once', startsAt: now - 3 * HOUR, endsAt: now - 2 * HOUR, level: 'full',
    });
    const m = await meMaintenance(storeAdminToken);
    expect(m.active).toBeNull();
    expect(m.upcoming?.startsAt).toBe(now + HOUR);
    expect(m.upcoming?.level).toBe('full');
    const ok = await inbound(storeAdminToken, 1, 1, 'LOT-MW-FUT');
    expect(ok.status).toBe(201);

    // 24時間より先の予定は upcoming に出ない
    await resetWindows();
    await insertWindow({ kind: 'once', startsAt: now + 25 * HOUR, endsAt: null, level: 'read_only' });
    expect((await meMaintenance(storeAdminToken)).upcoming).toBeNull();
  });

  it('weekly (現在の JST 曜日・時刻内): 書き込みが止まる', async () => {
    const jst = new Date(Date.now() + 9 * HOUR);
    const minute = jst.getUTCHours() * 60 + jst.getUTCMinutes();
    await insertWindow({
      kind: 'weekly',
      weekday: jst.getUTCDay(),
      startMinute: Math.max(0, minute - 30),
      endMinute: minute + 30,
      level: 'read_only',
    });
    const blocked = await inbound(storeAdminToken, 1, 1, 'LOT-MW-WK');
    expect(blocked.status).toBe(503);
    expect(((await blocked.json()) as { level: string }).level).toBe('read_only');

    // 曜日が違えば効かない
    await resetWindows();
    const jst2 = new Date(Date.now() + 9 * HOUR);
    const minute2 = jst2.getUTCHours() * 60 + jst2.getUTCMinutes();
    await insertWindow({
      kind: 'weekly',
      weekday: (jst2.getUTCDay() + 1) % 7,
      startMinute: Math.max(0, minute2 - 30),
      endMinute: minute2 + 30,
      level: 'read_only',
    });
    const ok = await inbound(storeAdminToken, 1, 1, 'LOT-MW-WK2');
    expect(ok.status).toBe(201);
  });

  it('店舗指定の枠はその店舗だけに効く', async () => {
    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR, level: 'read_only', storeId: 2,
    });
    const blocked = await inbound(store2StaffToken, 3, 2, 'LOT-MW-S2');
    expect(blocked.status).toBe(503);
    const ok = await inbound(storeAdminToken, 1, 1, 'LOT-MW-S1');
    expect(ok.status).toBe(201);
    expect((await meMaintenance(storeAdminToken)).active).toBeNull();
    expect((await meMaintenance(store2StaffToken)).active?.level).toBe('read_only');
  });

  it('features: 対象機能だけ 503 (analytics の GET も遮断)、対象外は通常動作', async () => {
    // 先に在庫を入れておく (移動の前提)
    const seed = await inbound(storeAdminToken, 1, 1, 'LOT-MW-FEAT');
    expect(seed.status).toBe(201);

    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR,
      level: 'features', features: ['transfers', 'analytics'],
    });

    idemSeq += 1;
    const transfer = await req(storeAdminToken, '/api/v1/movements/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `mw-test-${idemSeq}` },
      body: JSON.stringify({ fromLocationId: 1, toLocationId: 2, productId: 1, quantity: 1 }),
    });
    expect(transfer.status).toBe(503);
    const tBody = (await transfer.json()) as {
      error: string;
      level: string;
      features: Record<string, string>;
    };
    expect(tBody.error).toBe('MAINTENANCE');
    expect(tBody.level).toBe('features');
    expect(tBody.features).toEqual({ transfers: 'full', analytics: 'full' });

    const analytics = await req(storeAdminToken, '/api/v1/analytics');
    expect(analytics.status).toBe(503);

    // 対象外: 入庫 (movements) とマスタ作成と在庫参照は通常通り
    const inb = await inbound(storeAdminToken, 1, 1, 'LOT-MW-FEAT2');
    expect(inb.status).toBe(201);
    const product = await req(storeAdminToken, '/api/v1/master/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'SKU-MW-1', name: 'メンテ対象外品', unit: '個' }),
    });
    expect(product.status).toBe(201);
    const stocks = await req(storeAdminToken, '/api/v1/stocks');
    expect(stocks.status).toBe(200);

    const m = await meMaintenance(storeAdminToken);
    expect(m.active?.level).toBe('features');
    expect(m.active?.features).toEqual({ transfers: 'full', analytics: 'full' });
  });

  it('full: /me と logout 以外すべて 503', async () => {
    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR, level: 'full', message: '全面メンテナンス',
    });
    const stocks = await req(storeAdminToken, '/api/v1/stocks');
    expect(stocks.status).toBe(503);
    expect(((await stocks.json()) as { level: string }).level).toBe('full');

    const m = await meMaintenance(storeAdminToken);
    expect(m.active?.level).toBe('full');
    expect(m.active?.message).toBe('全面メンテナンス');

    const sessionToken = await createSession(testEnv.DB, 1);
    const logout = await SELF.fetch('https://example.com/api/v1/auth/logout', {
      method: 'POST',
      headers: { Cookie: `session=${sessionToken}` },
    });
    expect(logout.status).toBe(200);
  });

  it('全体管理者は強制の対象外 (状態は見える)', async () => {
    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR, level: 'read_only',
    });
    // 店舗ユーザーは止まる
    const blocked = await inbound(storeAdminToken, 1, 1, 'LOT-MW-EX1');
    expect(blocked.status).toBe(503);

    // 全体管理者はセッションで店舗を選べば書き込みできる
    const sessionToken = await createSession(testEnv.DB, 4);
    const cookie = { Cookie: `session=${sessionToken}` };
    const pick = await SELF.fetch('https://example.com/api/v1/session/store', {
      method: 'POST',
      headers: { ...cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: 1 }),
    });
    expect(pick.status).toBe(200);
    idemSeq += 1;
    const write = await SELF.fetch('https://example.com/api/v1/movements/inbound', {
      method: 'POST',
      headers: { ...cookie, 'Content-Type': 'application/json', 'Idempotency-Key': `mw-test-${idemSeq}` },
      body: JSON.stringify({ locationId: 1, productId: 1, lotCode: 'LOT-MW-EX2', quantity: 2 }),
    });
    expect(write.status).toBe(201);

    // 状態自体は /me で見える
    const meRes = await SELF.fetch('https://example.com/api/v1/me', { headers: cookie });
    const me = (await meRes.json()) as { maintenance: MeMaintenance; isPlatformAdmin: boolean };
    expect(me.isPlatformAdmin).toBe(true);
    expect(me.maintenance.active?.level).toBe('read_only');

    expect(platformToken).not.toBe('');
  });

  it('従来の即時設定と合算される (read_only が features より重い)', async () => {
    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR,
      level: 'features', features: ['transfers'],
    });
    await setLegacy(true, '緊急メンテナンス');
    const m = await meMaintenance(storeAdminToken);
    expect(m.active?.level).toBe('read_only');
    expect(m.active?.message).toBe('緊急メンテナンス');
    expect(m.active?.endsAt).toBe(now + HOUR); // 有限の終了は window 由来の最も早いもの
    const blocked = await inbound(storeAdminToken, 1, 1, 'LOT-MW-MIX');
    expect(blocked.status).toBe(503);

    await setLegacy(false, '');
    const m2 = await meMaintenance(storeAdminToken);
    expect(m2.active?.level).toBe('features');
  });
});

describe('メンテナンス細分化 (0012)', () => {
  it('旧キーは読み取り時に新キーへ展開される (movements / csv / master)', async () => {
    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR,
      level: 'features', features: ['movements', 'csv', 'master'],
    });
    const m = await meMaintenance(storeAdminToken);
    expect(m.active?.features).toEqual({
      inbound: 'full',
      outbound: 'full',
      csv_export: 'full',
      csv_import: 'full',
      master_products: 'full',
      master_locations: 'full',
      suppliers: 'full',
    });
    // 展開された inbound が実際に止まる
    const blocked = await inbound(storeAdminToken, 1, 1, 'LOT-MW-LEGACY');
    expect(blocked.status).toBe(503);
  });

  it('inbound と outbound は独立に止まる', async () => {
    const seed = await inbound(storeAdminToken, 1, 1, 'LOT-MW-SPLIT');
    expect(seed.status).toBe(201);

    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR,
      level: 'features', features: { inbound: 'full' },
    });
    const blockedIn = await inbound(storeAdminToken, 1, 1, 'LOT-MW-SPLIT2');
    expect(blockedIn.status).toBe(503);
    const okOut = await consume(storeAdminToken, 1, 1);
    expect(okOut.status).toBe(201);

    await resetWindows();
    const now2 = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now2 - 60_000, endsAt: now2 + HOUR,
      level: 'features', features: { outbound: 'full' },
    });
    const blockedOut = await consume(storeAdminToken, 1, 1);
    expect(blockedOut.status).toBe(503);
    // 負在庫の申請も outbound に含まれる
    const approval = await req(storeAdminToken, '/api/v1/negative-approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stockId: 1, quantity: 1, reason: 'テスト' }),
    });
    expect(approval.status).toBe(503);
    const okIn = await inbound(storeAdminToken, 1, 1, 'LOT-MW-SPLIT3');
    expect(okIn.status).toBe(201);
  });

  it("write 段階は書き込みだけ止め、閲覧を通す", async () => {
    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR,
      level: 'features', features: { stocktakes: 'write', purchase_orders: 'write' },
    });
    const list = await req(storeAdminToken, '/api/v1/stocktakes');
    expect(list.status).toBe(200);
    const start = await req(storeAdminToken, '/api/v1/stocktakes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(start.status).toBe(503);
    const poList = await req(storeAdminToken, '/api/v1/purchase-orders');
    expect(poList.status).toBe(200);
    idemSeq += 1;
    const poCreate = await req(storeAdminToken, '/api/v1/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `mw-test-${idemSeq}` },
      body: JSON.stringify({ supplierId: 1, lines: [{ productId: 1, quantity: 1 }] }),
    });
    expect(poCreate.status).toBe(503);

    // full 段階では読み取りも止まる
    await resetWindows();
    const now2 = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now2 - 60_000, endsAt: now2 + HOUR,
      level: 'features', features: { stocktakes: 'full' },
    });
    const listFull = await req(storeAdminToken, '/api/v1/stocktakes');
    expect(listFull.status).toBe(503);
  });

  it('csv_export と csv_import は分離され、master も分割される', async () => {
    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR,
      level: 'features', features: { csv_export: 'full', master_products: 'full' },
    });
    const csv = await req(storeAdminToken, '/api/v1/stocks.csv');
    expect(csv.status).toBe(503);
    const exp = await req(storeAdminToken, '/api/v1/admin/export.json');
    expect(exp.status).toBe(503);
    // csv_import は止まらない
    const imp = await SELF.fetch('https://example.com/api/v1/master/products/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${storeAdminToken}`, 'Content-Type': 'text/csv' },
      body: 'sku,name,unit\nSKU-MW-IMP,インポート品,個',
    });
    expect(imp.status).toBe(200);
    // 商品マスタは止まるが、倉庫マスタは通る
    const product = await req(storeAdminToken, '/api/v1/master/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'SKU-MW-BLOCK', name: '止まる品', unit: '個' }),
    });
    expect(product.status).toBe(503);
    const warehouse = await req(storeAdminToken, '/api/v1/master/warehouses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'WH-MW-1', name: '追加倉庫' }),
    });
    expect(warehouse.status).toBe(201);

    await resetWindows();
    const now2 = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now2 - 60_000, endsAt: now2 + HOUR,
      level: 'features', features: { csv_import: 'full', suppliers: 'full', master_locations: 'full' },
    });
    const imp2 = await SELF.fetch('https://example.com/api/v1/master/products/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${storeAdminToken}`, 'Content-Type': 'text/csv' },
      body: 'sku,name,unit\nSKU-MW-IMP2,インポート品2,個',
    });
    expect(imp2.status).toBe(503);
    const csv2 = await req(storeAdminToken, '/api/v1/stocks.csv');
    expect(csv2.status).toBe(200);
    const supplier = await req(storeAdminToken, '/api/v1/master/suppliers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '仕入先MW' }),
    });
    expect(supplier.status).toBe(503);
    const warehouse2 = await req(storeAdminToken, '/api/v1/master/warehouses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'WH-MW-2', name: '止まる倉庫' }),
    });
    expect(warehouse2.status).toBe(503);
  });

  it('upcoming の phase は開始までの時間で切り替わる', async () => {
    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now + 2 * HOUR, endsAt: now + 3 * HOUR, level: 'read_only',
    });
    expect((await meMaintenance(storeAdminToken)).upcoming?.phase).toBe('scheduled');

    await resetWindows();
    await insertWindow({
      kind: 'once', startsAt: now + 30 * 60_000, endsAt: now + HOUR, level: 'read_only',
    });
    expect((await meMaintenance(storeAdminToken)).upcoming?.phase).toBe('warning');

    await resetWindows();
    await insertWindow({
      kind: 'once', startsAt: now + 5 * 60_000, endsAt: now + HOUR, level: 'read_only',
    });
    const m = await meMaintenance(storeAdminToken);
    expect(m.upcoming?.phase).toBe('imminent');
  });

  it('lastEnded は終了後 30 分だけ返る', async () => {
    const now = Date.now();
    const endsAt = now - 5 * 60_000;
    await insertWindow({
      kind: 'once', startsAt: now - HOUR, endsAt, level: 'features', features: { transfers: 'full' },
    });
    const m = await meMaintenance(storeAdminToken);
    expect(m.active).toBeNull();
    expect(m.lastEnded?.endsAt).toBe(endsAt);
    expect(m.lastEnded?.level).toBe('features');
    expect(m.lastEnded?.features).toEqual({ transfers: 'full' });

    await resetWindows();
    await insertWindow({
      kind: 'once', startsAt: now - 2 * HOUR, endsAt: now - 40 * 60_000, level: 'read_only',
    });
    expect((await meMaintenance(storeAdminToken)).lastEnded).toBeNull();
  });

  it('拒否件数が window × グループ × 店舗で数えられる', async () => {
    const seed = await inbound(storeAdminToken, 1, 1, 'LOT-MW-CNT');
    expect(seed.status).toBe(201);
    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR,
      level: 'features', features: { transfers: 'full', analytics: 'full' },
    });
    const win = await testEnv.DB.prepare('SELECT MAX(id) AS id FROM maintenance_windows').first<{
      id: number;
    }>();
    const windowId = win?.id ?? 0;
    expect(windowId).toBeGreaterThan(0);

    expect((await transfer(storeAdminToken)).status).toBe(503);
    expect((await transfer(storeAdminToken)).status).toBe(503);
    expect((await req(storeAdminToken, '/api/v1/analytics')).status).toBe(503);
    // 対象外は数えない
    expect((await inbound(storeAdminToken, 1, 1, 'LOT-MW-CNT2')).status).toBe(201);

    const rows = await testEnv.DB.prepare(
      'SELECT feature_key, store_id, blocked_count FROM maintenance_rejections WHERE window_id = ?1 ORDER BY feature_key',
    )
      .bind(windowId)
      .all<{ feature_key: string; store_id: number; blocked_count: number }>();
    expect(rows.results).toEqual([
      { feature_key: 'analytics', store_id: 1, blocked_count: 1 },
      { feature_key: 'transfers', store_id: 1, blocked_count: 2 },
    ]);
  });

  it('login 停止: 新規ログインは止まり、既存セッションと全体管理者は通る', async () => {
    const now = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now - 60_000, endsAt: now + HOUR,
      level: 'features', features: { login: 'full' }, message: 'ログイン停止中',
    });

    const loginStart = await SELF.fetch('https://example.com/auth/login', { redirect: 'manual' });
    expect(loginStart.status).toBe(503);

    const staffCallback = await SELF.fetch('https://example.com/auth/callback?code=staff-code');
    expect(staffCallback.status).toBe(503);
    expect(staffCallback.headers.get('set-cookie') ?? '').not.toContain('session=');

    // 全体管理者はログインできる
    const adminCallback = await SELF.fetch('https://example.com/auth/callback?code=platform-code');
    expect(adminCallback.status).toBe(200);
    expect(adminCallback.headers.get('set-cookie') ?? '').toContain('session=');

    // 既存セッションはそのまま使える
    const sessionToken = await createSession(testEnv.DB, 1);
    const meRes = await SELF.fetch('https://example.com/api/v1/me', {
      headers: { Cookie: `session=${sessionToken}` },
    });
    expect(meRes.status).toBe(200);

    // 店舗指定の login 枠はログインには効かない
    await resetWindows();
    const now2 = Date.now();
    await insertWindow({
      kind: 'once', startsAt: now2 - 60_000, endsAt: now2 + HOUR,
      level: 'features', features: { login: 'full' }, storeId: 1,
    });
    const loginStart2 = await SELF.fetch('https://example.com/auth/login', { redirect: 'manual' });
    expect(loginStart2.status).toBe(302);
  });
});
