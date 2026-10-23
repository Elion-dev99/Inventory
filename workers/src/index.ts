import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from './env';
import {
  InventoryCoordinator,
  type ConsumeInput,
  type Envelope,
  type InboundInput,
} from './coordinator';
import { authenticate, assertHasAssignments, type AuthUser } from './lib/auth';
import {
  canAccessWarehouse,
  canPerform,
  hasRole,
  reachableWarehouseIds,
  RoleCode,
  type RoleAssignment,
} from './lib/access';
import { ApiError, badRequest, forbidden, notFound } from './lib/errors';
import { isExpired } from './fefo';
import {
  consumptionSchema,
  createApprovalSchema,
  createLocationSchema,
  createLotSchema,
  createProductSchema,
  createWarehouseSchema,
  decideApprovalSchema,
  formatDateOnly,
  inboundSchema,
  parseDateOnly,
} from './lib/schemas';

export { InventoryCoordinator };

/**
 * 在庫管理システム — Cloudflare Workers + D1 版 API。
 * パスは NestJS 版と互換 (/api/v1 配下)。
 * 在庫の書き込みはすべて InventoryCoordinator (Durable Object) 経由。
 * それ以外の読み取り・マスタ・承認レコードは Worker から D1 を直接扱う。
 */

type Variables = { user: AuthUser };
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ------------------------------------------------------------ ヘルスチェック
app.get('/api/v1/health', (c) => c.json({ status: 'ok' }));

// ------------------------------------------------------------ ルート (案内ページ)
// フロントエンド未実装のため、トップではサービスの状態と API の入口だけを示す。
app.get('/', (c) =>
  c.html(`<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>在庫管理システム</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.7;">
<h1>在庫管理システム</h1>
<p>サービスは稼働中です (Workers + D1 版)。</p>
<ul>
<li>ヘルスチェック: <a href="/api/v1/health">/api/v1/health</a></li>
<li>API ベースパス: <code>/api/v1</code> (業務 API は認証が必要です)</li>
</ul>
<p><a href="/login">Google でログイン</a> (業務 API の動作確認用ページ)</p>
<p>画面 (フロントエンド) は Phase 2 で提供予定です。</p>
</body>
</html>`),
);

// ------------------------------------------------------------ ログイン (動作確認用)
// Google Identity Services で ID トークンを取得し、業務 API を呼ぶ最小ページ。
// トークンは sessionStorage にのみ保持し、サーバー側では JWKS で検証する。
app.get('/login', (c) => {
  const clientId = c.env.OIDC_CLIENT_ID ?? '';
  if (!clientId) {
    return c.html(
      '<!doctype html><html lang="ja"><body style="font-family: system-ui, sans-serif; margin: 2rem;">OIDC が未設定です。</body></html>',
      503,
    );
  }
  return c.html(`<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ログイン | 在庫管理システム</title>
<script src="https://accounts.google.com/gsi/client" async defer></script>
</head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.7;">
<h1>在庫管理システム ログイン</h1>
<div id="gbtn"></div>
<p id="who"></p>
<button id="apitest" style="display:none; padding: 0.5rem 1rem;">API をテストする (在庫一覧)</button>
<button id="logout" style="display:none; padding: 0.5rem 1rem;">ログアウト</button>
<pre id="out" style="white-space: pre-wrap; background: #f4f4f4; padding: 1rem;"></pre>
<script>
function decodeJwt(t) {
  const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(p))));
}
function refresh() {
  const t = sessionStorage.getItem('idToken');
  document.getElementById('apitest').style.display = t ? '' : 'none';
  document.getElementById('logout').style.display = t ? '' : 'none';
  if (t) {
    try { const d = decodeJwt(t); document.getElementById('who').textContent = 'ログイン中: ' + (d.email || d.sub); } catch (e) {}
  } else { document.getElementById('who').textContent = ''; }
}
window.onload = function () {
  google.accounts.id.initialize({
    client_id: '${clientId}',
    callback: function (res) {
      sessionStorage.setItem('idToken', res.credential);
      document.getElementById('out').textContent = 'ログインしました。「API をテストする」を押してください。';
      refresh();
    },
  });
  google.accounts.id.renderButton(document.getElementById('gbtn'), { theme: 'outline', size: 'large' });
  refresh();
};
document.getElementById('apitest').onclick = async function () {
  const t = sessionStorage.getItem('idToken');
  const r = await fetch('/api/v1/stocks', { headers: { Authorization: 'Bearer ' + t } });
  document.getElementById('out').textContent = 'HTTP ' + r.status + '\n' + (await r.text());
};
document.getElementById('logout').onclick = function () {
  sessionStorage.removeItem('idToken');
  google.accounts.id.disableAutoSelect();
  document.getElementById('out').textContent = 'ログアウトしました。';
  refresh();
};
</script>
</body>
</html>`);
});

// ---------------------------------------------------------------- 認証
app.use('/api/v1/*', async (c, next) => {
  if (c.req.path === '/api/v1/health') return next();
  const user = await authenticate(c.req.raw, c.env);
  c.set('user', user);
  return next();
});

function user(c: AppContext): AuthUser {
  return c.get('user');
}

function requireRole(c: AppContext, ...roles: RoleCode[]): void {
  assertHasAssignments(user(c));
  if (!hasRole(user(c).assignments, ...roles)) throw forbidden('Insufficient role');
}

// ------------------------------------------------------------ ユーティリティ

async function parseJson(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest('Request body must be JSON');
  }
}

function parseWith<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return result.data;
}

function requireIdempotencyKey(c: AppContext): string {
  const key = c.req.header('idempotency-key');
  if (!key) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required for mutations');
  }
  return key;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Coordinator (単一インスタンス 'global') へのスタブ (RPC メソッドを型付け) */
interface CoordinatorStub {
  inbound: (input: InboundInput) => Promise<Envelope>;
  consume: (input: ConsumeInput) => Promise<Envelope>;
  startStocktake: (input: { actorId: number }) => Promise<Envelope>;
  finishStocktake: (input: { actorId: number; stocktakeId: number }) => Promise<Envelope>;
  fetch: (request: Request) => Promise<Response>;
}

function coordinator(c: AppContext): CoordinatorStub {
  const id = c.env.INVENTORY_COORDINATOR.idFromName('global');
  return c.env.INVENTORY_COORDINATOR.get(id) as unknown as CoordinatorStub;
}

function respond(c: AppContext, envelope: Envelope): Response {
  return c.json(envelope.body as Record<string, unknown>, envelope.status as 200);
}

// スコープ内 location の ID 一覧 (null = 全 location)。消費の候補絞り込みに使う
async function allowedLocationIds(c: AppContext): Promise<number[] | null> {
  const reachable = reachableWarehouseIds(user(c).assignments);
  if (reachable === null) return null;
  if (reachable.length === 0) return [];
  const { results } = await c.env.DB.prepare(
    `SELECT id FROM locations WHERE warehouse_id IN (${reachable.map(() => '?').join(',')})`,
  )
    .bind(...reachable)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

async function warehouseIdOfLocation(c: AppContext, locationId: number): Promise<number> {
  const row = await c.env.DB.prepare('SELECT warehouse_id FROM locations WHERE id = ?1 AND deleted_at IS NULL')
    .bind(locationId)
    .first<{ warehouse_id: number }>();
  if (!row) throw notFound('Location not found');
  return row.warehouse_id;
}

async function warehouseIdOfStock(c: AppContext, stockId: number): Promise<number> {
  const row = await c.env.DB.prepare(
    `SELECT loc.warehouse_id AS warehouse_id
       FROM stocks s JOIN locations loc ON loc.id = s.location_id
      WHERE s.id = ?1`,
  )
    .bind(stockId)
    .first<{ warehouse_id: number }>();
  if (!row) throw notFound('Stock not found');
  return row.warehouse_id;
}

// ---------------------------------------------------------------- マスタ

interface ProductRow {
  id: number;
  sku: string;
  name: string;
  unit: string;
  barcode: string | null;
  safety_stock: number;
  requires_expiry: number;
  expiry_alert_days: number | null;
  created_at: number;
  updated_at: number;
}

function productJson(r: ProductRow): Record<string, unknown> {
  return {
    id: r.id,
    sku: r.sku,
    name: r.name,
    unit: r.unit,
    barcode: r.barcode,
    safetyStock: r.safety_stock,
    requiresExpiry: r.requires_expiry === 1,
    expiryAlertDays: r.expiry_alert_days,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function listProducts(c: AppContext): Promise<Response> {
  assertHasAssignments(user(c));
  const skip = Number(c.req.query('skip') ?? 0);
  const take = Math.min(Number(c.req.query('take') ?? 50), 200);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM products WHERE deleted_at IS NULL ORDER BY id ASC LIMIT ?1 OFFSET ?2',
  )
    .bind(take, skip)
    .all<ProductRow>();
  return c.json(results.map(productJson));
}

async function createProduct(c: AppContext): Promise<Response> {
  requireRole(c, RoleCode.SYSTEM_ADMIN, RoleCode.INVENTORY_MANAGER);
  const dto = parseWith(createProductSchema, await parseJson(c));
  const now = Date.now();
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO products (sku, name, unit, barcode, safety_stock, requires_expiry, expiry_alert_days, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    )
      .bind(dto.sku, dto.name, dto.unit, dto.barcode ?? null, dto.safetyStock ?? 0, dto.requiresExpiry ? 1 : 0, dto.expiryAlertDays ?? null, now)
      .run();
    return c.json({ id: Number(res.meta.last_row_id), ...dto }, 201);
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Product with this sku already exists');
  }
}

async function listWarehouses(c: AppContext): Promise<Response> {
  assertHasAssignments(user(c));
  const reachable = reachableWarehouseIds(user(c).assignments);
  let sql = 'SELECT id, code, name FROM warehouses WHERE deleted_at IS NULL';
  const params: number[] = [];
  if (reachable !== null) {
    if (reachable.length === 0) return c.json([]);
    sql += ` AND id IN (${reachable.map(() => '?').join(',')})`;
    params.push(...reachable);
  }
  sql += ' ORDER BY id ASC';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
}

async function createWarehouse(c: AppContext): Promise<Response> {
  requireRole(c, RoleCode.SYSTEM_ADMIN, RoleCode.INVENTORY_MANAGER);
  const dto = parseWith(createWarehouseSchema, await parseJson(c));
  const now = Date.now();
  try {
    const res = await c.env.DB.prepare(
      'INSERT INTO warehouses (code, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)',
    )
      .bind(dto.code, dto.name, now)
      .run();
    return c.json({ id: Number(res.meta.last_row_id), code: dto.code, name: dto.name }, 201);
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Warehouse with this code already exists');
  }
}

async function listLocations(c: AppContext): Promise<Response> {
  assertHasAssignments(user(c));
  const reachable = reachableWarehouseIds(user(c).assignments);
  const warehouseId = c.req.query('warehouseId');
  let sql = `SELECT id, warehouse_id AS warehouseId, code, name
               FROM locations WHERE deleted_at IS NULL`;
  const params: number[] = [];
  if (reachable !== null) {
    if (reachable.length === 0) return c.json([]);
    sql += ` AND warehouse_id IN (${reachable.map(() => '?').join(',')})`;
    params.push(...reachable);
  }
  if (warehouseId !== undefined) {
    sql += ' AND warehouse_id = ?';
    params.push(Number(warehouseId));
  }
  sql += ' ORDER BY id ASC';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
}

async function createLocation(c: AppContext): Promise<Response> {
  requireRole(c, RoleCode.SYSTEM_ADMIN, RoleCode.INVENTORY_MANAGER);
  const dto = parseWith(createLocationSchema, await parseJson(c));
  if (!canAccessWarehouse(user(c).assignments, dto.warehouseId)) {
    throw forbidden('Out of warehouse scope');
  }
  const now = Date.now();
  try {
    const res = await c.env.DB.prepare(
      'INSERT INTO locations (warehouse_id, code, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
    )
      .bind(dto.warehouseId, dto.code, dto.name, now)
      .run();
    return c.json({ id: Number(res.meta.last_row_id), warehouseId: dto.warehouseId, code: dto.code, name: dto.name }, 201);
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Location with this code already exists in the warehouse');
  }
}

async function listLots(c: AppContext): Promise<Response> {
  assertHasAssignments(user(c));
  const productId = c.req.query('productId');
  let sql = 'SELECT id, product_id AS productId, lot_code AS lotCode, expiry_date AS expiryMs, received_at AS receivedAt FROM lots';
  const params: number[] = [];
  if (productId !== undefined) {
    sql += ' WHERE product_id = ?';
    params.push(Number(productId));
  }
  sql += ' ORDER BY id ASC LIMIT 200';
  const { results } = await c.env.DB.prepare(sql)
    .bind(...params)
    .all<{ id: number; productId: number; lotCode: string; expiryMs: number | null; receivedAt: number }>();
  return c.json(
    results.map((r) => ({ ...r, expiryDate: formatDateOnly(r.expiryMs), expiryMs: undefined })),
  );
}

async function createLot(c: AppContext): Promise<Response> {
  requireRole(c, RoleCode.SYSTEM_ADMIN, RoleCode.INVENTORY_MANAGER);
  const dto = parseWith(createLotSchema, await parseJson(c));
  const product = await c.env.DB.prepare('SELECT id, requires_expiry FROM products WHERE id = ?1 AND deleted_at IS NULL')
    .bind(dto.productId)
    .first<{ id: number; requires_expiry: number }>();
  if (!product) throw notFound('Product not found');
  let expiryMs: number | null = null;
  if (dto.expiryDate !== undefined) {
    expiryMs = parseDateOnly(dto.expiryDate);
    if (expiryMs === null) throw badRequest('expiryDate must be a valid YYYY-MM-DD date');
  }
  if (product.requires_expiry === 1 && expiryMs === null) {
    throw badRequest('expiryDate is required for this product');
  }
  const now = Date.now();
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO lots (product_id, lot_code, expiry_date, received_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4, ?4)`,
    )
      .bind(dto.productId, dto.lotCode, expiryMs, now)
      .run();
    return c.json(
      { id: Number(res.meta.last_row_id), productId: dto.productId, lotCode: dto.lotCode, expiryDate: dto.expiryDate ?? null },
      201,
    );
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Lot with this lotCode already exists for the product');
  }
}

for (const base of ['/api/v1/master', '/api/v1'] as const) {
  app.get(`${base}/products`, listProducts);
  app.post(`${base}/products`, createProduct);
  app.get(`${base}/warehouses`, listWarehouses);
  app.post(`${base}/warehouses`, createWarehouse);
  app.get(`${base}/locations`, listLocations);
  app.post(`${base}/locations`, createLocation);
  app.get(`${base}/lots`, listLots);
  app.post(`${base}/lots`, createLot);
}

// ---------------------------------------------------------------- 在庫参照

interface StockViewRow {
  id: number;
  location_id: number;
  lot_id: number;
  quantity: number;
  version: number;
  warehouse_id: number;
  product_id: number;
  sku: string;
  lot_code: string;
  expiry_date: number | null;
}

function stockJson(r: StockViewRow): Record<string, unknown> {
  return {
    id: r.id,
    locationId: r.location_id,
    lotId: r.lot_id,
    quantity: r.quantity,
    version: r.version,
    warehouseId: r.warehouse_id,
    productId: r.product_id,
    sku: r.sku,
    lotCode: r.lot_code,
    expiryDate: formatDateOnly(r.expiry_date),
  };
}

const STOCK_VIEW_SQL = `SELECT s.id, s.location_id, s.lot_id, s.quantity, s.version,
                               loc.warehouse_id, l.product_id, p.sku, l.lot_code, l.expiry_date
                          FROM stocks s
                          JOIN locations loc ON loc.id = s.location_id
                          JOIN lots l ON l.id = s.lot_id
                          JOIN products p ON p.id = l.product_id`;

app.get('/api/v1/stocks', async (c) => {
  assertHasAssignments(user(c));
  const reachable = reachableWarehouseIds(user(c).assignments);
  const conditions: string[] = [];
  const params: (number | string)[] = [];
  if (reachable !== null) {
    if (reachable.length === 0) return c.json([]);
    conditions.push(`loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`);
    params.push(...reachable);
  }
  const locationId = c.req.query('locationId');
  if (locationId !== undefined) {
    conditions.push('s.location_id = ?');
    params.push(Number(locationId));
  }
  const productId = c.req.query('productId');
  if (productId !== undefined) {
    conditions.push('l.product_id = ?');
    params.push(Number(productId));
  }
  const skip = Number(c.req.query('skip') ?? 0);
  const take = Math.min(Number(c.req.query('take') ?? 50), 200);
  const sql =
    STOCK_VIEW_SQL +
    (conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '') +
    ' ORDER BY s.id ASC LIMIT ? OFFSET ?';
  params.push(take, skip);
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<StockViewRow>();
  return c.json(results.map(stockJson));
});

app.get('/api/v1/stocks/:id', async (c) => {
  assertHasAssignments(user(c));
  const id = Number(c.req.param('id'));
  const row = await c.env.DB.prepare(`${STOCK_VIEW_SQL} WHERE s.id = ?1`)
    .bind(id)
    .first<StockViewRow>();
  if (!row) throw notFound('Stock not found');
  if (!canAccessWarehouse(user(c).assignments, row.warehouse_id)) {
    // スコープ外は存在自体を漏らさない (Nest 版の方針)
    throw notFound('Stock not found');
  }
  return c.json(stockJson(row));
});

// ---------------------------------------------------------------- 入出庫

app.post('/api/v1/movements/inbound', async (c) => {
  requireRole(c, RoleCode.INVENTORY_STAFF, RoleCode.INVENTORY_MANAGER, RoleCode.SYSTEM_ADMIN);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(inboundSchema, raw);
  const warehouseId = await warehouseIdOfLocation(c, dto.locationId);
  if (!canPerform(user(c).assignments, warehouseId, RoleCode.INVENTORY_STAFF, RoleCode.INVENTORY_MANAGER, RoleCode.SYSTEM_ADMIN)) {
    throw forbidden('Out of warehouse scope');
  }
  let expiryDateMs: number | null = null;
  if (dto.expiryDate !== undefined) {
    expiryDateMs = parseDateOnly(dto.expiryDate);
    if (expiryDateMs === null) throw badRequest('expiryDate must be a valid YYYY-MM-DD date');
  }
  const envelope = await coordinator(c).inbound({
    actorId: user(c).userId,
    endpoint: 'POST /api/v1/movements/inbound',
    idempotencyKey: requireIdempotencyKey(c),
    requestHash: await sha256Hex(JSON.stringify(raw)),
    locationId: dto.locationId,
    productId: dto.productId,
    lotCode: dto.lotCode,
    expiryDateMs,
    quantity: dto.quantity,
  });
  return respond(c, envelope);
});

app.post('/api/v1/movements/consumption', async (c) => {
  requireRole(c, RoleCode.INVENTORY_STAFF, RoleCode.INVENTORY_MANAGER, RoleCode.SYSTEM_ADMIN);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(consumptionSchema, raw);
  if (dto.locationId !== undefined) {
    const warehouseId = await warehouseIdOfLocation(c, dto.locationId);
    if (!canPerform(user(c).assignments, warehouseId, RoleCode.INVENTORY_STAFF, RoleCode.INVENTORY_MANAGER, RoleCode.SYSTEM_ADMIN)) {
      throw forbidden('Out of warehouse scope');
    }
  }
  const envelope = await coordinator(c).consume({
    actorId: user(c).userId,
    endpoint: 'POST /api/v1/movements/consumption',
    idempotencyKey: requireIdempotencyKey(c),
    requestHash: await sha256Hex(JSON.stringify(raw)),
    productId: dto.productId,
    ...(dto.locationId !== undefined ? { locationId: dto.locationId } : {}),
    quantity: dto.quantity,
    department: dto.department,
    purpose: dto.purpose,
    ...(dto.fefoDeviationReason !== undefined ? { fefoDeviationReason: dto.fefoDeviationReason } : {}),
    ...(dto.negativeApprovalId !== undefined ? { negativeApprovalId: dto.negativeApprovalId } : {}),
    allowedLocationIds: await allowedLocationIds(c),
  });
  return respond(c, envelope);
});

// ------------------------------------------------------- マイナス在庫承認

app.post('/api/v1/negative-approvals', async (c) => {
  requireRole(c, RoleCode.INVENTORY_STAFF, RoleCode.INVENTORY_MANAGER, RoleCode.SYSTEM_ADMIN);
  const dto = parseWith(createApprovalSchema, await parseJson(c));
  const warehouseId = await warehouseIdOfStock(c, dto.stockId);
  if (!canPerform(user(c).assignments, warehouseId, RoleCode.INVENTORY_STAFF, RoleCode.INVENTORY_MANAGER, RoleCode.SYSTEM_ADMIN)) {
    throw forbidden('Out of warehouse scope');
  }
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `INSERT INTO negative_stock_approvals (stock_id, quantity, reason, status, requested_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?5)`,
  )
    .bind(dto.stockId, dto.quantity, dto.reason, user(c).userId, now)
    .run();
  return c.json(
    { id: Number(res.meta.last_row_id), stockId: dto.stockId, quantity: dto.quantity, reason: dto.reason, status: 'pending', requestedBy: user(c).userId },
    201,
  );
});

app.get('/api/v1/negative-approvals', async (c) => {
  assertHasAssignments(user(c));
  const reachable = reachableWarehouseIds(user(c).assignments);
  if (reachable !== null && reachable.length === 0) return c.json([]);
  let sql = `SELECT a.id, a.stock_id AS stockId, a.quantity, a.reason, a.status,
                    a.requested_by AS requestedBy, a.approved_by AS approvedBy,
                    a.decided_at AS decidedAt, a.movement_id AS movementId, a.created_at AS createdAt
               FROM negative_stock_approvals a
               JOIN stocks s ON s.id = a.stock_id
               JOIN locations loc ON loc.id = s.location_id`;
  const params: number[] = [];
  if (reachable !== null) {
    sql += ` WHERE loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`;
    params.push(...reachable);
  }
  sql += ' ORDER BY a.id DESC LIMIT 100';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
});

app.post('/api/v1/negative-approvals/:id/decide', async (c) => {
  requireRole(c, RoleCode.INVENTORY_MANAGER, RoleCode.SYSTEM_ADMIN);
  const id = Number(c.req.param('id'));
  const dto = parseWith(decideApprovalSchema, await parseJson(c));
  const approval = await approvalRow(c, id);
  const warehouseId = await warehouseIdOfStock(c, approval.stock_id);
  if (!canPerform(user(c).assignments, warehouseId, RoleCode.INVENTORY_MANAGER, RoleCode.SYSTEM_ADMIN)) {
    throw forbidden('Out of warehouse scope');
  }
  if (approval.requested_by === user(c).userId) {
    // 自己承認禁止 (要件 Q1 / DB の CHECK 制約でも担保)
    throw new ApiError(422, 'SELF_APPROVAL_FORBIDDEN', 'Requester cannot decide their own approval');
  }
  if (approval.status !== 'pending') {
    throw new ApiError(409, 'APPROVAL_ALREADY_DECIDED', 'Approval has already been decided');
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE negative_stock_approvals
            SET status = ?1, approved_by = ?2, decided_at = ?3, updated_at = ?3
          WHERE id = ?4 AND status = 'pending'`,
      )
      .bind(dto.decision, user(c).userId, now, id),
    c.env.DB
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, created_at)
         VALUES (?1, ?2, 'negative_stock_approval', ?3, ?4, ?5)`,
      )
      .bind(user(c).userId, `negative_approval.${dto.decision}`, String(id), JSON.stringify({ decision: dto.decision }), now),
  ]);
  return c.json({ id, status: dto.decision, approvedBy: user(c).userId, decidedAt: now });
});

interface ApprovalDbRow {
  id: number;
  stock_id: number;
  status: string;
  requested_by: number;
}

async function approvalRow(c: AppContext, id: number): Promise<ApprovalDbRow> {
  const row = await c.env.DB.prepare(
    'SELECT id, stock_id, status, requested_by FROM negative_stock_approvals WHERE id = ?1',
  )
    .bind(id)
    .first<ApprovalDbRow>();
  if (!row) throw notFound('Negative stock approval not found');
  return row;
}

// ---------------------------------------------------------------- 棚卸し

app.post('/api/v1/stocktakes', async (c) => {
  requireRole(c, RoleCode.INVENTORY_MANAGER, RoleCode.SYSTEM_ADMIN);
  const envelope = await coordinator(c).startStocktake({ actorId: user(c).userId });
  return respond(c, envelope);
});

app.get('/api/v1/stocktakes', async (c) => {
  assertHasAssignments(user(c));
  const { results } = await c.env.DB.prepare(
    `SELECT id, status, started_by AS startedBy, started_at AS startedAt, confirmed_at AS confirmedAt
       FROM stocktakes ORDER BY id DESC LIMIT 50`,
  ).all();
  return c.json(results);
});

app.post('/api/v1/stocktakes/:id/finish', async (c) => {
  requireRole(c, RoleCode.INVENTORY_MANAGER, RoleCode.SYSTEM_ADMIN);
  const envelope = await coordinator(c).finishStocktake({
    actorId: user(c).userId,
    stocktakeId: Number(c.req.param('id')),
  });
  return respond(c, envelope);
});

// ---------------------------------------------------------------- アラート

interface AlertRow extends StockViewRow {
  safety_stock: number;
  expiry_alert_days: number | null;
}

app.get('/api/v1/alerts', async (c) => {
  assertHasAssignments(user(c));
  const reachable = reachableWarehouseIds(user(c).assignments);
  if (reachable !== null && reachable.length === 0) return c.json([]);
  let sql = `SELECT s.id, s.location_id, s.lot_id, s.quantity, s.version,
                    loc.warehouse_id, l.product_id, p.sku, l.lot_code, l.expiry_date,
                    p.safety_stock, p.expiry_alert_days
               FROM stocks s
               JOIN locations loc ON loc.id = s.location_id
               JOIN lots l ON l.id = s.lot_id
               JOIN products p ON p.id = l.product_id`;
  const params: number[] = [];
  if (reachable !== null) {
    sql += ` WHERE loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`;
    params.push(...reachable);
  }
  sql += ' ORDER BY s.id ASC LIMIT 1000';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<AlertRow>();

  const now = Date.now();
  const DAY = 86_400_000;
  const alerts: Record<string, unknown>[] = [];
  for (const r of results) {
    const base = {
      stockId: r.id,
      productId: r.product_id,
      sku: r.sku,
      quantity: r.quantity,
      expiryDate: formatDateOnly(r.expiry_date),
    };
    if (r.quantity < 0) alerts.push({ type: 'NEGATIVE_STOCK', ...base });
    if (isExpired(r.expiry_date, now)) {
      alerts.push({ type: 'EXPIRED', ...base });
      continue;
    }
    if (r.expiry_date !== null && r.expiry_alert_days !== null) {
      if (now >= r.expiry_date - r.expiry_alert_days * DAY) alerts.push({ type: 'EXPIRING', ...base });
    }
    if (r.quantity >= 0 && r.quantity <= r.safety_stock) alerts.push({ type: 'LOW_STOCK', ...base });
  }
  return c.json(alerts);
});

// ------------------------------------------------------- リアルタイム (WS)

app.get('/api/v1/realtime', async (c) => {
  assertHasAssignments(user(c));
  return coordinator(c).fetch(c.req.raw);
});

// ---------------------------------------------------------------- エラー

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
  console.error('Unhandled error', err);
  return c.json({ statusCode: 500, error: 'INTERNAL', message: 'Internal error' }, 500);
});

app.notFound((c) => c.json({ statusCode: 404, error: 'NOT_FOUND', message: 'Route not found' }, 404));

// 型参照用 (RPC の表面を保つ)
export type { RoleAssignment };
export default app;
