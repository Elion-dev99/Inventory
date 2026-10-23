import { env, SELF } from 'cloudflare:test';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import initSql from '../migrations/0001_init.sql?raw';
import seedSql from '../migrations/0002_seed_roles.sql?raw';
import permissionsSql from '../migrations/0003_permissions.sql?raw';
import businessSql from '../migrations/0005_business_completion.sql?raw';

/**
 * 同時実行・二重送信・整合性プロパティの結合テスト (要件で必須とされた観点)。
 * 実 D1 (miniflare) + HTTP 経路で検証する。
 *
 * - 同一 Idempotency-Key の並行リクエスト (二重送信) は 1 回だけ適用される
 * - 異なるキーの並行消費は、在庫総量を超えて成功しない (Coordinator の直列化)
 * - 疑似乱数の操作列の後も「stocks.quantity = その stock の台帳 quantity_change 累計」
 *   が全行で一致し、承認なしにマイナスにならない
 * - 楽観ロック (version 条件 + write_guards) の SQL 契約: version 不一致の batch は
 *   制約違反で全体がロールバックし 409 相当になる。単一 DO の直列処理では公開 API
 *   から version 不一致に到達できないため、Coordinator が使うのと同じ文面で固定する
 */

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = '1099201950238-iq41o4dmf63nnitj43ifnfojqvtbip8s.apps.googleusercontent.com';

interface TestEnv {
  DB: D1Database;
}
const testEnv = env as unknown as TestEnv;

let staffToken = '';
let keySeq = 0;

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
  init: { method?: string; body?: unknown; key?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  keySeq += 1;
  const res = await SELF.fetch(`https://example.com${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${staffToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': init.key ?? `conc-test-${keySeq}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

function inbound(locationId: number, productId: number, lotCode: string, quantity: number, key?: string) {
  return api('/api/v1/movements/inbound', {
    method: 'POST',
    body: { locationId, productId, lotCode, quantity },
    ...(key ? { key } : {}),
  });
}

function consume(productId: number, quantity: number, key?: string) {
  return api('/api/v1/movements/consumption', {
    method: 'POST',
    body: { productId, quantity, department: '製造部', purpose: '並行テスト' },
    ...(key ? { key } : {}),
  });
}

async function stockQuantity(stockId: number): Promise<number> {
  const row = await testEnv.DB.prepare('SELECT quantity FROM stocks WHERE id = ?1')
    .bind(stockId)
    .first<{ quantity: number }>();
  return row?.quantity ?? Number.NaN;
}

async function movementCount(stockId: number, type: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    'SELECT COUNT(*) AS n FROM stock_movements WHERE stock_id = ?1 AND type = ?2',
  )
    .bind(stockId, type)
    .first<{ n: number }>();
  return row?.n ?? 0;
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

/** 決定的な疑似乱数 (mulberry32)。シード固定で操作列を再現可能にする */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
       VALUES (1, 'sub-staff', 'staff@example.com', 'Staff', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id) VALUES (1, 'INVENTORY_STAFF', NULL)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, created_at, updated_at) VALUES (1, 'WH1', '本社倉庫', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at)
       VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1), (2, 1, 'A-2', '棚A-2', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, created_at, updated_at)
       VALUES (1, 'SKU-C1', '並行テスト品1', '個', 0, 0, ?1, ?1),
              (2, 'SKU-C2', '並行テスト品2', '個', 0, 0, ?1, ?1)`,
    ).bind(now),
  ]);

  staffToken = await mintToken('sub-staff', 'staff@example.com', privateKey);
});

describe('同時実行と二重送信 (HTTP + Coordinator 直列化)', () => {
  it('同一 Idempotency-Key の並行した消費は 1 回だけ適用される', async () => {
    const seed = await inbound(1, 1, 'LOT-CC', 20);
    expect(seed.status).toBe(201);
    const stockId = seed.body.stockId as number;

    const key = 'conc-same-key-consume';
    const results = await Promise.all([0, 1, 2, 3, 4].map(() => consume(1, 5, key)));
    // 5 本とも成功扱い (1 本が実適用、残りは保存済みレスポンスのリプレイ)
    for (const r of results) expect(r.status).toBe(201);
    const docIds = new Set(results.map((r) => (r.body as { documentId?: string }).documentId));
    expect(docIds.size).toBe(1);
    // 在庫は 1 回分だけ減り、台帳も 1 件だけ
    expect(await stockQuantity(stockId)).toBe(15);
    expect(await movementCount(stockId, 'OUT')).toBe(1);
  });

  it('同一 Idempotency-Key の並行した入庫は stocks を 1 行だけ作る', async () => {
    const key = 'conc-same-key-inbound';
    const results = await Promise.all([0, 1, 2, 3, 4].map(() => inbound(2, 1, 'LOT-CD', 7, key)));
    for (const r of results) expect(r.status).toBe(201);
    const stockIds = new Set(results.map((r) => r.body.stockId));
    expect(stockIds.size).toBe(1);
    const stockId = results[0]?.body.stockId as number;
    expect(await stockQuantity(stockId)).toBe(7);
    const rows = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM stocks s JOIN lots l ON l.id = s.lot_id
        WHERE s.location_id = 2 AND l.lot_code = 'LOT-CD'`,
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('異なるキーの並行消費は在庫総量を超えて成功しない', async () => {
    const seed = await inbound(1, 2, 'LOT-CE', 10);
    expect(seed.status).toBe(201);
    const stockId = seed.body.stockId as number;

    // 在庫 10 に対して 3 個の消費を 10 本並行: 成功は 3 本 (9 個) まで、残りは 409
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => consume(2, 3, `conc-race-${i}`)),
    );
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(successes.length + conflicts.length).toBe(10);
    expect(successes.length).toBe(3);
    expect(await stockQuantity(stockId)).toBe(1);
    expect(await movementCount(stockId, 'OUT')).toBe(3);
  });

  it('疑似乱数の操作列の後も台帳と在庫が一致し、マイナスにならない', async () => {
    const rand = mulberry32(20261024);
    const lotCodes = ['P-A', 'P-B', 'P-C'];
    let applied = 0;
    let rejected = 0;
    for (let i = 0; i < 60; i++) {
      const productId = rand() < 0.5 ? 1 : 2;
      const quantity = 1 + Math.floor(rand() * 8);
      const roll = rand();
      let res: { status: number };
      if (roll < 0.4) {
        res = await inbound(
          rand() < 0.5 ? 1 : 2,
          productId,
          lotCodes[Math.floor(rand() * lotCodes.length)] as string,
          quantity,
        );
      } else if (roll < 0.75) {
        res = await consume(productId, quantity);
      } else {
        const from = rand() < 0.5 ? 1 : 2;
        res = await api('/api/v1/movements/transfer', {
          method: 'POST',
          body: { fromLocationId: from, toLocationId: from === 1 ? 2 : 1, productId, quantity },
        });
      }
      if (res.status === 201) applied += 1;
      else {
        expect(res.status).toBe(409);
        rejected += 1;
      }
    }
    expect(applied).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);

    // 全 stocks: quantity = 自分の台帳の quantity_change 累計、最終 quantity_after とも一致し、負数でない
    const { results: stocks } = await testEnv.DB.prepare(
      `SELECT s.id, s.quantity,
              (SELECT COALESCE(SUM(quantity_change), 0) FROM stock_movements WHERE stock_id = s.id) AS ledger_sum,
              (SELECT quantity_after FROM stock_movements WHERE stock_id = s.id ORDER BY id DESC LIMIT 1) AS last_after
         FROM stocks s`,
    ).all<{ id: number; quantity: number; ledger_sum: number; last_after: number | null }>();
    expect(stocks.length).toBeGreaterThan(0);
    for (const s of stocks) {
      expect(s.quantity).toBe(s.ledger_sum);
      expect(s.quantity).toBe(s.last_after);
      expect(s.quantity).toBeGreaterThanOrEqual(0);
    }
    // 全体でも一致する
    const totals = await testEnv.DB.prepare(
      `SELECT (SELECT COALESCE(SUM(quantity), 0) FROM stocks) AS stock_total,
              (SELECT COALESCE(SUM(quantity_change), 0) FROM stock_movements) AS ledger_total`,
    ).first<{ stock_total: number; ledger_total: number }>();
    expect(totals?.stock_total).toBe(totals?.ledger_total);
  });

  it('楽観ロック: version 不一致の条件付き UPDATE はガード違反で batch ごと失敗する', async () => {
    const seed = await inbound(1, 1, 'LOT-V', 5);
    expect(seed.status).toBe(201);
    const stockId = seed.body.stockId as number;
    const row = await testEnv.DB.prepare('SELECT quantity, version FROM stocks WHERE id = ?1')
      .bind(stockId)
      .first<{ quantity: number; version: number }>();
    if (!row) throw new Error('stock missing');
    const staleVersion = row.version + 100;

    // Coordinator の runBatch と同じ形: 条件付き UPDATE (version 一致) + write_guards の EXISTS ガード。
    // version が古いと UPDATE は 0 件で、ガードが NULL を挿入して NOT NULL 制約違反になり batch 全体が失敗する。
    const batchId = `test-version-${Date.now()}`;
    let failed = false;
    try {
      await testEnv.DB.batch([
        testEnv.DB
          .prepare(
            'UPDATE stocks SET quantity = quantity + ?1, version = version + 1, updated_at = ?2 WHERE id = ?3 AND version = ?4',
          )
          .bind(3, Date.now(), stockId, staleVersion),
        testEnv.DB
          .prepare(
            `INSERT INTO write_guards (guard_key, ok, created_at)
             SELECT ?, CASE WHEN (EXISTS (SELECT 1 FROM stocks WHERE id = ? AND version = ? AND quantity = ?)) THEN 1 ELSE NULL END, ?`,
          )
          .bind(`${batchId}:g`, stockId, staleVersion + 1, row.quantity + 3, Date.now()),
      ]);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    // ロールバックされ、在庫は変わっていない
    expect(await stockQuantity(stockId)).toBe(row.quantity);

    // 正しい version では同じ batch が成功する (後始末のガード削除まで Coordinator と同じ)
    await testEnv.DB.batch([
      testEnv.DB
        .prepare(
          'UPDATE stocks SET quantity = quantity + ?1, version = version + 1, updated_at = ?2 WHERE id = ?3 AND version = ?4',
        )
        .bind(3, Date.now(), stockId, row.version),
      testEnv.DB
        .prepare(
          `INSERT INTO write_guards (guard_key, ok, created_at)
           SELECT ?, CASE WHEN (EXISTS (SELECT 1 FROM stocks WHERE id = ? AND version = ? AND quantity = ?)) THEN 1 ELSE NULL END, ?`,
        )
        .bind(`${batchId}:ok`, stockId, row.version + 1, row.quantity + 3, Date.now()),
      testEnv.DB.prepare('DELETE FROM write_guards WHERE guard_key LIKE ?').bind(`${batchId}:%`),
    ]);
    expect(await stockQuantity(stockId)).toBe(row.quantity + 3);
  });
});
