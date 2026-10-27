import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { planConsumption, type CandidateRow, type NegativeApprovalInfo } from './allocation';
import { proposeFefoAllocation, type FefoCandidate } from './fefo';
import {
  ApiError,
  badRequest,
  insufficientStock,
  notFound,
  stockConflict,
  stocktakeLocked,
} from './lib/errors';
import { buildAuditInsert } from './lib/audit-chain';

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
  /** 対象店舗 (テナント)。在庫・台帳・冪等キー・棚卸しロックはすべて店舗単位 */
  storeId: number;
}

export interface InboundInput extends MovementContext {
  locationId: number;
  productId: number;
  lotCode: string;
  /** 一括処理などで伝票を束ねる場合に呼び出し側が指定する。未指定は自動採番 */
  documentId?: string;
  /** UTC 0時のミリ秒。null = 期限なし */
  expiryDateMs: number | null;
  quantity: number;
  /** 台帳の種別。未指定 = 'IN' (入庫)。'RETURN' は返品 (0015、理由必須) */
  kind?: 'IN' | 'RETURN';
  /** 返品・廃棄の理由コード (0015) */
  reasonCode?: string | null;
  /** 理由の自由メモ (返品では必須、台帳の reason に入る) */
  reason?: string | null;
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
  /** 一括処理などで伝票を束ねる場合に呼び出し側が指定する。未指定は自動採番 */
  documentId?: string;
  department: string;
  purpose: string;
  fefoDeviationReason?: string;
  negativeApprovalId?: number;
  /** 消費してよい location の一覧。null = 全 location (全倉庫スコープ) */
  allowedLocationIds: number[] | null;
  /** 台帳の種別。未指定 = 'OUT' (消費)。'DISPOSAL' は廃棄 (0015) */
  movementType?: 'OUT' | 'DISPOSAL';
  /** 返品・廃棄の理由コード (0015) */
  reasonCode?: string | null;
  /** 理由の自由メモ (廃棄では必須、台帳の reason に入る) */
  reason?: string | null;
  /** 一括処理の束 (セット品展開など)。台帳の group_id に入る (0015) */
  groupId?: string | null;
  /** 監査ログのアクション名。未指定 = 'stock.consume' */
  auditAction?: string;
}

/** 一括入出庫の 1 行 (IN = 入庫、OUT = 消費) */
export type BulkLineInput =
  | {
      type: 'IN';
      locationId: number;
      productId: number;
      lotCode: string;
      expiryDateMs: number | null;
      quantity: number;
      reason?: string | null;
    }
  | {
      type: 'OUT';
      productId: number;
      locationId?: number;
      quantity: number;
      department?: string;
      purpose?: string;
    };

/**
 * 一括入出庫。全行を先に検証・シミュレーションし、1 行でも規則違反や
 * 在庫不足があれば全体を止める。通過したら行を順に実適用する。
 * 行ごとの冪等キーで再送にも耐える (適用済みの行は読み戻してスキップ)。
 */
export interface BulkInput extends MovementContext {
  lines: BulkLineInput[];
  /** 消費してよい location の一覧。null = 全 location (全倉庫スコープ) */
  allowedLocationIds: number[] | null;
}

/** セット品の消費入力 (0015)。構成品を FEFO で展開し、同一 group_id で記録する */
export interface BundleConsumeInput extends MovementContext {
  bundleProductId: number;
  locationId?: number;
  quantity: number;
  department: string;
  purpose: string;
  allowedLocationIds: number[] | null;
  components: { productId: number; quantity: number }[];
}

/** ピッキング確定の 1 明細 (検品済み数量をそのまま動かす) */
export interface PickConfirmItem {
  productId: number;
  fromLocationId: number;
  quantity: number;
}

/** ピッキングリストの確定入力 (0015)。全明細を 1 batch で原子的に実行する */
export interface PickConfirmInput extends MovementContext {
  pickListId: number;
  type: 'consume' | 'transfer';
  toLocationId?: number;
  items: PickConfirmItem[];
}

interface StockRow {
  id: number;
  location_id: number;
  lot_id: number;
  quantity: number;
  version: number;
}

export interface StartStocktakeInput {
  actorId: number;
  storeId: number;
  /** 'full' (全件、既定) | 'locations' (部分棚卸し: locationIds の場所のみ) */
  scopeType?: 'full' | 'locations';
  /** scopeType='locations' の対象 location ID 群 */
  locationIds?: number[];
  /** 盲検: 実数入力の間、帳簿数を一切見せない */
  blind?: boolean;
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
  /**
   * 書き込み系 RPC の直列化キュー。
   * Durable Object のハンドラは D1 への await を跨いで他の RPC と
   * インターリーブしうるため、「候補を読む -> 配分を計画 -> 条件付き UPDATE +
   * ガード + 台帳を batch で確定」という一連が他の書き込みと混ざらないよう、
   * 公開メソッドはすべてこのキューを通して 1 件ずつ実行する。
   * これが崩れると、条件付き UPDATE が 0 件でもガードが「他者の更新後の状態」と
   * 偶然一致して batch が確定し、台帳だけが記録される事故が起きる
   * (test/concurrency.spec.ts が回帰防止)。
   * WebSocket の fetch / メッセージ処理は書き込みをしないため対象外。
   */
  private writeQueue: Promise<void> = Promise.resolve();

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(fn);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ---------------------------------------------------------------- WebSocket

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade request', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    // 接続を店舗でタグ付けし、ブロードキャストを同店舗だけに届ける。
    // Worker の /realtime が ?store=<id> を付けて転送する。未指定 (null) の
    // 接続は全体管理者の監視用として全店舗分を受け取る。
    const raw = new URL(request.url).searchParams.get('store');
    const parsed = raw === null || raw === '' ? null : Number(raw);
    server.serializeAttachment({ storeId: parsed !== null && Number.isInteger(parsed) ? parsed : null });
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
    // payload.storeId がある通知は、同店舗タグの接続 (と未タグの全体監視) にだけ届ける
    const target = typeof payload.storeId === 'number' ? payload.storeId : null;
    for (const ws of this.ctx.getWebSockets()) {
      if (target !== null) {
        let tag: number | null = null;
        try {
          const attachment = ws.deserializeAttachment() as { storeId?: number | null } | null;
          tag = attachment?.storeId ?? null;
        } catch {
          tag = null;
        }
        if (tag !== null && tag !== target) continue;
      }
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
      'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = ?1 AND user_id = ?2 AND store_id = ?3',
    )
      .bind(ctx.idempotencyKey, ctx.actorId, ctx.storeId)
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
      `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, response_status, response_body, store_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      ctx.idempotencyKey,
      ctx.actorId,
      ctx.endpoint,
      ctx.requestHash,
      status,
      JSON.stringify(body),
      ctx.storeId,
      Date.now(),
    );
  }

  /**
   * 監査 1 件分の INSERT 文を作る (ハッシュチェーン付き、0017)。
   * チェーンの prev 読取は非同期のため呼び出し側で await する。
   * Coordinator の書き込みは runExclusive で直列化されるため、
   * ここ経由の監査は競合なく単一チェーンに連なる。
   */
  private auditStmt(
    actorId: number,
    action: string,
    targetType: string,
    targetId: string,
    payload: unknown,
    storeId: number | null,
  ): Promise<D1PreparedStatement> {
    return buildAuditInsert(this.env.DB, {
      actorId,
      action,
      targetType,
      targetId,
      payload,
      storeId,
      createdAt: Date.now(),
    });
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

  /** 列の有無をキャッシュする (migration 0014 未適用環境との後方互換用) */
  private columnCache = new Map<string, boolean>();

  private async hasColumn(table: string, column: string): Promise<boolean> {
    const key = `${table}.${column}`;
    const cached = this.columnCache.get(key);
    if (cached !== undefined) return cached;
    let found = false;
    try {
      const { results } = await this.env.DB.prepare(`PRAGMA table_info(${table})`).all<{
        name: string;
      }>();
      found = results.some((r) => r.name === column);
    } catch {
      found = false;
    }
    this.columnCache.set(key, found);
    return found;
  }

  private extMovementColumnsCache: boolean | null = null;

  /** 0015 の拡張列 (group_id / reason_code) が stock_movements にあるか */
  private async hasExtMovementColumns(): Promise<boolean> {
    if (this.extMovementColumnsCache !== null) return this.extMovementColumnsCache;
    const found =
      (await this.hasColumn('stock_movements', 'group_id')) &&
      (await this.hasColumn('stock_movements', 'reason_code'));
    this.extMovementColumnsCache = found;
    return found;
  }

  /**
   * 出庫系 1 配分分の文 (条件付き UPDATE + ガード + 台帳) を statements へ追加する。
   * 消費・廃棄・セット品展開で共用する。呼び出し側が batch 全体を組み立てる。
   */
  private appendOutflowAllocation(
    statements: D1PreparedStatement[],
    expected: Map<number, number>,
    args: {
      batchId: string;
      documentId: string;
      now: number;
      actorId: number;
      storeId: number;
      alloc: { stockId: number; quantity: number; before: number; after: number; version: number; negative: boolean };
      type: string;
      department: string | null;
      purpose: string | null;
      reason: string | null;
      groupId: string | null;
      reasonCode: string | null;
      ext: boolean;
      /** マイナス配分の下限 (承認数量)。negative のときのみ使う */
      negativeFloor: number;
    },
  ): void {
    const db = this.env.DB;
    const { alloc } = args;
    const idx = statements.length;
    if (alloc.negative) {
      statements.push(
        db
          .prepare(
            `UPDATE stocks SET quantity = quantity - ?1, version = version + 1, updated_at = ?2
              WHERE id = ?3 AND version = ?4 AND quantity - ?1 >= ?5`,
          )
          .bind(alloc.quantity, args.now, alloc.stockId, alloc.version, args.negativeFloor),
      );
    } else {
      statements.push(
        db
          .prepare(
            `UPDATE stocks SET quantity = quantity - ?1, version = version + 1, updated_at = ?2
              WHERE id = ?3 AND version = ?4 AND quantity >= ?1`,
          )
          .bind(alloc.quantity, args.now, alloc.stockId, alloc.version),
      );
    }
    expected.set(idx, 1);
    statements.push(
      this.guardStmt(
        args.batchId,
        `stock-${alloc.stockId}`,
        'EXISTS (SELECT 1 FROM stocks WHERE id = ? AND version = ? AND quantity = ?)',
        [alloc.stockId, alloc.version + 1, alloc.after],
      ),
    );
    const cols =
      'document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, department, purpose, reason, store_id, created_at' +
      (args.ext ? ', group_id, reason_code' : '');
    const placeholders =
      '?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12' + (args.ext ? ', ?13, ?14' : '');
    const binds: unknown[] = [
      args.documentId,
      alloc.stockId,
      args.type,
      -alloc.quantity,
      alloc.before,
      alloc.after,
      args.actorId,
      args.department,
      args.purpose,
      args.reason,
      args.storeId,
      args.now,
    ];
    if (args.ext) binds.push(args.groupId, args.reasonCode);
    statements.push(
      db
        .prepare(`INSERT INTO stock_movements (${cols}) VALUES (${placeholders})`)
        .bind(...binds),
    );
  }

  /**
   * 実施中・承認待ちの棚卸しのロック範囲を返す。無ければ null。
   * - full (および 0014 未適用環境): 店舗の全在庫が停止
   * - locations (部分棚卸し): scope_json の location だけが停止
   * 差異承認待ち (pending_approval) の間も在庫は動かせないため同じく停止する。
   * 棚卸し自身の調整 (decideStocktake) はこのチェックを通らない専用パスで行う。
   */
  private async activeStocktakeScope(
    storeId: number,
  ): Promise<{ scopeType: 'full' | 'locations'; locationIds: ReadonlySet<number> } | null> {
    const scoped = await this.hasColumn('stocktakes', 'scope_type');
    const row = scoped
      ? await this.env.DB.prepare(
          "SELECT scope_type, scope_json FROM stocktakes WHERE store_id = ?1 AND status IN ('in_progress', 'pending_approval') LIMIT 1",
        )
          .bind(storeId)
          .first<{ scope_type: string; scope_json: string | null }>()
      : await this.env.DB.prepare(
          "SELECT 'full' AS scope_type, NULL AS scope_json FROM stocktakes WHERE store_id = ?1 AND status IN ('in_progress', 'pending_approval') LIMIT 1",
        )
          .bind(storeId)
          .first<{ scope_type: string; scope_json: string | null }>();
    if (!row) return null;
    if (row.scope_type === 'locations') {
      let ids: number[] = [];
      try {
        const parsed = JSON.parse(row.scope_json ?? '[]') as unknown;
        if (Array.isArray(parsed)) ids = parsed.filter((v): v is number => typeof v === 'number');
      } catch {
        ids = [];
      }
      return { scopeType: 'locations', locationIds: new Set(ids) };
    }
    return { scopeType: 'full', locationIds: new Set() };
  }

  /**
   * 指定 location 群への移動が棚卸しロックに触れるなら 423。
   * full は店舗の全移動を止め、partial は対象 location を含む移動だけを止める。
   */
  private async assertLocationsUnlocked(storeId: number, locationIds: number[]): Promise<void> {
    const active = await this.activeStocktakeScope(storeId);
    if (!active) return;
    if (active.scopeType === 'full') throw stocktakeLocked();
    if (locationIds.some((id) => active.locationIds.has(id))) throw stocktakeLocked();
  }

  // ------------------------------------------------------------------ 入庫

  async inbound(input: InboundInput): Promise<Envelope> {
    return this.runExclusive(async () => {
      try {
        return await this.inboundInternal(input);
      } catch (e) {
        return this.errorEnvelope(e);
      }
    });
  }

  private async inboundInternal(input: InboundInput): Promise<Envelope> {
    const stored = await this.findStoredResponse(input);
    if (stored) return stored;
    await this.assertLocationsUnlocked(input.storeId, [input.locationId]);

    const db = this.env.DB;
    const now = Date.now();
    const documentId = input.documentId ?? crypto.randomUUID();
    const batchId = crypto.randomUUID();

    // 商品・保管場所・ロットはすべて対象店舗のものだけを引く (他店舗の ID は存在しない扱い)
    const withBundle = await this.hasColumn('products', 'is_bundle');
    const product = await db
      .prepare(
        `SELECT id, requires_expiry${withBundle ? ', is_bundle' : ''} FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL`,
      )
      .bind(input.productId, input.storeId)
      .first<{ id: number; requires_expiry: number; is_bundle?: number }>();
    if (!product) throw badRequest('Product not found');
    if (product.is_bundle === 1) {
      // セット品は自前の在庫を持たないため入庫・返品の対象にできない
      throw new ApiError(422, 'BUNDLE_NO_STOCK', 'Bundle products do not hold stock and cannot be received');
    }
    if (product.requires_expiry === 1 && input.expiryDateMs === null) {
      throw badRequest('expiryDate is required for this product');
    }
    const movementType = input.kind ?? 'IN';
    const ext = await this.hasExtMovementColumns();
    const mvCols =
      'document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, reason, store_id, created_at' +
      (ext ? ', group_id, reason_code' : '');
    const auditAction = movementType === 'RETURN' ? 'stock.return' : 'stock.inbound';
    const location = await db
      .prepare(
        `SELECT loc.id FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
          WHERE loc.id = ?1 AND loc.deleted_at IS NULL AND w.store_id = ?2`,
      )
      .bind(input.locationId, input.storeId)
      .first<{ id: number }>();
    if (!location) throw badRequest('Location not found');

    const lot = await db
      .prepare('SELECT id FROM lots WHERE product_id = ?1 AND lot_code = ?2 AND store_id = ?3')
      .bind(input.productId, input.lotCode, input.storeId)
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
      const inBinds: unknown[] = [
        documentId, stock.id, movementType, input.quantity, stock.quantity, after,
        input.actorId, input.reason ?? null, input.storeId, now,
      ];
      if (ext) inBinds.push(null, input.reasonCode ?? null);
      statements.push(
        db
          .prepare(
            `INSERT INTO stock_movements (${mvCols})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10${ext ? ', ?11, ?12' : ''})`,
          )
          .bind(...inBinds),
      );
      const body = { documentId, stockId: stock.id, quantity: after };
      statements.push(await this.auditStmt(input.actorId, auditAction, 'stock', String(stock.id), {
        documentId,
        quantity: input.quantity,
      }, input.storeId));
      statements.push(this.idempotencyStmt(input, 201, body));
      statements.push(this.cleanupGuardsStmt(batchId));
      await this.runBatch(statements, expected);
      this.broadcast({ type: 'stock.changed', stockIds: [stock.id], documentId, storeId: input.storeId, at: now });
      return this.envelope(201, body);
    }

    // 新規 stocks 行: lot が無ければ作り、stocks は lot を引くサブクエリで挿入する
    if (!lot) {
      statements.push(
        db
          .prepare(
            `INSERT INTO lots (product_id, lot_code, expiry_date, received_at, store_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?4)`,
          )
          .bind(input.productId, input.lotCode, input.expiryDateMs, now, input.storeId),
      );
    }
    statements.push(
      db.prepare(
        `INSERT INTO stocks (location_id, lot_id, quantity, version, store_id, created_at, updated_at)
         SELECT ?1, id, ?2, 1, ?3, ?4, ?4 FROM lots WHERE product_id = ?5 AND lot_code = ?6 AND store_id = ?3`,
      ).bind(input.locationId, input.quantity, input.storeId, now, input.productId, input.lotCode),
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
    const newBinds: unknown[] = [
      documentId, movementType, input.quantity, input.actorId, input.reason ?? null, input.storeId, now,
    ];
    if (ext) newBinds.push(null, input.reasonCode ?? null);
    newBinds.push(input.locationId, input.productId, input.lotCode);
    statements.push(
      db.prepare(
        `INSERT INTO stock_movements (${mvCols})
         SELECT ?1, s.id, ?2, ?3, 0, ?3, ?4, ?5, ?6, ?7${ext ? ', ?8, ?9' : ''}
           FROM stocks s JOIN lots l ON l.id = s.lot_id
          WHERE s.location_id = ?${ext ? 10 : 8} AND l.product_id = ?${ext ? 11 : 9} AND l.lot_code = ?${ext ? 12 : 10}`,
      ).bind(...newBinds),
    );

    // 作成された stock の ID を引く (batch 実行前に body が要るため、実行後にもう一度引く)
    const bodyPlaceholder = { documentId, stockId: 0, quantity: input.quantity };
    statements.push(
      await this.auditStmt(input.actorId, auditAction, 'product', String(input.productId), {
        documentId,
        quantity: input.quantity,
      }, input.storeId),
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
    this.broadcast({ type: 'stock.changed', stockIds: [created.id], documentId, storeId: input.storeId, at: now });
    return this.envelope(201, body);
  }

  // ------------------------------------------------------------------ 消費

  async consume(input: ConsumeInput): Promise<Envelope> {
    return this.runExclusive(async () => {
      try {
        return await this.consumeInternal(input);
      } catch (e) {
        return this.errorEnvelope(e);
      }
    });
  }

  private async consumeInternal(input: ConsumeInput): Promise<Envelope> {
    const stored = await this.findStoredResponse(input);
    if (stored) return stored;
    // 全面棚卸しは消費も全停止。部分棚卸しは候補の絞り込みで対応する (下記)
    const activeTake = await this.activeStocktakeScope(input.storeId);
    if (activeTake?.scopeType === 'full') throw stocktakeLocked();
    if (
      activeTake?.scopeType === 'locations' &&
      input.locationId !== undefined &&
      activeTake.locationIds.has(input.locationId)
    ) {
      throw stocktakeLocked();
    }

    const db = this.env.DB;
    const now = Date.now();
    const documentId = input.documentId ?? crypto.randomUUID();
    const batchId = crypto.randomUUID();

    // FEFO 候補: 対象商品の stocks を id 昇順で読む (DO 内では他者が書き換えない)
    // 店舗スコープ: 候補は対象店舗の stocks だけに限る
    let sql = `SELECT s.id AS stock_id, s.lot_id AS lot_id, s.location_id AS location_id,
                      loc.warehouse_id AS warehouse_id, s.quantity AS quantity, s.version AS version,
                      l.expiry_date AS expiry_date, l.received_at AS received_at
                 FROM stocks s
                 JOIN lots l ON l.id = s.lot_id
                 JOIN locations loc ON loc.id = s.location_id
                WHERE l.product_id = ? AND s.store_id = ?`;
    const params: unknown[] = [input.productId, input.storeId];
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
    const allCandidates: CandidateRow[] = results.map((r) => ({
      stockId: r.stock_id,
      lotId: r.lot_id,
      expiryDate: r.expiry_date,
      quantity: r.quantity,
      receivedAt: r.received_at,
      version: r.version,
      locationId: r.location_id,
      warehouseId: r.warehouse_id,
    }));

    // 部分棚卸し中は、対象 location の在庫を候補から外す (凍結)。
    // 場所未指定の消費で「対象外だけでは不足し、対象分を使えば足りる」場合は
    // 対象 location を含む移動として 423 を返す。
    let candidates = allCandidates;
    let needsLockedStock = false;
    if (activeTake?.scopeType === 'locations' && input.locationId === undefined) {
      candidates = allCandidates.filter((cd) => !activeTake.locationIds.has(cd.locationId));
      const openShortfall = planConsumption(candidates, input.quantity, now, null).shortfall;
      if (openShortfall > 0) {
        needsLockedStock = planConsumption(allCandidates, input.quantity, now, null).shortfall === 0;
      }
    } else if (activeTake?.scopeType === 'locations' && input.locationId !== undefined) {
      // locationId 指定時は上のチェックで対象外が確定している (候補はその場所のみ)
      candidates = allCandidates;
    }

    // マイナス在庫承認 (指定時のみ)。承認済み・未使用・対象が同じ商品であること
    let approval: NegativeApprovalInfo | null = null;
    if (input.negativeApprovalId !== undefined) {
      const row = await db
        .prepare('SELECT id, stock_id, quantity, status, requested_by, approved_by, movement_id FROM negative_stock_approvals WHERE id = ?1 AND store_id = ?2')
        .bind(input.negativeApprovalId, input.storeId)
        .first<ApprovalRow>();
      if (!row) throw notFound('Negative stock approval not found');
      if (row.status !== 'approved' || row.movement_id !== null) {
        throw new ApiError(409, 'APPROVAL_NOT_USABLE', 'Approval is not approved or has already been used');
      }
      if (row.approved_by === null || row.approved_by === row.requested_by) {
        throw new ApiError(422, 'SELF_APPROVAL_FORBIDDEN', 'Self-approval is not allowed');
      }
      if (activeTake?.scopeType === 'locations') {
        const lockedTarget = allCandidates.find((cd) => cd.stockId === row.stock_id);
        if (lockedTarget && activeTake.locationIds.has(lockedTarget.locationId)) {
          throw stocktakeLocked();
        }
      }
      const target = candidates.find((c) => c.stockId === row.stock_id);
      if (!target) {
        throw badRequest('Approval target stock is not part of this consumption');
      }
      approval = { id: row.id, stockId: row.stock_id, quantity: row.quantity };
    }

    const plan = planConsumption(candidates, input.quantity, now, approval);
    if (plan.shortfall > 0) {
      // 部分棚卸しの対象在庫を使えば足りる場合は、在庫不足ではなくロックとして返す
      if (needsLockedStock) throw stocktakeLocked();
      const available = input.quantity - plan.shortfall;
      throw insufficientStock(
        `Requested ${input.quantity}, available ${available} (expired lots excluded)`,
      );
    }

    const statements: D1PreparedStatement[] = [];
    const expected = new Map<number, number>();
    const ext = await this.hasExtMovementColumns();

    // stocks.id 昇順に更新してロック順序を統一する (DO では直列だが作法として揃える)
    const ordered = [...plan.allocations].sort((a, b) => a.stockId - b.stockId);
    for (const alloc of ordered) {
      this.appendOutflowAllocation(statements, expected, {
        batchId,
        documentId,
        now,
        actorId: input.actorId,
        storeId: input.storeId,
        alloc,
        type: input.movementType ?? 'OUT',
        department: input.department,
        purpose: input.purpose,
        reason: alloc.negative
          ? 'negative-stock-approved'
          : (input.reason ?? input.fefoDeviationReason ?? null),
        groupId: input.groupId ?? null,
        reasonCode: input.reasonCode ?? null,
        ext,
        // 例外パス: 承認数量の範囲でのみマイナスを許す (quantity - q >= -承認数量)
        negativeFloor: -(approval?.quantity ?? 0),
      });
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
      await this.auditStmt(input.actorId, input.auditAction ?? 'stock.consume', 'product', String(input.productId), {
        documentId,
        quantity: input.quantity,
        ...(plan.usedApprovalId !== null ? { negativeApprovalId: plan.usedApprovalId } : {}),
      }, input.storeId),
    );
    statements.push(this.idempotencyStmt(input, 201, body));
    statements.push(this.cleanupGuardsStmt(batchId));

    await this.runBatch(statements, expected);

    this.broadcast({
      type: 'stock.changed',
      stockIds: plan.allocations.map((a) => a.stockId),
      documentId,
      storeId: input.storeId,
      ...(plan.usedApprovalId !== null
        ? { negativeStockIds: ordered.filter((a) => a.negative).map((a) => a.stockId) }
        : {}),
      at: now,
    });
    return this.envelope(201, body);
  }

  // ------------------------------------------------------------------ 一括入出庫

  async bulkMovements(input: BulkInput): Promise<Envelope> {
    return this.runExclusive(async () => {
      try {
        return await this.bulkInternal(input);
      } catch (e) {
        return this.errorEnvelope(e);
      }
    });
  }

  private async bulkInternal(input: BulkInput): Promise<Envelope> {
    const stored = await this.findStoredResponse(input);
    if (stored) return stored;
    const db = this.env.DB;
    const now = Date.now();
    const documentId = crypto.randomUUID();
    const lineError = (i: number, message: string): ApiError =>
      new ApiError(422, 'BULK_LINE_INVALID', `line ${i + 1}: ${message}`);

    // 行ごとの冪等コンテキスト。再送時は適用済みの行を読み戻してスキップする
    const lineCtx: MovementContext[] = [];
    for (let i = 0; i < input.lines.length; i++) {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${input.requestHash}#${i}`),
      );
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      lineCtx.push({
        actorId: input.actorId,
        endpoint: input.endpoint,
        idempotencyKey: `${input.idempotencyKey}#${i}`,
        requestHash: hash,
        storeId: input.storeId,
      });
    }
    const lineStored: (Envelope | null)[] = [];
    for (const ctx of lineCtx) lineStored.push(await this.findStoredResponse(ctx));

    // ---- フェーズ 1: 全行の検証と在庫シミュレーション
    const activeTake = await this.activeStocktakeScope(input.storeId);
    if (activeTake?.scopeType === 'full') throw stocktakeLocked();
    const lockedLocations: ReadonlySet<number> =
      activeTake?.scopeType === 'locations' ? activeTake.locationIds : new Set<number>();

    const withBundle = await this.hasColumn('products', 'is_bundle');
    const productCache = new Map<number, { requiresExpiry: boolean; isBundle: boolean } | null>();
    const loadProduct = async (
      productId: number,
    ): Promise<{ requiresExpiry: boolean; isBundle: boolean } | null> => {
      const cached = productCache.get(productId);
      if (cached !== undefined) return cached;
      const row = await db
        .prepare(
          `SELECT requires_expiry${withBundle ? ', is_bundle' : ''} FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL`,
        )
        .bind(productId, input.storeId)
        .first<{ requires_expiry: number; is_bundle?: number }>();
      const value = row
        ? { requiresExpiry: row.requires_expiry === 1, isBundle: row.is_bundle === 1 }
        : null;
      productCache.set(productId, value);
      return value;
    };
    const locationCache = new Map<number, boolean>();
    const locationExists = async (locationId: number): Promise<boolean> => {
      const cached = locationCache.get(locationId);
      if (cached !== undefined) return cached;
      const row = await db
        .prepare(
          `SELECT loc.id FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
            WHERE loc.id = ?1 AND loc.deleted_at IS NULL AND w.store_id = ?2`,
        )
        .bind(locationId, input.storeId)
        .first<{ id: number }>();
      const value = row !== null;
      locationCache.set(locationId, value);
      return value;
    };
    const candCache = new Map<number, CandidateRow[]>();
    const loadCandidates = async (productId: number): Promise<CandidateRow[]> => {
      const cached = candCache.get(productId);
      if (cached) return cached;
      const { results } = await db
        .prepare(
          `SELECT s.id AS stock_id, s.lot_id AS lot_id, s.location_id AS location_id,
                  loc.warehouse_id AS warehouse_id, s.quantity AS quantity, s.version AS version,
                  l.expiry_date AS expiry_date, l.received_at AS received_at
             FROM stocks s
             JOIN lots l ON l.id = s.lot_id
             JOIN locations loc ON loc.id = s.location_id
            WHERE l.product_id = ? AND s.store_id = ?
            ORDER BY s.id ASC`,
        )
        .bind(productId, input.storeId)
        .all<CandidateDbRow>();
      const rows: CandidateRow[] = results.map((r) => ({
        stockId: r.stock_id,
        lotId: r.lot_id,
        expiryDate: r.expiry_date,
        quantity: r.quantity,
        receivedAt: r.received_at,
        version: r.version,
        locationId: r.location_id,
        warehouseId: r.warehouse_id,
      }));
      candCache.set(productId, rows);
      return rows;
    };
    // 実在庫の作業数量 (stockId -> 数量) と、この一括で新規に生える在庫の受け皿
    const overlay = new Map<number, number>();
    interface Synthetic {
      fakeId: number;
      productId: number;
      locationId: number;
      expiryDate: number | null;
      quantity: number;
      receivedAt: number;
    }
    const synthetics = new Map<string, Synthetic>();
    const syntheticByFakeId = new Map<number, Synthetic>();
    let syntheticSeq = 0;

    for (let i = 0; i < input.lines.length; i++) {
      if (lineStored[i]) continue;
      const line = input.lines[i]!;
      const product = await loadProduct(line.productId);
      if (!product) throw lineError(i, 'product not found');
      if (line.type === 'IN') {
        if (product.isBundle) {
          throw new ApiError(422, 'BUNDLE_NO_STOCK', `line ${i + 1}: bundle products do not hold stock`);
        }
        if (product.requiresExpiry && line.expiryDateMs === null) {
          throw lineError(i, 'expiryDate is required for this product');
        }
        if (!(await locationExists(line.locationId))) throw lineError(i, 'location not found');
        if (lockedLocations.has(line.locationId)) throw stocktakeLocked();
        const lot = await db
          .prepare('SELECT id FROM lots WHERE product_id = ?1 AND lot_code = ?2 AND store_id = ?3')
          .bind(line.productId, line.lotCode, input.storeId)
          .first<{ id: number }>();
        let appliedToExisting = false;
        if (lot) {
          const stock = await db
            .prepare('SELECT id, quantity FROM stocks WHERE location_id = ?1 AND lot_id = ?2')
            .bind(line.locationId, lot.id)
            .first<{ id: number; quantity: number }>();
          if (stock) {
            overlay.set(stock.id, (overlay.get(stock.id) ?? stock.quantity) + line.quantity);
            appliedToExisting = true;
          }
        }
        if (!appliedToExisting) {
          const key = `${line.locationId}|${line.productId}|${line.lotCode}`;
          const syn = synthetics.get(key);
          if (syn) {
            syn.quantity += line.quantity;
          } else {
            syntheticSeq += 1;
            const created: Synthetic = {
              fakeId: -syntheticSeq,
              productId: line.productId,
              locationId: line.locationId,
              expiryDate: line.expiryDateMs,
              quantity: line.quantity,
              receivedAt: now + syntheticSeq,
            };
            synthetics.set(key, created);
            syntheticByFakeId.set(created.fakeId, created);
          }
        }
      } else {
        if (product.isBundle) {
          throw lineError(i, 'bundle products are not supported in bulk; use the bundle consumption endpoint');
        }
        if (line.locationId !== undefined) {
          if (!(await locationExists(line.locationId))) throw lineError(i, 'location not found');
          if (lockedLocations.has(line.locationId)) throw stocktakeLocked();
        }
        const pristine = await loadCandidates(line.productId);
        const buildCandidates = (includeLocked: boolean): CandidateRow[] => {
          const out: CandidateRow[] = [];
          for (const cd of pristine) {
            if (line.locationId !== undefined && cd.locationId !== line.locationId) continue;
            if (input.allowedLocationIds !== null && !input.allowedLocationIds.includes(cd.locationId)) continue;
            if (!includeLocked && lockedLocations.has(cd.locationId)) continue;
            out.push({ ...cd, quantity: overlay.get(cd.stockId) ?? cd.quantity });
          }
          for (const syn of synthetics.values()) {
            if (syn.productId !== line.productId) continue;
            if (line.locationId !== undefined && syn.locationId !== line.locationId) continue;
            if (input.allowedLocationIds !== null && !input.allowedLocationIds.includes(syn.locationId)) continue;
            out.push({
              stockId: syn.fakeId,
              lotId: syn.fakeId,
              expiryDate: syn.expiryDate,
              quantity: syn.quantity,
              receivedAt: syn.receivedAt,
              version: 0,
              locationId: syn.locationId,
              warehouseId: 0,
            });
          }
          return out;
        };
        const plan = planConsumption(buildCandidates(false), line.quantity, now, null);
        if (plan.shortfall > 0) {
          if (
            lockedLocations.size > 0 &&
            planConsumption(buildCandidates(true), line.quantity, now, null).shortfall === 0
          ) {
            throw stocktakeLocked();
          }
          throw lineError(i, 'insufficient stock');
        }
        for (const a of plan.allocations) {
          if (a.stockId >= 0) {
            overlay.set(a.stockId, a.after);
          } else {
            const syn = syntheticByFakeId.get(a.stockId);
            if (syn) syn.quantity = a.after;
          }
        }
      }
    }

    // ---- フェーズ 2: 行を順に実適用する (内部処理が検証と冪等を再実行する)
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < input.lines.length; i++) {
      const line = input.lines[i]!;
      const already = lineStored[i];
      if (already) {
        results.push({ line: i + 1, type: line.type, ...(already.body as Record<string, unknown>) });
        continue;
      }
      const ctx = lineCtx[i]!;
      let envelope: Envelope;
      try {
        envelope =
          line.type === 'IN'
            ? await this.inboundInternal({
                ...ctx,
                locationId: line.locationId,
                productId: line.productId,
                lotCode: line.lotCode,
                expiryDateMs: line.expiryDateMs,
                quantity: line.quantity,
                reason: line.reason ?? null,
                documentId,
              })
            : await this.consumeInternal({
                ...ctx,
                productId: line.productId,
                ...(line.locationId !== undefined ? { locationId: line.locationId } : {}),
                quantity: line.quantity,
                department: line.department ?? '',
                purpose: line.purpose ?? '',
                allowedLocationIds: input.allowedLocationIds,
                documentId,
              });
      } catch (e) {
        envelope = this.errorEnvelope(e);
      }
      // 検証済みのため通常は到達しない。到達した場合は一括の冪等記録を残さず、
      // その行のエラーを返す (適用済みの行は行ごとの冪等キーで再送時にスキップされる)
      if (envelope.status >= 400) return envelope;
      results.push({ line: i + 1, type: line.type, ...(envelope.body as Record<string, unknown>) });
    }
    const body = { documentId, results };
    await this.idempotencyStmt(input, 201, body).run();
    return this.envelope(201, body);
  }

  // ------------------------------------------------------------------ 移動

  async transfer(input: TransferInput): Promise<Envelope> {
    return this.runExclusive(async () => {
      try {
        return await this.transferInternal(input);
      } catch (e) {
        return this.errorEnvelope(e);
      }
    });
  }

  /**
   * 在庫移動: 移動元の stocks から FEFO (または指定ロット) で引き、
   * 移動先の stocks へ加算する。台帳には同一 document_id で
   * TRANSFER_OUT (移動元) / TRANSFER_IN (移動先) を対で残す。
   */
  private async transferInternal(input: TransferInput): Promise<Envelope> {
    const stored = await this.findStoredResponse(input);
    if (stored) return stored;
    await this.assertLocationsUnlocked(input.storeId, [input.fromLocationId, input.toLocationId]);

    const db = this.env.DB;
    const now = Date.now();
    const documentId = crypto.randomUUID();
    const batchId = crypto.randomUUID();

    if (input.fromLocationId === input.toLocationId) {
      throw badRequest('fromLocationId and toLocationId must differ');
    }
    const product = await db
      .prepare('SELECT id FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL')
      .bind(input.productId, input.storeId)
      .first<{ id: number }>();
    if (!product) throw badRequest('Product not found');
    for (const locationId of [input.fromLocationId, input.toLocationId]) {
      const location = await db
        .prepare(
          `SELECT loc.id FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
            WHERE loc.id = ?1 AND loc.deleted_at IS NULL AND w.store_id = ?2`,
        )
        .bind(locationId, input.storeId)
        .first<{ id: number }>();
      if (!location) throw badRequest('Location not found');
    }

    // 移動元候補: 対象商品の stocks (期限切れは FEFO 提案から外れる = 移動もしない)
    let sql = `SELECT s.id AS stock_id, s.lot_id AS lot_id, s.quantity AS quantity,
                      s.version AS version, l.expiry_date AS expiry_date, l.received_at AS received_at
                 FROM stocks s
                 JOIN lots l ON l.id = s.lot_id
                WHERE s.location_id = ? AND l.product_id = ? AND s.store_id = ?`;
    const params: unknown[] = [input.fromLocationId, input.productId, input.storeId];
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
          WHERE location_id = ? AND store_id = ? AND lot_id IN (${lotIds.map(() => '?').join(',')})`,
      )
      .bind(input.toLocationId, input.storeId, ...lotIds)
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
            `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, store_id, created_at)
             VALUES (?1, ?2, 'TRANSFER_OUT', ?3, ?4, ?5, ?6, ?7, ?8)`,
          )
          .bind(documentId, alloc.stockId, -alloc.quantity, src.quantity, srcAfter, input.actorId, input.storeId, now),
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
              `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, store_id, created_at)
               VALUES (?1, ?2, 'TRANSFER_IN', ?3, ?4, ?5, ?6, ?7, ?8)`,
            )
            .bind(documentId, dest.id, alloc.quantity, dest.quantity, destAfter, input.actorId, input.storeId, now),
        );
      } else {
        // 移動先に stocks 行が無い: lot は既存なので lot_id を直接指定して作る
        statements.push(
          db
            .prepare(
              `INSERT INTO stocks (location_id, lot_id, quantity, version, store_id, created_at, updated_at)
               VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)`,
            )
            .bind(input.toLocationId, alloc.lotId, alloc.quantity, input.storeId, now),
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
            `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, store_id, created_at)
             SELECT ?1, s.id, 'TRANSFER_IN', ?2, 0, ?2, ?3, ?4, ?5
               FROM stocks s WHERE s.location_id = ?6 AND s.lot_id = ?7`,
          ).bind(documentId, alloc.quantity, input.actorId, input.storeId, now, input.toLocationId, alloc.lotId),
        );
      }
    }

    statements.push(
      await this.auditStmt(input.actorId, 'stock.transfer', 'product', String(input.productId), {
        documentId,
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        quantity: input.quantity,
      }, input.storeId),
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
      storeId: input.storeId,
      at: now,
    });
    return this.envelope(201, body);
  }

  // ------------------------------------------------- セット品消費 / ピッキング確定 (0015)

  /** FEFO 候補の読み取り (消費と同じ形)。locationId 未指定は店舗全体 */
  private async loadFefoCandidates(
    storeId: number,
    productId: number,
    locationId: number | undefined,
    allowedLocationIds: number[] | null,
  ): Promise<CandidateRow[]> {
    const db = this.env.DB;
    let sql = `SELECT s.id AS stock_id, s.lot_id AS lot_id, s.location_id AS location_id,
                      loc.warehouse_id AS warehouse_id, s.quantity AS quantity, s.version AS version,
                      l.expiry_date AS expiry_date, l.received_at AS received_at
                 FROM stocks s
                 JOIN lots l ON l.id = s.lot_id
                 JOIN locations loc ON loc.id = s.location_id
                WHERE l.product_id = ? AND s.store_id = ?`;
    const params: unknown[] = [productId, storeId];
    if (locationId !== undefined) {
      sql += ' AND s.location_id = ?';
      params.push(locationId);
    }
    if (allowedLocationIds !== null) {
      if (allowedLocationIds.length === 0) return [];
      sql += ` AND s.location_id IN (${allowedLocationIds.map(() => '?').join(',')})`;
      params.push(...allowedLocationIds);
    }
    sql += ' ORDER BY s.id ASC';
    const { results } = await db.prepare(sql).bind(...params).all<CandidateDbRow>();
    return results.map((r) => ({
      stockId: r.stock_id,
      lotId: r.lot_id,
      expiryDate: r.expiry_date,
      quantity: r.quantity,
      receivedAt: r.received_at,
      version: r.version,
      locationId: r.location_id,
      warehouseId: r.warehouse_id,
    }));
  }

  async consumeBundle(input: BundleConsumeInput): Promise<Envelope> {
    return this.runExclusive(async () => {
      try {
        return await this.consumeBundleInternal(input);
      } catch (e) {
        return this.errorEnvelope(e);
      }
    });
  }

  /**
   * セット品の消費: 構成品を必要数 × セット数だけ FEFO で消費する。
   * 全構成品の計画が揃ってから 1 batch で確定するため、どれか 1 つでも
   * 不足すれば全体が失敗する (中途半端な展開を残さない)。
   * 台帳は構成品ごとの OUT で、group_id (= document_id) で束ねる。
   */
  private async consumeBundleInternal(input: BundleConsumeInput): Promise<Envelope> {
    const stored = await this.findStoredResponse(input);
    if (stored) return stored;
    const activeTake = await this.activeStocktakeScope(input.storeId);
    if (activeTake?.scopeType === 'full') throw stocktakeLocked();
    if (
      activeTake?.scopeType === 'locations' &&
      input.locationId !== undefined &&
      activeTake.locationIds.has(input.locationId)
    ) {
      throw stocktakeLocked();
    }

    const db = this.env.DB;
    const now = Date.now();
    const documentId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const ext = await this.hasExtMovementColumns();

    const withBundle = await this.hasColumn('products', 'is_bundle');
    const bundle = await db
      .prepare(
        `SELECT id${withBundle ? ', is_bundle' : ''} FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL`,
      )
      .bind(input.bundleProductId, input.storeId)
      .first<{ id: number; is_bundle?: number }>();
    if (!bundle) throw badRequest('Product not found');
    if (withBundle && bundle.is_bundle !== 1) {
      throw new ApiError(422, 'NOT_A_BUNDLE', 'Product is not a bundle');
    }
    if (input.components.length === 0) {
      throw new ApiError(422, 'BUNDLE_HAS_NO_COMPONENTS', 'Bundle has no components');
    }

    interface ComponentPlan {
      productId: number;
      required: number;
      allocations: { stockId: number; lotId: number; locationId: number; quantity: number; before: number; after: number; version: number; negative: boolean }[];
    }
    const plans: ComponentPlan[] = [];
    for (const comp of input.components) {
      const required = comp.quantity * input.quantity;
      let candidates = await this.loadFefoCandidates(
        input.storeId,
        comp.productId,
        input.locationId,
        input.allowedLocationIds,
      );
      let needsLockedStock = false;
      if (activeTake?.scopeType === 'locations' && input.locationId === undefined) {
        const all = candidates;
        candidates = all.filter((cd) => !activeTake.locationIds.has(cd.locationId));
        if (planConsumption(candidates, required, now, null).shortfall > 0) {
          needsLockedStock = planConsumption(all, required, now, null).shortfall === 0;
        }
      }
      const plan = planConsumption(candidates, required, now, null);
      if (plan.shortfall > 0) {
        if (needsLockedStock) throw stocktakeLocked();
        throw insufficientStock(
          `Component product ${comp.productId}: requested ${required}, available ${required - plan.shortfall} (expired lots excluded)`,
        );
      }
      plans.push({ productId: comp.productId, required, allocations: plan.allocations });
    }

    const statements: D1PreparedStatement[] = [];
    const expected = new Map<number, number>();
    const bodyAllocations: { productId: number; stockId: number; lotId: number; locationId: number; quantity: number }[] = [];
    for (const plan of plans) {
      const ordered = [...plan.allocations].sort((a, b) => a.stockId - b.stockId);
      for (const alloc of ordered) {
        this.appendOutflowAllocation(statements, expected, {
          batchId,
          documentId,
          now,
          actorId: input.actorId,
          storeId: input.storeId,
          alloc,
          type: 'OUT',
          department: input.department,
          purpose: input.purpose,
          reason: null,
          groupId: documentId,
          reasonCode: null,
          ext,
          negativeFloor: 0,
        });
        bodyAllocations.push({
          productId: plan.productId,
          stockId: alloc.stockId,
          lotId: alloc.lotId,
          locationId: alloc.locationId,
          quantity: alloc.quantity,
        });
      }
    }
    const body = { documentId, groupId: documentId, allocations: bodyAllocations };
    statements.push(
      await this.auditStmt(input.actorId, 'stock.consume_bundle', 'product', String(input.bundleProductId), {
        documentId,
        quantity: input.quantity,
        components: plans.map((p) => ({ productId: p.productId, quantity: p.required })),
      }, input.storeId),
    );
    statements.push(this.idempotencyStmt(input, 201, body));
    statements.push(this.cleanupGuardsStmt(batchId));
    await this.runBatch(statements, expected);
    this.broadcast({
      type: 'stock.changed',
      stockIds: bodyAllocations.map((a) => a.stockId),
      documentId,
      storeId: input.storeId,
      at: now,
    });
    return this.envelope(201, body);
  }

  async confirmPick(input: PickConfirmInput): Promise<Envelope> {
    return this.runExclusive(async () => {
      try {
        return await this.confirmPickInternal(input);
      } catch (e) {
        return this.errorEnvelope(e);
      }
    });
  }

  /**
   * ピッキングリストの確定: 検品済み数量を消費または移動として一括実行する。
   * 計画はメモリ上の残高 (オーバーレイ) に対して組み立て、全明細の計画が
   * 揃ってから 1 batch で確定するため、在庫不足があれば全体が失敗する。
   * 同一 batch 内で pick_lists を done に進めることも含めて原子的。
   */
  private async confirmPickInternal(input: PickConfirmInput): Promise<Envelope> {
    const stored = await this.findStoredResponse(input);
    if (stored) return stored;
    const touchedLocationIds = input.items.map((i) => i.fromLocationId);
    if (input.type === 'transfer' && input.toLocationId !== undefined) {
      touchedLocationIds.push(input.toLocationId);
    }
    await this.assertLocationsUnlocked(input.storeId, touchedLocationIds);

    const db = this.env.DB;
    const now = Date.now();
    const documentId = crypto.randomUUID();
    const batchId = crypto.randomUUID();
    const ext = await this.hasExtMovementColumns();

    if (input.type === 'transfer') {
      if (input.toLocationId === undefined) throw badRequest('toLocationId is required for transfer pick lists');
      for (const item of input.items) {
        if (item.fromLocationId === input.toLocationId) {
          throw badRequest('fromLocationId and toLocationId must differ');
        }
      }
    }

    interface StockState {
      id: number;
      lotId: number;
      locationId: number;
      /** batch 実行前の数量・version (条件付き UPDATE の期待値) */
      initialQuantity: number;
      version: number;
      /** オーバーレイ上の現在数量 */
      quantity: number;
    }
    const stockState = new Map<number, StockState>();
    /** 新規に作る移動先 stocks (locationId:lotId -> 数量) */
    const destNew = new Map<string, { locationId: number; lotId: number; quantity: number }>();
    interface Op {
      stockId: number | null;
      destKey: string | null;
      type: string;
      quantityChange: number;
      before: number;
      after: number;
    }
    const ops: Op[] = [];

    const registerStock = (row: { id: number; lot_id: number; location_id: number; quantity: number; version: number }): StockState => {
      const existing = stockState.get(row.id);
      if (existing) return existing;
      const st: StockState = {
        id: row.id,
        lotId: row.lot_id,
        locationId: row.location_id,
        initialQuantity: row.quantity,
        version: row.version,
        quantity: row.quantity,
      };
      stockState.set(row.id, st);
      return st;
    };

    for (const item of input.items) {
      if (item.quantity <= 0) continue;
      const product = await db
        .prepare('SELECT id FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL')
        .bind(item.productId, input.storeId)
        .first<{ id: number }>();
      if (!product) throw badRequest('Product not found');
      const { results } = await db
        .prepare(
          `SELECT s.id, s.lot_id, s.location_id, s.quantity, s.version,
                  l.expiry_date, l.received_at
             FROM stocks s JOIN lots l ON l.id = s.lot_id
            WHERE s.location_id = ? AND l.product_id = ? AND s.store_id = ?
            ORDER BY s.id ASC`,
        )
        .bind(item.fromLocationId, item.productId, input.storeId)
        .all<{ id: number; lot_id: number; location_id: number; quantity: number; version: number; expiry_date: number | null; received_at: number }>();
      const candidates: FefoCandidate[] = results.map((r) => {
        const st = registerStock(r);
        return {
          stockId: r.id,
          lotId: r.lot_id,
          expiryDate: r.expiry_date,
          quantity: st.quantity,
          receivedAt: r.received_at,
        };
      });
      const plan = proposeFefoAllocation(candidates, item.quantity, now);
      if (plan.shortfall > 0) {
        throw insufficientStock(
          `Product ${item.productId} at location ${item.fromLocationId}: requested ${item.quantity}, available ${item.quantity - plan.shortfall} (expired lots excluded)`,
        );
      }
      for (const alloc of plan.allocations) {
        const st = stockState.get(alloc.stockId);
        if (!st) throw stockConflict();
        const before = st.quantity;
        const after = before - alloc.quantity;
        st.quantity = after;
        ops.push({
          stockId: st.id,
          destKey: null,
          type: input.type === 'consume' ? 'OUT' : 'TRANSFER_OUT',
          quantityChange: -alloc.quantity,
          before,
          after,
        });
        if (input.type === 'transfer') {
          const toLocationId = input.toLocationId as number;
          const destRow = await db
            .prepare('SELECT id, lot_id, location_id, quantity, version FROM stocks WHERE location_id = ?1 AND lot_id = ?2 AND store_id = ?3')
            .bind(toLocationId, alloc.lotId, input.storeId)
            .first<{ id: number; lot_id: number; location_id: number; quantity: number; version: number }>();
          if (destRow) {
            const dst = registerStock(destRow);
            const dBefore = dst.quantity;
            dst.quantity += alloc.quantity;
            ops.push({
              stockId: dst.id,
              destKey: null,
              type: 'TRANSFER_IN',
              quantityChange: alloc.quantity,
              before: dBefore,
              after: dst.quantity,
            });
          } else {
            const key = `${toLocationId}:${alloc.lotId}`;
            const dn = destNew.get(key) ?? { locationId: toLocationId, lotId: alloc.lotId, quantity: 0 };
            const dBefore = dn.quantity;
            dn.quantity += alloc.quantity;
            destNew.set(key, dn);
            ops.push({
              stockId: null,
              destKey: key,
              type: 'TRANSFER_IN',
              quantityChange: alloc.quantity,
              before: dBefore,
              after: dn.quantity,
            });
          }
        }
      }
    }
    if (ops.length === 0) throw badRequest('No picked items to confirm');

    const statements: D1PreparedStatement[] = [];
    const expected = new Map<number, number>();
    const mvCols =
      'document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, department, purpose, reason, store_id, created_at' +
      (ext ? ', group_id, reason_code' : '');
    const purpose = input.type === 'consume' ? `ピッキング #${input.pickListId}` : null;

    // 既存 stocks の更新は stock ごとに 1 回に集約する (同一行への二重更新を避ける)
    const touched = [...stockState.values()]
      .filter((st) => st.quantity !== st.initialQuantity)
      .sort((a, b) => a.id - b.id);
    for (const st of touched) {
      const delta = st.quantity - st.initialQuantity;
      const idx = statements.length;
      if (delta < 0) {
        statements.push(
          db
            .prepare(
              `UPDATE stocks SET quantity = quantity - ?1, version = version + 1, updated_at = ?2
                WHERE id = ?3 AND version = ?4 AND quantity >= ?1`,
            )
            .bind(-delta, now, st.id, st.version),
        );
      } else {
        statements.push(
          db
            .prepare(
              'UPDATE stocks SET quantity = quantity + ?1, version = version + 1, updated_at = ?2 WHERE id = ?3 AND version = ?4',
            )
            .bind(delta, now, st.id, st.version),
        );
      }
      expected.set(idx, 1);
      statements.push(
        this.guardStmt(
          batchId,
          `pick-stock-${st.id}`,
          'EXISTS (SELECT 1 FROM stocks WHERE id = ? AND version = ? AND quantity = ?)',
          [st.id, st.version + 1, st.quantity],
        ),
      );
    }
    // 新規の移動先 stocks
    for (const dn of destNew.values()) {
      statements.push(
        db
          .prepare(
            `INSERT INTO stocks (location_id, lot_id, quantity, version, store_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)`,
          )
          .bind(dn.locationId, dn.lotId, dn.quantity, input.storeId, now),
      );
      statements.push(
        this.guardStmt(
          batchId,
          `pick-new-${dn.locationId}-${dn.lotId}`,
          'EXISTS (SELECT 1 FROM stocks WHERE location_id = ? AND lot_id = ? AND quantity = ? AND version = 1)',
          [dn.locationId, dn.lotId, dn.quantity],
        ),
      );
    }
    // 台帳 (計画順)
    for (const op of ops) {
      if (op.stockId !== null) {
        const binds: unknown[] = [
          documentId, op.stockId, op.type, op.quantityChange, op.before, op.after,
          input.actorId, null, op.type === 'OUT' ? purpose : null, null, input.storeId, now,
        ];
        if (ext) binds.push(documentId, null);
        statements.push(
          db
            .prepare(
              `INSERT INTO stock_movements (${mvCols}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12${ext ? ', ?13, ?14' : ''})`,
            )
            .bind(...binds),
        );
      } else {
        const dn = destNew.get(op.destKey as string);
        if (!dn) throw stockConflict();
        const binds: unknown[] = [
          documentId, op.type, op.quantityChange, op.before, op.after, input.actorId, input.storeId, now,
        ];
        if (ext) binds.push(documentId, null);
        binds.push(dn.locationId, dn.lotId);
        statements.push(
          db.prepare(
            `INSERT INTO stock_movements (${mvCols})
             SELECT ?1, s.id, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, ?7, ?8${ext ? ', ?9, ?10' : ''}
               FROM stocks s WHERE s.location_id = ?${ext ? 11 : 9} AND s.lot_id = ?${ext ? 12 : 10}`,
          ).bind(...binds),
        );
      }
    }
    // リストを done に進める (同一 batch で原子的に)
    if (await this.hasColumn('pick_lists', 'status')) {
      const idx = statements.length;
      statements.push(
        db
          .prepare(
            "UPDATE pick_lists SET status = 'done', completed_at = ?1 WHERE id = ?2 AND store_id = ?3 AND status = 'open'",
          )
          .bind(now, input.pickListId, input.storeId),
      );
      expected.set(idx, 1);
    }
    statements.push(
      await this.auditStmt(input.actorId, 'pick_list.confirm', 'pick_list', String(input.pickListId), {
        documentId,
        type: input.type,
        items: input.items.filter((i) => i.quantity > 0).length,
      }, input.storeId),
    );
    const body = { documentId, groupId: documentId, movements: ops.length };
    statements.push(this.idempotencyStmt(input, 201, body));
    statements.push(this.cleanupGuardsStmt(batchId));
    await this.runBatch(statements, expected);

    const stockIds = touched.map((st) => st.id);
    for (const dn of destNew.values()) {
      const created = await db
        .prepare('SELECT id FROM stocks WHERE location_id = ?1 AND lot_id = ?2 AND store_id = ?3')
        .bind(dn.locationId, dn.lotId, input.storeId)
        .first<{ id: number }>();
      if (created) stockIds.push(created.id);
    }
    this.broadcast({ type: 'stock.changed', stockIds, documentId, storeId: input.storeId, at: now });
    return this.envelope(201, body);
  }

  // ---------------------------------------------------------------- 棚卸し

  async startStocktake(input: StartStocktakeInput): Promise<Envelope> {
    return this.runExclusive(async () => {
      try {
        return await this.startStocktakeInternal(input);
      } catch (e) {
        return this.errorEnvelope(e);
      }
    });
  }

  private async startStocktakeInternal(input: StartStocktakeInput): Promise<Envelope> {
    try {
      const db = this.env.DB;
      const now = Date.now();
      const scopeType = input.scopeType ?? 'full';
      const blind = input.blind === true;
      const locationIds = [...new Set(input.locationIds ?? [])];
      if (scopeType === 'locations') {
        if (locationIds.length === 0) {
          throw badRequest('locationIds is required for a partial (locations) stocktake');
        }
        // 対象 location はすべて対象店舗のものであること (他店舗の ID は存在しない扱い)
        const { results: locRows } = await db
          .prepare(
            `SELECT loc.id FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
              WHERE loc.deleted_at IS NULL AND w.store_id = ?1 AND loc.id IN (${locationIds.map(() => '?').join(',')})`,
          )
          .bind(input.storeId, ...locationIds)
          .all<{ id: number }>();
        if (locRows.length !== locationIds.length) throw badRequest('Location not found');
      }

      // 実施中+承認待ちは店舗ごとに 1 件まで (DB の部分ユニークインデックスでも担保)
      const existing = await db
        .prepare(
          "SELECT id FROM stocktakes WHERE store_id = ?1 AND status IN ('in_progress', 'pending_approval') LIMIT 1",
        )
        .bind(input.storeId)
        .first<{ id: number }>();
      if (existing) throw stocktakeLocked('Another stocktake is already in progress or awaiting approval');

      const scoped = await this.hasColumn('stocktakes', 'scope_type');
      const inserted = scoped
        ? await db
            .prepare(
              `INSERT INTO stocktakes (status, started_by, started_at, store_id, scope_type, scope_json, blind, created_at, updated_at)
               VALUES ('in_progress', ?1, ?2, ?3, ?4, ?5, ?6, ?2, ?2)`,
            )
            .bind(
              input.actorId,
              now,
              input.storeId,
              scopeType,
              scopeType === 'locations' ? JSON.stringify(locationIds) : null,
              blind ? 1 : 0,
            )
            .run()
        : await db
            .prepare(
              `INSERT INTO stocktakes (status, started_by, started_at, store_id, created_at, updated_at)
               VALUES ('in_progress', ?1, ?2, ?3, ?2, ?2)`,
            )
            .bind(input.actorId, now, input.storeId)
            .run();
      const stocktakeId = Number(inserted.meta.last_row_id);

      // 帳簿数のスナップショット: full は店舗の全 stocks、partial は対象 location の分のみ
      const lineResult =
        scopeType === 'locations'
          ? await db
              .prepare(
                `INSERT INTO stocktake_lines (stocktake_id, stock_id, book_quantity)
                 SELECT ?1, id, quantity FROM stocks
                  WHERE store_id = ?2 AND location_id IN (${locationIds.map(() => '?').join(',')})`,
              )
              .bind(stocktakeId, input.storeId, ...locationIds)
              .run()
          : await db
              .prepare(
                `INSERT INTO stocktake_lines (stocktake_id, stock_id, book_quantity)
                 SELECT ?1, id, quantity FROM stocks WHERE store_id = ?2`,
              )
              .bind(stocktakeId, input.storeId)
              .run();
      await (await this.auditStmt(input.actorId, 'stocktake.start', 'stocktake', String(stocktakeId), {
        stocktakeId,
        scopeType,
        ...(scopeType === 'locations' ? { locationIds } : {}),
        blind,
      }, input.storeId)).run();

      const body = {
        id: stocktakeId,
        status: 'in_progress',
        startedBy: input.actorId,
        startedAt: now,
        lineCount: lineResult.meta.changes,
        scopeType,
        ...(scopeType === 'locations' ? { locationIds } : {}),
        blind,
      };
      this.broadcast({ type: 'stocktake.started', stocktakeId, storeId: input.storeId, at: now });
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
  async finishStocktake(input: { actorId: number; stocktakeId: number; storeId: number }): Promise<Envelope> {
    return this.runExclusive(async () => {
      try {
        return await this.finishStocktakeInternal(input);
      } catch (e) {
        return this.errorEnvelope(e);
      }
    });
  }

  private async finishStocktakeInternal(input: { actorId: number; stocktakeId: number; storeId: number }): Promise<Envelope> {
    try {
      const db = this.env.DB;
      const now = Date.now();
      const batchId = crypto.randomUUID();
      const stocktake = await db
        .prepare('SELECT id, status, store_id FROM stocktakes WHERE id = ?1')
        .bind(input.stocktakeId)
        .first<{ id: number; status: string; store_id: number }>();
      if (!stocktake || stocktake.store_id !== input.storeId || stocktake.status !== 'in_progress') {
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
          await this.auditStmt(input.actorId, 'stocktake.finish', 'stocktake', String(input.stocktakeId), {
            stocktakeId: input.stocktakeId,
            result: 'confirmed',
          }, input.storeId),
        );
        statements.push(this.cleanupGuardsStmt(batchId));
        await this.runBatch(statements, expected);

        const body = { id: input.stocktakeId, status: 'confirmed', confirmedAt: now };
        this.broadcast({ type: 'stocktake.finished', stocktakeId: input.stocktakeId, storeId: input.storeId, at: now });
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
        await this.auditStmt(input.actorId, 'stocktake.finish', 'stocktake', String(input.stocktakeId), {
          stocktakeId: input.stocktakeId,
          result: 'pending_approval',
          differences: diffs,
        }, input.storeId),
      );
      statements.push(this.cleanupGuardsStmt(batchId));
      await this.runBatch(statements, expected);

      const body = { id: input.stocktakeId, status: 'pending_approval', differences: diffs };
      this.broadcast({ type: 'stocktake.pending_approval', stocktakeId: input.stocktakeId, storeId: input.storeId, at: now });
      return this.envelope(200, body);
    } catch (e) {
      return this.errorEnvelope(e);
    }
  }

  /**
   * 棚卸しの差異承認/差し戻し (pending_approval のときのみ)。
   * 承認: 差異を調整伝票 (stock_movements type 'ADJUST', reason 'stocktake-adjustment')
   * として在庫へ反映し confirmed にする。棚卸しロック中でも棚卸し自身の調整は
   * 通す必要があるため、このメソッドはロックチェックを経由しない専用パス。
   * 差し戻し: 実数は保持したまま in_progress に戻す。
   */
  async decideStocktake(input: {
    actorId: number;
    stocktakeId: number;
    approve: boolean;
    storeId: number;
  }): Promise<Envelope> {
    return this.runExclusive(async () => {
      try {
        return await this.decideStocktakeInternal(input);
      } catch (e) {
        return this.errorEnvelope(e);
      }
    });
  }

  private async decideStocktakeInternal(input: {
    actorId: number;
    stocktakeId: number;
    approve: boolean;
    storeId: number;
  }): Promise<Envelope> {
    try {
      const db = this.env.DB;
      const now = Date.now();
      const batchId = crypto.randomUUID();
      const stocktake = await db
        .prepare('SELECT id, status, store_id FROM stocktakes WHERE id = ?1')
        .bind(input.stocktakeId)
        .first<{ id: number; status: string; store_id: number }>();
      if (!stocktake || stocktake.store_id !== input.storeId || stocktake.status !== 'pending_approval') {
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
          await this.auditStmt(input.actorId, 'stocktake.decide', 'stocktake', String(input.stocktakeId), {
            stocktakeId: input.stocktakeId,
            approve: false,
          }, input.storeId),
        );
        statements.push(this.cleanupGuardsStmt(batchId));
        await this.runBatch(statements, expected);

        const body = { id: input.stocktakeId, status: 'in_progress' };
        this.broadcast({ type: 'stocktake.decision', stocktakeId: input.stocktakeId, approve: false, storeId: input.storeId, at: now });
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
              `INSERT INTO stock_movements (document_id, stock_id, type, quantity_change, quantity_before, quantity_after, actor_id, reason, store_id, created_at)
               VALUES (?1, ?2, 'ADJUST', ?3, ?4, ?5, ?6, 'stocktake-adjustment', ?7, ?8)`,
            )
            .bind(documentId, diff.stockId, diff.difference, stock.quantity, after, input.actorId, input.storeId, now),
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
        await this.auditStmt(input.actorId, 'stocktake.decide', 'stocktake', String(input.stocktakeId), {
          stocktakeId: input.stocktakeId,
          approve: true,
          documentId,
          adjustments: adjustments.map((a) => ({ stockId: a.stockId, difference: a.difference })),
        }, input.storeId),
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
        storeId: input.storeId,
        at: now,
      });
      this.broadcast({ type: 'stocktake.finished', stocktakeId: input.stocktakeId, storeId: input.storeId, at: now });
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
