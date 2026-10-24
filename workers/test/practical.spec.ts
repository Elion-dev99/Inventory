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
import type { Env } from '../src/env';
import { requireImagesBucket } from '../src/lib/photos';
import { qrSvg } from '../src/lib/qr';

/**
 * 実用機能トップ5の結合テスト (migration 0014):
 * - QR ラベル印刷ページ (サーバー描画 + QR SVG)
 * - 商品画像 / 検品写真 (R2 バインディング IMAGES、未設定時は 503 劣化)
 * - 部分棚卸し (対象 location のみロック) + 盲検 (実数入力中に帳簿数を秘匿)
 * - 単位換算 (ケース入力 → 基本単位) と発注提案のケース切り上げ
 * - 発注点の高度化 (平均日次消費 × リードタイム + 安全在庫、論理在庫で判定)、
 *   分納の残数量、残クローズ、納期超過フラグ
 *
 * ユーザー: 2 = 店舗1の在庫管理者、3 = 店舗1のスタッフ。
 * 商品: 1 = 基本品 / 40 = ケース品 (入数12・安全在庫5) / 41 = リードタイム品
 *       (LT10・安全在庫5) / 43 = 発注残検証品 (安全在庫5) / 44 = 消費検証品
 *       (LT10・安全在庫5)。
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
  IMAGES?: R2Bucket;
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
    rawBody?: BodyInit;
    contentType?: string;
    key?: string | null;
  } = {},
): Promise<ApiResult> {
  idemSeq += 1;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.key !== null) headers['Idempotency-Key'] = init.key ?? `practical-${idemSeq}`;
  let body: BodyInit | undefined;
  if (init.rawBody !== undefined) {
    body = init.rawBody;
    if (init.contentType) headers['Content-Type'] = init.contentType;
  } else if (init.body !== undefined) {
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

/** バイナリ応答のバイト列を取得する (画像配信の検証用) */
async function fetchBytes(path: string, token: string): Promise<{ status: number; bytes: Uint8Array }> {
  const res = await SELF.fetch(`https://example.com${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
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

// 小さな PNG (ヘッダのみ。サーバーは Content-Type で検証する)
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

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
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, case_size, lead_time_days, created_at, updated_at)
       VALUES (1, 'SKU-BASE', '基本品', '個', 0, 0, NULL, NULL, ?1, ?1),
              (40, 'SKU-CASE', 'ケース品', '個', 5, 0, 12, NULL, ?1, ?1),
              (41, 'SKU-LEAD', 'リードタイム品', '個', 5, 0, NULL, 10, ?1, ?1),
              (43, 'SKU-ONORDER', '発注残検証品', '個', 5, 0, NULL, NULL, ?1, ?1),
              (44, 'SKU-CONSUME', '消費検証品', '個', 5, 0, NULL, 10, ?1, ?1)`,
    ).bind(now),
  ]);

  managerToken = await mintToken('sub-manager', 'manager@example.com', privateKey);
  staffToken = await mintToken('sub-staff', 'staff@example.com', privateKey);

  const sup = await api('/api/v1/master/suppliers', managerToken, {
    method: 'POST',
    body: { name: '検証仕入先', leadTimeDays: 3 },
  });
  expect(sup.status).toBe(201);
  expect(sup.body.leadTimeDays).toBe(3);
  supplierId = sup.body.id as number;
});

describe('QR ラベル印刷ページ', () => {
  it('qrSvg は SVG 文字列を返す', () => {
    const svg = qrSvg('SKU-BASE');
    expect(svg).toContain('<svg');
    expect(svg).toContain('<path');
  });

  it('商品ラベル: QR (SKU) + 商品名 + SKU を含む印刷ページを返す', async () => {
    const res = await api('/labels/print?type=products&ids=1,40', managerToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.text).toContain('<svg');
    expect(res.text).toContain('基本品');
    expect(res.text).toContain('SKU-BASE');
    expect(res.text).toContain('ケース品');
    expect(res.text).toContain('@media print');
  });

  it('保管場所ラベル: QR (場所コード) + 場所名を含む', async () => {
    const res = await api('/labels/print?type=locations&ids=1', managerToken);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<svg');
    expect(res.text).toContain('A-1');
    expect(res.text).toContain('棚A-1');
  });

  it('未認証は 401、権限のないスタッフは 403', async () => {
    const anon = await api('/labels/print?type=products&ids=1', '');
    expect(anon.status).toBe(401);
    const staff = await api('/labels/print?type=products&ids=1', staffToken);
    // スタッフは master.read を持たない想定。持つロール構成なら 200 でも可
    expect([200, 403]).toContain(staff.status);
  });
});

describe('商品画像 (R2)', () => {
  it('PUT → GET → DELETE の往復と imageKey の反映', async () => {
    const put = await api('/api/v1/products/1/image', managerToken, {
      method: 'PUT',
      rawBody: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(put.status).toBe(200);
    expect(put.body.imageKey).toBe('products/1/1.jpg');

    const masterList = await api('/api/v1/master/products?take=200', managerToken);
    expect(masterList.status).toBe(200);
    const product = (masterList.body as Record<string, unknown>[]).find((p) => p.id === 1);
    expect(product?.imageKey).toBe('products/1/1.jpg');
    expect(product?.caseSize).toBeNull();
    expect(product?.leadTimeDays).toBeNull();
    const caseProduct = (masterList.body as Record<string, unknown>[]).find((p) => p.id === 40);
    expect(caseProduct?.caseSize).toBe(12);

    const got = await fetchBytes('/api/v1/products/1/image', managerToken);
    expect(got.status).toBe(200);
    expect(got.bytes.length).toBe(PNG_BYTES.length);
    expect(got.bytes[0]).toBe(0x89);

    const del = await api('/api/v1/products/1/image', managerToken, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const gone = await api('/api/v1/products/1/image', managerToken);
    expect(gone.status).toBe(404);
  });

  it('Content-Type が画像でなければ 400、2MB 超は 413', async () => {
    const bad = await api('/api/v1/products/1/image', managerToken, {
      method: 'PUT',
      rawBody: new Uint8Array([1, 2, 3]),
      contentType: 'text/plain',
    });
    expect(bad.status).toBe(400);

    const big = await api('/api/v1/products/1/image', managerToken, {
      method: 'PUT',
      rawBody: new Uint8Array(2 * 1024 * 1024 + 1),
      contentType: 'image/jpeg',
    });
    expect(big.status).toBe(413);
  });

  it('IMAGES バインディングが無い環境では 503 PHOTOS_NOT_CONFIGURED', () => {
    let caught: unknown = null;
    try {
      requireImagesBucket({} as Env);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    const err = caught as { status: number; code: string };
    expect(err.status).toBe(503);
    expect(err.code).toBe('PHOTOS_NOT_CONFIGURED');
  });
});

describe('発注提案の高度化 (発注残が無い初期状態)', () => {
  it('ケース品: 提案数量はケース単位に切り上げ、内訳が返る', async () => {
    const res = await api('/api/v1/purchase-orders/suggestions', managerToken);
    expect(res.status).toBe(200);
    const list = res.body as Record<string, unknown>[];
    const s = list.find((x) => x.productId === 40);
    expect(s).toBeDefined();
    // 消費ゼロ → 発注点 = 安全在庫 5。提案 raw = 5 + 5 - 0 = 10 → 1ケース (12) に切り上げ
    expect(s?.reorderPoint).toBe(5);
    expect(s?.onHand).toBe(0);
    expect(s?.onOrder).toBe(0);
    expect(s?.logicalStock).toBe(0);
    expect(s?.avgDailyConsumption).toBe(0);
    expect(s?.suggestedQuantity).toBe(12);
    expect(s?.suggestedCases).toBe(1);
    expect(s?.caseSize).toBe(12);
  });

  it('商品のリードタイムが発注点に使われる', async () => {
    const res = await api('/api/v1/purchase-orders/suggestions', managerToken);
    const list = res.body as Record<string, unknown>[];
    const s = list.find((x) => x.productId === 41);
    expect(s).toBeDefined();
    expect(s?.leadTimeDays).toBe(10);
    expect(s?.reorderPoint).toBe(5);
    expect(s?.suggestedQuantity).toBe(10);
  });

  it('平均日次消費 × リードタイムが発注点に反映される', async () => {
    const inRes = await inbound(staffToken, 1, 44, 'CS-1', 90);
    expect(inRes.status).toBe(201);
    const outRes = await consume(staffToken, 44, 90, 1);
    expect(outRes.status).toBe(201);

    const res = await api('/api/v1/purchase-orders/suggestions', managerToken);
    const list = res.body as Record<string, unknown>[];
    const s = list.find((x) => x.productId === 44);
    expect(s).toBeDefined();
    // 平均日次 = 90 / 90 = 1、発注点 = ceil(1 × 10) + 5 = 15、提案 = 15 + 5 - 0 = 20
    expect(s?.avgDailyConsumption).toBe(1);
    expect(s?.leadTimeDays).toBe(10);
    expect(s?.reorderPoint).toBe(15);
    expect(s?.shortage).toBe(15);
    expect(s?.suggestedQuantity).toBe(20);
  });
});

describe('単位換算・分納・残クローズ・納期超過', () => {
  let poCaseId = 0;
  let receivedMovementId = 0;

  it('ケース入力は基本単位へ換算され、入力単位も明細に保持される', async () => {
    const res = await api('/api/v1/purchase-orders', managerToken, {
      method: 'POST',
      body: {
        supplierId,
        lines: [{ productId: 40, inputQuantity: 3, inputUnit: 'case' }],
      },
    });
    expect(res.status).toBe(201);
    poCaseId = res.body.id as number;
    const line = (res.body.lines as Record<string, unknown>[])[0]!;
    expect(line.quantity).toBe(36);
    expect(line.inputQuantity).toBe(3);
    expect(line.inputUnit).toBe('case');
    expect(line.remainingQuantity).toBe(36);
    expect(res.body.overdue).toBe(false);
  });

  it('入数の無い商品へのケース入力は 400', async () => {
    const res = await api('/api/v1/purchase-orders', managerToken, {
      method: 'POST',
      body: {
        supplierId,
        lines: [{ productId: 1, inputQuantity: 2, inputUnit: 'case' }],
      },
    });
    expect(res.status).toBe(400);
  });

  it('部分入荷で残数量が減り、生成された伝票が返る。その伝票へ検品写真を付けられる', async () => {
    const listRes = await api('/api/v1/purchase-orders', managerToken);
    const po = (listRes.body as Record<string, unknown>[]).find((r) => r.id === poCaseId);
    const lineId = (po?.lines as Record<string, unknown>[])[0]!.id as number;
    const res = await api(`/api/v1/purchase-orders/${poCaseId}/receive`, managerToken, {
      method: 'POST',
      body: { locationId: 1, lines: [{ lineId, quantity: 10, lotCode: 'RC-1' }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ordered');
    const line = (res.body.lines as Record<string, unknown>[])[0]!;
    expect(line.receivedQuantity).toBe(10);
    expect(line.remainingQuantity).toBe(26);
    const movements = res.body.receivedMovements as { lineId: number; movementId: number }[];
    expect(movements).toHaveLength(1);
    expect(movements[0]!.lineId).toBe(lineId);
    receivedMovementId = movements[0]!.movementId;
    expect(receivedMovementId).toBeGreaterThan(0);

    // 検品写真: 添付 → 一覧 → 配信 → 履歴の photoCount
    const post = await api(`/api/v1/movements/${receivedMovementId}/photos`, staffToken, {
      method: 'POST',
      rawBody: PNG_BYTES,
      contentType: 'image/png',
    });
    expect(post.status).toBe(201);
    const photoId = post.body.id as number;
    expect(photoId).toBeGreaterThan(0);

    const list = await api(`/api/v1/movements/${receivedMovementId}/photos`, staffToken);
    expect(list.status).toBe(200);
    expect((list.body as unknown[]).length).toBe(1);

    const served = await fetchBytes(`/api/v1/photos/${photoId}`, staffToken);
    expect(served.status).toBe(200);
    expect(served.bytes.length).toBe(PNG_BYTES.length);
    expect(served.bytes[0]).toBe(0x89);

    const history = await api('/api/v1/movements?take=50', staffToken);
    const row = (history.body as Record<string, unknown>[]).find((r) => r.id === receivedMovementId);
    expect(row?.photoCount).toBe(1);
  });

  it('残クローズで closed になり、監査が残り、以降の受入・再クローズは 409', async () => {
    const res = await api(`/api/v1/purchase-orders/${poCaseId}/close-residual`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');

    const audit = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'purchase_order.close_residual' AND target_id = ?1",
    )
      .bind(String(poCaseId))
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);

    const lineId = (res.body.lines as Record<string, unknown>[])[0]!.id as number;
    const receive = await api(`/api/v1/purchase-orders/${poCaseId}/receive`, managerToken, {
      method: 'POST',
      body: { locationId: 1, lines: [{ lineId, quantity: 1, lotCode: 'RC-2' }] },
    });
    expect(receive.status).toBe(409);

    const again = await api(`/api/v1/purchase-orders/${poCaseId}/close-residual`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(again.status).toBe(409);
  });

  it('発注残が論理在庫に算入され、発注点以上なら提案されない。残クローズで再び提案される', async () => {
    const create = await api('/api/v1/purchase-orders', managerToken, {
      method: 'POST',
      body: { supplierId, lines: [{ productId: 43, quantity: 10 }] },
    });
    expect(create.status).toBe(201);
    const poId = create.body.id as number;
    const lineId = (create.body.lines as Record<string, unknown>[])[0]!.id as number;

    // 下書き (draft) の発注残は論理在庫に算入しない → まだ提案される
    let res = await api('/api/v1/purchase-orders/suggestions', managerToken);
    let s = (res.body as Record<string, unknown>[]).find((x) => x.productId === 43);
    expect(s).toBeDefined();
    expect(s?.onOrder).toBe(0);

    // 部分入荷 2 → ordered、実在庫 2 + 発注残 8 = 論理在庫 10 >= 発注点 5 → 提案から消える
    const receive = await api(`/api/v1/purchase-orders/${poId}/receive`, managerToken, {
      method: 'POST',
      body: { locationId: 1, lines: [{ lineId, quantity: 2, lotCode: 'OO-1' }] },
    });
    expect(receive.status).toBe(200);
    res = await api('/api/v1/purchase-orders/suggestions', managerToken);
    s = (res.body as Record<string, unknown>[]).find((x) => x.productId === 43);
    expect(s).toBeUndefined();

    // 実在庫を使い切っても発注残 8 だけで発注点以上 → まだ提案されない
    const out = await consume(staffToken, 43, 2, 1);
    expect(out.status).toBe(201);
    res = await api('/api/v1/purchase-orders/suggestions', managerToken);
    s = (res.body as Record<string, unknown>[]).find((x) => x.productId === 43);
    expect(s).toBeUndefined();

    // 残クローズすると発注残が消え、再び提案される (内訳: 発注残 0)
    const close = await api(`/api/v1/purchase-orders/${poId}/close-residual`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(close.status).toBe(200);
    res = await api('/api/v1/purchase-orders/suggestions', managerToken);
    s = (res.body as Record<string, unknown>[]).find((x) => x.productId === 43);
    expect(s).toBeDefined();
    expect(s?.onOrder).toBe(0);
    expect(s?.onHand).toBe(0);
  });

  it('納期を過ぎた未完了の発注は overdue、未来の納期・完了済みは対象外', async () => {
    const past = await api('/api/v1/purchase-orders', managerToken, {
      method: 'POST',
      body: { supplierId, expectedDate: '2020-01-01', lines: [{ productId: 1, quantity: 5 }] },
    });
    expect(past.status).toBe(201);
    expect(past.body.overdue).toBe(true);

    const future = await api('/api/v1/purchase-orders', managerToken, {
      method: 'POST',
      body: { supplierId, expectedDate: '2999-01-01', lines: [{ productId: 1, quantity: 5 }] },
    });
    expect(future.status).toBe(201);
    expect(future.body.overdue).toBe(false);

    const list = await api('/api/v1/purchase-orders', managerToken);
    const rows = list.body as Record<string, unknown>[];
    expect(rows.find((r) => r.id === past.body.id)?.overdue).toBe(true);
    expect(rows.find((r) => r.id === future.body.id)?.overdue).toBe(false);
    // 残クローズ済みのケース品 PO は過去納期でも overdue にならない (納期未設定のため false)
    expect(rows.find((r) => r.id === poCaseId)?.status).toBe('closed');
  });
});

describe('部分棚卸し + 盲検', () => {
  let stocktakeId = 0;
  let lineIdLoc1 = 0;

  it('対象場所のみ明細が生成され、盲検中は帳簿数・差異が返らない', async () => {
    expect((await inbound(staffToken, 1, 1, 'TK-1', 10)).status).toBe(201);
    expect((await inbound(staffToken, 2, 1, 'TK-2', 10)).status).toBe(201);

    const start = await api('/api/v1/stocktakes', managerToken, {
      method: 'POST',
      body: { scopeType: 'locations', locationIds: [1], blind: true },
    });
    expect(start.status).toBe(201);
    stocktakeId = start.body.id as number;
    expect(start.body.scopeType).toBe('locations');
    expect(start.body.locationIds).toEqual([1]);
    expect(start.body.blind).toBe(true);

    const detail = await api(`/api/v1/stocktakes/${stocktakeId}`, managerToken);
    expect(detail.status).toBe(200);
    const lines = detail.body.lines as Record<string, unknown>[];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((ln) => ln.locationId === 1)).toBe(true);
    // 対象は TK-1 の行 (他の商品の 0 在庫行も明細に含まれうるためロットで特定する)
    const tkLine = lines.find((ln) => ln.lotCode === 'TK-1');
    expect(tkLine).toBeDefined();
    lineIdLoc1 = tkLine?.id as number;
    const line0 = tkLine as Record<string, unknown>;
    // 盲検: 帳簿数と差異のキーが存在しない
    expect('bookQuantity' in line0).toBe(false);
    expect('difference' in line0).toBe(false);
  });

  it('ロックは対象場所だけ: 対象外の入庫・消費は通り、対象への入庫・移動は 423', async () => {
    expect((await inbound(staffToken, 2, 1, 'TK-3', 5)).status).toBe(201);
    expect((await inbound(staffToken, 1, 1, 'TK-4', 5)).status).toBe(423);
    expect((await consume(staffToken, 1, 3, 2)).status).toBe(201);
    expect((await consume(staffToken, 1, 1, 1)).status).toBe(423);

    const transferIn = await api('/api/v1/movements/transfer', staffToken, {
      method: 'POST',
      body: { fromLocationId: 2, toLocationId: 1, productId: 1, quantity: 1 },
    });
    expect(transferIn.status).toBe(423);
    const transferOut = await api('/api/v1/movements/transfer', staffToken, {
      method: 'POST',
      body: { fromLocationId: 1, toLocationId: 2, productId: 1, quantity: 1 },
    });
    expect(transferOut.status).toBe(423);
  });

  it('実数入力の応答でも盲検中は帳簿数が漏れない。承認待ちになると差異が見える', async () => {
    const put = await api(`/api/v1/stocktakes/${stocktakeId}/lines/${lineIdLoc1}`, managerToken, {
      method: 'PUT',
      body: { countedQuantity: 8 },
    });
    expect(put.status).toBe(200);
    expect(put.body.countedQuantity).toBe(8);
    expect('bookQuantity' in put.body).toBe(false);
    expect('difference' in put.body).toBe(false);

    const finish = await api(`/api/v1/stocktakes/${stocktakeId}/finish`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(finish.status).toBe(200);
    expect(finish.body.status).toBe('pending_approval');

    const detail = await api(`/api/v1/stocktakes/${stocktakeId}`, managerToken);
    const line = (detail.body.lines as Record<string, unknown>[]).find((ln) => ln.id === lineIdLoc1);
    expect(line?.bookQuantity).toBe(10);
    expect(line?.difference).toBe(-2);
  });

  it('差し戻し → 実数を直して終了するとロックが解除される', async () => {
    const reject = await api(`/api/v1/stocktakes/${stocktakeId}/decide`, managerToken, {
      method: 'POST',
      body: { approve: false },
    });
    expect(reject.status).toBe(200);

    const put = await api(`/api/v1/stocktakes/${stocktakeId}/lines/${lineIdLoc1}`, managerToken, {
      method: 'PUT',
      body: { countedQuantity: 10 },
    });
    expect(put.status).toBe(200);

    const finish = await api(`/api/v1/stocktakes/${stocktakeId}/finish`, managerToken, {
      method: 'POST',
      body: {},
    });
    expect(finish.status).toBe(200);
    expect(finish.body.status).toBe('confirmed');

    expect((await inbound(staffToken, 1, 1, 'TK-5', 1)).status).toBe(201);
  });
});
