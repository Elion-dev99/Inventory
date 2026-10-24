import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
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
import practicalSql from '../migrations/0014_practical.sql?raw';
import commercialSql from '../migrations/0015_commercial.sql?raw';
import { runScheduledPoDrafts } from '../src/lib/commercial';
import { computeFreeQuantities } from '../src/lib/free-stock';

/**
 * 商用レベル第1弾 (migration 0015) の結合テスト:
 * - 引当 (作成/解放/消費変換) とフリー在庫計算
 * - 返品・廃棄 (理由必須、在庫増減、分析の廃棄集計)
 * - ピッキング (作成 → 検品 → 確定、原子性)
 * - セット品 (組立可能数、展開消費、循環防止、入庫禁止)
 * - ロケーション階層 (親指定と循環防止)
 * - 発注テンプレート + 定期下書き生成
 * - 商品の一括編集
 *
 * ユーザー: 2 = 店舗1の在庫管理者、3 = 店舗1のスタッフ。
 * 商品: 1 = 基本品 (単価100) / 2 = ピッキング消費用 / 3 = ピッキング移動用 /
 *       4 = 原子性検証用B / 10 = セット品 / 11,12 = 構成品 / 20,21 = 一括編集用。
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let managerToken = '';
let staffToken = '';
let idemSeq = 0;
let supplierId = 0;

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

interface ApiResult {
  status: number;
  headers: Headers;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function api(
  path: string,
  token: string,
  init: {
    method?: string;
    body?: unknown;
    key?: string | null;
  } = {},
): Promise<ApiResult> {
  idemSeq += 1;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.key !== null) headers['Idempotency-Key'] = init.key ?? `commercial-${idemSeq}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: init.method ?? 'GET',
    headers,
    body,
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  return { status: res.status, headers: res.headers, text, body: parsed };
}

function statementsOf(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function inbound(token: string, locationId: number, productId: number, lotCode: string, quantity: number) {
  return api('/api/v1/movements/inbound', token, {
    method: 'POST',
    body: { locationId, productId, lotCode, quantity },
  });
}

async function consume(token: string, productId: number, quantity: number, locationId?: number) {
  return api('/api/v1/movements/consumption', token, {
    method: 'POST',
    body: {
      productId,
      quantity,
      department: '製造部',
      purpose: '検証',
      ...(locationId !== undefined ? { locationId } : {}),
    },
  });
}

async function stockQty(productId: number, locationId: number): Promise<number> {
  const res = await api(`/api/v1/stocks?take=200&productId=${productId}`, managerToken);
  expect(res.status).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = (res.body as any[]).find((s) => s.locationId === locationId);
  return row ? (row.quantity as number) : 0;
}

async function stockRow(productId: number, locationId: number) {
  const res = await api(`/api/v1/stocks?take=200&productId=${productId}`, managerToken);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (res.body as any[]).find((s) => s.locationId === locationId);
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(JSON.stringify({ keys: [jwk] }), {
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
    ...statementsOf(maintenanceWindowsSql),
    ...statementsOf(maintenanceExtrasSql),
    ...statementsOf(announcementsSql),
    ...statementsOf(practicalSql),
    ...statementsOf(commercialSql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (2, 'sub-manager', 'manager@example.com', 'Manager', 'active', ?1, ?1),
              (3, 'sub-staff', 'staff@example.com', 'Staff', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, created_at, updated_at)
       VALUES (1, 'WH1', '本社倉庫', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (2, 'INVENTORY_MANAGER', NULL, 1), (3, 'INVENTORY_STAFF', NULL, 1)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
       VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1), (2, 1, 'A-2', '棚A-2', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, unit_cost, created_at, updated_at)
       VALUES (1, 'SKU-BASE', '基本品', '個', 0, 0, 100, ?1, ?1),
              (2, 'SKU-PICK', 'ピッキング消費品', '個', 0, 0, 50, ?1, ?1),
              (3, 'SKU-MOVE', 'ピッキング移動品', '個', 0, 0, 50, ?1, ?1),
              (4, 'SKU-ATOMIC', '原子性検証品', '個', 0, 0, 50, ?1, ?1),
              (10, 'SKU-BUNDLE', 'セット品', 'セット', 0, 0, NULL, ?1, ?1),
              (11, 'SKU-COMP-A', '構成品A', '個', 0, 0, 30, ?1, ?1),
              (12, 'SKU-COMP-B', '構成品B', '個', 0, 0, 20, ?1, ?1),
              (20, 'SKU-BULK-1', '一括品1', '個', 0, 0, 10, ?1, ?1),
              (21, 'SKU-BULK-2', '一括品2', '個', 0, 0, 10, ?1, ?1)`,
    ).bind(now),
  ]);

  managerToken = await mintToken('sub-manager', 'manager@example.com', privateKey);
  staffToken = await mintToken('sub-staff', 'staff@example.com', privateKey);

  const sup = await api('/api/v1/master/suppliers', managerToken, {
    method: 'POST',
    body: { name: '検証仕入先', leadTimeDays: 3 },
  });
  expect(sup.status).toBe(201);
  supplierId = sup.body.id as number;

  // 基本品: 場所1に 100
  const in1 = await inbound(managerToken, 1, 1, 'LOT-BASE-1', 100);
  expect(in1.status).toBe(201);
});

describe('フリー在庫計算 (純粋関数)', () => {
  it('場所指定と店舗全体の引当をウォーターフォールで差し引く', () => {
    const stocks = [
      { stockId: 1, productId: 1, locationId: 1, quantity: 50 },
      { stockId: 2, productId: 1, locationId: 1, quantity: 30 },
      { stockId: 3, productId: 1, locationId: 2, quantity: 20 },
    ];
    const free = computeFreeQuantities(stocks, [
      { productId: 1, locationId: 1, quantity: 60 },
      { productId: 1, locationId: null, quantity: 25 },
    ]);
    // 場所1の引当60: 行1から50、行2から10 → 行1=0, 行2=20
    // 店舗全体25: 行1は0、行2から20、行3から5 → 行2=0, 行3=15
    expect(free.get(1)).toBe(0);
    expect(free.get(2)).toBe(0);
    expect(free.get(3)).toBe(15);
  });

  it('引当が無ければ実在庫と一致する', () => {
    const free = computeFreeQuantities(
      [{ stockId: 1, productId: 1, locationId: 1, quantity: 7 }],
      [],
    );
    expect(free.get(1)).toBe(7);
  });
});

describe('引当とフリー在庫', () => {
  it('引当を作成すると在庫一覧のフリーが減る', async () => {
    const created = await api('/api/v1/reservations', managerToken, {
      method: 'POST',
      body: { productId: 1, quantity: 30, reason: '出荷予定' },
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('active');

    const row = await stockRow(1, 1);
    expect(row.quantity).toBe(100);
    expect(row.freeQuantity).toBe(70);
  });

  it('フリー在庫を超える引当は 422', async () => {
    const over = await api('/api/v1/reservations', managerToken, {
      method: 'POST',
      body: { productId: 1, quantity: 71, reason: '超過' },
    });
    expect(over.status).toBe(422);
    expect(over.body.error).toBe('RESERVATION_EXCEEDS_FREE_STOCK');
  });

  it('場所指定の引当はその場所のフリーだけを減らす', async () => {
    const in2 = await inbound(managerToken, 2, 1, 'LOT-BASE-2', 40);
    expect(in2.status).toBe(201);
    const created = await api('/api/v1/reservations', managerToken, {
      method: 'POST',
      body: { productId: 1, locationId: 2, quantity: 15, reason: '場所指定' },
    });
    expect(created.status).toBe(201);
    const row2 = await stockRow(1, 2);
    expect(row2.freeQuantity).toBe(40 - 15 - 30 + 30); // 店舗全体30は行id順に場所1側から負担されるため場所2は場所指定分のみ
    expect(row2.freeQuantity).toBe(25);
    const row1 = await stockRow(1, 1);
    expect(row1.freeQuantity).toBe(70);
  });

  it('期限切れの引当は一覧に出ず、フリーも拘束しない', async () => {
    const created = await api('/api/v1/reservations', managerToken, {
      method: 'POST',
      body: { productId: 1, quantity: 5, reason: '期限切れ', expiresAt: Date.now() - 1000 },
    });
    expect(created.status).toBe(201);
    const list = await api('/api/v1/reservations', managerToken);
    expect(list.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((list.body as any[]).some((r) => r.reason === '期限切れ')).toBe(false);
    const row = await stockRow(1, 1);
    expect(row.freeQuantity).toBe(70);
  });

  it('解放するとフリーが戻る', async () => {
    const created = await api('/api/v1/reservations', managerToken, {
      method: 'POST',
      body: { productId: 1, quantity: 10, reason: '解放テスト' },
    });
    expect(created.status).toBe(201);
    const released = await api(`/api/v1/reservations/${created.body.id}/release`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(released.status).toBe(200);
    expect(released.body.status).toBe('released');
    const row = await stockRow(1, 1);
    expect(row.freeQuantity).toBe(70);
  });

  it('引当の消費変換で実在庫が減り、引当が consumed になる', async () => {
    const created = await api('/api/v1/reservations', managerToken, {
      method: 'POST',
      body: { productId: 1, locationId: 1, quantity: 10, reason: '消費変換' },
    });
    expect(created.status).toBe(201);
    const before = await stockQty(1, 1);
    const consumed = await api(`/api/v1/reservations/${created.body.id}/consume`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(consumed.status).toBe(201);
    expect(consumed.body.reservation.status).toBe('consumed');
    expect(await stockQty(1, 1)).toBe(before - 10);
    // 二重変換は 409
    const again = await api(`/api/v1/reservations/${created.body.id}/consume`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(again.status).toBe(409);
  });
});

describe('返品・廃棄', () => {
  it('返品は理由コードとメモが必須', async () => {
    const noReason = await api('/api/v1/movements/return', managerToken, {
      method: 'POST',
      body: { locationId: 1, productId: 1, lotCode: 'LOT-BASE-1', quantity: 5 },
    });
    expect(noReason.status).toBe(400);
    const noCode = await api('/api/v1/movements/return', managerToken, {
      method: 'POST',
      body: { locationId: 1, productId: 1, lotCode: 'LOT-BASE-1', quantity: 5, reason: 'メモのみ' },
    });
    expect(noCode.status).toBe(400);
  });

  it('返品で在庫が増え、台帳に RETURN と理由が残る', async () => {
    const before = await stockQty(1, 1);
    const ret = await api('/api/v1/movements/return', managerToken, {
      method: 'POST',
      body: {
        locationId: 1,
        productId: 1,
        lotCode: 'LOT-BASE-1',
        quantity: 5,
        reasonCode: 'other',
        reason: '部署から戻り',
      },
    });
    expect(ret.status).toBe(201);
    expect(await stockQty(1, 1)).toBe(before + 5);
    const history = await api('/api/v1/movements?type=RETURN&take=10', managerToken);
    expect(history.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (history.body as any[])[0];
    expect(row.type).toBe('RETURN');
    expect(row.reasonCode).toBe('other');
    expect(row.reason).toBe('部署から戻り');
    expect(row.quantityChange).toBe(5);
  });

  it('廃棄は理由が必須で、在庫不足は 409 (マイナスフローに乗らない)', async () => {
    const noReason = await api('/api/v1/movements/disposal', managerToken, {
      method: 'POST',
      body: { productId: 1, quantity: 1 },
    });
    expect(noReason.status).toBe(400);
    const tooMany = await api('/api/v1/movements/disposal', managerToken, {
      method: 'POST',
      body: { productId: 1, quantity: 100000, reasonCode: 'damaged', reason: '破損' },
    });
    expect(tooMany.status).toBe(409);
  });

  it('廃棄で在庫が減り、分析に廃棄集計が入る', async () => {
    const before = await stockQty(1, 1);
    const dis = await api('/api/v1/movements/disposal', managerToken, {
      method: 'POST',
      body: { productId: 1, locationId: 1, quantity: 5, reasonCode: 'damaged', reason: '破損のため' },
    });
    expect(dis.status).toBe(201);
    expect(await stockQty(1, 1)).toBe(before - 5);
    const analytics = await api('/api/v1/analytics', managerToken);
    expect(analytics.status).toBe(200);
    expect(analytics.body.disposal.quantity).toBe(5);
    expect(analytics.body.disposal.value).toBe(5 * 100);
  });
});

describe('ピッキング', () => {
  it('作成 → 検品 (数量修正) → 確定で消費が実行される', async () => {
    const inRes = await inbound(managerToken, 1, 2, 'LOT-PICK-1', 20);
    expect(inRes.status).toBe(201);
    const created = await api('/api/v1/pick-lists', managerToken, {
      method: 'POST',
      body: { type: 'consume', items: [{ productId: 2, fromLocationId: 1, plannedQty: 8 }] },
    });
    expect(created.status).toBe(201);
    const listId = created.body.id as number;
    const itemId = created.body.items[0].id as number;
    expect(created.body.items[0].pickedQty).toBe(0);

    // 計画を超える実績は 422
    const over = await api(`/api/v1/pick-lists/${listId}/items/${itemId}`, managerToken, {
      method: 'PUT',
      body: { pickedQty: 9 },
    });
    expect(over.status).toBe(422);

    const upd = await api(`/api/v1/pick-lists/${listId}/items/${itemId}`, managerToken, {
      method: 'PUT',
      body: { pickedQty: 8 },
    });
    expect(upd.status).toBe(200);

    const confirmed = await api(`/api/v1/pick-lists/${listId}/confirm`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(confirmed.status).toBe(201);
    expect(await stockQty(2, 1)).toBe(12);
    const detail = await api(`/api/v1/pick-lists/${listId}`, managerToken);
    expect(detail.body.status).toBe('done');
  });

  it('移動リストの確定で在庫が移動する', async () => {
    const inRes = await inbound(managerToken, 1, 3, 'LOT-MOVE-1', 10);
    expect(inRes.status).toBe(201);
    const created = await api('/api/v1/pick-lists', managerToken, {
      method: 'POST',
      body: { type: 'transfer', toLocationId: 2, items: [{ productId: 3, fromLocationId: 1, plannedQty: 4 }] },
    });
    expect(created.status).toBe(201);
    const listId = created.body.id as number;
    const itemId = created.body.items[0].id as number;
    await api(`/api/v1/pick-lists/${listId}/items/${itemId}`, managerToken, {
      method: 'PUT',
      body: { pickedQty: 4 },
    });
    const confirmed = await api(`/api/v1/pick-lists/${listId}/confirm`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(confirmed.status).toBe(201);
    expect(await stockQty(3, 1)).toBe(6);
    expect(await stockQty(3, 2)).toBe(4);
  });

  it('確定時に在庫不足があると全体が失敗し、在庫もリスト状態も変わらない', async () => {
    const inA = await inbound(managerToken, 1, 3, 'LOT-MOVE-1', 10);
    expect(inA.status).toBe(201);
    const inB = await inbound(managerToken, 1, 4, 'LOT-ATOMIC-1', 10);
    expect(inB.status).toBe(201);
    const created = await api('/api/v1/pick-lists', managerToken, {
      method: 'POST',
      body: {
        type: 'consume',
        items: [
          { productId: 3, fromLocationId: 1, plannedQty: 5 },
          { productId: 4, fromLocationId: 1, plannedQty: 5 },
        ],
      },
    });
    expect(created.status).toBe(201);
    const listId = created.body.id as number;
    for (const item of created.body.items) {
      await api(`/api/v1/pick-lists/${listId}/items/${item.id}`, managerToken, {
        method: 'PUT',
        body: { pickedQty: item.plannedQty },
      });
    }
    // 確定前に商品4 の在庫を通常消費で減らして不足させる (10 → 3)
    const drain = await consume(managerToken, 4, 7, 1);
    expect(drain.status).toBe(201);
    const beforeA = await stockQty(3, 1);
    const confirmed = await api(`/api/v1/pick-lists/${listId}/confirm`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(confirmed.status).toBe(409);
    // 原子性: 商品3 も減っていない、リストは open のまま
    expect(await stockQty(3, 1)).toBe(beforeA);
    const detail = await api(`/api/v1/pick-lists/${listId}`, managerToken);
    expect(detail.body.status).toBe('open');
    // 取消できる
    const cancelled = await api(`/api/v1/pick-lists/${listId}/cancel`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
  });
});

describe('セット品', () => {
  it('構成品を設定すると組立可能数が計算できる', async () => {
    const setBundle = await api('/api/v1/master/products/10', managerToken, {
      method: 'PUT',
      body: { isBundle: true },
    });
    expect(setBundle.status).toBe(200);
    expect(setBundle.body.isBundle).toBe(true);

    const inA = await inbound(managerToken, 1, 11, 'LOT-COMP-A', 10);
    expect(inA.status).toBe(201);
    const inB = await inbound(managerToken, 1, 12, 'LOT-COMP-B', 3);
    expect(inB.status).toBe(201);

    const put = await api('/api/v1/products/10/bundle', managerToken, {
      method: 'PUT',
      body: { components: [{ productId: 11, quantity: 2 }, { productId: 12, quantity: 1 }] },
    });
    expect(put.status).toBe(200);
    // min(10/2, 3/1) = 3、単価 = 30*2 + 20*1 = 80
    expect(put.body.assemblable).toBe(3);
    expect(put.body.unitCost).toBe(80);

    const list = await api('/api/v1/bundles', managerToken);
    expect(list.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (list.body as any[]).find((b) => b.productId === 10);
    expect(row.assemblable).toBe(3);
  });

  it('セット品の消費は構成品を展開し、同一 group_id で記録される', async () => {
    const res = await api('/api/v1/movements/bundle-consumption', managerToken, {
      method: 'POST',
      body: { productId: 10, quantity: 2, department: '製造部', purpose: '組立' },
    });
    expect(res.status).toBe(201);
    expect(res.body.groupId).toBeTruthy();
    expect(await stockQty(11, 1)).toBe(10 - 4);
    expect(await stockQty(12, 1)).toBe(3 - 2);
    const history = await api('/api/v1/movements?productId=11&take=10', managerToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (history.body as any[])[0];
    expect(row.type).toBe('OUT');
    expect(row.groupId).toBe(res.body.groupId);
  });

  it('構成品が不足するセット消費は全体が失敗する', async () => {
    const res = await api('/api/v1/movements/bundle-consumption', managerToken, {
      method: 'POST',
      body: { productId: 10, quantity: 5, department: '製造部', purpose: '組立' },
    });
    expect(res.status).toBe(409);
    expect(await stockQty(11, 1)).toBe(6);
    expect(await stockQty(12, 1)).toBe(1);
  });

  it('セット品の入庫は 422、セットの中のセットと自己参照は 422', async () => {
    const inBundle = await inbound(managerToken, 1, 10, 'LOT-BUNDLE', 1);
    expect(inBundle.status).toBe(422);

    const makeBundle11 = await api('/api/v1/master/products/11', managerToken, {
      method: 'PUT',
      body: { isBundle: true },
    });
    expect(makeBundle11.status).toBe(200);
    const nesting = await api('/api/v1/products/11/bundle', managerToken, {
      method: 'PUT',
      body: { components: [{ productId: 10, quantity: 1 }] },
    });
    expect(nesting.status).toBe(422);
    expect(nesting.body.error).toBe('BUNDLE_NESTING_FORBIDDEN');
    // 後片付け: 商品11 を通常商品へ戻す
    await api('/api/v1/products/11/bundle', managerToken, {
      method: 'PUT',
      body: { components: [] },
    });
    await api('/api/v1/master/products/11', managerToken, {
      method: 'PUT',
      body: { isBundle: false },
    });

    const selfRef = await api('/api/v1/products/10/bundle', managerToken, {
      method: 'PUT',
      body: { components: [{ productId: 10, quantity: 1 }] },
    });
    expect(selfRef.status).toBe(422);
    expect(selfRef.body.error).toBe('BUNDLE_SELF_REFERENCE');
  });
});

describe('ロケーション階層', () => {
  it('親を指定して作成でき、一覧に parentId が出る', async () => {
    const zone = await api('/api/v1/master/locations', managerToken, {
      method: 'POST',
      body: { warehouseId: 1, code: 'ZONE-A', name: 'ゾーンA' },
    });
    expect(zone.status).toBe(201);
    const shelf = await api('/api/v1/master/locations', managerToken, {
      method: 'POST',
      body: { warehouseId: 1, code: 'ZONE-A-1', name: '棚1', parentId: zone.body.id },
    });
    expect(shelf.status).toBe(201);
    expect(shelf.body.parentId).toBe(zone.body.id);

    const list = await api('/api/v1/master/locations', managerToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (list.body as any[]).find((l) => l.id === shelf.body.id);
    expect(row.parentId).toBe(zone.body.id);
  });

  it('循環する親指定は 422', async () => {
    const list = await api('/api/v1/master/locations', managerToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zone = (list.body as any[]).find((l) => l.code === 'ZONE-A');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shelf = (list.body as any[]).find((l) => l.code === 'ZONE-A-1');
    const cycle = await api(`/api/v1/master/locations/${zone.id}`, managerToken, {
      method: 'PUT',
      body: { parentId: shelf.id },
    });
    expect(cycle.status).toBe(422);
    const selfParent = await api(`/api/v1/master/locations/${zone.id}`, managerToken, {
      method: 'PUT',
      body: { parentId: zone.id },
    });
    expect(selfParent.status).toBe(422);
  });
});

describe('発注テンプレートと定期発注', () => {
  it('テンプレートを作成し、下書きを生成すると source=template になる', async () => {
    const created = await api('/api/v1/purchase-order-templates', managerToken, {
      method: 'POST',
      body: { name: '週次補充', supplierId, lines: [{ productId: 1, quantity: 5 }] },
    });
    expect(created.status).toBe(201);
    const templateId = created.body.id as number;

    const generated = await api(`/api/v1/purchase-order-templates/${templateId}/generate`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(generated.status).toBe(201);
    expect(generated.body.status).toBe('draft');
    expect(generated.body.source).toBe('template');
    expect(generated.body.lines[0].quantity).toBe(5);
  });

  it('定期スケジュールを設定すると期限到来で下書きが生成され、次回が前進する', async () => {
    const created = await api('/api/v1/purchase-order-templates', managerToken, {
      method: 'POST',
      body: { name: '定期補充', supplierId, lines: [{ productId: 1, quantity: 3 }] },
    });
    expect(created.status).toBe(201);
    const templateId = created.body.id as number;

    const scheduled = await api(`/api/v1/purchase-order-templates/${templateId}/schedule`, managerToken, {
      method: 'PUT',
      body: { intervalDays: 7, enabled: true },
    });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.schedule.enabled).toBe(true);
    expect(scheduled.body.schedule.intervalDays).toBe(7);

    // 期限を過去へ巻き戻して実行する
    await testEnv.DB.prepare('UPDATE po_schedules SET next_run_at = ?1 WHERE template_id = ?2')
      .bind(Date.now() - 1000, templateId)
      .run();
    const generatedCount = await runScheduledPoDrafts(testEnv.DB, Date.now());
    expect(generatedCount).toBe(1);

    const orders = await api('/api/v1/purchase-orders', managerToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduledPo = (orders.body as any[]).find((po) => po.source === 'schedule');
    expect(scheduledPo).toBeTruthy();
    expect(scheduledPo.status).toBe('draft');
    expect(scheduledPo.lines[0].quantity).toBe(3);

    // next_run_at は未来へ前進し、last_run_at が記録される
    const after = await api('/api/v1/purchase-order-templates', managerToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tpl = (after.body as any[]).find((t) => t.id === templateId);
    expect(tpl.schedule.nextRunAt).toBeGreaterThan(Date.now());
    expect(tpl.schedule.lastRunAt).not.toBeNull();

    // 再実行しても二重生成しない
    const again = await runScheduledPoDrafts(testEnv.DB, Date.now());
    expect(again).toBe(0);
  });

  it('テンプレートを削除するとスケジュールも消える', async () => {
    const created = await api('/api/v1/purchase-order-templates', managerToken, {
      method: 'POST',
      body: { name: '削除対象', supplierId, lines: [{ productId: 1, quantity: 1 }] },
    });
    const templateId = created.body.id as number;
    await api(`/api/v1/purchase-order-templates/${templateId}/schedule`, managerToken, {
      method: 'PUT',
      body: { intervalDays: 3, enabled: true },
    });
    const del = await api(`/api/v1/purchase-order-templates/${templateId}`, managerToken, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    const row = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM po_schedules WHERE template_id = ?1')
      .bind(templateId)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe('商品の一括編集', () => {
  it('複数商品の安全在庫と単価を一括で変更でき、監査が 1 件に集約される', async () => {
    const res = await api('/api/v1/admin/products/bulk', managerToken, {
      method: 'PUT',
      body: { ids: [20, 21], patch: { safetyStock: 7, unitCost: 55 } },
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const list = await api('/api/v1/master/products?take=200', managerToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p20 = (list.body as any[]).find((p) => p.id === 20);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p21 = (list.body as any[]).find((p) => p.id === 21);
    expect(p20.safetyStock).toBe(7);
    expect(p20.unitCost).toBe(55);
    expect(p21.safetyStock).toBe(7);
    expect(p21.unitCost).toBe(55);

    const audit = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'product.bulk_update'",
    ).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('無効化で一覧から消え、有効化で戻る', async () => {
    const off = await api('/api/v1/admin/products/bulk', managerToken, {
      method: 'PUT',
      body: { ids: [20], patch: { active: false } },
    });
    expect(off.status).toBe(200);
    let list = await api('/api/v1/master/products?take=200', managerToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((list.body as any[]).some((p) => p.id === 20)).toBe(false);

    const on = await api('/api/v1/admin/products/bulk', managerToken, {
      method: 'PUT',
      body: { ids: [20], patch: { active: true } },
    });
    expect(on.status).toBe(200);
    list = await api('/api/v1/master/products?take=200', managerToken);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((list.body as any[]).some((p) => p.id === 20)).toBe(true);
  });

  it('スタッフ (master.write なし) は一括編集できない', async () => {
    const res = await api('/api/v1/admin/products/bulk', staffToken, {
      method: 'PUT',
      body: { ids: [21], patch: { safetyStock: 1 } },
    });
    expect(res.status).toBe(403);
  });
});
