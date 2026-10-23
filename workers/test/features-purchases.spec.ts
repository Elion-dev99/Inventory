import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import initSql from '../migrations/0001_init.sql?raw';
import seedSql from '../migrations/0002_seed_roles.sql?raw';
import permissionsSql from '../migrations/0003_permissions.sql?raw';
import businessSql from '../migrations/0005_business_completion.sql?raw';
import featuresSql from '../migrations/0006_feature_flags.sql?raw';
import purchasingSql from '../migrations/0007_purchasing_analytics.sql?raw';
import sessionsSql from '../migrations/0004_sessions.sql?raw';
import multiStoreSql from '../migrations/0008_multi_store.sql?raw';

/**
 * 追加機能の結合テスト (実 D1 に 0001〜0007 を適用し、HTTP 経路を通す):
 * - 機能フラグ: 解決 (既定 true)、管理 API (admin.permissions 必須、未知キー 422、
 *   監査ログ)、オフ時の各機能 API の 403 FEATURE_DISABLED
 * - 仕入先マスタ CRUD (master.read/write)
 * - 発注提案 (安全在庫との比較と提案数量)
 * - 発注書: 作成 (冪等キー必須・再送で同一発注書)、部分入荷 -> ordered、
 *   全量入荷 -> received、過入荷 422、棚卸しロック中の入荷 423
 * - 分析レポート: 月別集計・在庫評価額とカバー率・滞留在庫・消費上位
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';
const DAY = 86_400_000;

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let adminToken = '';
let managerToken = '';
let staffToken = '';
let viewerToken = '';
let idemSeq = 0;
let seedNow = 0;

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

async function api(
  path: string,
  token: string,
  init: { method?: string; body?: unknown; key?: string | null; rawBody?: string; contentType?: string } = {},
): Promise<Response> {
  idemSeq += 1;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.key !== null) headers['Idempotency-Key'] = init.key ?? `fp-test-${idemSeq}`;
  let body: string | undefined;
  if (init.rawBody !== undefined) {
    body = init.rawBody;
    if (init.contentType) headers['Content-Type'] = init.contentType;
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['Content-Type'] = 'application/json';
  }
  return SELF.fetch(`https://example.com${path}`, {
    method: init.method ?? 'GET',
    headers,
    body,
  });
}

async function inbound(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { stockId: number; quantity: number } }> {
  const res = await api('/api/v1/movements/inbound', token, { method: 'POST', body });
  return { status: res.status, body: (await res.json()) as { stockId: number; quantity: number } };
}

async function stockQuantityByLot(productId: number, lotCode: string, locationId: number): Promise<number> {
  const row = await testEnv.DB.prepare(
    `SELECT s.quantity FROM stocks s JOIN lots l ON l.id = s.lot_id
      WHERE l.product_id = ?1 AND l.lot_code = ?2 AND s.location_id = ?3`,
  )
    .bind(productId, lotCode, locationId)
    .first<{ quantity: number }>();
  return row?.quantity ?? 0;
}

async function setFeature(key: string, enabled: boolean): Promise<void> {
  const res = await api(`/api/v1/admin/features/${key}`, adminToken, {
    method: 'PUT',
    body: { enabled },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ key, enabled });
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
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  seedNow = now;
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-admin', 'admin@example.com', 'Admin', 'active', ?1, ?1),
              (2, 'sub-manager', 'manager@example.com', 'Manager', 'active', ?1, ?1),
              (3, 'sub-staff', 'staff@example.com', 'Staff', 'active', ?1, ?1),
              (4, 'sub-viewer', 'viewer@example.com', 'Viewer', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, created_at, updated_at)
       VALUES (1, 'WH1', '本社倉庫', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL, NULL), (2, 'INVENTORY_MANAGER', NULL, 1),
              (3, 'INVENTORY_STAFF', NULL, 1), (4, 'VIEWER', NULL, 1)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
       VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1), (2, 1, 'A-2', '棚A-2', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, created_at, updated_at)
       VALUES (1, 'SKU-BASE', '基本品', '個', 0, 0, ?1, ?1),
              (10, 'SKU-FLAG', 'フラグ検証品', '個', 0, 0, ?1, ?1),
              (20, 'SKU-SUG', '提案検証品', '個', 5, 0, ?1, ?1),
              (21, 'SKU-PO', '発注検証品', '個', 0, 0, ?1, ?1),
              (30, 'SKU-ANA', '分析検証品', '個', 0, 0, ?1, ?1),
              (31, 'SKU-DEAD', '滞留品', '個', 0, 0, ?1, ?1),
              (32, 'SKU-NOMOVE', '無移動品', '個', 0, 0, ?1, ?1)`,
    ).bind(now),
  ]);

  adminToken = await mintToken('sub-admin', 'admin@example.com', privateKey);
  managerToken = await mintToken('sub-manager', 'manager@example.com', privateKey);
  staffToken = await mintToken('sub-staff', 'staff@example.com', privateKey);
  viewerToken = await mintToken('sub-viewer', 'viewer@example.com', privateKey);
});

describe('機能フラグ', () => {
  it('GET /features は既定ですべて true を返し、/me にも features が入る', async () => {
    const res = await api('/api/v1/features', staffToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features: Record<string, boolean> };
    expect(Object.keys(body.features).sort()).toEqual(
      ['alerts', 'analytics', 'barcode_scan', 'csv', 'negative_stock', 'purchase_orders', 'stocktakes', 'transfers'].sort(),
    );
    expect(Object.values(body.features).every((v) => v === true)).toBe(true);

    const me = await api('/api/v1/me', staffToken);
    const meBody = (await me.json()) as { features: Record<string, boolean>; permissions: string[] };
    expect(meBody.features.transfers).toBe(true);
    expect(meBody.permissions).toContain('purchases.read');
    expect(meBody.permissions).not.toContain('purchases.write');
  });

  it('管理 API は admin.permissions 必須で、未知キーは 422、変更は監査ログに残る', async () => {
    const denied = await api('/api/v1/admin/features/transfers', staffToken, {
      method: 'PUT',
      body: { enabled: false },
    });
    expect(denied.status).toBe(403);

    const listDenied = await api('/api/v1/admin/features', staffToken);
    expect(listDenied.status).toBe(403);

    const unknown = await api('/api/v1/admin/features/nope', adminToken, {
      method: 'PUT',
      body: { enabled: false },
    });
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as { error: string }).error).toBe('UNKNOWN_FEATURE');

    const list = await api('/api/v1/admin/features', adminToken);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { features: { key: string; label: string; enabled: boolean }[] };
    expect(listBody.features).toHaveLength(8);
    expect(listBody.features.find((f) => f.key === 'transfers')).toMatchObject({ label: '在庫移動', enabled: true });

    await setFeature('transfers', false);
    const audit = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'feature_flag.update' AND target_id = 'transfers'",
    ).first<{ n: number }>();
    expect(audit?.n).toBeGreaterThanOrEqual(1);
    await setFeature('transfers', true);
  });

  it('transfers をオフにすると移動が 403 FEATURE_DISABLED になり、戻すと動く', async () => {
    const inRes = await inbound(staffToken, {
      locationId: 1, productId: 10, lotCode: 'F-A', expiryDate: '2027-01-01', quantity: 10,
    });
    expect(inRes.status).toBe(201);

    await setFeature('transfers', false);
    const blocked = await api('/api/v1/movements/transfer', staffToken, {
      method: 'POST',
      body: { fromLocationId: 1, toLocationId: 2, productId: 10, quantity: 3 },
    });
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: string }).error).toBe('FEATURE_DISABLED');

    await setFeature('transfers', true);
    const ok = await api('/api/v1/movements/transfer', staffToken, {
      method: 'POST',
      body: { fromLocationId: 1, toLocationId: 2, productId: 10, quantity: 3 },
    });
    expect(ok.status).toBe(201);
    expect(await stockQuantityByLot(10, 'F-A', 2)).toBe(3);
  });

  it('alerts / csv / stocktakes / negative_stock / purchase_orders / analytics のオフも強制される', async () => {
    await setFeature('alerts', false);
    const alerts = await api('/api/v1/alerts', adminToken);
    expect(alerts.status).toBe(403);
    expect(((await alerts.json()) as { error: string }).error).toBe('FEATURE_DISABLED');
    await setFeature('alerts', true);

    await setFeature('csv', false);
    const csvRes = await api('/api/v1/stocks.csv', adminToken);
    expect(csvRes.status).toBe(403);
    const importRes = await api('/api/v1/master/products/import', adminToken, {
      method: 'POST',
      rawBody: 'sku,name,unit\nX-1,品,個',
      contentType: 'text/csv',
    });
    expect(importRes.status).toBe(403);
    await setFeature('csv', true);
    const csvOk = await api('/api/v1/stocks.csv', adminToken);
    expect(csvOk.status).toBe(200);

    await setFeature('stocktakes', false);
    const st = await api('/api/v1/stocktakes', adminToken, { method: 'POST', body: {} });
    expect(st.status).toBe(403);
    await setFeature('stocktakes', true);

    const stockRow = await testEnv.DB.prepare(
      'SELECT s.id FROM stocks s JOIN lots l ON l.id = s.lot_id WHERE l.product_id = 10 AND s.location_id = 1',
    ).first<{ id: number }>();
    await setFeature('negative_stock', false);
    const neg = await api('/api/v1/negative-approvals', adminToken, {
      method: 'POST',
      body: { stockId: stockRow?.id, quantity: 1, reason: 'テスト' },
    });
    expect(neg.status).toBe(403);
    expect(((await neg.json()) as { error: string }).error).toBe('FEATURE_DISABLED');
    await setFeature('negative_stock', true);

    await setFeature('purchase_orders', false);
    const po = await api('/api/v1/purchase-orders', managerToken);
    expect(po.status).toBe(403);
    await setFeature('purchase_orders', true);

    await setFeature('analytics', false);
    const an = await api('/api/v1/analytics', adminToken);
    expect(an.status).toBe(403);
    await setFeature('analytics', true);
  });
});

describe('仕入先マスタ', () => {
  let supplierId = 0;

  it('CRUD ができ、書き込みは master.write が必要', async () => {
    const created = await api('/api/v1/master/suppliers', managerToken, {
      method: 'POST',
      body: { name: 'テスト商事', contact: '山田', email: 'sales@example.co.jp', phone: '03-0000-0000', note: '月末締め' },
    });
    expect(created.status).toBe(201);
    supplierId = ((await created.json()) as { id: number }).id;
    expect(supplierId).toBeGreaterThan(0);

    const staffCreate = await api('/api/v1/master/suppliers', staffToken, {
      method: 'POST',
      body: { name: '権限なし商事' },
    });
    expect(staffCreate.status).toBe(403);

    const list = await api('/api/v1/master/suppliers', staffToken);
    expect(list.status).toBe(200);
    const suppliers = (await list.json()) as { id: number; name: string }[];
    expect(suppliers.some((s) => s.id === supplierId && s.name === 'テスト商事')).toBe(true);

    const updated = await api(`/api/v1/master/suppliers/${supplierId}`, managerToken, {
      method: 'PUT',
      body: { name: 'テスト商事 (改)', phone: null },
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ name: 'テスト商事 (改)', phone: null });

    const deleted = await api(`/api/v1/master/suppliers/${supplierId}`, managerToken, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const after = (await (await api('/api/v1/master/suppliers', staffToken)).json()) as { id: number }[];
    expect(after.some((s) => s.id === supplierId)).toBe(false);
  });
});

describe('発注提案', () => {
  it('安全在庫を下回ると不足分と提案数量 (safety*2 - total) を返す', async () => {
    const first = await api('/api/v1/purchase-orders/suggestions', staffToken);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      productId: number; safetyStock: number; totalQuantity: number; shortage: number; suggestedQuantity: number;
    }[];
    const s1 = firstBody.find((s) => s.productId === 20);
    expect(s1).toMatchObject({ safetyStock: 5, totalQuantity: 0, shortage: 5, suggestedQuantity: 10 });

    const inRes = await inbound(staffToken, { locationId: 1, productId: 20, lotCode: 'SUG-1', quantity: 3 });
    expect(inRes.status).toBe(201);
    const second = (await (await api('/api/v1/purchase-orders/suggestions', staffToken)).json()) as typeof firstBody;
    expect(second.find((s) => s.productId === 20)).toMatchObject({
      totalQuantity: 3, shortage: 2, suggestedQuantity: 7,
    });

    const inRes2 = await inbound(staffToken, { locationId: 1, productId: 20, lotCode: 'SUG-1', quantity: 10 });
    expect(inRes2.status).toBe(201);
    const third = (await (await api('/api/v1/purchase-orders/suggestions', staffToken)).json()) as typeof firstBody;
    expect(third.find((s) => s.productId === 20)).toBeUndefined();
  });
});

describe('発注書と入荷', () => {
  let supplierId = 0;
  let poId = 0;
  let poLineId = 0;

  beforeAll(async () => {
    const res = await api('/api/v1/master/suppliers', adminToken, {
      method: 'POST',
      body: { name: '発注先物産' },
    });
    expect(res.status).toBe(201);
    supplierId = ((await res.json()) as { id: number }).id;
  });

  it('作成は purchases.write と冪等キーが必須で、再送は同じ発注書を返す', async () => {
    const staffCreate = await api('/api/v1/purchase-orders', staffToken, {
      method: 'POST',
      body: { supplierId, lines: [{ productId: 21, quantity: 10 }] },
    });
    expect(staffCreate.status).toBe(403);

    const noKey = await api('/api/v1/purchase-orders', managerToken, {
      method: 'POST',
      key: null,
      body: { supplierId, lines: [{ productId: 21, quantity: 10 }] },
    });
    expect(noKey.status).toBe(400);
    expect(((await noKey.json()) as { error: string }).error).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const body = { supplierId, expectedDate: '2026-11-01', lines: [{ productId: 21, quantity: 10, unitCost: 100 }] };
    const created = await api('/api/v1/purchase-orders', managerToken, { method: 'POST', key: 'po-create-1', body });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      id: number; status: string; supplierName: string;
      lines: { id: number; productId: number; quantity: number; receivedQuantity: number; unitCost: number }[];
    };
    expect(createdBody.status).toBe('draft');
    expect(createdBody.supplierName).toBe('発注先物産');
    expect(createdBody.lines).toHaveLength(1);
    expect(createdBody.lines[0]).toMatchObject({ productId: 21, quantity: 10, receivedQuantity: 0, unitCost: 100 });
    poId = createdBody.id;
    poLineId = createdBody.lines[0]!.id;

    const replay = await api('/api/v1/purchase-orders', managerToken, { method: 'POST', key: 'po-create-1', body });
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { id: number }).id).toBe(poId);

    const reused = await api('/api/v1/purchase-orders', managerToken, {
      method: 'POST',
      key: 'po-create-1',
      body: { supplierId, lines: [{ productId: 21, quantity: 99 }] },
    });
    expect(reused.status).toBe(422);
    expect(((await reused.json()) as { error: string }).error).toBe('IDEMPOTENCY_KEY_REUSED');

    const list = (await (await api('/api/v1/purchase-orders', managerToken)).json()) as { id: number }[];
    expect(list.filter((p) => p.id === poId)).toHaveLength(1);
  });

  it('部分入荷で ordered になり、全量入荷で received になって在庫へ反映される', async () => {
    const partial = await api(`/api/v1/purchase-orders/${poId}/receive`, managerToken, {
      method: 'POST',
      body: { locationId: 1, lines: [{ lineId: poLineId, quantity: 4, lotCode: 'PO-LOT-1' }] },
    });
    expect(partial.status).toBe(200);
    const partialBody = (await partial.json()) as {
      status: string; lines: { receivedQuantity: number }[];
    };
    expect(partialBody.status).toBe('ordered');
    expect(partialBody.lines[0]!.receivedQuantity).toBe(4);
    expect(await stockQuantityByLot(21, 'PO-LOT-1', 1)).toBe(4);

    const rest = await api(`/api/v1/purchase-orders/${poId}/receive`, managerToken, {
      method: 'POST',
      body: { locationId: 1, lines: [{ lineId: poLineId, quantity: 6, lotCode: 'PO-LOT-1' }] },
    });
    expect(rest.status).toBe(200);
    const restBody = (await rest.json()) as { status: string; lines: { receivedQuantity: number }[] };
    expect(restBody.status).toBe('received');
    expect(restBody.lines[0]!.receivedQuantity).toBe(10);
    expect(await stockQuantityByLot(21, 'PO-LOT-1', 1)).toBe(10);

    const again = await api(`/api/v1/purchase-orders/${poId}/receive`, managerToken, {
      method: 'POST',
      body: { locationId: 1, lines: [{ lineId: poLineId, quantity: 1, lotCode: 'PO-LOT-1' }] },
    });
    expect(again.status).toBe(409);
  });

  it('発注数を超える入荷は 422 OVER_RECEIVE', async () => {
    const created = await api('/api/v1/purchase-orders', managerToken, {
      method: 'POST',
      body: { supplierId, lines: [{ productId: 21, quantity: 2 }] },
    });
    expect(created.status).toBe(201);
    const po = (await created.json()) as { id: number; lines: { id: number }[] };
    const res = await api(`/api/v1/purchase-orders/${po.id}/receive`, managerToken, {
      method: 'POST',
      body: { locationId: 1, lines: [{ lineId: po.lines[0]!.id, quantity: 3, lotCode: 'PO-LOT-X' }] },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('OVER_RECEIVE');
  });

  it('棚卸しロック中の入荷は 423 で、終了後は入荷できる', async () => {
    const created = await api('/api/v1/purchase-orders', managerToken, {
      method: 'POST',
      body: { supplierId, lines: [{ productId: 21, quantity: 1 }] },
    });
    const po = (await created.json()) as { id: number; lines: { id: number }[] };

    const started = await api('/api/v1/stocktakes', adminToken, { method: 'POST', body: {} });
    expect(started.status).toBe(201);
    const stocktakeId = ((await started.json()) as { id: number }).id;

    const blocked = await api(`/api/v1/purchase-orders/${po.id}/receive`, managerToken, {
      method: 'POST',
      body: { locationId: 1, lines: [{ lineId: po.lines[0]!.id, quantity: 1, lotCode: 'PO-LOT-LOCK' }] },
    });
    expect(blocked.status).toBe(423);

    const finished = await api(`/api/v1/stocktakes/${stocktakeId}/finish`, adminToken, { method: 'POST', body: {} });
    expect(finished.status).toBe(200);

    const ok = await api(`/api/v1/purchase-orders/${po.id}/receive`, managerToken, {
      method: 'POST',
      body: { locationId: 1, lines: [{ lineId: po.lines[0]!.id, quantity: 1, lotCode: 'PO-LOT-LOCK' }] },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe('received');
  });
});

describe('分析レポート', () => {
  beforeAll(async () => {
    const updated = await api('/api/v1/master/products/30', adminToken, {
      method: 'PUT',
      body: { unitCost: 200 },
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { unitCost: number }).unitCost).toBe(200);

    const inRes = await inbound(staffToken, { locationId: 1, productId: 30, lotCode: 'ANA-1', quantity: 5 });
    expect(inRes.status).toBe(201);
    const consumed = await api('/api/v1/movements/consumption', staffToken, {
      method: 'POST',
      body: { productId: 30, quantity: 2, department: '製造部', purpose: '分析検証' },
    });
    expect(consumed.status).toBe(201);

    // 滞留在庫: 最終移動が 100 日前の在庫と、移動履歴の無い在庫を直接作る
    const old = seedNow - 100 * DAY;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO lots (id, product_id, lot_code, expiry_date, received_at, created_at, updated_at)
         VALUES (901, 31, 'DEAD-1', NULL, ?1, ?1, ?1), (902, 32, 'NOMOVE-1', NULL, ?1, ?1, ?1)`,
      ).bind(old),
      testEnv.DB.prepare(
        `INSERT INTO stocks (id, location_id, lot_id, quantity, version, created_at, updated_at)
         VALUES (901, 1, 901, 7, 1, ?1, ?1), (902, 1, 902, 4, 1, ?1, ?1)`,
      ).bind(old),
      testEnv.DB.prepare(
        `INSERT INTO stock_movements (id, document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, created_at)
         VALUES (901, 'doc-dead', 901, 'IN', 7, 0, 7, 1, ?1)`,
      ).bind(old),
    ]);
  });

  it('月別集計・評価額・カバー率・滞留・消費上位を返す', async () => {
    const res = await api('/api/v1/analytics', viewerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      monthly: { month: string; in: number; out: number }[];
      valuation: { totalValue: number; pricedProducts: number; totalProducts: number; coverageRate: number };
      deadStock: { productId: number; totalQuantity: number; lastMovementAt: number | null }[];
      topConsumed: { productId: number; quantity: number }[];
    };
    expect(body.monthly).toHaveLength(6);
    const currentMonth = new Date().toISOString().slice(0, 7);
    const thisMonth = body.monthly[body.monthly.length - 1]!;
    expect(thisMonth.month).toBe(currentMonth);
    expect(thisMonth.in).toBeGreaterThanOrEqual(5);
    expect(thisMonth.out).toBeGreaterThanOrEqual(2);

    // 単価を設定したのは商品 30 のみ。在庫 3 個 x 200 円 = 600 円
    expect(body.valuation.totalValue).toBe(600);
    expect(body.valuation.pricedProducts).toBe(1);
    expect(body.valuation.totalProducts).toBe(7);
    expect(body.valuation.coverageRate).toBeCloseTo(1 / 7, 5);

    const dead = body.deadStock.find((d) => d.productId === 31);
    expect(dead).toMatchObject({ totalQuantity: 7 });
    expect(dead?.lastMovementAt).toBe(seedNow - 100 * DAY);
    const noMove = body.deadStock.find((d) => d.productId === 32);
    expect(noMove).toMatchObject({ totalQuantity: 4, lastMovementAt: null });

    const top = body.topConsumed.find((t) => t.productId === 30);
    expect(top?.quantity).toBe(2);
  });
});
