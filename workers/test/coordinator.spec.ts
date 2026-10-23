import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Envelope } from '../src/coordinator';
import initSql from '../migrations/0001_init.sql?raw';
import seedSql from '../migrations/0002_seed_roles.sql?raw';
import permissionsSql from '../migrations/0003_permissions.sql?raw';
import sessionsSql from '../migrations/0004_sessions.sql?raw';
import businessSql from '../migrations/0005_business_completion.sql?raw';
import featuresSql from '../migrations/0006_feature_flags.sql?raw';
import purchasingSql from '../migrations/0007_purchasing_analytics.sql?raw';
import multiStoreSql from '../migrations/0008_multi_store.sql?raw';

/**
 * Coordinator の結合テスト: 実 D1 (miniflare) に対してマイグレーションを適用し、
 * Durable Object の RPC 経由で 入庫 -> 消費 -> マイナス承認消費 -> 棚卸し停止 を通す。
 * 条件付き UPDATE + write_guards + batch 原子性と冪等リプレイを実経路で検証する。
 */

interface TestEnv {
  DB: D1Database;
  INVENTORY_COORDINATOR: DurableObjectNamespace;
}

const testEnv = env as unknown as TestEnv;

interface CoordinatorStub {
  inbound: (input: Record<string, unknown>) => Promise<Envelope>;
  consume: (input: Record<string, unknown>) => Promise<Envelope>;
  startStocktake: (input: { actorId: number; storeId: number }) => Promise<Envelope>;
  finishStocktake: (input: { actorId: number; stocktakeId: number; storeId: number }) => Promise<Envelope>;
}

function stub(): CoordinatorStub {
  const id = testEnv.INVENTORY_COORDINATOR.idFromName('global');
  return testEnv.INVENTORY_COORDINATOR.get(id) as unknown as CoordinatorStub;
}

let seq = 0;
function ctx(endpoint: string): Record<string, unknown> {
  seq += 1;
  return { actorId: 1, endpoint, idempotencyKey: `key-${seq}`, requestHash: `hash-${seq}`, storeId: 1 };
}

async function stockQuantity(stockId: number): Promise<number> {
  const row = await testEnv.DB.prepare('SELECT quantity FROM stocks WHERE id = ?1')
    .bind(stockId)
    .first<{ quantity: number }>();
  return row?.quantity ?? Number.NaN;
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
  for (const stmt of [...statementsOf(initSql),
    ...statementsOf(seedSql),
    ...statementsOf(permissionsSql),
    ...statementsOf(sessionsSql),
    ...statementsOf(businessSql),
    ...statementsOf(featuresSql),
    ...statementsOf(purchasingSql),
    ...statementsOf(multiStoreSql),]) {
    await testEnv.DB.prepare(stmt).run();
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO users (id, external_id, email, display_name, status, created_at, updated_at)
       VALUES (1, 'sub-staff', 'staff@example.com', 'Staff', 'active', ?1, ?1),
              (2, 'sub-manager', 'manager@example.com', 'Manager', 'active', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO user_roles (user_id, role_code, warehouse_id) VALUES (1, 'INVENTORY_STAFF', NULL), (2, 'INVENTORY_MANAGER', NULL)`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO warehouses (id, code, name, created_at, updated_at) VALUES (1, 'WH1', '本社倉庫', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO locations (id, warehouse_id, code, name, created_at, updated_at) VALUES (1, 1, 'A-1', '棚A-1', ?1, ?1)`,
    ).bind(now),
    testEnv.DB.prepare(
      `INSERT INTO products (id, sku, name, unit, safety_stock, requires_expiry, created_at, updated_at)
       VALUES (1, 'SKU-1', 'テスト品', '個', 0, 0, ?1, ?1)`,
    ).bind(now),
  ]);
});

describe('InventoryCoordinator (D1 結合)', () => {
  it('入庫 -> 冪等リプレイ -> 消費 -> 在庫不足 409 の一連が成立する', async () => {
    const s = stub();
    const inboundInput = {
      ...ctx('POST /api/v1/movements/inbound'),
      locationId: 1,
      productId: 1,
      lotCode: 'LOT-1',
      expiryDateMs: null,
      quantity: 10,
    };
    const inbound = await s.inbound(inboundInput);
    expect(inbound.status).toBe(201);
    const body = inbound.body as { stockId: number; quantity: number };
    expect(body.quantity).toBe(10);
    const stockId = body.stockId;

    // 同一キー・同一ハッシュの再送は保存済み結果を返し、二重加算しない
    const replay = await s.inbound(inboundInput);
    expect(replay.status).toBe(201);
    expect((replay.body as { quantity: number }).quantity).toBe(10);
    expect(await stockQuantity(stockId)).toBe(10);

    // 同一キーで異なる内容は 422
    const reused = await s.inbound({ ...inboundInput, requestHash: 'different', quantity: 5 });
    expect(reused.status).toBe(422);

    const consumed = await s.consume({
      ...ctx('POST /api/v1/movements/consumption'),
      productId: 1,
      quantity: 4,
      department: '製造部',
      purpose: 'テスト消費',
      allowedLocationIds: null,
    });
    expect(consumed.status).toBe(201);
    expect(await stockQuantity(stockId)).toBe(6);

    const short = await s.consume({
      ...ctx('POST /api/v1/movements/consumption'),
      productId: 1,
      quantity: 100,
      department: '製造部',
      purpose: '不足テスト',
      allowedLocationIds: null,
    });
    expect(short.status).toBe(409);
    expect((short.body as { error: string }).error).toBe('INSUFFICIENT_STOCK');
    // 失敗した消費は在庫も台帳も汚さない (batch 原子性)
    expect(await stockQuantity(stockId)).toBe(6);
    const movements = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM stock_movements WHERE type = 'OUT'",
    ).first<{ n: number }>();
    expect(movements?.n).toBe(1);
  });

  it('承認済みレコードがある場合のみマイナス消費でき、承認は使用済みになる', async () => {
    const s = stub();
    const stock = await testEnv.DB.prepare('SELECT id, quantity FROM stocks LIMIT 1').first<{
      id: number;
      quantity: number;
    }>();
    if (!stock) throw new Error('stock missing (previous test must run first)');
    const now = Date.now();
    const approval = await testEnv.DB.prepare(
      `INSERT INTO negative_stock_approvals (stock_id, quantity, reason, status, requested_by, approved_by, decided_at, created_at, updated_at)
       VALUES (?1, 10, '緊急対応', 'approved', 1, 2, ?2, ?2, ?2)`,
    )
      .bind(stock.id, now)
      .run();

    const consumed = await s.consume({
      ...ctx('POST /api/v1/movements/consumption'),
      productId: 1,
      quantity: stock.quantity + 3,
      department: '保守部',
      purpose: '緊急対応',
      negativeApprovalId: Number(approval.meta.last_row_id),
      allowedLocationIds: null,
    });
    expect(consumed.status).toBe(201);
    expect(await stockQuantity(stock.id)).toBe(-3);

    const used = await testEnv.DB.prepare(
      'SELECT movement_id FROM negative_stock_approvals WHERE id = ?1',
    )
      .bind(Number(approval.meta.last_row_id))
      .first<{ movement_id: number | null }>();
    expect(used?.movement_id).not.toBeNull();

    // 使用済み承認の再利用は 409
    const again = await s.consume({
      ...ctx('POST /api/v1/movements/consumption'),
      productId: 1,
      quantity: 1,
      department: '保守部',
      purpose: '再利用テスト',
      negativeApprovalId: Number(approval.meta.last_row_id),
      allowedLocationIds: null,
    });
    expect(again.status).toBe(409);
  });

  it('棚卸し実施中は入庫が 423 で止まり、終了後は再開できる', async () => {
    const s = stub();
    const started = await s.startStocktake({ actorId: 2, storeId: 1 });
    expect(started.status).toBe(201);
    const stocktakeId = (started.body as { id: number }).id;

    const blocked = await s.inbound({
      ...ctx('POST /api/v1/movements/inbound'),
      locationId: 1,
      productId: 1,
      lotCode: 'LOT-2',
      expiryDateMs: null,
      quantity: 1,
    });
    expect(blocked.status).toBe(423);

    const finished = await s.finishStocktake({ actorId: 2, stocktakeId, storeId: 1 });
    expect(finished.status).toBe(200);

    const after = await s.inbound({
      ...ctx('POST /api/v1/movements/inbound'),
      locationId: 1,
      productId: 1,
      lotCode: 'LOT-2',
      expiryDateMs: null,
      quantity: 1,
    });
    expect(after.status).toBe(201);
  });
});
