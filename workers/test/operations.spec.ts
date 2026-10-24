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
import operationsSql from '../migrations/0016_operations.sql?raw';

/**
 * 商用レベル第2弾 (運営基盤) のうち店舗アプリ側の結合テスト:
 * - 初期セットアップ進捗 (GET /api/v1/setup/status) が実データで判定される
 * - CSV テンプレート (商品・保管場所) が取込形式で返る
 * - 同時実行 100 件 (入庫・消費・移動の混在) でも台帳の連鎖と実在庫が一致
 * - 5,000 SKU / 10,000 移動の規模でも在庫一覧・履歴一覧が完走し、
 *   一覧クエリが想定インデックスを使う (EXPLAIN で確認)
 *
 * ユーザー: 2 = 店舗1の在庫管理者。セットアップ検証のため割当は段階的に足す。
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let managerToken = '';
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

interface ApiResult {
  status: number;
  headers: Headers;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function api(
  path: string,
  token: string | null,
  init: { method?: string; body?: unknown; key?: string | null } = {},
): Promise<ApiResult> {
  idemSeq += 1;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.key !== null) headers['Idempotency-Key'] = init.key ?? `ops-${idemSeq}`;
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
    ...statementsOf(operationsSql),
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
      `INSERT INTO warehouses (id, code, name, store_id, created_at, updated_at)
       VALUES (1, 'WH1', '本社倉庫', 1, ?1, ?1)`,
    ).bind(now),
    // セットアップ判定の検証のため、はじめは管理者 1 人だけを割り当てる
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (2, 'INVENTORY_MANAGER', NULL, 1)`,
    ),
  ]);
  managerToken = await mintToken('sub-manager', 'manager@example.com', privateKey);
});

// ------------------------------------------------------------------ セットアップ

describe('初期セットアップ支援', () => {
  it('setup/status は実データで段階的に判定される', async () => {
    // 初期状態: 場所・商品なし / メンバー 1 人 / 機能フラグ未設定
    let res = await api('/api/v1/setup/status', managerToken);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual({ locations: false, products: false, members: false, features: false });
    expect(res.body.doneCount).toBe(0);
    expect(res.body.complete).toBe(false);

    // 保管場所を登録すると locations が立つ
    const loc = await api('/api/v1/master/locations', managerToken, {
      method: 'POST',
      body: { warehouseId: 1, code: 'A-1', name: '棚A-1' },
    });
    expect(loc.status).toBe(201);
    res = await api('/api/v1/setup/status', managerToken);
    expect(res.body.items.locations).toBe(true);
    expect(res.body.counts.locations).toBe(1);

    // 商品を登録すると products が立つ
    const prod = await api('/api/v1/master/products', managerToken, {
      method: 'POST',
      body: { sku: 'SKU-SETUP', name: '初期商品', unit: '個' },
    });
    expect(prod.status).toBe(201);
    res = await api('/api/v1/setup/status', managerToken);
    expect(res.body.items.products).toBe(true);

    // 2 人目の割当で members が立つ
    await testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id)
       VALUES (3, 'INVENTORY_STAFF', NULL, 1)`,
    ).run();
    res = await api('/api/v1/setup/status', managerToken);
    expect(res.body.items.members).toBe(true);
    expect(res.body.counts.members).toBe(2);

    // 機能フラグを 1 件でも設定すると features が立ち、完了になる
    await testEnv.DB.prepare(
      `INSERT INTO feature_flags (store_id, key, enabled, updated_by, updated_at)
       VALUES (1, 'alerts', 1, 2, ?1)`,
    ).bind(Date.now()).run();
    res = await api('/api/v1/setup/status', managerToken);
    expect(res.body.items.features).toBe(true);
    expect(res.body.doneCount).toBe(4);
    expect(res.body.complete).toBe(true);
  });

  it('setup/status は未認証では使えない', async () => {
    const res = await api('/api/v1/setup/status', null);
    expect(res.status).toBe(401);
  });

  it('商品 CSV テンプレートは取込と同じ列で返る', async () => {
    const res = await api('/api/v1/setup/template/products.csv', managerToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('products-template.csv');
    expect(res.text).toContain('sku,name,unit,requires_expiry,unit_cost');
    expect(res.text).toContain('SAMPLE-001');
  });

  it('保管場所 CSV テンプレートは階層つきの参考形式で返る', async () => {
    const res = await api('/api/v1/setup/template/locations.csv', managerToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('locations-template.csv');
    expect(res.text).toContain('warehouse_code,code,name,parent_code');
    expect(res.text).toContain('ZONE-A');
  });
});

// ------------------------------------------------------------------ 同時実行 100 件

async function ledgerChainOk(stockId: number): Promise<boolean> {
  const { results } = await testEnv.DB.prepare(
    'SELECT quantity_before, quantity_after, quantity_change FROM stock_movements WHERE stock_id = ?1 ORDER BY id ASC',
  )
    .bind(stockId)
    .all<{ quantity_before: number; quantity_after: number; quantity_change: number }>();
  if (results.length === 0) return false;
  let expected = 0;
  for (const m of results) {
    if (m.quantity_before !== expected) return false;
    if (m.quantity_after !== m.quantity_before + m.quantity_change) return false;
    expected = m.quantity_after;
  }
  const stock = await testEnv.DB.prepare('SELECT quantity FROM stocks WHERE id = ?1')
    .bind(stockId)
    .first<{ quantity: number }>();
  return stock !== null && stock.quantity === expected;
}

async function stockIdOf(productId: number, locationId: number): Promise<number> {
  const row = await testEnv.DB.prepare(
    `SELECT s.id FROM stocks s JOIN lots l ON l.id = s.lot_id
      WHERE l.product_id = ?1 AND s.location_id = ?2 AND s.store_id = 1`,
  )
    .bind(productId, locationId)
    .first<{ id: number }>();
  if (!row) throw new Error(`stock not found: product ${productId} location ${locationId}`);
  return row.id;
}

describe('同時実行 100 件の整合性', () => {
  it('入庫・消費・移動を混ぜて並行実行しても台帳と実在庫が一致する', async () => {
    const now = Date.now();
    // 競合用に専用の場所と商品を用意する (場所 1 はセットアップ検証で作成済み)
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
         VALUES (2, 1, 'B-1', '棚B-1', ?1, ?1)`,
      ).bind(now),
      testEnv.DB.prepare(
        `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, created_at, updated_at)
         VALUES (101, 'SKU-CC-IN', '並行入庫品', '個', 0, 0, ?1, ?1),
                (102, 'SKU-CC-OUT', '並行消費品', '個', 0, 0, ?1, ?1),
                (103, 'SKU-CC-MOVE', '並行移動品', '個', 0, 0, ?1, ?1)`,
      ).bind(now),
    ]);
    // 消費・移動の原資を先に入れておく
    for (const [productId, lot] of [[102, 'CC-OUT-1'], [103, 'CC-MOVE-1']] as const) {
      const seed = await api('/api/v1/movements/inbound', managerToken, {
        method: 'POST',
        body: { locationId: 1, productId, lotCode: lot, quantity: 100 },
      });
      expect(seed.status).toBe(201);
    }

    const jobs: Promise<ApiResult>[] = [];
    for (let i = 0; i < 40; i++) {
      jobs.push(api('/api/v1/movements/inbound', managerToken, {
        method: 'POST',
        body: { locationId: 1, productId: 101, lotCode: 'CC-IN-1', quantity: 2 },
        key: `cc-in-${i}`,
      }));
    }
    for (let i = 0; i < 30; i++) {
      jobs.push(api('/api/v1/movements/consumption', managerToken, {
        method: 'POST',
        body: { productId: 102, quantity: 1, department: '製造部', purpose: '並行検証' },
        key: `cc-out-${i}`,
      }));
    }
    for (let i = 0; i < 30; i++) {
      jobs.push(api('/api/v1/movements/transfer', managerToken, {
        method: 'POST',
        body: { fromLocationId: 1, toLocationId: 2, productId: 103, quantity: 1 },
        key: `cc-move-${i}`,
      }));
    }
    const results = await Promise.all(jobs);
    for (const r of results) {
      expect([200, 201]).toContain(r.status);
    }

    // 数量: 入庫品 40×2=80 / 消費品 100-30=70 / 移動品 元 100-30=70・先 30
    const inStock = await stockIdOf(101, 1);
    const outStock = await stockIdOf(102, 1);
    const moveFrom = await stockIdOf(103, 1);
    const moveTo = await stockIdOf(103, 2);
    const qty = async (id: number) =>
      (await testEnv.DB.prepare('SELECT quantity FROM stocks WHERE id = ?1').bind(id).first<{ quantity: number }>())?.quantity;
    expect(await qty(inStock)).toBe(80);
    expect(await qty(outStock)).toBe(70);
    expect(await qty(moveFrom)).toBe(70);
    expect(await qty(moveTo)).toBe(30);

    // 台帳の連鎖 (quantity_before → quantity_after) が全行でつながり、実在庫と一致する
    for (const id of [inStock, outStock, moveFrom, moveTo]) {
      expect(await ledgerChainOk(id)).toBe(true);
    }
    // 移動は OUT/IN が対で残る
    const moveOut = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM stock_movements WHERE stock_id = ?1 AND type = 'TRANSFER_OUT'",
    ).bind(moveFrom).first<{ n: number }>();
    const moveIn = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM stock_movements WHERE stock_id = ?1 AND type = 'TRANSFER_IN'",
    ).bind(moveTo).first<{ n: number }>();
    expect(moveOut?.n).toBe(30);
    expect(moveIn?.n).toBe(30);
  }, 120_000);
});

// ------------------------------------------------------------------ 大規模データ

describe('大規模データでの一覧取得', () => {
  it('5,000 SKU・10,000 移動でも在庫一覧と履歴一覧が完走する', async () => {
    const now = Date.now();
    const PRODUCT_BASE = 2000;
    const PRODUCT_COUNT = 5000;
    const CHUNK = 500;
    // 商品・ロット・在庫を各 5,000 件、移動を各在庫 2 件ずつ = 10,000 件作る
    for (let start = 0; start < PRODUCT_COUNT; start += CHUNK) {
      const productRows: string[] = [];
      const lotRows: string[] = [];
      const stockRows: string[] = [];
      const movementRows: string[] = [];
      for (let i = start; i < Math.min(start + CHUNK, PRODUCT_COUNT); i++) {
        const pid = PRODUCT_BASE + i;
        productRows.push(`(${pid}, 1, 'SKU-SCALE-${i}', '規模品${i}', '個', 0, 0, ${now}, ${now})`);
        lotRows.push(`(${pid}, ${pid}, 'LOT-SCALE-${i}', NULL, ${now}, 1, ${now}, ${now})`);
        stockRows.push(`(${pid}, 1, ${pid}, 10, 1, 1, ${now}, ${now})`);
        movementRows.push(
          `('scale-${i}-a', ${pid}, 'IN', 5, 0, 5, 2, 1, ${now})`,
          `('scale-${i}-b', ${pid}, 'IN', 5, 5, 10, 2, 1, ${now})`,
        );
      }
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO products (id, store_id, sku, name, unit, safety_stock, requires_expiry, created_at, updated_at) VALUES ${productRows.join(',')}`,
        ),
        testEnv.DB.prepare(
          `INSERT INTO lots (id, product_id, lot_code, expiry_date, received_at, store_id, created_at, updated_at) VALUES ${lotRows.join(',')}`,
        ),
        testEnv.DB.prepare(
          `INSERT INTO stocks (id, location_id, lot_id, quantity, version, store_id, created_at, updated_at) VALUES ${stockRows.join(',')}`,
        ),
        testEnv.DB.prepare(
          `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, store_id, created_at) VALUES ${movementRows.join(',')}`,
        ),
      ]);
    }
    const counts = await testEnv.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM products WHERE store_id = 1) AS products, (SELECT COUNT(*) FROM stock_movements WHERE store_id = 1) AS movements',
    ).first<{ products: number; movements: number }>();
    expect(counts?.products).toBeGreaterThanOrEqual(5000);
    expect(counts?.movements).toBeGreaterThanOrEqual(10000);

    // 在庫一覧 (1 ページ 200 件) が返る
    let started = Date.now();
    const stocksRes = await api('/api/v1/stocks?take=200', managerToken);
    const stocksMs = Date.now() - started;
    expect(stocksRes.status).toBe(200);
    expect(Array.isArray(stocksRes.body)).toBe(true);
    expect(stocksRes.body.length).toBe(200);

    // 深いページ (skip=4800) でも返る
    const deepRes = await api('/api/v1/stocks?take=200&skip=4800', managerToken);
    expect(deepRes.status).toBe(200);
    expect(deepRes.body.length).toBeGreaterThan(0);

    // 履歴一覧 (新しい順 200 件) が返る
    started = Date.now();
    const movementsRes = await api('/api/v1/movements?take=200', managerToken);
    const movementsMs = Date.now() - started;
    expect(movementsRes.status).toBe(200);
    expect(movementsRes.body.length).toBe(200);

    // 目安: テスト環境で数秒以内 (超過したらインデックス不足を疑う)
    expect(stocksMs).toBeLessThan(8000);
    expect(movementsMs).toBeLessThan(8000);

    // 一覧クエリが店舗インデックスで検索し、フルスキャンしないことを EXPLAIN で裏取りする
    const stocksPlan = await testEnv.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT s.id FROM stocks s
         JOIN locations loc ON loc.id = s.location_id JOIN lots l ON l.id = s.lot_id
         JOIN products p ON p.id = l.product_id
        WHERE s.store_id = 1 ORDER BY s.id ASC LIMIT 200`,
    ).all<{ detail: string }>();
    const stocksPlanText = stocksPlan.results.map((r) => r.detail).join(' ');
    expect(stocksPlanText).toContain('SEARCH s USING INDEX idx_stocks_store');
    expect(stocksPlanText).not.toMatch(/(^|\s)SCAN s(\s|$)/);
    const movementsPlan = await testEnv.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT mv.id FROM stock_movements mv
         JOIN stocks s ON s.id = mv.stock_id JOIN locations loc ON loc.id = s.location_id
         JOIN lots l ON l.id = s.lot_id JOIN products p ON p.id = l.product_id
        WHERE mv.store_id = 1 ORDER BY mv.id DESC LIMIT 200`,
    ).all<{ detail: string }>();
    const movementsPlanText = movementsPlan.results.map((r) => r.detail).join(' ');
    expect(movementsPlanText).toContain('SEARCH mv USING INDEX idx_movements_store');
    expect(movementsPlanText).not.toMatch(/(^|\s)SCAN mv(\s|$)/);
  }, 180_000);
});
