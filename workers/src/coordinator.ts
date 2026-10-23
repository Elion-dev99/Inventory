import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { planConsumption, type CandidateRow, type NegativeApprovalInfo } from './allocation';
import { proposeFefoAllocation } from './fefo';
import {
  ApiError,
  badRequest,
  insufficientStock,
  notFound,
  stockConflict,
  stocktakeLocked,
} from './lib/errors';

/**
 * InventoryCoordinator — 在庫書き込みの単一窓口 (単一の Durable Object)。
 *
 * 整合性設計:
 * - D1 には対話的トランザクションが無い代わりに、全ての在庫書き込みをこの DO に
 *   集約する。DO はリクエストを直列に処理するため、「読み取り -> FEFO 配分 ->
 *   条件付き UPDATE -> 台帳記録」を競合なく実行できる。Coordinator 以外は
 *   stocks / stock_movements へ書き込まない。
 * - 書き込みは D1 batch() で原子的に実行する。各条件付き UPDATE
 *   (version 一致 + 数量条件) の直後には write_guards へのガード行を置き、
 *   「更新後の行が期待どおり存在する」ことを EXISTS で検証する。条件が外れて
 *   いれば ok が NULL になり NOT NULL 制約違反で batch 全体がロールバックする。
 *   つまり中途半端な状態は残らない。batch 成功後も meta.changes を検証し、
 *   想定外は 409 として返す。
 * - リアルタイム配信もこの DO が担う: 確定後に WebSocket (Hibernation API) の
 *   接続中クライアントへ stock.changed をブロードキャストする。
 */

export interface Envelope {
  status: number;
  body: unknown;
}

interface MovementContext {
  actorId: number;
  endpoint: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface InboundInput extends MovementContext {
  locationId: number;
  productId: number;
  lotCode: string;
  /** UTC 0時のミリ秒。null = 期限なし */
  expiryDateMs: number | null;
  quantity: number;
}

export interface TransferInput extends MovementContext {
  fromLocationId: number;
  toLocationId: number;
  productId: number;
  /** 指定時はそのロットのみから移動する。未指定は FEFO 順に引く */
  lotId?: number;
  quantity: number;
}

export interface ConsumeInput extends MovementContext {
  productId: number;
  locationId?: number;
  quantity: number;
  department: string;
  purpose: string;
  fefoDeviationReason?: string;
  negativeApprovalId?: number;
  /** 消費してよい location の一覧。null = 全 location (全倉庫スコープ) */
  allowedLocationIds: number[] | null;
}

interface StockRow {
  id: number;
  location_id: number;
  lot_id: number;
  quantity: number;
  version: number;
}

interface CandidateDbRow {
  stock_id: number;
  lot_id: number;
  location_id: number;
  warehouse_id: number;
  quantity: number;
  version: number;
  expiry_date: number | null;
  received_at: number;
}

interface ApprovalRow {
  id: number;
  stock_id: number;
  quantity: number;
  status: string;
  requested_by: number;
  approved_by: number | null;
  movement_id: number | null;
}

export class InventoryCoordinator extends DurableObject<Env> {
  // ---------------------------------------------------------------- WebSocket

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade request', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string' && message === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // 既に閉じている場合は何もしない
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // 同上
    }
  }

  private broadcast(payload: Record<string, unknown>): void {
    const message = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // 切断済みソケットは無視する。再接続時は REST で再同期する前提 (README 参照)
      }
    }
  }

  // ------------------------------------------------------------------- 共通

  private envelope(status: number, body: unknown): Envelope {
    return { status, body };
  }

  private errorEnvelope(e: unknown): Envelope {
    if (e instanceof ApiError) return { status: e.status, body: e.toBody() };
    console.error('InventoryCoordinator error', e);
    return {
      status: 500,
      body: { statusCode: 500, error: 'INTERNAL', message: 'Internal error' },
    };
  }

  /** 冪等性: 保存済みレスポンスがあればそれを返す。再利用時のハッシュ不一致は 422 */
  private async findStoredResponse(ctx: MovementContext): Promise<Envelope | null> {
    const row = await this.env.DB.prepare(
      'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = ?1 AND user_id = ?2',
    )
      .bind(ctx.idempotencyKey, ctx.actorId)
      .first<{ request_hash: string; response_status: number | null; response_body: string | null }>();
    if (!row || row.response_status === null || row.response_body === null) return null;
    if (row.request_hash !== ctx.requestHash) {
      throw new ApiError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key was already used with a different request body',
      );
    }
    return { status: row.response_status, body: JSON.parse(row.response_body) as unknown };
  }

  private idempotencyStmt(ctx: MovementContext, status: number, body: unknown): D1PreparedStatement {
    return this.env.DB.prepare(
      `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, response_status, response_body, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      ctx.idempotencyKey,
      ctx.actorId,
      ctx.endpoint,
      ctx.requestHash,
      status,
      JSON.stringify(body),
      Date.now(),
    );
  }

  private auditStmt(
    actorId: number,
    action: string,
    targetType: string,
    targetId: string,
    payload: unknown,
  ): D1PreparedStatement {
    return this.env.DB.prepare(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(actorId, action, targetType, targetId, JSON.stringify(payload), Date.now());
  }

  /**
   * ガード行: 条件が真なら ok=1、偽なら ok=NULL を挿入し、NOT NULL 制約違反で
   * batch 全体を失敗 (ロールバック) させる。成功時は末尾の DELETE で掃除する。
   */
  private guardStmt(batchId: string, tag: string, conditionSql: string, params: unknown[]): D1PreparedStatement {
    return this.env.DB.prepare(
      `INSERT INTO write_guards (guard_key, ok, created_at)
       SELECT ?, CASE WHEN (${conditionSql}) THEN 1 ELSE NULL END, ?`,
    ).bind(`${batchId}:${tag}`, ...params, Date.now());
  }

  private cleanupGuardsStmt(batchId: string): D1PreparedStatement {
    return this.env.DB.prepare('DELETE FROM write_guards WHERE guard_key LIKE ?').bind(`${batchId}:%`);
  }

  /**
   * batch を実行し、各文の成否と、指定した文の changes を検証する。
   * ガード違反 (制約エラー) は batch がロールバックされるため 409 として返す。
   */
  private async runBatch(
    statements: D1PreparedStatement[],
    expectedChanges: ReadonlyMap<number, number>,
  ): Promise<void> {
    let results: D1Result[];
    try {
      results = await this.env.DB.batch(statements);
    } catch {
      throw stockConflict();
    }
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result || !result.success) throw stockConflict();
      const expected = expectedChanges.get(i);
      if (expected !== undefined && result.meta.changes !== expected) throw stockConflict();
    }
  }

  /**
   * 棚卸し実施中は全面停止 (要件 Q3)。Prisma の stocktakes に倉庫を持たないため全体ロック。
   * 差異承認待ち (pending_approval) の間も在庫は動かせないため同じく停止する。
   * 棚卸し自身の調整 (decideStocktake) はこのチェックを通らない専用パスで行う。
   */
  private async assertNotLocked(): Promise<void> {
    const row = await this.env.DB.prepare(
      "SELECT id FROM stocktakes WHERE status IN ('in_progress', 'pending_approval') LIMIT 1",
    ).first<{ id: number }>();
    if (row) throw stocktakeLocked();
  }

  // ------------------------------------------------------------------ 入庫

  async inbound(input: InboundInput): Promise<Envelope> {
    try {
      return await this.inboundInternal(input);
    } catch (e) {
      return this.errorEnvelope(e);
    }
  }

  private async inboundInternal(input: InboundInput): Promise<Envelope> {
    const stored = await this.findStoredResponse(input);
    if (stored) return stored;
    await this.assertNotLocked();

    const db = this.env.DB;
    const now = Date.now();
    const documentId = crypto.randomUUID();
    const batchId = crypto.randomUUID();

    const product = await db
      .prepare('SELECT id, requires_expiry FROM products WHERE id = ?1 AND deleted_at IS NULL')
      .bind(input.productId)
      .first<{ id: number; requires_expiry: number }>();
    if (!product) throw badRequest('Product not found');
    if (product.requires_expiry === 1 && input.expiryDateMs === null) {
      throw badRequest('expiryDate is required for this product');
    }
    const location = await db
      .prepare('SELECT id FROM locations WHERE id = ?1 AND deleted_at IS NULL')
      .bind(input.locationId)
      .first<{ id: number }>();
    if (!location) throw badRequest('Location not found');

    const lot = await db
      .prepare('SELECT id FROM lots WHERE product_id = ?1 AND lot_code = ?2')
      .bind(input.productId, input.lotCode)
      .first<{ id: number }>();

    const stock = lot
      ? await db
          .prepare('SELECT id, location_id, lot_id, quantity, version FROM stocks WHERE location_id = ?1 AND lot_id = ?2')
          .bind(input.locationId, lot.id)
          .first<StockRow>()
      : null;

    const statements: D1PreparedStatement[] = [];
    const expected = new Map<number, number>();

    if (stock) {
      // 既存 stocks 行: 条件付き UPDATE (version 一致) + ガード
      const after = stock.quantity + input.quantity;
      statements.push(
        db
          .prepare(
            'UPDATE stocks SET quantity = quantity + ?1, version = version + 1, updated_at = ?2 WHERE id = ?3 AND version = ?4',
          )
          .bind(input.quantity, now, stock.id, stock.version),
      );
      expected.set(0, 1);
      statements.push(
        this.guardStmt(
          batchId,
          `stock-${stock.id}`,
          'EXISTS (SELECT 1 FROM stocks WHERE id = ? AND version = ? AND quantity = ?)',
          [stock.id, stock.version + 1, after],
        ),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, created_at)
             VALUES (?1, ?2, 'IN', ?3, ?4, ?5, ?6, ?7)`,
          )
          .bind(documentId, stock.id, input.quantity, stock.quantity, after, input.actorId, now),
      );
      const body = { documentId, stockId: stock.id, quantity: after };
      statements.push(this.auditStmt(input.actorId, 'stock.inbound', 'stock', String(stock.id), {
        documentId,
        quantity: input.quantity,
      }));
      statements.push(this.idempotencyStmt(input, 201, body));
      statements.push(this.cleanupGuardsStmt(batchId));
      await this.runBatch(statements, expected);
      this.broadcast({ type: 'stock.changed', stockIds: [stock.id], documentId, at: now });
      return this.envelope(201, body);
    }

    // 新規 stocks 行: lot が無ければ作り、stocks は lot を引くサブクエリで挿入する
    if (!lot) {
      statements.push(
        db
          .prepare(
            `INSERT INTO lots (product_id, lot_code, expiry_date, received_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4, ?4)`,
          )
          .bind(input.productId, input.lotCode, input.expiryDateMs, now),
      );
    }
    statements.push(
      db.prepare(
        `INSERT INTO stocks (location_id, lot_id, quantity, version, created_at, updated_at)
         SELECT ?1, id, ?2, 1, ?3, ?3 FROM lots WHERE product_id = ?4 AND lot_code = ?5`,
      ).bind(input.locationId, input.quantity, now, input.productId, input.lotCode),
    );
    statements.push(
      this.guardStmt(
        batchId,
        'stock-new',
        `EXISTS (SELECT 1 FROM stocks s JOIN lots l ON l.id = s.lot_id
                 WHERE s.location_id = ? AND l.product_id = ? AND l.lot_code = ? AND s.quantity = ? AND s.version = 1)`,
        [input.locationId, input.productId, input.lotCode, input.quantity],
      ),
    );
    statements.push(
      db.prepare(
        `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, created_at)
         SELECT ?1, s.id, 'IN', ?2, 0, ?2, ?3, ?4
           FROM stocks s JOIN lots l ON l.id = s.lot_id
          WHERE s.location_id = ?5 AND l.product_id = ?6 AND l.lot_code = ?7`,
      ).bind(documentId, input.quantity, input.actorId, now, input.locationId, input.productId, input.lotCode),
    );

    // 作成された stock の ID を引く (batch 実行前に body が要るため、実行後にもう一度引く)
    const bodyPlaceholder = { documentId, stockId: 0, quantity: input.quantity };
    statements.push(
      this.auditStmt(input.actorId, 'stock.inbound', 'product', String(input.productId), {
        documentId,
        quantity: input.quantity,
      }),
    );
    // 冪等レコードは stockId 確定後に別途保存する (後段で処理)
    statements.push(this.cleanupGuardsStmt(batchId));
    await this.runBatch(statements, expected);

    const created = await db
      .prepare(
        `SELECT s.id FROM stocks s JOIN lots l ON l.id = s.lot_id
          WHERE s.location_id = ?1 AND l.product_id = ?2 AND l.lot_code = ?3`,
      )
      .bind(input.locationId, input.productId, input.lotCode)
      .first<{ id: number }>();
    if (!created) throw stockConflict();
    const body = { ...bodyPlaceholder, stockId: created.id };
    // DO は直列処理のため、この保存が他リクエストと競合することはない
    await this.idempotencyStmt(input, 201, body).run();
    this.broadcast({ type: 'stock.changed', stockIds: [created.id], documentId, at: now });
    return this.envelope(201, body);
  }

  // ------------------------------------------------------------------ 消費

  async consume(input: ConsumeInput): Promise<Envelope> {
    try {
      return await this.consumeInternal(input);
    } catch (e) {
      return this.errorEnvelope(e);
    }
  }

  private async consumeInternal(input: ConsumeInput): Promise<Envelope> {
    const stored = await this.findStoredResponse(input);
    if (stored) return stored;
    await this.assertNotLocked();

    const db = this.env.DB;
    const now = Date.now();
    const documentId = crypto.randomUUID();
    const batchId = crypto.randomUUID();

    // FEFO 候補: 対象商品の stocks を id 昇順で読む (DO 内では他者が書き換えない)
    let sql = `SELECT s.id AS stock_id, s.lot_id AS lot_id, s.location_id AS location_id,
                      loc.warehouse_id AS warehouse_id, s.quantity AS quantity, s.version AS version,
                      l.expiry_date AS expiry_date, l.received_at AS received_at
                 FROM stocks s
                 JOIN lots l ON l.id = s.lot_id
                 JOIN locations loc ON loc.id = s.location_id
                WHERE l.product_id = ?`;
    const params: unknown[] = [input.productId];
    if (input.locationId !== undefined) {
      sql += ' AND s.location_id = ?';
      params.push(input.locationId);
    }
    if (input.allowedLocationIds !== null) {
      if (input.allowedLocationIds.length === 0) {
        throw insufficientStock('No stock in accessible locations');
      }
      sql += ` AND s.location_id IN (${input.allowedLocationIds.map(() => '?').join(',')})`;
      params.push(...input.allowedLocationIds);
    }
    sql += ' ORDER BY s.id ASC';
    const { results } = await db.prepare(sql).bind(...params).all<CandidateDbRow>();
    const candidates: CandidateRow[] = results.map((r) => ({
      stockId: r.stock_id,
      lotId: r.lot_id,
      expiryDate: r.expiry_date,
      quantity: r.quantity,
      receivedAt: r.received_at,
      version: r.version,
      locationId: r.location_id,
      warehouseId: r.warehouse_id,
    }));

    // マイナス在庫承認 (指定時のみ)。承認済み・未使用・対象が同じ商品であること
    let approval: NegativeApprovalInfo | null = null;
    if (input.negativeApprovalId !== undefined) {
      const row = await db
        .prepare('SELECT id, stock_id, quantity, status, requested_by, approved_by, movement_id FROM negative_stock_approvals WHERE id = ?1')
        .bind(input.negativeApprovalId)
        .first<ApprovalRow>();
      if (!row) throw notFound('Negative stock approval not found');
      if (row.status !== 'approved' || row.movement_id !== null) {
        throw new ApiError(409, 'APPROVAL_NOT_USABLE', 'Approval is not approved or has already been used');
      }
      if (row.approved_by === null || row.approved_by === row.requested_by) {
        throw new ApiError(422, 'SELF_APPROVAL_FORBIDDEN', 'Self-approval is not allowed');
      }
      const target = candidates.find((c) => c.stockId === row.stock_id);
      if (!target) {
        throw badRequest('Approval target stock is not part of this consumption');
      }
      approval = { id: row.id, stockId: row.stock_id, quantity: row.quantity };
    }

    const plan = planConsumption(candidates, input.quantity, now, approval);
    if (plan.shortfall > 0) {
      const available = input.quantity - plan.shortfall;
      throw insufficientStock(
        `Requested ${input.quantity}, available ${available} (expired lots excluded)`,
      );
    }

    const statements: D1PreparedStatement[] = [];
    const expected = new Map<number, number>();

    // stocks.id 昇順に更新してロック順序を統一する (DO では直列だが作法として揃える)
    const ordered = [...plan.allocations].sort((a, b) => a.stockId - b.stockId);
    for (const alloc of ordered) {
      const idx = statements.length;
      if (alloc.negative) {
        // 例外パス: 承認数量の範囲でのみマイナスを許す (quantity - q >= -承認数量)
        statements.push(
          db
            .prepare(
              `UPDATE stocks SET quantity = quantity - ?1, version = version + 1, updated_at = ?2
                WHERE id = ?3 AND version = ?4 AND quantity - ?1 >= ?5`,
            )
            .bind(alloc.quantity, now, alloc.stockId, alloc.version, -(approval?.quantity ?? 0)),
        );
      } else {
        statements.push(
          db
            .prepare(
              `UPDATE stocks SET quantity = quantity - ?1, version = version + 1, updated_at = ?2
                WHERE id = ?3 AND version = ?4 AND quantity >= ?1`,
            )
            .bind(alloc.quantity, now, alloc.stockId, alloc.version),
        );
      }
      expected.set(idx, 1);
      statements.push(
        this.guardStmt(
          batchId,
          `stock-${alloc.stockId}`,
          'EXISTS (SELECT 1 FROM stocks WHERE id = ? AND version = ? AND quantity = ?)',
          [alloc.stockId, alloc.version + 1, alloc.after],
        ),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, department, purpose, reason, created_at)
             VALUES (?1, ?2, 'OUT', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
          )
          .bind(
            documentId,
            alloc.stockId,
            -alloc.quantity,
            alloc.before,
            alloc.after,
            input.actorId,
            input.department,
            input.purpose,
            alloc.negative ? 'negative-stock-approved' : (input.fefoDeviationReason ?? null),
            now,
          ),
      );
    }

    if (plan.usedApprovalId !== null) {
      // 承認を使用済みにする (movement_id は同一 batch 内の伝票を引く)
      const negativeAlloc = ordered.find((a) => a.negative);
      const idx = statements.length;
      statements.push(
        db
          .prepare(
            `UPDATE negative_stock_approvals
                SET movement_id = (SELECT id FROM stock_movements WHERE document_id = ?1 AND stock_id = ?2),
                    updated_at = ?3
              WHERE id = ?4 AND movement_id IS NULL AND status = 'approved'`,
          )
          .bind(documentId, negativeAlloc?.stockId ?? 0, now, plan.usedApprovalId),
      );
      expected.set(idx, 1);
      statements.push(
        this.guardStmt(
          batchId,
          `approval-${plan.usedApprovalId}`,
          'EXISTS (SELECT 1 FROM negative_stock_approvals WHERE id = ? AND movement_id IS NOT NULL)',
          [plan.usedApprovalId],
        ),
      );
    }

    const body = {
      documentId,
      allocations: plan.allocations.map((a) => ({
        stockId: a.stockId,
        lotId: a.lotId,
        locationId: a.locationId,
        quantity: a.quantity,
        negative: a.negative,
      })),
      ...(plan.usedApprovalId !== null ? { negativeApprovalId: plan.usedApprovalId } : {}),
    };
    statements.push(
      this.auditStmt(input.actorId, 'stock.consume', 'product', String(input.productId), {
        documentId,
        quantity: input.quantity,
        ...(plan.usedApprovalId !== null ? { negativeApprovalId: plan.usedApprovalId } : {}),
      }),
    );
    statements.push(this.idempotencyStmt(input, 201, body));
    statements.push(this.cleanupGuardsStmt(batchId));

    await this.runBatch(statements, expected);

    this.broadcast({
      type: 'stock.changed',
      stockIds: plan.allocations.map((a) => a.stockId),
      documentId,
      ...(plan.usedApprovalId !== null
        ? { negativeStockIds: ordered.filter((a) => a.negative).map((a) => a.stockId) }
        : {}),
      at: now,
    });
    return this.envelope(201, body);
  }

  // ------------------------------------------------------------------ 移動

  async transfer(input: TransferInput): Promise<Envelope> {
    try {
      return await this.transferInternal(input);
    } catch (e) {
      return this.errorEnvelope(e);
    }
  }

  /**
   * 在庫移動: 移動元の stocks から FEFO (または指定ロット) で引き、
   * 移動先の stocks へ加算する。台帳には同一 document_id で
   * TRANSFER_OUT (移動元) / TRANSFER_IN (移動先) を対で残す。
   */
  private async transferInternal(input: TransferInput): Promise<Envelope> {
    const stored = await this.findStoredResponse(input);
    if (stored) return stored;
    await this.assertNotLocked();

    const db = this.env.DB;
    const now = Date.now();
    const documentId = crypto.randomUUID();
    const batchId = crypto.randomUUID();

    if (input.fromLocationId === input.toLocationId) {
      throw badRequest('fromLocationId and toLocationId must differ');
    }
    const product = await db
      .prepare('SELECT id FROM products WHERE id = ?1 AND deleted_at IS NULL')
      .bind(input.productId)
      .first<{ id: number }>();
    if (!product) throw badRequest('Product not found');
    for (const locationId of [input.fromLocationId, input.toLocationId]) {
      const location = await db
        .prepare('SELECT id FROM locations WHERE id = ?1 AND deleted_at IS NULL')
        .bind(locationId)
        .first<{ id: number }>();
      if (!location) throw badRequest('Location not found');
    }

    // 移動元候補: 対象商品の stocks (期限切れは FEFO 提案から外れる = 移動もしない)
    let sql = `SELECT s.id AS stock_id, s.lot_id AS lot_id, s.quantity AS quantity,
                      s.version AS version, l.expiry_date AS expiry_date, l.received_at AS received_at
                 FROM stocks s
                 JOIN lots l ON l.id = s.lot_id
                WHERE s.location_id = ? AND l.product_id = ?`;
    const params: unknown[] = [input.fromLocationId, input.productId];
    if (input.lotId !== undefined) {
      sql += ' AND s.lot_id = ?';
      params.push(input.lotId);
    }
    sql += ' ORDER BY s.id ASC';
    const { results } = await db.prepare(sql).bind(...params).all<CandidateDbRow>();
    const byId = new Map(results.map((r) => [r.stock_id, r]));

    const plan = proposeFefoAllocation(
      results.map((r) => ({
        stockId: r.stock_id,
        lotId: r.lot_id,
        expiryDate: r.expiry_date,
        quantity: r.quantity,
        receivedAt: r.received_at,
      })),
      input.quantity,
      now,
    );
    if (plan.shortfall > 0) {
      const available = input.quantity - plan.shortfall;
      throw insufficientStock(
        `Requested ${input.quantity}, available ${available} at source location (expired lots excluded)`,
      );
    }

    // 移動先の既存 stocks を lot 単位で引いておく (無ければ batch 内で作る)
    const lotIds = plan.allocations.map((a) => a.lotId);
    const { results: destRows } = await db
      .prepare(
        `SELECT id, lot_id, quantity, version FROM stocks
          WHERE location_id = ? AND lot_id IN (${lotIds.map(() => '?').join(',')})`,
      )
      .bind(input.toLocationId, ...lotIds)
      .all<{ id: number; lot_id: number; quantity: number; version: number }>();
    const destByLot = new Map(destRows.map((r) => [r.lot_id, r]));

    const statements: D1PreparedStatement[] = [];
    const expected = new Map<number, number>();
    const ordered = [...plan.allocations].sort((a, b) => a.stockId - b.stockId);

    for (const alloc of ordered) {
      const src = byId.get(alloc.stockId);
      if (!src) throw stockConflict();
      const srcAfter = src.quantity - alloc.quantity;

      let idx = statements.length;
      statements.push(
        db
          .prepare(
            `UPDATE stocks SET quantity = quantity - ?1, version = version + 1, updated_at = ?2
              WHERE id = ?3 AND version = ?4 AND quantity >= ?1`,
          )
          .bind(alloc.quantity, now, alloc.stockId, src.version),
      );
      expected.set(idx, 1);
      statements.push(
        this.guardStmt(
          batchId,
          `transfer-out-${alloc.stockId}`,
          'EXISTS (SELECT 1 FROM stocks WHERE id = ? AND version = ? AND quantity = ?)',
          [alloc.stockId, src.version + 1, srcAfter],
        ),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, created_at)
             VALUES (?1, ?2, 'TRANSFER_OUT', ?3, ?4, ?5, ?6, ?7)`,
          )
          .bind(documentId, alloc.stockId, -alloc.quantity, src.quantity, srcAfter, input.actorId, now),
      );

      const dest = destByLot.get(alloc.lotId);
      if (dest) {
        const destAfter = dest.quantity + alloc.quantity;
        idx = statements.length;
        statements.push(
          db
            .prepare(
              'UPDATE stocks SET quantity = quantity + ?1, version = version + 1, updated_at = ?2 WHERE id = ?3 AND version = ?4',
            )
            .bind(alloc.quantity, now, dest.id, dest.version),
        );
        expected.set(idx, 1);
        statements.push(
          this.guardStmt(
            batchId,
            `transfer-in-${dest.id}`,
            'EXISTS (SELECT 1 FROM stocks WHERE id = ? AND version = ? AND quantity = ?)',
            [dest.id, dest.version + 1, destAfter],
          ),
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, created_at)
               VALUES (?1, ?2, 'TRANSFER_IN', ?3, ?4, ?5, ?6, ?7)`,
            )
            .bind(documentId, dest.id, alloc.quantity, dest.quantity, destAfter, input.actorId, now),
        );
      } else {
        // 移動先に stocks 行が無い: lot は既存なので lot_id を直接指定して作る
        statements.push(
          db
            .prepare(
              `INSERT INTO stocks (location_id, lot_id, quantity, version, created_at, updated_at)
               VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
            )
            .bind(input.toLocationId, alloc.lotId, alloc.quantity, now),
        );
        statements.push(
          this.guardStmt(
            batchId,
            `transfer-in-new-${alloc.lotId}`,
            'EXISTS (SELECT 1 FROM stocks WHERE location_id = ? AND lot_id = ? AND quantity = ? AND version = 1)',
            [input.toLocationId, alloc.lotId, alloc.quantity],
          ),
        );
        statements.push(
          db.prepare(
            `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, created_at)
             SELECT ?1, s.id, 'TRANSFER_IN', ?2, 0, ?2, ?3, ?4
               FROM stocks s WHERE s.location_id = ?5 AND s.lot_id = ?6`,
          ).bind(documentId, alloc.quantity, input.actorId, now, input.toLocationId, alloc.lotId),
        );
      }
    }

    statements.push(
      this.auditStmt(input.actorId, 'stock.transfer', 'product', String(input.productId), {
        documentId,
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        quantity: input.quantity,
      }),
    );
    statements.push(this.cleanupGuardsStmt(batchId));
    await this.runBatch(statements, expected);

    // 新規作成した移動先 stocks の ID を引いてレスポンスを確定する (DO は直列処理)
    const bodyAllocations: { lotId: number; fromStockId: number; toStockId: number; quantity: number }[] = [];
    for (const alloc of ordered) {
      let dest = destByLot.get(alloc.lotId);
      if (!dest) {
        const created = await db
          .prepare('SELECT id FROM stocks WHERE location_id = ?1 AND lot_id = ?2')
          .bind(input.toLocationId, alloc.lotId)
          .first<{ id: number }>();
        if (!created) throw stockConflict();
        dest = { id: created.id, lot_id: alloc.lotId, quantity: 0, version: 1 };
      }
      bodyAllocations.push({
        lotId: alloc.lotId,
        fromStockId: alloc.stockId,
        toStockId: dest.id,
        quantity: alloc.quantity,
      });
    }
    const body = { documentId, allocations: bodyAllocations };
    await this.idempotencyStmt(input, 201, body).run();
    this.broadcast({
      type: 'stock.changed',
      stockIds: [
        ...bodyAllocations.map((a) => a.fromStockId),
        ...bodyAllocations.map((a) => a.toStockId),
      ],
      documentId,
      at: now,
    });
    return this.envelope(201, body);
  }

  // ---------------------------------------------------------------- 棚卸し

  async startStocktake(input: { actorId: number }): Promise<Envelope> {
    try {
      const db = this.env.DB;
      const now = Date.now();
      const existing = await db
        .prepare("SELECT id FROM stocktakes WHERE status IN ('in_progress', 'pending_approval') LIMIT 1")
        .first<{ id: number }>();
      if (existing) throw stocktakeLocked('Another stocktake is already in progress or awaiting approval');

      const inserted = await db
        .prepare(
          `INSERT INTO stocktakes (status, started_by, started_at, created_at, updated_at)
           VALUES ('in_progress', ?1, ?2, ?2, ?2)`,
        )
        .bind(input.actorId, now)
        .run();
      const stocktakeId = Number(inserted.meta.last_row_id);

      // 全 stocks の帳簿数をスナップショットする (Nest 版と同一)
      const lineResult = await db
        .prepare(
          `INSERT INTO stocktake_lines (stocktake_id, stock_id, book_quantity)
           SELECT ?1, id, quantity FROM stocks`,
        )
        .bind(stocktakeId)
        .run();
      await this.auditStmt(input.actorId, 'stocktake.start', 'stocktake', String(stocktakeId), {
        stocktakeId,
      }).run();

      const body = {
        id: stocktakeId,
        status: 'in_progress',
        startedBy: input.actorId,
        startedAt: now,
        lineCount: lineResult.meta.changes,
      };
      this.broadcast({ type: 'stocktake.started', stocktakeId, at: now });
      return this.envelope(201, body);
    } catch (e) {
      return this.errorEnvelope(e);
    }
  }

  /** 差異のある lines (実数が入力され、帳簿数と異なるもの)。stock 昇順で決定的に並べる */
  private async stocktakeDiffLines(stocktakeId: number): Promise<StocktakeDiffLine[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT id AS line_id, stock_id, book_quantity, counted_quantity
         FROM stocktake_lines
        WHERE stocktake_id = ?1
          AND counted_quantity IS NOT NULL
          AND counted_quantity <> book_quantity
        ORDER BY stock_id ASC`,
    )
      .bind(stocktakeId)
      .all<{ line_id: number; stock_id: number; book_quantity: number; counted_quantity: number }>();
    return results.map((r) => ({
      lineId: r.line_id,
      stockId: r.stock_id,
      bookQuantity: r.book_quantity,
      countedQuantity: r.counted_quantity,
      difference: r.counted_quantity - r.book_quantity,
    }));
  }

  /**
   * 棚卸しの終了。差異が無ければそのまま confirmed。
   * 差異があれば pending_approval に止める (全面停止は継続し、decideStocktake で
   * 承認 = 調整反映 / 差し戻し = in_progress へ復帰、を決める)。
   * 未入力 (counted_quantity IS NULL) の lines は帳簿どおりとして差異に数えない。
   */
  async finishStocktake(input: { actorId: number; stocktakeId: number }): Promise<Envelope> {
    try {
      const db = this.env.DB;
      const now = Date.now();
      const batchId = crypto.randomUUID();
      const stocktake = await db
        .prepare('SELECT id, status FROM stocktakes WHERE id = ?1')
        .bind(input.stocktakeId)
        .first<{ id: number; status: string }>();
      if (!stocktake || stocktake.status !== 'in_progress') {
        throw notFound('In-progress stocktake not found');
      }

      const diffs = await this.stocktakeDiffLines(input.stocktakeId);
      const statements: D1PreparedStatement[] = [];
      const expected = new Map<number, number>();

      if (diffs.length === 0) {
        statements.push(
          db
            .prepare(
              `UPDATE stocktakes SET status = 'confirmed', confirmed_at = ?1, updated_at = ?1
                WHERE id = ?2 AND status = 'in_progress'`,
            )
            .bind(now, input.stocktakeId),
        );
        expected.set(0, 1);
        statements.push(
          this.guardStmt(
            batchId,
            `stocktake-${input.stocktakeId}`,
            "EXISTS (SELECT 1 FROM stocktakes WHERE id = ? AND status = 'confirmed')",
            [input.stocktakeId],
          ),
        );
        statements.push(
          this.auditStmt(input.actorId, 'stocktake.finish', 'stocktake', String(input.stocktakeId), {
            stocktakeId: input.stocktakeId,
            result: 'confirmed',
          }),
        );
        statements.push(this.cleanupGuardsStmt(batchId));
        await this.runBatch(statements, expected);

        const body = { id: input.stocktakeId, status: 'confirmed', confirmedAt: now };
        this.broadcast({ type: 'stocktake.finished', stocktakeId: input.stocktakeId, at: now });
        return this.envelope(200, body);
      }

      statements.push(
        db
          .prepare(
            `UPDATE stocktakes SET status = 'pending_approval', updated_at = ?1
              WHERE id = ?2 AND status = 'in_progress'`,
          )
          .bind(now, input.stocktakeId),
      );
      expected.set(0, 1);
      statements.push(
        this.guardStmt(
          batchId,
          `stocktake-${input.stocktakeId}`,
          "EXISTS (SELECT 1 FROM stocktakes WHERE id = ? AND status = 'pending_approval')",
          [input.stocktakeId],
        ),
      );
      statements.push(
        this.auditStmt(input.actorId, 'stocktake.finish', 'stocktake', String(input.stocktakeId), {
          stocktakeId: input.stocktakeId,
          result: 'pending_approval',
          differences: diffs,
        }),
      );
      statements.push(this.cleanupGuardsStmt(batchId));
      await this.runBatch(statements, expected);

      const body = { id: input.stocktakeId, status: 'pending_approval', differences: diffs };
      this.broadcast({ type: 'stocktake.pending_approval', stocktakeId: input.stocktakeId, at: now });
      return this.envelope(200, body);
    } catch (e) {
      return this.errorEnvelope(e);
    }
  }

  /**
   * 棚卸しの差異承認/差し戻し (pending_approval のときのみ)。
   * 承認: 差異を調整伝票 (stock_movements type 'ADJUST', reason 'stocktake-adjustment')
   * として在庫へ反映し confirmed にする。棚卸しロック中でも棚卸し自身の調整は
   * 通す必要があるため、このメソッドは assertNotLocked を経由しない専用パス。
   * 差し戻し: 実数は保持したまま in_progress に戻す。
   */
  async decideStocktake(input: {
    actorId: number;
    stocktakeId: number;
    approve: boolean;
  }): Promise<Envelope> {
    try {
      const db = this.env.DB;
      const now = Date.now();
      const batchId = crypto.randomUUID();
      const stocktake = await db
        .prepare('SELECT id, status FROM stocktakes WHERE id = ?1')
        .bind(input.stocktakeId)
        .first<{ id: number; status: string }>();
      if (!stocktake || stocktake.status !== 'pending_approval') {
        throw notFound('Pending-approval stocktake not found');
      }

      const statements: D1PreparedStatement[] = [];
      const expected = new Map<number, number>();

      if (!input.approve) {
        statements.push(
          db
            .prepare(
              `UPDATE stocktakes SET status = 'in_progress', decided_by = ?1, decided_at = ?2, updated_at = ?2
                WHERE id = ?3 AND status = 'pending_approval'`,
            )
            .bind(input.actorId, now, input.stocktakeId),
        );
        expected.set(0, 1);
        statements.push(
          this.guardStmt(
            batchId,
            `stocktake-${input.stocktakeId}`,
            "EXISTS (SELECT 1 FROM stocktakes WHERE id = ? AND status = 'in_progress')",
            [input.stocktakeId],
          ),
        );
        statements.push(
          this.auditStmt(input.actorId, 'stocktake.decide', 'stocktake', String(input.stocktakeId), {
            stocktakeId: input.stocktakeId,
            approve: false,
          }),
        );
        statements.push(this.cleanupGuardsStmt(batchId));
        await this.runBatch(statements, expected);

        const body = { id: input.stocktakeId, status: 'in_progress' };
        this.broadcast({ type: 'stocktake.decision', stocktakeId: input.stocktakeId, approve: false, at: now });
        return this.envelope(200, body);
      }

      const diffs = await this.stocktakeDiffLines(input.stocktakeId);
      const documentId = crypto.randomUUID();
      const adjustments: (StocktakeDiffLine & { quantityAfter: number })[] = [];

      for (const diff of diffs) {
        const stock = await db
          .prepare('SELECT id, quantity, version FROM stocks WHERE id = ?1')
          .bind(diff.stockId)
          .first<StockRow>();
        if (!stock) throw stockConflict();
        // ロック期間中は在庫が動かないため現在数 = 帳簿数のはずで、
        // 調整後はちょうど実数になる。想定外なら 409 で止める
        const after = stock.quantity + diff.difference;
        if (after < 0) throw stockConflict();

        const idx = statements.length;
        statements.push(
          db
            .prepare(
              `UPDATE stocks SET quantity = quantity + ?1, version = version + 1, updated_at = ?2
                WHERE id = ?3 AND version = ?4`,
            )
            .bind(diff.difference, now, diff.stockId, stock.version),
        );
        expected.set(idx, 1);
        statements.push(
          this.guardStmt(
            batchId,
            `adjust-${diff.stockId}`,
            'EXISTS (SELECT 1 FROM stocks WHERE id = ? AND version = ? AND quantity = ?)',
            [diff.stockId, stock.version + 1, after],
          ),
        );
        statements.push(
          db
            .prepare(
              `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, reason, created_at)
               VALUES (?1, ?2, 'ADJUST', ?3, ?4, ?5, ?6, 'stocktake-adjustment', ?7)`,
            )
            .bind(documentId, diff.stockId, diff.difference, stock.quantity, after, input.actorId, now),
        );
        adjustments.push({ ...diff, quantityAfter: after });
      }

      const statusIdx = statements.length;
      statements.push(
        db
          .prepare(
            `UPDATE stocktakes SET status = 'confirmed', confirmed_at = ?1, decided_by = ?2, decided_at = ?1, updated_at = ?1
              WHERE id = ?3 AND status = 'pending_approval'`,
          )
          .bind(now, input.actorId, input.stocktakeId),
      );
      expected.set(statusIdx, 1);
      statements.push(
        this.guardStmt(
          batchId,
          `stocktake-${input.stocktakeId}`,
          "EXISTS (SELECT 1 FROM stocktakes WHERE id = ? AND status = 'confirmed')",
          [input.stocktakeId],
        ),
      );
      statements.push(
        this.auditStmt(input.actorId, 'stocktake.decide', 'stocktake', String(input.stocktakeId), {
          stocktakeId: input.stocktakeId,
          approve: true,
          documentId,
          adjustments: adjustments.map((a) => ({ stockId: a.stockId, difference: a.difference })),
        }),
      );
      statements.push(this.cleanupGuardsStmt(batchId));
      await this.runBatch(statements, expected);

      const body = {
        id: input.stocktakeId,
        status: 'confirmed',
        confirmedAt: now,
        documentId,
        adjustments,
      };
      this.broadcast({
        type: 'stock.changed',
        stockIds: adjustments.map((a) => a.stockId),
        documentId,
        at: now,
      });
      this.broadcast({ type: 'stocktake.finished', stocktakeId: input.stocktakeId, at: now });
      return this.envelope(200, body);
    } catch (e) {
      return this.errorEnvelope(e);
    }
  }
}

interface StocktakeDiffLine {
  lineId: number;
  stockId: number;
  bookQuantity: number;
  countedQuantity: number;
  /** 実数 - 帳簿数 */
  difference: number;
}
