import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import initSql from '../migrations/0001_init.sql?raw';
import seedSql from '../migrations/0002_seed_roles.sql?raw';
import permissionsSql from '../migrations/0003_permissions.sql?raw';
import businessSql from '../migrations/0005_business_completion.sql?raw';

/**
 * 業務機能の完成 (商品化ステップ3) の結合テスト: 実 D1 に 0001〜0003 + 0005 を
 * 適用し、テスト用 OIDC トークンで HTTP 経路を通す。
 * - 在庫移動 (FEFO / lot 指定 / 不足 409 / スコープ 403 / 棚卸し中 423 / 冪等)
 * - 棚卸しの実数入力と差異承認 (pending_approval -> 承認で ADJUST 反映 / 差し戻し)
 * - マスタ CRUD (編集・論理削除)
 * - CSV エクスポート / インポート
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let adminToken = '';
let staffToken = '';
let scopedToken = '';
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

async function api(
  path: string,
  token: string,
  init: { method?: string; body?: unknown; key?: string; rawBody?: string; contentType?: string } = {},
): Promise<Response> {
  idemSeq += 1;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Idempotency-Key': init.key ?? `biz-test-${idemSeq}`,
  };
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
  key?: string,
): Promise<{ status: number; body: { stockId: number; quantity: number } }> {
  const res = await api('/api/v1/movements/inbound', token, { method: 'POST', body, key });
  return { status: res.status, body: (await res.json()) as { stockId: number; quantity: number } };
}

async function stockQuantity(stockId: number): Promise<number> {
  const row = await testEnv.DB.prepare('SELECT quantity FROM stocks WHERE id = ?1')
    .bind(stockId)
    .first<{ quantity: number }>();
  return row?.quantity ?? Number.NaN;
}

async function lotIdOf(productId: number, lotCode: string): Promise<number> {
  const res = await api(`/api/v1/master/lots?productId=${productId}`, adminToken);
  const lots = (await res.json()) as { id: number; lotCode: string }[];
  const lot = lots.find((l) => l.lotCode === lotCode);
  if (!lot) throw new Error(`lot ${lotCode} not found`);
  return lot.id;
}

async function stockIdAt(locationId: number, lotId: number): Promise<number> {
  const row = await testEnv.DB.prepare(
    'SELECT id FROM stocks WHERE location_id = ?1 AND lot_id = ?2',
  )
    .bind(locationId, lotId)
    .first<{ id: number }>();
  if (!row) throw new Error(`stock not found at location ${locationId} lot ${lotId}`);
  return row.id;
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
    ...statementsOf(businessSql),
  ]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-admin', 'admin@example.com', 'Admin', 'active', ?1, ?1),
              (2, 'sub-staff', 'staff@example.com', 'Staff', 'active', ?1, ?1),
              (3, 'sub-scoped', 'scoped@example.com', 'Scoped', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, created_at, updated_at)
       VALUES (1, 'WH1', '本社倉庫', ?1, ?1), (2, 'WH2', '第二倉庫', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id)
       VALUES (1, 'SYSTEM_ADMIN', NULL), (2, 'INVENTORY_STAFF', NULL), (3, 'INVENTORY_STAFF', 2)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
       VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1), (2, 1, 'A-2', '棚A-2', ?1, ?1), (3, 2, 'B-1', '棚B-1', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, created_at, updated_at)
       VALUES (1, 'SKU-1', 'テスト品', '個', 0, 0, ?1, ?1)`,
    ).bind(now),
  ]);

  adminToken = await mintToken('sub-admin', 'admin@example.com', privateKey);
  staffToken = await mintToken('sub-staff', 'staff@example.com', privateKey);
  scopedToken = await mintToken('sub-scoped', 'scoped@example.com', privateKey);
});

describe('在庫移動 (transfer)', () => {
  it('FEFO で複数ロットから引き、移動先へ加算され、台帳が同一伝票で対になる', async () => {
    const a = await inbound(staffToken, {
      locationId: 1, productId: 1, lotCode: 'LOT-T1-A', expiryDate: '2027-01-01', quantity: 5,
    });
    expect(a.status).toBe(201);
    const b = await inbound(staffToken, {
      locationId: 1, productId: 1, lotCode: 'LOT-T1-B', expiryDate: '2027-06-01', quantity: 5,
    });
    expect(b.status).toBe(201);

    const res = await api('/api/v1/movements/transfer', staffToken, {
      method: 'POST',
      body: { fromLocationId: 1, toLocationId: 2, productId: 1, quantity: 7 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      documentId: string;
      allocations: { lotId: number; fromStockId: number; toStockId: number; quantity: number }[];
    };
    const lotA = await lotIdOf(1, 'LOT-T1-A');
    const lotB = await lotIdOf(1, 'LOT-T1-B');
    // 期限の早い A から 5、B から 2
    expect(body.allocations).toEqual([
      { lotId: lotA, fromStockId: a.body.stockId, toStockId: await stockIdAt(2, lotA), quantity: 5 },
      { lotId: lotB, fromStockId: b.body.stockId, toStockId: await stockIdAt(2, lotB), quantity: 2 },
    ]);
    expect(await stockQuantity(a.body.stockId)).toBe(0);
    expect(await stockQuantity(b.body.stockId)).toBe(3);
    expect(await stockQuantity(await stockIdAt(2, lotA))).toBe(5);
    expect(await stockQuantity(await stockIdAt(2, lotB))).toBe(2);

    const movements = await testEnv.DB.prepare(
      'SELECT type, quantity_change FROM stock_movements WHERE document_id = ?1 ORDER BY id ASC',
    )
      .bind(body.documentId)
      .all<{ type: string; quantity_change: number }>();
    expect(movements.results.map((m) => m.type)).toEqual([
      'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'TRANSFER_IN',
    ]);
    expect(movements.results.map((m) => m.quantity_change)).toEqual([-5, 5, -2, 2]);
  });

  it('lotId 指定時はそのロットだけから移動する', async () => {
    const lotB = await lotIdOf(1, 'LOT-T1-B');
    const srcBefore = await stockQuantity(await stockIdAt(1, lotB));
    const dstBefore = await stockQuantity(await stockIdAt(2, lotB));
    const res = await api('/api/v1/movements/transfer', staffToken, {
      method: 'POST',
      body: { fromLocationId: 1, toLocationId: 2, productId: 1, lotId: lotB, quantity: 2 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { allocations: { lotId: number; quantity: number }[] };
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0]).toMatchObject({ lotId: lotB, quantity: 2 });
    expect(await stockQuantity(await stockIdAt(1, lotB))).toBe(srcBefore - 2);
    expect(await stockQuantity(await stockIdAt(2, lotB))).toBe(dstBefore + 2);
  });

  it('在庫不足は 409 で、在庫も台帳も汚れない', async () => {
    const before = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM stock_movements WHERE type LIKE 'TRANSFER%'",
    ).first<{ n: number }>();
    const res = await api('/api/v1/movements/transfer', staffToken, {
      method: 'POST',
      body: { fromLocationId: 1, toLocationId: 2, productId: 1, quantity: 1000 },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('INSUFFICIENT_STOCK');
    const after = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM stock_movements WHERE type LIKE 'TRANSFER%'",
    ).first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('倉庫スコープ外 (片側でも) は 403', async () => {
    // scoped は倉庫 2 のみ。移動元が倉庫 1 なら不可
    const fromOut = await api('/api/v1/movements/transfer', scopedToken, {
      method: 'POST',
      body: { fromLocationId: 1, toLocationId: 3, productId: 1, quantity: 1 },
    });
    expect(fromOut.status).toBe(403);
    // 移動先が倉庫 1 でも不可
    const toOut = await api('/api/v1/movements/transfer', scopedToken, {
      method: 'POST',
      body: { fromLocationId: 3, toLocationId: 1, productId: 1, quantity: 1 },
    });
    expect(toOut.status).toBe(403);
  });

  it('同一キー・同一内容の再送は冪等リプレイ (二重に動かない)', async () => {
    const lotB = await lotIdOf(1, 'LOT-T1-B');
    const srcId = await stockIdAt(1, lotB);
    const dstId = await stockIdAt(2, lotB);
    const srcBefore = await stockQuantity(srcId);
    const dstBefore = await stockQuantity(dstId);
    const payload = {
      method: 'POST',
      body: { fromLocationId: 1, toLocationId: 2, productId: 1, lotId: lotB, quantity: 1 },
      key: 'transfer-idem-1',
    } as const;
    const first = await api('/api/v1/movements/transfer', staffToken, payload);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { documentId: string };
    const replay = await api('/api/v1/movements/transfer', staffToken, payload);
    expect(replay.status).toBe(201);
    expect(((await replay.json()) as { documentId: string }).documentId).toBe(firstBody.documentId);
    expect(await stockQuantity(srcId)).toBe(srcBefore - 1);
    expect(await stockQuantity(dstId)).toBe(dstBefore + 1);
  });

  it('棚卸し実施中は 423', async () => {
    const started = await api('/api/v1/stocktakes', adminToken, { method: 'POST', body: {} });
    expect(started.status).toBe(201);
    const stocktakeId = ((await started.json()) as { id: number }).id;

    const blocked = await api('/api/v1/movements/transfer', staffToken, {
      method: 'POST',
      body: { fromLocationId: 1, toLocationId: 2, productId: 1, quantity: 1 },
    });
    expect(blocked.status).toBe(423);

    // 実数を入れていないので差異なしで即 confirmed
    const finished = await api(`/api/v1/stocktakes/${stocktakeId}/finish`, adminToken, {
      method: 'POST',
      body: {},
    });
    expect(finished.status).toBe(200);
    expect(((await finished.json()) as { status: string }).status).toBe('confirmed');
  });
});

describe('棚卸しの実数入力と差異承認', () => {
  let product2Id = 0;
  let stock2Id = 0;

  it('差異ありは pending_approval になり、差し戻しで戻り、承認で ADJUST 反映される', async () => {
    const created = await api('/api/v1/master/products', adminToken, {
      method: 'POST',
      body: { sku: 'SKU-2', name: '棚卸し対象品', unit: '個' },
    });
    expect(created.status).toBe(201);
    product2Id = ((await created.json()) as { id: number }).id;

    const inboundRes = await inbound(adminToken, {
      locationId: 1, productId: product2Id, lotCode: 'LOT-S1', quantity: 10,
    });
    expect(inboundRes.status).toBe(201);
    stock2Id = inboundRes.body.stockId;

    const started = await api('/api/v1/stocktakes', adminToken, { method: 'POST', body: {} });
    expect(started.status).toBe(201);
    const stocktakeId = ((await started.json()) as { id: number }).id;

    const detail = await api(`/api/v1/stocktakes/${stocktakeId}`, adminToken);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      status: string;
      lines: { id: number; productId: number; bookQuantity: number; countedQuantity: number | null; difference: number | null }[];
    };
    const line = detailBody.lines.find((l) => l.productId === product2Id);
    if (!line) throw new Error('line for product2 not found');
    expect(line.bookQuantity).toBe(10);
    expect(line.countedQuantity).toBeNull();

    const counted = await api(`/api/v1/stocktakes/${stocktakeId}/lines/${line.id}`, adminToken, {
      method: 'PUT',
      body: { countedQuantity: 7 },
    });
    expect(counted.status).toBe(200);
    expect(((await counted.json()) as { difference: number }).difference).toBe(-3);

    const finished = await api(`/api/v1/stocktakes/${stocktakeId}/finish`, adminToken, {
      method: 'POST',
      body: {},
    });
    expect(finished.status).toBe(200);
    const finishedBody = (await finished.json()) as {
      status: string;
      differences: { stockId: number; difference: number }[];
    };
    expect(finishedBody.status).toBe('pending_approval');
    expect(finishedBody.differences).toEqual([
      expect.objectContaining({ stockId: stock2Id, difference: -3 }),
    ]);
    // 在庫はまだ変わっていない
    expect(await stockQuantity(stock2Id)).toBe(10);

    // 承認待ちの間も全面停止は継続する
    const blockedInbound = await inbound(adminToken, {
      locationId: 1, productId: product2Id, lotCode: 'LOT-S2', quantity: 1,
    });
    expect(blockedInbound.status).toBe(423);

    // 実数入力は pending_approval 中はできない
    const countedLate = await api(`/api/v1/stocktakes/${stocktakeId}/lines/${line.id}`, adminToken, {
      method: 'PUT',
      body: { countedQuantity: 9 },
    });
    expect(countedLate.status).toBe(409);

    // 差し戻し: in_progress に戻り、実数は保持される
    const rejected = await api(`/api/v1/stocktakes/${stocktakeId}/decide`, adminToken, {
      method: 'POST',
      body: { approve: false },
    });
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as { status: string }).status).toBe('in_progress');
    const detailAfterReject = await api(`/api/v1/stocktakes/${stocktakeId}`, adminToken);
    const lineAfterReject = ((await detailAfterReject.json()) as {
      lines: { id: number; countedQuantity: number | null }[];
    }).lines.find((l) => l.id === line.id);
    expect(lineAfterReject?.countedQuantity).toBe(7);
    expect(await stockQuantity(stock2Id)).toBe(10);

    // 再度 finish -> pending_approval -> 承認で在庫が実数に合う
    const finished2 = await api(`/api/v1/stocktakes/${stocktakeId}/finish`, adminToken, {
      method: 'POST',
      body: {},
    });
    expect(((await finished2.json()) as { status: string }).status).toBe('pending_approval');

    const approved = await api(`/api/v1/stocktakes/${stocktakeId}/decide`, adminToken, {
      method: 'POST',
      body: { approve: true },
    });
    expect(approved.status).toBe(200);
    const approvedBody = (await approved.json()) as {
      status: string;
      adjustments: { stockId: number; difference: number; quantityAfter: number }[];
    };
    expect(approvedBody.status).toBe('confirmed');
    expect(approvedBody.adjustments).toEqual([
      expect.objectContaining({ stockId: stock2Id, difference: -3, quantityAfter: 7 }),
    ]);
    expect(await stockQuantity(stock2Id)).toBe(7);

    const adjust = await testEnv.DB.prepare(
      `SELECT type, quantity_change, quantity_before, quantity_after, reason
         FROM stock_movements WHERE stock_id = ?1 AND type = 'ADJUST'`,
    )
      .bind(stock2Id)
      .first<{ type: string; quantity_change: number; quantity_before: number; quantity_after: number; reason: string }>();
    expect(adjust).toMatchObject({
      quantity_change: -3,
      quantity_before: 10,
      quantity_after: 7,
      reason: 'stocktake-adjustment',
    });
  });

  it('差異なし (実数 = 帳簿数) は即 confirmed', async () => {
    const started = await api('/api/v1/stocktakes', adminToken, { method: 'POST', body: {} });
    expect(started.status).toBe(201);
    const stocktakeId = ((await started.json()) as { id: number }).id;

    const detail = await api(`/api/v1/stocktakes/${stocktakeId}`, adminToken);
    const lines = ((await detail.json()) as {
      lines: { id: number; productId: number; bookQuantity: number }[];
    }).lines;
    const line = lines.find((l) => l.productId === product2Id);
    if (!line) throw new Error('line for product2 not found');
    const counted = await api(`/api/v1/stocktakes/${stocktakeId}/lines/${line.id}`, adminToken, {
      method: 'PUT',
      body: { countedQuantity: line.bookQuantity },
    });
    expect(counted.status).toBe(200);

    const finished = await api(`/api/v1/stocktakes/${stocktakeId}/finish`, adminToken, {
      method: 'POST',
      body: {},
    });
    expect(finished.status).toBe(200);
    expect(((await finished.json()) as { status: string }).status).toBe('confirmed');
  });
});

describe('マスタ CRUD', () => {
  it('商品・倉庫・場所・ロットの編集と論理削除ができる', async () => {
    // 商品
    const created = await api('/api/v1/master/products', adminToken, {
      method: 'POST',
      body: { sku: 'SKU-CRUD', name: '編集前', unit: '個' },
    });
    expect(created.status).toBe(201);
    const productId = ((await created.json()) as { id: number }).id;

    const updated = await api(`/api/v1/master/products/${productId}`, adminToken, {
      method: 'PUT',
      body: { name: '編集後', safetyStock: 4 },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()) as { name: string; safetyStock: number }).toMatchObject({
      name: '編集後',
      safetyStock: 4,
    });

    // 倉庫・場所
    const whUpdated = await api('/api/v1/master/warehouses/2', adminToken, {
      method: 'PUT',
      body: { name: '第二倉庫 (改称)' },
    });
    expect(whUpdated.status).toBe(200);
    expect(((await whUpdated.json()) as { name: string }).name).toBe('第二倉庫 (改称)');

    const locUpdated = await api('/api/v1/master/locations/3', adminToken, {
      method: 'PUT',
      body: { name: '棚B-1 (改称)' },
    });
    expect(locUpdated.status).toBe(200);

    // ロット: 作成 -> 編集 (lot_code と期限のみ) -> 削除
    const lotCreated = await api('/api/v1/master/lots', adminToken, {
      method: 'POST',
      body: { productId: 1, lotCode: 'LOT-EDIT', expiryDate: '2028-01-01' },
    });
    expect(lotCreated.status).toBe(201);
    const lotId = ((await lotCreated.json()) as { id: number }).id;

    const lotUpdated = await api(`/api/v1/master/lots/${lotId}`, adminToken, {
      method: 'PUT',
      body: { lotCode: 'LOT-EDITED', expiryDate: '2028-02-02' },
    });
    expect(lotUpdated.status).toBe(200);
    expect((await lotUpdated.json()) as { lotCode: string; expiryDate: string }).toMatchObject({
      lotCode: 'LOT-EDITED',
      expiryDate: '2028-02-02',
    });

    const lotDeleted = await api(`/api/v1/master/lots/${lotId}`, adminToken, { method: 'DELETE' });
    expect(lotDeleted.status).toBe(200);
    const lotsAfter = await api('/api/v1/master/lots?productId=1', adminToken);
    const lots = (await lotsAfter.json()) as { id: number }[];
    expect(lots.map((l) => l.id)).not.toContain(lotId);

    // 商品の論理削除: 一覧から消える
    const deleted = await api(`/api/v1/master/products/${productId}`, adminToken, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const list = await api('/api/v1/master/products?take=200', adminToken);
    const products = (await list.json()) as { id: number }[];
    expect(products.map((p) => p.id)).not.toContain(productId);

    // 削除済みへの再削除・存在しない ID は 404
    const again = await api(`/api/v1/master/products/${productId}`, adminToken, { method: 'DELETE' });
    expect(again.status).toBe(404);
    const missing = await api('/api/v1/master/products/99999', adminToken, {
      method: 'PUT',
      body: { name: 'x' },
    });
    expect(missing.status).toBe(404);
  });

  it('master.write の無いユーザーは編集できない (403)', async () => {
    const res = await api('/api/v1/master/products/1', staffToken, {
      method: 'PUT',
      body: { name: 'だめ' },
    });
    expect(res.status).toBe(403);
  });
});

describe('CSV 入出力', () => {
  it('在庫 CSV はスコープ内の在庫を返し、スコープ外は含まれない', async () => {
    const res = await api('/api/v1/stocks.csv', staffToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('stocks.csv');
    const text = await res.text();
    expect(text).toContain('商品コード');
    expect(text).toContain('SKU-1');
    expect(text).toContain('LOT-T1-A');

    // 倉庫 2 のみのユーザーには倉庫 1 の在庫が含まれない
    const scopedRes = await api('/api/v1/stocks.csv', scopedToken);
    expect(scopedRes.status).toBe(200);
    const scopedText = await scopedRes.text();
    expect(scopedText).toContain('商品コード');
    expect(scopedText).not.toContain('SKU-1');
  });

  it('CSV インポート (テキスト) は登録・スキップ・失敗を集計する', async () => {
    const csv = [
      'sku,name,unit,requires_expiry',
      'CSV-NEW,新規商品,個,true',
      'SKU-1,重複商品,個,false',
      ',名前なし,個,false',
    ].join('\n');
    const res = await api('/api/v1/master/products/import', adminToken, {
      method: 'POST',
      rawBody: csv,
      contentType: 'text/csv',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      created: number;
      skipped: number;
      failed: { line: number; sku?: string; reason: string }[];
    };
    expect(body.total).toBe(3);
    expect(body.created).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]?.line).toBe(4);

    const list = await api('/api/v1/master/products?take=200', adminToken);
    const products = (await list.json()) as { sku: string; requiresExpiry: boolean }[];
    expect(products.find((p) => p.sku === 'CSV-NEW')?.requiresExpiry).toBe(true);
  });

  it('CSV インポート (multipart) でファイルを登録できる', async () => {
    const form = new FormData();
    const file = new File(['sku,name,unit,requires_expiry\nCSV-MP,MP商品,箱,false\n'], 'products.csv', {
      type: 'text/csv',
    });
    form.append('file', file);
    idemSeq += 1;
    const res = await SELF.fetch('https://example.com/api/v1/master/products/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': `biz-test-${idemSeq}` },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: number };
    expect(body.created).toBe(1);
  });

  it('master.write の無いユーザーはインポートできない (403)', async () => {
    const res = await api('/api/v1/master/products/import', staffToken, {
      method: 'POST',
      rawBody: 'sku,name,unit\nX-1,だめ,個\n',
      contentType: 'text/csv',
    });
    expect(res.status).toBe(403);
  });
});
