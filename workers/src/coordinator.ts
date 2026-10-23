import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { planConsumption, type CandidateRow, type NegativeApprovalInfo } from './allocation';
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

  /** 棚卸し実施中は全面停止 (要件 Q3)。Prisma の stocktakes に倉庫を持たないため全体ロック */
  private async assertNotLocked(): Promise<void> {
    const row = await this.env.DB.prepare(
      "SELECT id FROM stocktakes WHERE status = 'in_progress' LIMIT 1",
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

  // ---------------------------------------------------------------- 棚卸し

  async startStocktake(input: { actorId: number }): Promise<Envelope> {
    try {
      const db = this.env.DB;
      const now = Date.now();
      const existing = await db
        .prepare("SELECT id FROM stocktakes WHERE status = 'in_progress' LIMIT 1")
        .first<{ id: number }>();
      if (existing) throw stocktakeLocked('Another stocktake is already in progress');

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
      const statements: D1PreparedStatement[] = [];
      const expected = new Map<number, number>();
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
        }),
      );
      statements.push(this.cleanupGuardsStmt(batchId));
      await this.runBatch(statements, expected);

      const body = { id: input.stocktakeId, status: 'confirmed', confirmedAt: now };
      this.broadcast({ type: 'stocktake.finished', stocktakeId: input.stocktakeId, at: now });
      return this.envelope(200, body);
    } catch (e) {
      return this.errorEnvelope(e);
    }
  }
}
