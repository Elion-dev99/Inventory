import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from './env';
import {
  InventoryCoordinator,
  type BulkInput,
  type BulkLineInput,
  type BundleConsumeInput,
  type ConsumeInput,
  type Envelope,
  type InboundInput,
  type PickConfirmInput,
  type StartStocktakeInput,
  type TransferInput,
} from './coordinator';
import {
  authenticate,
  assertHasAssignments,
  syncUserFromPayload,
  verifyToken,
  type AuthUser,
} from './lib/auth';
import {
  ALL_ROLE_CODES,
  assignedStoreIds,
  canAccessWarehouse,
  canPerformPermission,
  hasPermission,
  isPlatformAdmin,
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
  Permission,
  permissionsOf,
  reachableWarehouseIds,
  resolveRolePermissions,
  RoleCode,
  type PermissionKey,
  type RoleAssignment,
  type RolePermissionMap,
} from './lib/access';
import {
  accessibleStores,
  getStore,
  resolveStoreContext,
  softResolveStoreContext,
  type StoreContext,
  type StoreInfo,
} from './lib/stores';
import {
  clearSessionCookieHeader,
  createSession,
  currentSessionRow,
  destroySession,
  hashSessionToken,
  markSessionStepUp,
  readSessionToken,
  resolveSessionUser,
  sessionCookieHeader,
  setSessionStore,
  STEP_UP_WINDOW_MS,
} from './lib/session';
import { buildAuditInsert, insertAudit, verifyAuditChain } from './lib/audit-chain';
import {
  base64UrlDecode,
  base64UrlEncode,
  checkClientData,
  consumeChallenge,
  coseEc2ToJwk,
  issueChallenge,
  parseAttestationObject,
  parseAuthenticatorData,
  parseClientData,
  sha256Bytes,
  bytesEqual,
  verifyAssertionSignature,
  verifyAttestationSignature,
} from './lib/webauthn';
import { clientIp, recordLoginEvent } from './lib/login-events';
import { APP_HTML } from './app/page';
import { APP_CSS } from './app/styles';
import { APP_JS } from './app/client';
import { PWA_HEAD, manifestResponse, iconResponse, serviceWorkerResponse } from './pwa';
import { ApiError, badRequest, forbidden, notFound } from './lib/errors';
import { isExpired } from './fefo';
import {
  bulkProductsSchema,
  bundleComponentsSchema,
  bundleConsumptionSchema,
  bulkMovementsSchema,
  consumptionSchema,
  createNamedMasterSchema,
  createReasonCodeSchema,
  storeSettingsSchema,
  updateCategorySchema,
  updateNamedMasterSchema,
  updateReasonCodeSchema,
  consumeReservationSchema,
  countedQuantitySchema,
  createApprovalSchema,
  createPickListSchema,
  createPoTemplateSchema,
  createReservationSchema,
  createStocktakeSchema,
  createLocationSchema,
  createLotSchema,
  createProductSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  createWarehouseSchema,
  decideApprovalSchema,
  decideStocktakeSchema,
  disposalSchema,
  formatDateOnly,
  inboundSchema,
  parseDateOnly,
  poScheduleSchema,
  receivePurchaseOrderSchema,
  returnMovementSchema,
  signupSchema,
  transferSchema,
  updateLocationSchema,
  updateLotSchema,
  updatePickItemSchema,
  updateProductSchema,
  updateSupplierSchema,
  updateWarehouseSchema,
} from './lib/schemas';
import {
  activeReservationRows,
  bundleAvailability,
  bundleComponentRows,
  createDraftPurchaseOrder,
  reservationJson,
  runScheduledPoDrafts,
  storeStockRows,
  type ReservationDbRow,
} from './lib/commercial';
import { computeFreeQuantities } from './lib/free-stock';
import {
  SUPPORTED_CURRENCIES,
  assertReasonCodeUsable,
  ensureReasonCodesSeeded,
  getStoreSettings,
  isValidTimezone,
  listReasonCodes,
  setStoreSettings,
  type ReasonKind,
} from './lib/store-masters';
import { maybeAutoBackup } from './lib/backup';
import {
  defaultFeatures,
  FEATURE_CATALOG,
  FEATURE_KEYS,
  getFeatures,
  isFeatureEnabled,
  type FeatureMap,
} from './lib/features';
import {
  exceedsLimit,
  hasOrganizationsTable,
  organizationUsage,
  planAllowsFeature,
  planAllowsModule,
  planFeatureError,
  planLimitError,
  resolveStorePlan,
  singleStoreUsage,
  type ModuleKey,
} from './lib/plans';
import {
  applyIndustryTemplate,
  findTemplate,
  isTemplateKey,
  templateCatalogJson,
} from './lib/templates';
import { parseCsv, toCsv } from './lib/csv';
import {
  recordMaintenanceRejections,
  resolveMaintenance,
  resolvedMaintenanceMessage,
  type MaintenanceResolution,
} from './lib/maintenance';
import {
  announcementAdminJson,
  announcementJson,
  getVisibleAnnouncement,
  listVisibleAnnouncements,
  markAnnouncementRead,
  type AnnouncementRow,
} from './lib/announcements';
import {
  maybeSendAnnouncementPush,
  runScheduledAnnouncementPushes,
} from './lib/push';
import {
  imageResponse,
  imagesBucket,
  movementPhotoKey,
  productImageKey,
  readImageBody,
  requireImagesBucket,
} from './lib/photos';
import { qrSvg } from './lib/qr';
import {
  SCAN_ENGINE_VERSION,
  SCAN_READER_JS,
  SCAN_SHARE_JS,
  SCAN_WASM_SHA256,
  scanWasmBytes,
} from './scan-assets';
import { SCAN_WORKER_JS } from './scan-worker';

export { InventoryCoordinator };

/**
 * 在庫管理システム — Cloudflare Workers + D1 版 API。
 * パスは NestJS 版と互換 (/api/v1 配下)。
 * 在庫の書き込みはすべて InventoryCoordinator (Durable Object) 経由。
 * それ以外の読み取り・マスタ・承認レコードは Worker から D1 を直接扱う。
 */

type Variables = {
  user: AuthUser;
  /** 解決済みの店舗コンテキスト (業務 API 用にメモ化する) */
  storeCtx?: StoreContext;
  /** 表示用の緩い解決結果 (null = 未選択) のメモ化 */
  softCtxBox?: { ctx: StoreContext | null };
  /** 認証ミドルウェアで解決したメンテナンス状態 (/me が再利用する) */
  maintenance?: MaintenanceResolution;
};
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// -------------------------------------------------- セキュリティ基盤 (0017)
// 全レスポンスへセキュリティヘッダを付け、/api/v1 の状態変更リクエストには
// Origin チェックを行う (CSRF の多層防御。一次防御は Cookie の SameSite=Lax)。
// CSP の緩和点:
// - script-src の 'unsafe-inline': /app 等の単一 HTML がインラインスクリプト
//   で構成されるため (nonce 化は将来課題)。
// - script-src / frame-src の accounts.google.com: /login の Google
//   Identity Services ボタン (外部スクリプト + iframe) 用。
// - 'wasm-unsafe-eval': スキャンエンジン (zxing-wasm) のコンパイル用。
const CSP_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://accounts.google.com",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob:",
  "connect-src 'self' wss:",
  "style-src 'self' 'unsafe-inline'",
  'frame-src https://accounts.google.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * CSP を付けないパス。Service Worker とスキャンエンジンは、自身の応答
 * ヘッダがそのまま実行コンテキストのポリシーになるため、アプリ文書向け
 * CSP を被せると起動できなくなる (nosniff 等の他ヘッダは付ける)。
 */
function skipsCsp(path: string): boolean {
  return path === '/sw.js' || path.startsWith('/assets/scan/');
}

app.use('*', async (c, next) => {
  if (
    c.req.path.startsWith('/api/v1/') &&
    (c.req.method === 'POST' ||
      c.req.method === 'PUT' ||
      c.req.method === 'DELETE' ||
      c.req.method === 'PATCH')
  ) {
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost === null || originHost !== new URL(c.req.url).host) {
        return c.json(
          { statusCode: 403, error: 'ORIGIN_MISMATCH', message: 'Origin does not match host' },
          403,
        );
      }
    }
  }
  await next();
  try {
    const headers = c.res.headers;
    if (!skipsCsp(c.req.path)) headers.set('Content-Security-Policy', CSP_VALUE);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  } catch {
    // WebSocket (101) などヘッダを変更できないレスポンスでは黙って諦める
  }
});

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
<p><a href="/app">アプリを開く</a> (在庫管理の画面。ログインが必要です)</p>
<p><a href="/login">Google でログイン</a> (業務 API の動作確認用ページ)</p>
<p><a href="/admin/permissions">権限管理</a> (管理者用: ロールごとの権限とユーザーのロール付与)</p>
</body>
</html>`),
);

// ------------------------------------------------------------ フロントエンド SPA
// /app で配信する単一ページアプリ (src/app/)。認証は Cookie セッションで、
// 未ログイン時はアプリ側が /api/v1/me の 401 を見てログイン導線を出す。
app.get('/app', (c) => c.html(APP_HTML));

// /app の CSS / JS 本体。内容ハッシュ付き URL で参照され、内容が変わらない
// 限り再ダウンロードされない (immutable)。シェル HTML は小さく保たれる。
app.get('/assets/app.css', () =>
  new Response(APP_CSS, {
    headers: {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  }),
);
app.get('/assets/app.js', () =>
  new Response(APP_JS, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  }),
);

// PWA: ホーム画面追加でブラウザのバーを出さずにフルスクリーン起動する
app.get('/manifest.webmanifest', () => manifestResponse());
app.get('/icons/:name', (c) => iconResponse(c.req.param('name')) ?? c.notFound());
// Web Push 用 Service Worker (push で通知表示、クリックで /app を開く)
app.get('/sw.js', () => serviceWorkerResponse());

// ------------------------------------------------------------ バーコードスキャンエンジン
// ZXing (zxing-wasm) のデコードエンジンを Worker 自身が配信する。
// 本番デプロイが単一モジュール (index.js) の API アップロードのため、
// エンジンを外部 CDN に置かず、glue JS は文字列として、wasm は base64 で
// 内包している (src/scan-assets.ts、生成: scripts/gen-scan-assets.mjs)。
// ブラウザ側はモジュールワーカー (/assets/scan/worker.js) が相対 import で
// glue を読み、wasm は Cache Storage にキャッシュして使う。
function scanJsResponse(js: string): Response {
  return new Response(js, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
app.get('/assets/scan/worker.js', () => scanJsResponse(SCAN_WORKER_JS));
app.get('/assets/scan/es/share.js', () => scanJsResponse(SCAN_SHARE_JS));
app.get('/assets/scan/es/reader/index.js', () => scanJsResponse(SCAN_READER_JS));
app.get('/assets/scan/zxing_reader.wasm', () =>
  new Response(scanWasmBytes(), {
    headers: {
      'Content-Type': 'application/wasm',
      'Cache-Control': 'public, max-age=604800',
      ETag: `"zxing-${SCAN_ENGINE_VERSION}-${SCAN_WASM_SHA256.slice(0, 12)}"`,
    },
  }),
);

// ------------------------------------------------------------ ラベル印刷
// QR ラベルをサーバー描画で返す印刷用ページ (要ログイン + master.read)。
// 商品ラベルの QR 内容はスキャンで解決できる値 (バーコードがあればバーコード、
// 無ければ SKU)、保管場所ラベルは場所コード。印刷時は白背景・黒文字で、
// アプリの UI を出さない (@media print でツールバーを隠す)。

function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.get('/labels/print', async (c) => {
  const authUser = await authenticate(c.req.raw, c.env);
  c.set('user', authUser);
  await requirePermission(c, Permission.MASTER_READ);
  const ctx = await storeContext(c);
  const type = c.req.query('type') === 'locations' ? 'locations' : 'products';
  const ids = (c.req.query('ids') ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 200);

  interface LabelItem {
    qr: string;
    title: string;
    sub: string;
  }
  const items: LabelItem[] = [];
  if (type === 'products') {
    const sql =
      'SELECT id, sku, name, barcode FROM products WHERE store_id = ?1 AND deleted_at IS NULL' +
      (ids.length > 0 ? ` AND id IN (${ids.map(() => '?').join(',')})` : '') +
      ' ORDER BY id ASC LIMIT 200';
    const { results } = await c.env.DB.prepare(sql)
      .bind(ctx.store.id, ...ids)
      .all<{ id: number; sku: string; name: string; barcode: string | null }>();
    for (const r of results) {
      items.push({ qr: r.barcode && r.barcode.length > 0 ? r.barcode : r.sku, title: r.name, sub: r.sku });
    }
  } else {
    const sql =
      `SELECT loc.id, loc.code, loc.name, w.name AS warehouse_name
         FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
        WHERE w.store_id = ?1 AND loc.deleted_at IS NULL` +
      (ids.length > 0 ? ` AND loc.id IN (${ids.map(() => '?').join(',')})` : '') +
      ' ORDER BY loc.id ASC LIMIT 200';
    const { results } = await c.env.DB.prepare(sql)
      .bind(ctx.store.id, ...ids)
      .all<{ id: number; code: string; name: string; warehouse_name: string }>();
    for (const r of results) {
      items.push({ qr: r.code, title: r.name, sub: `${r.code} / ${r.warehouse_name}` });
    }
  }

  const cards = items
    .map(
      (it) =>
        `<div class="label"><div class="qr">${qrSvg(it.qr)}</div>` +
        `<div class="label-name">${escHtml(it.title)}</div>` +
        `<div class="label-sub">${escHtml(it.sub)}</div></div>`,
    )
    .join('\n');
  const heading = type === 'products' ? '商品ラベル' : '保管場所ラベル';
  return c.html(`<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading} | 在庫管理システム</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1rem; background: #fff; color: #000; }
  .toolbar { margin-bottom: 1rem; }
  .toolbar button { font: inherit; padding: 0.5rem 1rem; border: 1px solid #888; border-radius: 6px; background: #fff; cursor: pointer; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
  .label { border: 1px solid #999; border-radius: 6px; padding: 10px; text-align: center; break-inside: avoid; page-break-inside: avoid; }
  .qr svg { width: 96px; height: 96px; }
  .label-name { font-weight: 700; font-size: 0.95rem; margin-top: 6px; overflow-wrap: break-word; }
  .label-sub { font-size: 0.8rem; color: #333; overflow-wrap: break-word; }
  .empty { color: #555; }
  @media print {
    body { margin: 0; }
    .toolbar { display: none; }
    .grid { gap: 6px; }
  }
  @page { margin: 10mm; }
</style></head>
<body>
<div class="toolbar"><button type="button" onclick="window.print()">印刷する</button>
<span>${heading} (${items.length} 件)</span></div>
${items.length > 0 ? `<div class="grid">\n${cards}\n</div>` : '<p class="empty">対象がありません。</p>'}
</body>
</html>`);
});

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
<p><a id="fallback" href="/auth/login" style="display:inline-block; padding: 0.5rem 1rem; border: 1px solid #888; border-radius: 6px; text-decoration: none;">Google でログイン (ボタンが出ない場合はこちら)</a></p>
<p id="who"></p>
<button id="apitest" style="padding: 0.5rem 1rem;">API をテストする (在庫一覧)</button>
<button id="logout" style="padding: 0.5rem 1rem;">ログアウト</button>
<pre id="out" style="white-space: pre-wrap; background: #f4f4f4; padding: 1rem;"></pre>
<script>
function decodeJwt(t) {
  const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(p))));
}
function getToken() {
  return localStorage.getItem('idToken') || sessionStorage.getItem('idToken') || '';
}
function refresh() {
  const t = getToken();
  if (t) {
    try { const d = decodeJwt(t); document.getElementById('who').textContent = 'ログイン中: ' + (d.email || d.sub); } catch (e) {}
  } else { document.getElementById('who').textContent = '未ログインです。'; }
}
async function runApiTest() {
  const t = getToken();
  if (!t) {
    document.getElementById('out').textContent = '先に Google でログインしてください。';
    return;
  }
  const r = await fetch('/api/v1/stocks', { headers: { Authorization: 'Bearer ' + t } });
  document.getElementById('out').textContent = 'HTTP ' + r.status + '\n' + (await r.text());
}
window.onload = function () {
  let tries = 0;
  const timer = setInterval(function () {
    tries++;
    if (window.google && google.accounts && google.accounts.id) {
      clearInterval(timer);
      google.accounts.id.initialize({
        client_id: '${clientId}',
        callback: function (res) {
          localStorage.setItem('idToken', res.credential);
          sessionStorage.setItem('idToken', res.credential);
          document.getElementById('out').textContent = 'ログインしました。自動で API をテストします。';
          refresh();
          runApiTest();
        },
      });
      google.accounts.id.renderButton(document.getElementById('gbtn'), { theme: 'outline', size: 'large' });
    } else if (tries > 50) {
      clearInterval(timer);
      document.getElementById('out').textContent = 'Google のボタンを読み込めませんでした。下の「Google でログイン」リンクを使ってください。';
    }
  }, 200);
  refresh();
  if (getToken()) runApiTest();
};
document.getElementById('apitest').onclick = runApiTest;
document.getElementById('logout').onclick = function () {
  localStorage.removeItem('idToken');
  sessionStorage.removeItem('idToken');
  if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
  document.getElementById('out').textContent = 'ログアウトしました。';
  refresh();
};
</script>
</body>
</html>`);
});

// ------------------------------------------------------------ 権限管理画面
// /app と同じ Cookie セッションで管理 API を呼ぶ (Bearer トークンが localStorage に
// あれば併用する)。スタイルも /app と共通 (APP_CSS)。
app.get('/admin/permissions', (c) =>
  c.html(`<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>権限管理 | 在庫管理システム</title>${PWA_HEAD}
<style>${APP_CSS}
.role-picker { display: flex; gap: 2px; padding: 2px; background: var(--control); border-radius: var(--r-sm); overflow-x: auto; margin-bottom: 1rem; -webkit-overflow-scrolling: touch; }
.role-picker button { flex: 1 0 auto; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 0.88rem; font-weight: 600; padding: 0.5rem 0.55rem; border-radius: 8px; cursor: pointer; white-space: nowrap; }
.role-picker button.sel { background: var(--surface); color: var(--fg); box-shadow: var(--shadow); }
.perm-row { padding: 0.65rem 1rem 0.75rem; border-bottom: 1px solid var(--line); }
.perm-row:last-child { border-bottom: 0; }
.perm-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 0.3rem; }
.perm-name { font-weight: 600; }
.perm-name small { color: var(--muted); font-weight: 400; font-size: 0.78rem; margin-left: 0.45rem; }
.perm-state { font-size: 0.82rem; color: var(--muted); white-space: nowrap; }
.perm-state.on { color: var(--accent); font-weight: 600; }
.perm-desc { margin: 0 0 0.5rem; font-size: 0.82rem; color: var(--muted); }
.perm-seg { display: flex; gap: 2px; padding: 2px; background: var(--control); border-radius: var(--r-sm); }
.perm-seg button { flex: 1 1 0; min-width: 0; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 0.9rem; font-weight: 600; padding: 0.45rem 0.2rem; border-radius: 8px; cursor: pointer; white-space: nowrap; }
.perm-seg button.sel { background: var(--surface); color: var(--fg); box-shadow: var(--shadow); }
.perm-seg button.sel.on { background: var(--accent); color: #fff; }
#matrix.saving .perm-seg button { pointer-events: none; opacity: 0.55; }
</style></head>
<body>
<header class="app-header">
  <img class="app-icon" src="/icons/icon-192.png" alt="">
  <h1>権限管理</h1>
  <span class="spacer"></span>
  <span id="who" class="ws-label"></span>
  <a href="/app">アプリへ戻る</a>
</header>
<main>
<p id="status" style="color: var(--ok);"></p>
<p id="error" style="color: var(--danger); white-space: pre-wrap;"></p>
<div id="loginGuide" class="section-box" style="display:none;">
  <p>ログインが必要です（セッションの有効期限は8時間です）。</p>
  <p><a class="btn" href="/auth/login">Google でログインする</a></p>
</div>

<h2>ロールごとの権限</h2>
<p class="small muted">ロールを選んで権限を切り替えます。切り替えると即時に保存されます。</p>
<div id="rolePicker" class="role-picker"></div>
<div id="matrix"><div class="skl skl-row"></div><div class="skl skl-row"></div><div class="skl skl-row"></div></div>

<h2>機能のオン/オフ</h2>
<p class="small muted">オフにした機能は、権限があっても API が 403 (FEATURE_DISABLED) を返し、アプリの画面からも消えます。変更は即時反映され、監査ログに記録されます。</p>
<div id="features"><div class="skl skl-row"></div><div class="skl skl-row"></div></div>

<h2>ユーザーとロール付与</h2>
<div id="users"><div class="skl skl-row"></div><div class="skl skl-row"></div></div>
</main>

<script>
function getToken() {
  try { return localStorage.getItem('idToken') || sessionStorage.getItem('idToken') || ''; } catch (e) { return ''; }
}
function setStatus(msg) { document.getElementById('status').textContent = msg; }
function setError(msg) { document.getElementById('error').textContent = msg; }
async function api(path, opts) {
  const headers = { 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) };
  const t = getToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  const res = await fetch(path, { credentials: 'same-origin', ...(opts || {}), headers });
  const text = await res.text();
  if (res.status === 401) {
    document.getElementById('loginGuide').style.display = '';
    throw new Error('未ログインです。下のボタンからログインしてください。');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text);
  return text ? JSON.parse(text) : null;
}

let catalog = [];
let roleList = [];
let matrix = {};
let userList = [];

let currentRole = '';
let savingPerms = false;

function renderRolePicker() {
  const el = document.getElementById('rolePicker');
  el.innerHTML = '';
  for (const r of roleList) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.name || r.code;
    if (r.code === currentRole) b.className = 'sel';
    b.onclick = () => {
      if (savingPerms || currentRole === r.code) return;
      currentRole = r.code;
      renderRolePicker();
      renderMatrix();
    };
    el.appendChild(b);
  }
}

function paintPermRow(row, on) {
  const state = row.querySelector('.perm-state');
  state.textContent = on ? '許可' : 'なし';
  state.className = 'perm-state' + (on ? ' on' : '');
  row.querySelectorAll('.perm-seg button').forEach((b) => {
    const sel = (b.dataset.val === 'on') === on;
    b.className = sel ? ('sel' + (on ? ' on' : '')) : '';
  });
}

function renderMatrix() {
  const el = document.getElementById('matrix');
  if (roleList.length === 0) { el.textContent = 'ロールがありません。'; return; }
  if (!currentRole || !roleList.some((r) => r.code === currentRole)) {
    // 既定は最も編集機会の多い在庫管理者 (無ければ先頭のロール)
    const def = roleList.find((r) => r.code === 'INVENTORY_MANAGER') || roleList[0];
    currentRole = def.code;
  }
  renderRolePicker();
  const granted = matrix[currentRole] || [];
  let html = '<div class="group">';
  for (const p of catalog) {
    const on = granted.includes(p.key);
    html += '<div class="perm-row" data-perm="' + p.key + '">' +
      '<div class="perm-head"><span class="perm-name">' + (p.label || p.key) + '<small>' + p.key + '</small></span>' +
      '<span class="perm-state' + (on ? ' on' : '') + '">' + (on ? '許可' : 'なし') + '</span></div>' +
      (p.description ? '<p class="perm-desc">' + p.description + '</p>' : '') +
      '<div class="perm-seg">' +
      '<button type="button" data-val="off" class="' + (!on ? 'sel' : '') + '">なし</button>' +
      '<button type="button" data-val="on" class="' + (on ? 'sel on' : '') + '">許可</button>' +
      '</div></div>';
  }
  html += '</div>';
  el.innerHTML = html;
  el.querySelectorAll('.perm-row').forEach((row) => {
    row.querySelectorAll('.perm-seg button').forEach((btn) => {
      btn.onclick = () => togglePerm(row.dataset.perm, btn.dataset.val === 'on', row);
    });
  });
}

async function togglePerm(key, on, row) {
  if (savingPerms) return;
  const role = currentRole;
  const prev = (matrix[role] || []).slice();
  if (prev.includes(key) === on) return;
  const next = on ? prev.concat([key]) : prev.filter((k) => k !== key);
  matrix[role] = next;
  paintPermRow(row, on);
  savingPerms = true;
  document.getElementById('matrix').classList.add('saving');
  setError(''); setStatus('保存中…');
  try {
    await api('/api/v1/admin/role-permissions/' + encodeURIComponent(role), {
      method: 'PUT',
      body: JSON.stringify({ permissions: next }),
    });
    setStatus('保存しました。');
  } catch (e) {
    matrix[role] = prev;
    paintPermRow(row, prev.includes(key));
    setStatus('');
    setError(String(e && e.message ? e.message : e));
  } finally {
    savingPerms = false;
    document.getElementById('matrix').classList.remove('saving');
  }
}

let featureList = [];

function renderFeatures() {
  const el = document.getElementById('features');
  if (featureList.length === 0) { el.textContent = '機能がありません。'; return; }
  let html = '<div class="group">';
  for (const f of featureList) {
    html += '<div class="group-row"><span class="row-label">' + f.label + ' <small class="muted">' + f.key + '</small></span>' +
      '<label class="switch"><input type="checkbox" data-feature="' + f.key + '"' + (f.enabled ? ' checked' : '') + '><span class="track"></span></label></div>';
  }
  html += '</div>';
  el.innerHTML = html;
  el.querySelectorAll('input[type=checkbox][data-feature]').forEach((box) => {
    box.onchange = () => toggleFeature(box.dataset.feature, box.checked, box);
  });
}

async function toggleFeature(key, enabled, box) {
  setError(''); setStatus('保存中…');
  box.disabled = true;
  try {
    await api('/api/v1/admin/features/' + encodeURIComponent(key), {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    const f = featureList.find((x) => x.key === key);
    if (f) f.enabled = enabled;
    setStatus('機能「' + key + '」を' + (enabled ? 'オン' : 'オフ') + 'にしました。');
  } catch (e) {
    box.checked = !enabled;
    setStatus('');
    setError(String(e && e.message ? e.message : e));
  } finally {
    box.disabled = false;
  }
}

function renderUsers() {
  const el = document.getElementById('users');
  if (userList.length === 0) { el.textContent = 'ユーザーがいません。'; return; }
  el.innerHTML = '';
  for (const u of userList) {
    const box = document.createElement('div');
    box.className = 'card';
    box.style.marginBottom = '0.75rem';
    const roleOptions = roleList.map((r) => '<option value="' + r.code + '">' + r.code + '</option>').join('');
    let rows = '';
    u.assignments.forEach((a, i) => {
      rows += '<li>' + a.roleCode + ' / 倉庫: ' + (a.warehouseId === null ? '全倉庫' : a.warehouseId) +
        ' <button data-act="remove" data-user="' + u.id + '" data-idx="' + i + '">削除</button></li>';
    });
    box.innerHTML =
      '<strong>#' + u.id + ' ' + u.email + '</strong> (' + u.displayName + ', ' + u.status + ')' +
      '<ul>' + rows + '</ul>' +
      '<select id="role-' + u.id + '">' + roleOptions + '</select> ' +
      '<input id="wh-' + u.id + '" type="number" min="1" placeholder="倉庫ID (空=全倉庫)" style="width: 12em;"> ' +
      '<button data-act="add" data-user="' + u.id + '">割当を追加</button> ' +
      '<button data-act="save" data-user="' + u.id + '">このユーザーを保存</button>';
    el.appendChild(box);
  }
  el.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.onclick = () => onUserAction(btn.dataset.act, Number(btn.dataset.user), btn.dataset.idx);
  });
}

async function onUserAction(act, userId, idx) {
  const u = userList.find((x) => x.id === userId);
  if (!u) return;
  setError(''); setStatus('');
  if (act === 'remove') {
    u.assignments.splice(Number(idx), 1);
    renderUsers();
    setStatus('割当を外しました (保存ボタンで確定します)。');
    return;
  }
  if (act === 'add') {
    const roleCode = document.getElementById('role-' + userId).value;
    const whRaw = document.getElementById('wh-' + userId).value;
    const warehouseId = whRaw === '' ? null : Number(whRaw);
    if (u.assignments.some((a) => a.roleCode === roleCode && a.warehouseId === warehouseId)) {
      setError('同じ割当が既にあります。');
      return;
    }
    u.assignments.push({ roleCode, warehouseId });
    renderUsers();
    setStatus('割当を追加しました (保存ボタンで確定します)。');
    return;
  }
  if (act === 'save') {
    try {
      await api('/api/v1/admin/users/' + userId + '/roles', {
        method: 'PUT',
        body: JSON.stringify({ assignments: u.assignments }),
      });
      setStatus('ユーザー #' + userId + ' の割当を保存しました。');
    } catch (e) {
      setError(String(e && e.message ? e.message : e));
    }
  }
}

async function loadAll() {
  try {
    const me = await api('/api/v1/me');
    document.getElementById('who').textContent = (me.user && me.user.email ? me.user.email : '') + ' でログイン中';
  } catch (e) {
    document.getElementById('who').textContent = '未ログイン';
    document.getElementById('matrix').textContent = '';
    document.getElementById('users').textContent = '';
    setError(String(e && e.message ? e.message : e));
    return;
  }
  try {
    const data = await api('/api/v1/admin/permissions');
    catalog = data.permissions;
    roleList = data.roles;
    matrix = data.matrix;
    renderMatrix();
  } catch (e) {
    document.getElementById('matrix').textContent = '';
    setError(String(e && e.message ? e.message : e));
    return;
  }
  try {
    const fdata = await api('/api/v1/admin/features');
    featureList = fdata.features;
    renderFeatures();
  } catch (e) {
    document.getElementById('features').textContent = '機能一覧を読み込めませんでした。';
  }
  try {
    userList = await api('/api/v1/admin/users');
    renderUsers();
  } catch (e) {
    document.getElementById('users').textContent = '';
    setError(String(e && e.message ? e.message : e));
  }
}

loadAll();
</script>
</body>
</html>`),
);


// ログイン開始 (サーバー側リダイレクト、認可コードフロー)。
// ブラウザ側の JS に依存せず、通常のリンク遷移だけで進める。nonce/state は Cookie で保持する。
// 新規ログイン停止中 (features の 'login') は開始自体を 503 で止める
// (ログイン中のセッションは影響を受けない)。
app.get('/auth/login', async (c) => {
  const loginBlock = await loginMaintenanceBlock(c);
  if (loginBlock) return c.html(loginMaintenancePage(loginBlock.message, loginBlock.endsAt), 503);
  const clientId = c.env.OIDC_CLIENT_ID ?? '';
  if (!clientId) return c.text('OIDC is not configured', 503);
  // ステップアップ再認証 (?stepup=1): 既存セッションの step_up_at を打ち直す
  // ための再ログイン。Google 側にも再認証を強制する (prompt=login)。
  const stepup = new URL(c.req.url).searchParams.get('stepup') === '1';
  const nonce = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: new URL('/auth/callback', c.req.url).toString(),
    response_type: 'code',
    scope: 'openid email profile',
    nonce,
    state: nonce,
    prompt: stepup ? 'login' : 'select_account',
  });
  const headers = new Headers({
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  });
  headers.append('Set-Cookie', `oauth_nonce=${nonce}; Path=/; Max-Age=600; SameSite=Lax`);
  if (stepup) {
    // nonce と紐付けて、コールバックで「この往復がステップアップ用か」を判定する
    headers.append('Set-Cookie', `oauth_stepup=${nonce}; Path=/; Max-Age=600; SameSite=Lax`);
  }
  return new Response(null, { status: 302, headers });
});

// OAuth リダイレクト受け口 (サーバー側で完結)。
// 認可コードを Google と交換して ID トークンを得て、検証し、users を同期して
// 結果をそのまま表示する。画面側のボタン操作は不要。
app.get('/auth/callback', async (c) => {
  const page = (title: string, body: string, status: 200 | 400 | 500 | 503 = 200) =>
    c.html(
      `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | 在庫管理システム</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.7;">
<h1>${title}</h1>
${body}
<p><a href="/login">ログイン画面へ</a></p>
</body>
</html>`,
      status,
    );

  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const oauthError = url.searchParams.get('error');
  if (oauthError) return page('ログインに失敗しました', `<p>Google からエラーが返されました: ${oauthError}</p>`, 400);
  if (!code) return page('ログインに失敗しました', '<p>認可コードが返されませんでした。</p>', 400);

  const clientId = c.env.OIDC_CLIENT_ID ?? '';
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    return page('サーバー設定が不足しています', '<p>GOOGLE_CLIENT_SECRET が未設定です。</p>', 500);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: new URL('/auth/callback', c.req.url).toString(),
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) {
    return page('ログインに失敗しました', `<p>トークン交換に失敗しました (HTTP ${tokenRes.status})。</p>`, 400);
  }
  const tokenJson = (await tokenRes.json()) as { id_token?: string };
  if (!tokenJson.id_token) {
    return page('ログインに失敗しました', '<p>ID トークンが返されませんでした。</p>', 400);
  }

  let authUser: AuthUser;
  let cookieNonce = '';
  try {
    const payload = await verifyToken(c.env, tokenJson.id_token);
    cookieNonce = (c.req.header('cookie') ?? '').match(/(?:^|;\s*)oauth_nonce=([^;]*)/)?.[1] ?? '';
    if (cookieNonce && payload.nonce !== cookieNonce) {
      return page('ログインに失敗しました', '<p>nonce が一致しません。もう一度ログインしてください。</p>', 400);
    }
    authUser = await syncUserFromPayload(c.env, payload);
  } catch {
    return page('ログインに失敗しました', '<p>ID トークンの検証に失敗しました。</p>', 400);
  }

  // ログイン履歴と新しい端末の通知 (0017)。失敗してもログインは止めない。
  await recordLoginEvent(c.env.DB, c.env, {
    userId: authUser.userId,
    method: 'google',
    ip: clientIp(c.req.raw),
    userAgent: c.req.header('user-agent') ?? null,
  });

  // ステップアップ再認証の往復: 既存セッションが同じユーザーなら新規発行せず、
  // そのセッションの step_up_at を打ち直して /app へ戻す。
  const stepupNonce = (c.req.header('cookie') ?? '').match(/(?:^|;\s*)oauth_stepup=([^;]*)/)?.[1] ?? '';
  if (stepupNonce && cookieNonce && stepupNonce === cookieNonce) {
    try {
      const sessionUser = await resolveSessionUser(c.env.DB, c.req.raw);
      if (sessionUser && sessionUser.userId === authUser.userId) {
        await markSessionStepUp(c.env.DB, c.req.raw);
        const headers = new Headers({ Location: '/app' });
        headers.append('Set-Cookie', 'oauth_stepup=; Path=/; Max-Age=0; SameSite=Lax');
        return new Response(null, { status: 302, headers });
      }
    } catch {
      // セッションが引けない場合は通常のログインとして続行する
    }
  }

  // 新規ログイン停止中はセッションを発行しない (全体管理者は対象外)。
  // /auth/login を経ずに直接来た場合もここで止める。
  if (!isPlatformAdmin(authUser.assignments)) {
    const loginBlock = await loginMaintenanceBlock(c);
    if (loginBlock) {
      const safeMessage = loginBlock.message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const endText = loginBlock.endsAt
        ? `<p>終了予定: ${new Date(loginBlock.endsAt).toLocaleString('ja-JP')}</p>`
        : '<p>終了時刻は未定です。</p>';
      return page('メンテナンス中', `<p>${safeMessage}</p>${endText}`, 503);
    }
  }

  const roles =
    authUser.assignments.length > 0
      ? authUser.assignments.map((a) => a.roleCode).join(', ')
      : '未付与';
  const note =
    authUser.assignments.length > 0
      ? '<p>このまま業務 API を利用できます。</p>'
      : '<p>アカウントは作成されましたが、権限はまだ付いていません。アプリを開くと、そのまま自分の組織・店舗を作成して使い始めるか、管理者にロール付与を依頼できます。</p>';
  // ブラウザ向けにログインセッションを発行する (Cookie は HttpOnly)。
  // 以後の API / WebSocket はこのセッションで認証できる。
  // 発行時の UA / IP はセッション管理画面での端末表示用に記録する (0017)。
  const sessionToken = await createSession(c.env.DB, authUser.userId, {
    userAgent: c.req.header('user-agent') ?? null,
    ip: clientIp(c.req.raw),
  });
  const res = page(
    'ログインしました',
    `<p>メールアドレス: ${authUser.email}</p><p>ユーザー ID: ${authUser.userId}</p><p>現在のロール: ${roles}</p>${note}<p><a href="/app">アプリを開く</a></p>`,
  );
  res.headers.append('Set-Cookie', sessionCookieHeader(sessionToken));
  return res;
});

// ---------------------------------------------------------------- 認証
/**
 * features レベルのメンテナンスで停止する機能キーとエンドポイントの対応表。
 * lib/maintenance.ts の MAINTENANCE_FEATURES とキーを一致させる。
 * 全メソッドを対象にキーを返し、「どのメソッドを止めるか」は段階
 * ('write' = 非 GET のみ / 'full' = 全メソッド) で判定する。
 */
function maintenanceFeatureFor(method: string, path: string): string | null {
  const p = path.startsWith('/api/v1') ? path.slice('/api/v1'.length) : path;
  if (p === '/analytics') return 'analytics';
  if (p === '/alerts') return 'alerts';
  if (p === '/stocks.csv' || p === '/admin/export.json') return 'csv_export';
  if (p === '/products/import' || p === '/master/products/import') return 'csv_import';
  if (p === '/movements/inbound') return 'inbound';
  if (p === '/movements/return') return 'inbound';
  if (p === '/movements/consumption') return 'outbound';
  if (p === '/movements/disposal') return 'outbound';
  if (p === '/movements/bundle-consumption') return 'outbound';
  if (p === '/movements/transfer') return 'transfers';
  if (p === '/reservations' || p.startsWith('/reservations/')) return 'outbound';
  if (p === '/pick-lists' || p.startsWith('/pick-lists/')) return 'outbound';
  if (p === '/purchase-order-templates' || p.startsWith('/purchase-order-templates/')) return 'purchase_orders';
  if (p === '/admin/products/bulk') return 'master_products';
  if (p === '/settings') return 'master_products';
  if (
    p === '/master/reason-codes' ||
    p.startsWith('/master/reason-codes/') ||
    p === '/master/departments' ||
    p.startsWith('/master/departments/') ||
    p === '/master/categories' ||
    p.startsWith('/master/categories/')
  ) {
    return 'master_products';
  }
  if (p === '/negative-approvals' || p.startsWith('/negative-approvals/')) return 'outbound';
  if (p === '/stocktakes' || p.startsWith('/stocktakes/')) return 'stocktakes';
  if (p === '/purchase-orders' || p.startsWith('/purchase-orders/')) return 'purchase_orders';
  if (
    p === '/suppliers' ||
    p.startsWith('/suppliers/') ||
    p === '/master/suppliers' ||
    p.startsWith('/master/suppliers/')
  ) {
    return 'suppliers';
  }
  if (
    p === '/products' ||
    p.startsWith('/products/') ||
    p === '/master/products' ||
    p.startsWith('/master/products/')
  ) {
    return 'master_products';
  }
  if (
    p === '/warehouses' ||
    p.startsWith('/warehouses/') ||
    p === '/locations' ||
    p.startsWith('/locations/') ||
    p === '/lots' ||
    p.startsWith('/lots/') ||
    p === '/master/warehouses' ||
    p.startsWith('/master/warehouses/') ||
    p === '/master/locations' ||
    p.startsWith('/master/locations/') ||
    p === '/master/lots' ||
    p.startsWith('/master/lots/')
  ) {
    return 'master_locations';
  }
  return null;
}

/**
 * 新規ログイン停止 (features の 'login') の判定。全店舗対象 (store_id NULL)
 * の枠だけが効く。該当すれば告知文と終了予定を返す。
 */
async function loginMaintenanceBlock(
  c: AppContext,
): Promise<{ message: string; endsAt: number | null } | null> {
  const resolution = await resolveMaintenance(c.env.DB, null);
  const active = resolution.active;
  if (active && active.level === 'features' && active.features['login']) {
    return { message: resolvedMaintenanceMessage(active), endsAt: active.endsAt };
  }
  return null;
}

/** ログイン停止中の案内ページ (503) */
function loginMaintenancePage(message: string, endsAt: number | null): string {
  const safeMessage = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const endText = endsAt
    ? `<p>終了予定: ${new Date(endsAt).toLocaleString('ja-JP')}</p>`
    : '<p>終了時刻は未定です。</p>';
  return `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>メンテナンス中 | 在庫管理システム</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.7;">
<h1>メンテナンス中</h1>
<p>${safeMessage}</p>
${endText}
<p>ログイン中のセッションはそのまま利用できます。</p>
</body>
</html>`;
}

app.use('/api/v1/*', async (c, next) => {
  if (c.req.path === '/api/v1/health') return next();
  // パスキーのログイン開始・検証は未認証で受ける (認証そのものが目的)。
  // 新規ログイン停止 (features の 'login') はハンドラ側で判定する。
  if (
    c.req.path === '/api/v1/auth/passkey/login/options' ||
    c.req.path === '/api/v1/auth/passkey/login/verify'
  ) {
    return next();
  }
  const authUser = await authenticate(c.req.raw, c.env);
  c.set('user', authUser);
  // メンテナンス (全体管理の maintenance_windows + 従来の即時設定を合算)。
  // 認証後・現在店舗の確定後に判定する。全体管理者 (store_id NULL の
  // SYSTEM_ADMIN 割当) は強制の対象外 (状態は /me で見える)。
  // ログアウトだけはどのレベルでも常時通す。
  const isLogout = c.req.method === 'POST' && c.req.path === '/api/v1/auth/logout';
  if (!isLogout) {
    const ctx = await softStoreContext(c);
    const resolution = await resolveMaintenance(c.env.DB, ctx ? ctx.store.id : null);
    c.set('maintenance', resolution);
    const active = resolution.active;
    if (active && !isPlatformAdmin(authUser.assignments)) {
      const isMeGet = c.req.method === 'GET' && c.req.path === '/api/v1/me';
      const featureKey = maintenanceFeatureFor(c.req.method, c.req.path);
      let blocked = false;
      if (active.level === 'full') {
        blocked = !isMeGet;
      } else if (active.level === 'read_only') {
        blocked = c.req.method !== 'GET';
      } else if (featureKey) {
        const stage = active.features[featureKey];
        // 'full' は全メソッド、'write' は書き込み系 (非 GET) のみ止める
        if (stage === 'full') blocked = true;
        else if (stage === 'write') blocked = c.req.method !== 'GET';
      }
      if (blocked) {
        // 拒否件数を「寄与した window × 機能グループ × 店舗」で集計する
        // (全体管理者は上の分岐で対象外なので数えない)。
        const contributors =
          active.level === 'features'
            ? active.windows.filter((w) => {
                if (!featureKey) return false;
                const stage = w.features[featureKey];
                if (stage === 'full') return true;
                return stage === 'write' && c.req.method !== 'GET';
              })
            : active.windows.filter((w) => w.level === active.level);
        await recordMaintenanceRejections(
          c.env.DB,
          contributors.map((w) => ({
            windowId: w.id,
            featureKey: featureKey ?? active.level,
            storeId: ctx ? ctx.store.id : 0,
          })),
        );
        return c.json(
          {
            statusCode: 503,
            error: 'MAINTENANCE',
            message: resolvedMaintenanceMessage(active),
            level: active.level,
            endsAt: active.endsAt,
            features: active.features,
          },
          503,
        );
      }
    }
  }
  return next();
});

function user(c: AppContext): AuthUser {
  return c.get('user');
}

/**
 * 実効権限マトリクスを D1 の role_permissions から解決する (リクエストごと)。
 * テーブル未適用・未投入の環境では既定マトリクスにフォールバックする。
 */
async function loadRolePermissions(c: AppContext): Promise<RolePermissionMap> {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT role_code, permission_key FROM role_permissions',
    ).all<{ role_code: string; permission_key: string }>();
    return resolveRolePermissions(results);
  } catch {
    return resolveRolePermissions([]);
  }
}

/**
 * 現在店舗のコンテキストを解決する (リクエスト内でメモ化)。
 * 割当なしは 403、店舗未選択は 409 STORE_NOT_SELECTED、停止中店舗への
 * 店舗ユーザーのアクセスは 403 STORE_SUSPENDED (lib/stores.ts)。
 */
async function storeContext(c: AppContext): Promise<StoreContext> {
  const cached = c.get('storeCtx');
  if (cached) return cached;
  const ctx = await resolveStoreContext(c.env.DB, user(c), user(c).sessionStoreId ?? null);
  c.set('storeCtx', ctx);
  return ctx;
}

/** 表示用 (/me など) の緩い解決。店舗が決まらなければ null */
async function softStoreContext(c: AppContext): Promise<StoreContext | null> {
  const box = c.get('softCtxBox');
  if (box) return box.ctx;
  const ctx = await softResolveStoreContext(c.env.DB, user(c), user(c).sessionStoreId ?? null);
  c.set('softCtxBox', { ctx });
  return ctx;
}

/**
 * 現在店舗での権限が無ければ 403。解決済みマトリクスを返すのでスコープ判定にも
 * 再利用できる。権限は「現在店舗の割当」で解決し、全体管理者は現在店舗でも
 * 全権限として扱う。
 */
async function requirePermission(
  c: AppContext,
  permission: PermissionKey,
  preloaded?: RolePermissionMap,
): Promise<RolePermissionMap> {
  const ctx = await storeContext(c);
  const rp = preloaded ?? (await loadRolePermissions(c));
  if (ctx.isPlatformAdmin) return rp;
  if (!hasPermission(ctx.assignments, rp, permission)) {
    throw forbidden('Insufficient permission');
  }
  return rp;
}

/**
 * 店舗に依らない全体管理系の権限チェック。ロール×権限マトリクス自体は
 * 店舗横断の概念のため、こちらは全割当で判定する (全体管理者は常に可)。
 */
async function requireGlobalPermission(
  c: AppContext,
  permission: PermissionKey,
): Promise<RolePermissionMap> {
  assertHasAssignments(user(c));
  const rp = await loadRolePermissions(c);
  if (isPlatformAdmin(user(c).assignments)) return rp;
  if (!hasPermission(user(c).assignments, rp, permission)) {
    throw forbidden('Insufficient permission');
  }
  return rp;
}

/** 現在店舗での「権限 AND 倉庫スコープ」判定。全体管理者は常に可 */
function canPerformInStore(
  ctx: StoreContext,
  rp: RolePermissionMap,
  warehouseId: number,
  permission: PermissionKey,
): boolean {
  if (ctx.isPlatformAdmin) return true;
  return canPerformPermission(ctx.assignments, rp, warehouseId, permission);
}

/**
 * 機能フラグのサーバー側強制。管理者がオフにした機能は、権限があっても
 * 403 FEATURE_DISABLED で止める (画面の出し分けだけに頼らない)。
 * プラン制 (0018) との合流: 実効値は「店舗フラグ ON かつ プラン許可」。
 * フラグがオンでもプランが許可しなければ PLAN_FEATURE_NOT_AVAILABLE。
 * 組織に所属しない店舗 (レガシー) と全体管理者の自店舗 (DGOSK = owner)
 * はプラン側では制限されない。
 */
async function requireFeature(c: AppContext, key: string): Promise<void> {
  const ctx = await storeContext(c);
  if (!(await isFeatureEnabled(c.env.DB, key, ctx.store.id))) {
    throw new ApiError(403, 'FEATURE_DISABLED', `Feature is disabled: ${key}`);
  }
  const plan = await resolveStorePlan(c.env.DB, ctx.store.id);
  if (!planAllowsFeature(plan.def, key)) {
    throw planFeatureError(plan.def.key, key);
  }
}

/**
 * プランのモジュール (引当・ピッキング・セット品・返品廃棄・発注テンプレート・
 * 一括編集) のサーバー側強制。プランに無いモジュールは
 * 403 PLAN_FEATURE_NOT_AVAILABLE。
 */
async function requireModule(c: AppContext, moduleKey: ModuleKey): Promise<void> {
  const ctx = await storeContext(c);
  const plan = await resolveStorePlan(c.env.DB, ctx.store.id);
  if (!planAllowsModule(plan.def, moduleKey)) {
    throw planFeatureError(plan.def.key, moduleKey);
  }
}

/** 店舗フラグにプラン許可を重ねた実効フラグ (/me・/features の表示用) */
async function effectiveFeatures(c: AppContext, storeId: number): Promise<FeatureMap> {
  const features = await getFeatures(c.env.DB, storeId);
  const plan = await resolveStorePlan(c.env.DB, storeId);
  for (const key of Object.keys(features)) {
    if (features[key] && !planAllowsFeature(plan.def, key)) features[key] = false;
  }
  return features;
}

/** /me に載せるプラン要約。組織なし店舗は owner 相当 (organization は null) */
async function planSummaryForStore(c: AppContext, storeId: number): Promise<Record<string, unknown>> {
  const plan = await resolveStorePlan(c.env.DB, storeId);
  const usage = plan.organization
    ? await organizationUsage(c.env.DB, plan.organization.id)
    : await singleStoreUsage(c.env.DB, storeId);
  return {
    key: plan.def.key,
    name: plan.def.name,
    price: plan.def.price,
    organization: plan.organization ? { id: plan.organization.id, name: plan.organization.name } : null,
    limits: plan.def.limits,
    usage,
  };
}

/**
 * SKU 上限チェック (プラン)。組織に所属しない店舗は制限なし。
 * adding は今回増える商品数 (CSV インポートは投入見込み数)。
 */
async function assertSkuLimit(c: AppContext, storeId: number, adding: number): Promise<void> {
  if (adding <= 0) return;
  const plan = await resolveStorePlan(c.env.DB, storeId);
  if (!plan.organization || plan.def.limits.skus === null) return;
  const usage = await organizationUsage(c.env.DB, plan.organization.id);
  if (exceedsLimit(plan.def.limits.skus, usage.skus, adding)) {
    throw planLimitError(plan.def.key, 'skus', plan.def.limits.skus, usage.skus);
  }
}

/**
 * 重要操作の再認証 (ステップアップ、0017)。Cookie セッション経由の場合、
 * セッションの step_up_at が 10 分以内でなければ 403 STEP_UP_REQUIRED。
 * ログイン自体が step_up_at を打つため、ログイン直後はそのまま通る。
 * Bearer (IdP の短期トークン) は直近に IdP で認証済みとして扱い対象外。
 * step_up_at 列が無い環境 (0017 未適用) では強制しない。
 */
async function requireStepUp(c: AppContext): Promise<void> {
  const me = user(c);
  if (!me.viaSession) return;
  if (!(await hasColumn(c, 'sessions', 'step_up_at'))) return;
  const session = await currentSessionRow(c.env.DB, c.req.raw);
  if (!session) return;
  if (session.stepUpAt !== null && Date.now() - session.stepUpAt <= STEP_UP_WINDOW_MS) return;
  throw new ApiError(403, 'STEP_UP_REQUIRED', 'Step-up authentication is required');
}

/** テーブルに列が存在するか (マイグレーション未適用環境との後方互換用) */
async function hasColumn(c: AppContext, table: string, column: string): Promise<boolean> {
  try {
    const { results } = await c.env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    return results.some((r) => r.name === column);
  } catch {
    return false;
  }
}

/** テーブル自体が存在するか (0014 の movement_photos など) */
async function hasTable(c: AppContext, table: string): Promise<boolean> {
  try {
    const row = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
    )
      .bind(table)
      .first<{ name: string }>();
    return row !== null;
  } catch {
    return false;
  }
}

// ------------------------------------------------- 全体管理者の不可視化
// 全体管理者 (全体割当 = SYSTEM_ADMIN かつ store_id IS NULL を持つユーザー) は
// 店舗側の管理対象ではなく、その名前・メールアドレス・ID はもちろん、
// 「存在」自体も店舗ユーザーに見せない。対象は「全体割当を持ち、現在店舗の
// 割当を持たない」ユーザー。現在店舗の割当も持つ人は、その店舗のメンバー
// として通常表示する。閲覧者自身が全体管理者の場合は何も隠さない
// (本人の表示・操作は通常通り)。判定はすべてサーバー側で行う。
// 監査ログは対象者の行ごと返さず、件数からも除外する (ラベルでの匿名化は
// 存在を示してしまうため行わない)。業務レコード (在庫の移動履歴など) は
// 店舗のデータとして残すが、操作者 ID 欄は null にして誰の操作か分からない
// 形にする。

/** 現在店舗の文脈で素性を隠す全体管理者のユーザー ID 集合 */
async function hiddenPlatformUserIds(
  c: AppContext,
  storeId: number,
): Promise<ReadonlySet<number>> {
  if (isPlatformAdmin(user(c).assignments)) return new Set();
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT DISTINCT ur.user_id AS userId
         FROM user_roles ur
        WHERE ur.role_code = 'SYSTEM_ADMIN' AND ur.store_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM user_roles s
             WHERE s.user_id = ur.user_id AND s.store_id = ?1
          )`,
    )
      .bind(storeId)
      .all<{ userId: number }>();
    return new Set(results.map((r) => r.userId));
  } catch {
    return new Set();
  }
}

/** user ID フィールドの匿名化 (対象ユーザーなら null、それ以外はそのまま) */
function anonymizeUserId(id: number | null, hidden: ReadonlySet<number>): number | null {
  return id !== null && hidden.has(id) ? null : id;
}

/** レスポンス JSON の user ID フィールド群を匿名化する */
function anonymizeUserFields(
  obj: Record<string, unknown>,
  hidden: ReadonlySet<number>,
  fields: readonly string[],
): Record<string, unknown> {
  if (hidden.size === 0) return obj;
  const out = { ...obj };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'number' && hidden.has(v)) out[f] = null;
  }
  return out;
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
  bulkMovements: (input: BulkInput) => Promise<Envelope>;
  consumeBundle: (input: BundleConsumeInput) => Promise<Envelope>;
  confirmPick: (input: PickConfirmInput) => Promise<Envelope>;
  transfer: (input: TransferInput) => Promise<Envelope>;
  startStocktake: (input: StartStocktakeInput) => Promise<Envelope>;
  finishStocktake: (input: { actorId: number; stocktakeId: number; storeId: number }) => Promise<Envelope>;
  decideStocktake: (input: { actorId: number; stocktakeId: number; approve: boolean; storeId: number }) => Promise<Envelope>;
  fetch: (request: Request) => Promise<Response>;
}

function coordinator(c: AppContext): CoordinatorStub {
  const id = c.env.INVENTORY_COORDINATOR.idFromName('global');
  return c.env.INVENTORY_COORDINATOR.get(id) as unknown as CoordinatorStub;
}

function respond(c: AppContext, envelope: Envelope): Response {
  return c.json(envelope.body as Record<string, unknown>, envelope.status as 200);
}

// スコープ内 location の ID 一覧 (null = 現在店舗の全 location)。消費の候補絞り込みに使う
async function allowedLocationIds(c: AppContext): Promise<number[] | null> {
  const ctx = await storeContext(c);
  const reachable = reachableWarehouseIds(ctx.assignments);
  if (reachable === null) return null;
  if (reachable.length === 0) return [];
  const { results } = await c.env.DB.prepare(
    `SELECT loc.id FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
      WHERE w.store_id = ? AND loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`,
  )
    .bind(ctx.store.id, ...reachable)
    .all<{ id: number }>();
  return results.map((r) => r.id);
}

/** location の倉庫を返す。他店舗の location は存在しないものとして 404 にする */
async function warehouseIdOfLocation(c: AppContext, locationId: number): Promise<number> {
  const ctx = await storeContext(c);
  const row = await c.env.DB.prepare(
    `SELECT loc.warehouse_id AS warehouse_id
       FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
      WHERE loc.id = ?1 AND loc.deleted_at IS NULL AND w.store_id = ?2`,
  )
    .bind(locationId, ctx.store.id)
    .first<{ warehouse_id: number }>();
  if (!row) throw notFound('Location not found');
  return row.warehouse_id;
}

/** stock の倉庫を返す。他店舗の stock は存在しないものとして 404 にする */
async function warehouseIdOfStock(c: AppContext, stockId: number): Promise<number> {
  const ctx = await storeContext(c);
  const row = await c.env.DB.prepare(
    `SELECT loc.warehouse_id AS warehouse_id
       FROM stocks s JOIN locations loc ON loc.id = s.location_id
      WHERE s.id = ?1 AND s.store_id = ?2`,
  )
    .bind(stockId, ctx.store.id)
    .first<{ warehouse_id: number }>();
  if (!row) throw notFound('Stock not found');
  return row.warehouse_id;
}

// ------------------------------------------------- セッション / 自分自身 / 履歴

/**
 * 自分の情報と実効権限。/app の初期表示と権限出し分けに使う。
 * 権限・機能フラグは「現在店舗」で解決したものを返す。あわせて入れる店舗の
 * 一覧・現在店舗・全体管理者かどうかも返し、/app の店舗選択と出し分けに使う。
 */
app.get('/api/v1/me', async (c) => {
  const me = user(c);
  // 起動時の要所なので、互いに独立した読み取りは並列に走らせる
  const [rp, ctx] = await Promise.all([loadRolePermissions(c), softStoreContext(c)]);
  const platform = isPlatformAdmin(me.assignments);
  const [stores, features, plan, settings, maintenanceRes] = await Promise.all([
    // stores 未適用の環境では店舗なしとして扱う
    accessibleStores(c.env.DB, me).catch(() => [] as StoreInfo[]),
    ctx ? effectiveFeatures(c, ctx.store.id) : Promise.resolve(defaultFeatures()),
    ctx ? planSummaryForStore(c, ctx.store.id) : Promise.resolve(null),
    ctx ? getStoreSettings(c.env.DB, ctx.store.id) : Promise.resolve({ currency: 'JPY', timezone: 'Asia/Tokyo' }),
    (async () =>
      c.get('maintenance') ?? (await resolveMaintenance(c.env.DB, ctx ? ctx.store.id : null)))(),
  ]);
  return c.json({
    id: me.userId,
    email: me.email,
    displayName: me.displayName,
    assignments: me.assignments,
    permissions: platform
      ? PERMISSION_CATALOG.map((p) => p.key).sort()
      : ctx
        ? [...permissionsOf(ctx.assignments, rp)].sort()
        : [],
    features,
    plan,
    settings,
    stores,
    currentStore: ctx ? ctx.store : null,
    isPlatformAdmin: platform,
    maintenance: {
      active: maintenanceRes.active
        ? {
            level: maintenanceRes.active.level,
            features: maintenanceRes.active.features,
            endsAt: maintenanceRes.active.endsAt,
            message: resolvedMaintenanceMessage(maintenanceRes.active),
            windows: maintenanceRes.active.windows,
          }
        : null,
      upcoming: maintenanceRes.upcoming,
      lastEnded: maintenanceRes.lastEnded,
    },
  });
});

// ------------------------------------------------------------ 店舗の選択

/** 自分が入れる店舗の一覧と、現在選択中の店舗 */
app.get('/api/v1/stores', async (c) => {
  const me = user(c);
  const stores = await accessibleStores(c.env.DB, me);
  const ctx = await softStoreContext(c);
  return c.json({
    stores,
    currentStoreId: ctx ? ctx.store.id : null,
    isPlatformAdmin: isPlatformAdmin(me.assignments),
  });
});

const sessionStoreBodySchema = z.object({ storeId: z.number().int().positive() });

/**
 * 現在店舗をセッションに保存する。所属していない店舗は 403、
 * 停止中の店舗に入れるのは全体管理者だけ。Bearer 認証にはセッションが
 * 無いため保存できない (400)。
 */
app.post('/api/v1/session/store', async (c) => {
  const me = user(c);
  if (!me.viaSession) {
    throw new ApiError(400, 'SESSION_REQUIRED', 'Store selection requires a login session');
  }
  const dto = parseWith(sessionStoreBodySchema, await parseJson(c));
  const store = await getStore(c.env.DB, dto.storeId);
  if (!store) throw notFound('Store not found');
  const platform = isPlatformAdmin(me.assignments);
  if (!platform && !assignedStoreIds(me.assignments).includes(dto.storeId)) {
    throw forbidden('You do not belong to this store');
  }
  if (store.status === 'suspended' && !platform) {
    throw new ApiError(403, 'STORE_SUSPENDED', 'This store is suspended.');
  }
  await setSessionStore(c.env.DB, c.req.raw, dto.storeId);
  return c.json({ currentStore: store });
});

// ------------------------------------------------- セルフサインアップ

/** 業種テンプレートのカタログ (サインアップ画面の選択肢) */
app.get('/api/v1/signup/templates', async (c) => {
  user(c);
  return c.json({ templates: templateCatalogJson() });
});

/**
 * セルフサインアップ (導入の汎用化)。ログイン済みで割当がまだ無いユーザーが、
 * 自分の組織 (フリープラン) と最初の店舗を作って使い始める導線。
 * - 組織 + 店舗 + 既定倉庫 (WH-01) を作り、作成者を店舗の SYSTEM_ADMIN にする
 * - 業種テンプレートでカテゴリ・部門・理由コード・最初の保管場所を初期投入する
 * - セッションの現在店舗を新しい店舗に切り替える
 * 既に割当があるユーザー (全体管理者を含む) は 409、Bearer 認証はセッションが
 * 無いため 400 (現在店舗をセッションに保存できない)。
 */
app.post('/api/v1/signup', async (c) => {
  const me = user(c);
  if (!me.viaSession) {
    throw new ApiError(400, 'SESSION_REQUIRED', 'Signup requires a login session');
  }
  if (isPlatformAdmin(me.assignments)) {
    throw new ApiError(409, 'ALREADY_ASSIGNED', 'Platform administrators do not need signup');
  }
  if (me.assignments.length > 0) {
    throw new ApiError(409, 'ALREADY_ASSIGNED', 'This account already belongs to a store');
  }
  if (!(await hasOrganizationsTable(c.env.DB))) {
    throw new ApiError(503, 'SIGNUP_UNAVAILABLE', 'Signup is not available in this environment');
  }
  // 新規ログイン停止中はサインアップも止める (/auth/callback の発行抑止と同じ考え方)
  const loginBlock = await loginMaintenanceBlock(c);
  if (loginBlock) {
    throw new ApiError(503, 'MAINTENANCE', loginBlock.message);
  }
  const dto = parseWith(signupSchema, await parseJson(c));
  const templateKey = dto.templateKey ?? 'general';
  if (!isTemplateKey(templateKey)) {
    throw new ApiError(400, 'INVALID_TEMPLATE', `Unknown template: ${templateKey}`);
  }
  const template = findTemplate(templateKey);
  const db = c.env.DB;
  const now = Date.now();

  const orgRes = await db
    .prepare('INSERT INTO organizations (name, plan_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)')
    .bind(dto.organizationName, 'free', now)
    .run();
  const organizationId = Number(orgRes.meta.last_row_id);

  // 店舗コードは全店舗で一意。自動生成して衝突したら数回だけ引き直す
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let storeId = 0;
  let storeCode = '';
  for (let attempt = 0; attempt < 5 && storeId === 0; attempt++) {
    let suffix = '';
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    for (const b of bytes) suffix += alphabet[b % alphabet.length];
    storeCode = `S${suffix}`;
    try {
      const res = await db
        .prepare(
          `INSERT INTO stores (code, name, status, organization_id, created_at, updated_at)
           VALUES (?1, ?2, 'active', ?3, ?4, ?4)`,
        )
        .bind(storeCode, dto.storeName, organizationId, now)
        .run();
      storeId = Number(res.meta.last_row_id);
    } catch {
      // コード衝突時は次の候補で再試行する
    }
  }
  if (storeId === 0) throw new ApiError(500, 'SIGNUP_FAILED', 'Failed to allocate a store code');

  const whRes = await db
    .prepare('INSERT INTO warehouses (store_id, code, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)')
    .bind(storeId, 'WH-01', '倉庫', now)
    .run();
  const warehouseId = Number(whRes.meta.last_row_id);

  await db
    .prepare('INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id) VALUES (?1, ?2, NULL, ?3)')
    .bind(me.userId, RoleCode.SYSTEM_ADMIN, storeId)
    .run();

  const applied = await applyIndustryTemplate(db, storeId, templateKey, { warehouseId });

  await setSessionStore(db, c.req.raw, storeId).catch(() => {});
  await insertAudit(db, {
    actorId: me.userId,
    action: 'store.signup',
    targetType: 'store',
    targetId: String(storeId),
    payload: { organizationId, organizationName: dto.organizationName, storeCode, templateKey },
    storeId,
    createdAt: now,
  });

  return c.json(
    {
      organization: { id: organizationId, name: dto.organizationName, planKey: 'free' },
      store: { id: storeId, code: storeCode, name: dto.storeName, status: 'active' },
      warehouse: { id: warehouseId, code: 'WH-01', name: '倉庫' },
      template: { key: template.key, name: template.name, applied },
    },
    201,
  );
});

// ------------------------------------------------------- 初期セットアップ

/**
 * セットアップ進捗 (現在店舗)。「はじめに」画面とホームのカードが使う。
 * 判定はすべて実データから行う (保存された進捗フラグは持たない):
 * - locations: 保管場所が 1 件以上 (削除済みを除く)
 * - products: 商品が 1 件以上 (削除済みを除く)
 * - members: 現在店舗に割当のあるユーザーが 2 人以上
 * - features: 機能フラグが 1 件でも明示設定されていれば「確認済み」とみなす
 * - settings: 店舗設定 (通貨・タイムゾーン) が 1 件でも明示保存されていれば
 *   「確認済み」とみなす (0020 の汎用化に合わせて追加)
 */
app.get('/api/v1/setup/status', async (c) => {
  await requirePermission(c, Permission.MASTER_READ);
  const ctx = await storeContext(c);
  const db = c.env.DB;
  const count = async (sql: string, ...params: number[]): Promise<number> => {
    try {
      const row = await db.prepare(sql).bind(...params).first<{ n: number }>();
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  };
  const locationCount = await count(
    `SELECT COUNT(*) AS n FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
      WHERE w.store_id = ?1 AND loc.deleted_at IS NULL`,
    ctx.store.id,
  );
  const productCount = await count(
    'SELECT COUNT(*) AS n FROM products WHERE store_id = ?1 AND deleted_at IS NULL',
    ctx.store.id,
  );
  const memberCount = await count(
    'SELECT COUNT(DISTINCT user_id) AS n FROM user_roles WHERE store_id = ?1',
    ctx.store.id,
  );
  const featureFlagCount = await count(
    'SELECT COUNT(*) AS n FROM feature_flags WHERE store_id = ?1',
    ctx.store.id,
  );
  const settingsCount = await count(
    'SELECT COUNT(*) AS n FROM store_settings WHERE store_id = ?1',
    ctx.store.id,
  );
  const items = {
    locations: locationCount >= 1,
    products: productCount >= 1,
    members: memberCount >= 2,
    features: featureFlagCount >= 1,
    settings: settingsCount >= 1,
  };
  const doneCount = Object.values(items).filter(Boolean).length;
  return c.json({
    items,
    counts: { locations: locationCount, products: productCount, members: memberCount },
    doneCount,
    totalCount: 5,
    complete: doneCount === 5,
  });
});

/** 商品 CSV テンプレート (取込と同じ列 sku,name,unit,requires_expiry,unit_cost) */
app.get('/api/v1/setup/template/products.csv', async (c) => {
  await requirePermission(c, Permission.MASTER_READ);
  await storeContext(c);
  const rows: string[][] = [
    ['SAMPLE-001', 'サンプル商品A', '個', 'false', '120'],
    ['SAMPLE-002', 'サンプル商品B (期限管理あり)', '箱', 'true', ''],
  ];
  return c.body('\uFEFF' + toCsv(['sku', 'name', 'unit', 'requires_expiry', 'unit_cost'], rows), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="products-template.csv"',
  });
});

/** 保管場所 CSV テンプレート (warehouse_code,code,name,parent_code の参考形式) */
app.get('/api/v1/setup/template/locations.csv', async (c) => {
  await requirePermission(c, Permission.MASTER_READ);
  await storeContext(c);
  const rows: string[][] = [
    ['WH-01', 'ZONE-A', 'ゾーンA', ''],
    ['WH-01', 'A-01', '棚A-01', 'ZONE-A'],
    ['WH-01', 'A-02', '棚A-02', 'ZONE-A'],
  ];
  return c.body('\uFEFF' + toCsv(['warehouse_code', 'code', 'name', 'parent_code'], rows), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="locations-template.csv"',
  });
});

// ------------------------------------------------------------ 機能フラグ

/** 解決済みの機能フラグ (現在店舗、プラン許可を重ねた実効値)。/app の出し分け用 */
app.get('/api/v1/features', async (c) => {
  const ctx = await storeContext(c);
  return c.json({ features: await effectiveFeatures(c, ctx.store.id) });
});

app.get('/api/v1/admin/features', async (c) => {
  await requirePermission(c, Permission.ADMIN_PERMISSIONS);
  const ctx = await storeContext(c);
  const features = await getFeatures(c.env.DB, ctx.store.id);
  return c.json({
    features: FEATURE_CATALOG.map((f) => ({ key: f.key, label: f.label, enabled: features[f.key] === true })),
  });
});

const featureFlagBodySchema = z.object({ enabled: z.boolean() });

/** 機能フラグの upsert (店舗単位)。監査ログにも店舗を記録する */
async function upsertFeatureFlag(
  c: AppContext,
  storeId: number,
  key: string,
  enabled: boolean,
  via: 'admin' | 'platform',
): Promise<void> {
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO feature_flags (store_id, key, enabled, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(store_id, key) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(storeId, key, enabled ? 1 : 0, user(c).userId, now),
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'feature_flag.update',
      targetType: 'feature_flag',
      targetId: key,
      payload: { enabled, storeId, via },
      storeId,
      createdAt: now,
    }),
  ]);
}

app.put('/api/v1/admin/features/:key', async (c) => {
  await requirePermission(c, Permission.ADMIN_PERMISSIONS);
  const ctx = await storeContext(c);
  const key = c.req.param('key');
  if (!FEATURE_KEYS.has(key)) {
    throw new ApiError(422, 'UNKNOWN_FEATURE', `Unknown feature key: ${key}`);
  }
  const dto = parseWith(featureFlagBodySchema, await parseJson(c));
  await upsertFeatureFlag(c, ctx.store.id, key, dto.enabled, 'admin');
  return c.json({ key, enabled: dto.enabled });
});

/** ログアウト: Cookie セッションを破棄し、Cookie 自体も失効させる */
app.post('/api/v1/auth/logout', async (c) => {
  try {
    await destroySession(c.env.DB, c.req.raw);
  } catch {
    // sessions テーブル未適用の環境では破棄するものが無い
  }
  return c.json({ loggedOut: true }, 200, { 'Set-Cookie': clearSessionCookieHeader() });
});

// ------------------------------------------------- パスキー / セッション (0017)
// WebAuthn (Face ID 等) ログイン、自分のセッション管理、ログイン履歴、
// ステップアップ再認証。検証ロジックは lib/webauthn.ts、ログイン記録は
// lib/login-events.ts。失敗は詳細を漏らさない汎用エラーに倒す。

const PASSKEY_FAILED = () =>
  new ApiError(400, 'PASSKEY_VERIFICATION_FAILED', 'Passkey verification failed');

function rpIdOf(c: AppContext): string {
  return new URL(c.req.url).hostname;
}

function originOf(c: AppContext): string {
  return new URL(c.req.url).origin;
}

async function requirePasskeyTables(c: AppContext): Promise<void> {
  if (!(await hasTable(c, 'passkey_credentials')) || !(await hasTable(c, 'webauthn_challenges'))) {
    throw new ApiError(503, 'PASSKEY_NOT_CONFIGURED', 'Passkey is not configured (migration 0017)');
  }
}

const passkeyRegisterVerifySchema = z.object({
  credentialId: z.string().min(1),
  clientDataJSON: z.string().min(1),
  attestationObject: z.string().min(1),
  transports: z.array(z.string()).optional(),
  label: z.string().max(100).optional(),
});

const passkeyAssertionSchema = z.object({
  credentialId: z.string().min(1),
  clientDataJSON: z.string().min(1),
  authenticatorData: z.string().min(1),
  signature: z.string().min(1),
});

interface PasskeyCredentialRow {
  id: number;
  user_id: number;
  credential_id: string;
  public_key_jwk: string;
  sign_count: number;
  transports: string | null;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
}

/**
 * assertion を検証する共通処理 (ログインとステップアップで共用)。
 * 成功したら該当クレデンシャル行を返し、sign_count / last_used_at を更新する。
 * 失敗はすべて汎用エラー (詳細を漏らさない)。
 */
async function verifyPasskeyAssertion(
  c: AppContext,
  dto: z.infer<typeof passkeyAssertionSchema>,
  purpose: 'login' | 'step_up',
  expectedUserId: number | null,
): Promise<PasskeyCredentialRow> {
  const db = c.env.DB;
  let clientDataBytes: Uint8Array;
  let authenticatorDataBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    clientDataBytes = base64UrlDecode(dto.clientDataJSON);
    authenticatorDataBytes = base64UrlDecode(dto.authenticatorData);
    signatureBytes = base64UrlDecode(dto.signature);
  } catch {
    throw PASSKEY_FAILED();
  }
  let challenge: string;
  try {
    challenge = parseClientData(clientDataBytes).challenge;
  } catch {
    throw PASSKEY_FAILED();
  }
  const challengeRow = await consumeChallenge(db, challenge, purpose);
  if (!challengeRow) throw PASSKEY_FAILED();
  if (expectedUserId !== null && challengeRow.user_id !== expectedUserId) throw PASSKEY_FAILED();

  const credential = await db
    .prepare('SELECT * FROM passkey_credentials WHERE credential_id = ?1')
    .bind(dto.credentialId)
    .first<PasskeyCredentialRow>();
  if (!credential) throw PASSKEY_FAILED();
  if (expectedUserId !== null && credential.user_id !== expectedUserId) throw PASSKEY_FAILED();

  try {
    const clientData = parseClientData(clientDataBytes);
    checkClientData(clientData, { type: 'webauthn.get', challenge, origin: originOf(c) });
    const authData = parseAuthenticatorData(authenticatorDataBytes);
    const expectedRpHash = await sha256Bytes(rpIdOf(c));
    if (!bytesEqual(authData.rpIdHash, expectedRpHash)) throw new Error('rpIdHash mismatch');
    if (!authData.userPresent || !authData.userVerified) throw new Error('UP/UV required');
    // signCount が戻っている assertion は複製の疑いがあるため拒否する。
    // カウンタを持たない authenticator (双方 0) は許容する。
    if (
      (authData.signCount !== 0 || credential.sign_count !== 0) &&
      authData.signCount <= credential.sign_count
    ) {
      throw new Error('signCount regression');
    }
    const clientHash = await sha256Bytes(clientDataBytes);
    const signedData = new Uint8Array(authenticatorDataBytes.length + clientHash.length);
    signedData.set(authenticatorDataBytes, 0);
    signedData.set(clientHash, authenticatorDataBytes.length);
    const jwk = JSON.parse(credential.public_key_jwk) as JsonWebKey;
    const ok = await verifyAssertionSignature(jwk, signatureBytes, signedData);
    if (!ok) throw new Error('signature mismatch');
  } catch {
    throw PASSKEY_FAILED();
  }

  // sign_count は assertion 側の値を保存する (検証済みの値を再パースして使う)
  const verifiedCount = parseAuthenticatorData(authenticatorDataBytes).signCount;
  await db
    .prepare('UPDATE passkey_credentials SET sign_count = ?1, last_used_at = ?2 WHERE id = ?3')
    .bind(verifiedCount, Date.now(), credential.id)
    .run();
  return credential;
}

/** パスキー登録の開始 (ログイン済みユーザー本人) */
app.post('/api/v1/auth/passkey/register/options', async (c) => {
  await requirePasskeyTables(c);
  const me = user(c);
  const challenge = await issueChallenge(c.env.DB, { userId: me.userId, purpose: 'register' });
  const { results } = await c.env.DB.prepare(
    'SELECT credential_id FROM passkey_credentials WHERE user_id = ?1 ORDER BY id ASC',
  )
    .bind(me.userId)
    .all<{ credential_id: string }>();
  return c.json({
    challenge,
    rp: { name: '在庫管理システム', id: rpIdOf(c) },
    user: {
      id: base64UrlEncode(new TextEncoder().encode(String(me.userId))),
      name: me.email,
      displayName: me.displayName || me.email,
    },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    timeout: 60000,
    attestation: 'none',
    // 端末内蔵 (Face ID) と外部キーの両方を許可し、discoverable にする
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: results.map((r) => ({ type: 'public-key', id: r.credential_id })),
  });
});

/** パスキー登録の検証・保存 */
app.post('/api/v1/auth/passkey/register/verify', async (c) => {
  await requirePasskeyTables(c);
  const me = user(c);
  const dto = parseWith(passkeyRegisterVerifySchema, await parseJson(c));
  let clientDataBytes: Uint8Array;
  let attestationBytes: Uint8Array;
  try {
    clientDataBytes = base64UrlDecode(dto.clientDataJSON);
    attestationBytes = base64UrlDecode(dto.attestationObject);
  } catch {
    throw PASSKEY_FAILED();
  }
  let challenge: string;
  try {
    challenge = parseClientData(clientDataBytes).challenge;
  } catch {
    throw PASSKEY_FAILED();
  }
  const challengeRow = await consumeChallenge(c.env.DB, challenge, 'register');
  if (!challengeRow || challengeRow.user_id !== me.userId) throw PASSKEY_FAILED();

  let credentialId: string;
  try {
    const clientData = parseClientData(clientDataBytes);
    checkClientData(clientData, { type: 'webauthn.create', challenge, origin: originOf(c) });
    const { authData, format } = parseAttestationObject(attestationBytes);
    const expectedRpHash = await sha256Bytes(rpIdOf(c));
    if (!bytesEqual(authData.rpIdHash, expectedRpHash)) throw new Error('rpIdHash mismatch');
    if (!authData.userPresent || !authData.userVerified) throw new Error('UP/UV required');
    if (!authData.attestedCredentialData) throw new Error('no attested credential data');
    const jwk = coseEc2ToJwk(authData.attestedCredentialData.cosePublicKey);
    if (!(await verifyAttestationSignature(attestationBytes, clientDataBytes, jwk))) {
      throw new Error('attestation signature invalid');
    }
    credentialId = base64UrlEncode(authData.attestedCredentialData.credentialId);
    if (dto.credentialId !== credentialId) throw new Error('credential id mismatch');
    const now = Date.now();
    const inserted = await c.env.DB.prepare(
      `INSERT INTO passkey_credentials (user_id, credential_id, public_key_jwk, sign_count, transports, label, created_at, last_used_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)`,
    )
      .bind(
        me.userId,
        credentialId,
        JSON.stringify(jwk),
        authData.signCount,
        dto.transports ? JSON.stringify(dto.transports) : null,
        dto.label ?? null,
        now,
      )
      .run();
    return c.json({ id: Number(inserted.meta.last_row_id), credentialId, createdAt: now }, 201);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw PASSKEY_FAILED();
  }
});

/** パスキーログインの開始 (未認証。ユーザー名なし・discoverable) */
app.post('/api/v1/auth/passkey/login/options', async (c) => {
  await requirePasskeyTables(c);
  const loginBlock = await loginMaintenanceBlock(c);
  if (loginBlock) {
    return c.json(
      { statusCode: 503, error: 'MAINTENANCE', message: loginBlock.message, endsAt: loginBlock.endsAt },
      503,
    );
  }
  const challenge = await issueChallenge(c.env.DB, { userId: null, purpose: 'login' });
  return c.json({
    challenge,
    rpId: rpIdOf(c),
    timeout: 60000,
    userVerification: 'required',
  });
});

/** パスキーログインの検証。成功すれば通常のセッションを発行する */
app.post('/api/v1/auth/passkey/login/verify', async (c) => {
  await requirePasskeyTables(c);
  const dto = parseWith(passkeyAssertionSchema, await parseJson(c));
  const credential = await verifyPasskeyAssertion(c, dto, 'login', null);
  const target = await c.env.DB.prepare('SELECT id, status FROM users WHERE id = ?1')
    .bind(credential.user_id)
    .first<{ id: number; status: string }>();
  if (!target || target.status !== 'active') throw PASSKEY_FAILED();
  await recordLoginEvent(c.env.DB, c.env, {
    userId: target.id,
    method: 'passkey',
    ip: clientIp(c.req.raw),
    userAgent: c.req.header('user-agent') ?? null,
  });
  const token = await createSession(c.env.DB, target.id, {
    userAgent: c.req.header('user-agent') ?? null,
    ip: clientIp(c.req.raw),
    passkeyVerified: true,
  });
  return c.json({ ok: true }, 200, { 'Set-Cookie': sessionCookieHeader(token) });
});

/** 自分のパスキー一覧 */
app.get('/api/v1/auth/passkey/credentials', async (c) => {
  await requirePasskeyTables(c);
  const me = user(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, credential_id, label, created_at, last_used_at
       FROM passkey_credentials WHERE user_id = ?1 ORDER BY id ASC`,
  )
    .bind(me.userId)
    .all<{ id: number; credential_id: string; label: string | null; created_at: number; last_used_at: number | null }>();
  return c.json(
    results.map((r) => ({
      id: r.id,
      credentialId: r.credential_id,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
  );
});

/** 自分のパスキーを削除する */
app.delete('/api/v1/auth/passkey/credentials/:id', async (c) => {
  await requirePasskeyTables(c);
  const me = user(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw notFound('Passkey not found');
  const res = await c.env.DB.prepare(
    'DELETE FROM passkey_credentials WHERE id = ?1 AND user_id = ?2',
  )
    .bind(id, me.userId)
    .run();
  if (res.meta.changes === 0) throw notFound('Passkey not found');
  return c.json({ id, deleted: true });
});

/** ステップアップ用のチャレンジ発行 (現在のセッションに紐付ける) */
app.post('/api/v1/auth/passkey/step-up/options', async (c) => {
  await requirePasskeyTables(c);
  const me = user(c);
  const session = await currentSessionRow(c.env.DB, c.req.raw);
  const challenge = await issueChallenge(c.env.DB, {
    userId: me.userId,
    purpose: 'step_up',
    sessionId: session?.id ?? null,
  });
  return c.json({
    challenge,
    rpId: rpIdOf(c),
    timeout: 60000,
    userVerification: 'required',
  });
});

/** ステップアップ再認証 (パスキー)。現在のセッションに step_up_at を打つ */
app.post('/api/v1/auth/step-up/passkey', async (c) => {
  await requirePasskeyTables(c);
  const me = user(c);
  if (!me.viaSession) return c.json({ ok: true, stepUp: 'not_required' });
  const dto = parseWith(passkeyAssertionSchema, await parseJson(c));
  // チャレンジが現在のセッション用に発行されたものかも検証する
  let challengeText: string;
  try {
    challengeText = parseClientData(base64UrlDecode(dto.clientDataJSON)).challenge;
  } catch {
    throw PASSKEY_FAILED();
  }
  const session = await currentSessionRow(c.env.DB, c.req.raw);
  if (!session) throw PASSKEY_FAILED();
  const challengeRow = await c.env.DB.prepare(
    'SELECT session_id FROM webauthn_challenges WHERE challenge = ?1 AND purpose = ?2',
  )
    .bind(challengeText, 'step_up')
    .first<{ session_id: number | null }>();
  if (!challengeRow || challengeRow.session_id !== session.id) throw PASSKEY_FAILED();
  await verifyPasskeyAssertion(c, dto, 'step_up', me.userId);
  await markSessionStepUp(c.env.DB, c.req.raw, undefined, { viaPasskey: true });
  return c.json({ ok: true });
});

/** 自分の有効セッション一覧 (現在のセッションには印を付ける) */
app.get('/api/v1/auth/sessions', async (c) => {
  const me = user(c);
  const token = readSessionToken(c.req.raw);
  const currentHash = token ? await hashSessionToken(token) : null;
  const hasMeta = await hasColumn(c, 'sessions', 'user_agent');
  const metaCols = hasMeta ? ', user_agent, ip, last_seen_at' : '';
  const { results } = await c.env.DB.prepare(
    `SELECT id, token_hash, created_at, expires_at${metaCols}
       FROM sessions
      WHERE user_id = ?1 AND (scope IS NULL OR scope = 'app') AND expires_at > ?2
      ORDER BY created_at DESC`,
  )
    .bind(me.userId, Date.now())
    .all<Record<string, unknown>>();
  return c.json(
    results.map((r) => ({
      id: Number(r.id),
      createdAt: Number(r.created_at),
      lastSeenAt: r.last_seen_at != null ? Number(r.last_seen_at) : null,
      userAgent: (r.user_agent as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
      current: currentHash !== null && r.token_hash === currentHash,
    })),
  );
});

/** 自分の他のセッションを失効させる (現在のセッション自身は対象外) */
app.delete('/api/v1/auth/sessions/:id', async (c) => {
  const me = user(c);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw notFound('Session not found');
  const row = await c.env.DB.prepare('SELECT id, token_hash FROM sessions WHERE id = ?1 AND user_id = ?2')
    .bind(id, me.userId)
    .first<{ id: number; token_hash: string }>();
  if (!row) throw notFound('Session not found');
  const token = readSessionToken(c.req.raw);
  const currentHash = token ? await hashSessionToken(token) : null;
  if (currentHash !== null && row.token_hash === currentHash) {
    throw new ApiError(400, 'CURRENT_SESSION', 'Current session cannot be revoked here. Use logout.');
  }
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(id).run();
  return c.json({ id, revoked: true });
});

/** 自分のログイン履歴 (直近 20 件) */
app.get('/api/v1/auth/login-events', async (c) => {
  const me = user(c);
  if (!(await hasTable(c, 'login_events'))) return c.json([]);
  const { results } = await c.env.DB.prepare(
    `SELECT method, ip, user_agent, device_label, created_at
       FROM login_events WHERE user_id = ?1 ORDER BY id DESC LIMIT 20`,
  )
    .bind(me.userId)
    .all<{ method: string; ip: string | null; user_agent: string | null; device_label: string; created_at: number }>();
  return c.json(
    results.map((r) => ({
      method: r.method,
      ip: r.ip,
      userAgent: r.user_agent,
      deviceLabel: r.device_label,
      createdAt: r.created_at,
    })),
  );
});

/** 入出庫履歴 (stock_movements の参照)。現在店舗・スコープ外倉庫の履歴は出さない */
app.get('/api/v1/movements', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  const reachable = reachableWarehouseIds(ctx.assignments);
  if (reachable !== null && reachable.length === 0) return c.json([]);
  const conditions: string[] = ['mv.store_id = ?'];
  const params: (number | string)[] = [ctx.store.id];
  if (reachable !== null) {
    conditions.push(`loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`);
    params.push(...reachable);
  }
  const productId = c.req.query('productId');
  if (productId !== undefined) {
    conditions.push('l.product_id = ?');
    params.push(Number(productId));
  }
  const type = c.req.query('type');
  if (type !== undefined) {
    conditions.push('mv.type = ?');
    params.push(type);
  }
  // 差分取得: sinceId を渡すと「その ID より後」だけを古い順に返す (連携用)
  const sinceIdRaw = c.req.query('sinceId');
  const sinceId = sinceIdRaw !== undefined && sinceIdRaw !== '' ? Number(sinceIdRaw) : null;
  if (sinceId !== null && Number.isFinite(sinceId)) {
    conditions.push('mv.id > ?');
    params.push(Math.trunc(sinceId));
  }
  const skip = sinceId !== null ? 0 : Number(c.req.query('skip') ?? 0);
  const take = Math.min(Number(c.req.query('take') ?? 50), 200);
  // 検品写真の件数 (0014 の movement_photos がある環境のみ数える)
  const photoCountSql = (await hasTable(c, 'movement_photos'))
    ? '(SELECT COUNT(*) FROM movement_photos mp WHERE mp.movement_id = mv.id) AS photoCount'
    : '0 AS photoCount';
  // 0015 の拡張列 (セット品の束・返品/廃棄の理由コード)
  const extSql = (await hasColumn(c, 'stock_movements', 'group_id'))
    ? 'mv.group_id AS groupId, mv.reason_code AS reasonCode,'
    : 'NULL AS groupId, NULL AS reasonCode,';
  const sql =
    `SELECT mv.id, mv.document_id AS documentId, mv.stock_id AS stockId, mv.type,
            mv.quantity_change AS quantityChange, mv.quantity_before AS quantityBefore,
            mv.quantity_after AS quantityAfter, mv.actor_id AS actorId,
            mv.department, mv.purpose, mv.reason, ${extSql} mv.created_at AS createdAt,
            s.location_id AS locationId, loc.warehouse_id AS warehouseId,
            l.product_id AS productId, l.lot_code AS lotCode, p.sku, ${photoCountSql}
       FROM stock_movements mv
       JOIN stocks s ON s.id = mv.stock_id
       JOIN locations loc ON loc.id = s.location_id
       JOIN lots l ON l.id = s.lot_id
       JOIN products p ON p.id = l.product_id` +
    (conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '') +
    (sinceId !== null ? ' ORDER BY mv.id ASC LIMIT ? OFFSET ?' : ' ORDER BY mv.id DESC LIMIT ? OFFSET ?');
  params.push(take, skip);
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  // 全体管理者の操作は actorId を伏せる (誰の操作かは店舗側に出さない)
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(
    results.map((r) => anonymizeUserFields(r as Record<string, unknown>, hidden, ['actorId'])),
  );
});

// ------------------------------------------------------- 検品写真 (R2)
// 入出庫伝票 (stock_movements) への写真添付。実体は R2、台帳は movement_photos。
// 写真は 1 リクエスト 1 枚で、複数枚は繰り返し呼ぶ。バインディング IMAGES や
// テーブル (0014) が無い環境では 503 PHOTOS_NOT_CONFIGURED で劣化する。

interface MovementPhotoRow {
  id: number;
  movement_id: number;
  image_key: string;
  created_by: number;
  created_at: number;
}

async function loadMovementInStore(c: AppContext, movementId: number, storeId: number): Promise<void> {
  const row = await c.env.DB.prepare('SELECT id FROM stock_movements WHERE id = ?1 AND store_id = ?2')
    .bind(movementId, storeId)
    .first<{ id: number }>();
  if (!row) throw notFound('Movement not found');
}

/** 検品写真を 1 枚追加する (movements.inbound)。発注の受入で生まれた伝票にもそのまま付けられる */
app.post('/api/v1/movements/:id/photos', async (c) => {
  await requirePermission(c, Permission.MOVEMENTS_INBOUND);
  const ctx = await storeContext(c);
  const movementId = Number(c.req.param('id'));
  if (!(await hasTable(c, 'movement_photos'))) {
    throw new ApiError(503, 'PHOTOS_NOT_CONFIGURED', 'Movement photos are not configured (migration 0014 / R2 binding IMAGES)');
  }
  await loadMovementInStore(c, movementId, ctx.store.id);
  const bucket = requireImagesBucket(c.env);
  const { bytes, contentType } = await readImageBody(c.req.raw);
  const now = Date.now();
  const inserted = await c.env.DB.prepare(
    `INSERT INTO movement_photos (store_id, movement_id, image_key, created_by, created_at)
     VALUES (?1, ?2, '', ?3, ?4)`,
  )
    .bind(ctx.store.id, movementId, user(c).userId, now)
    .run();
  const photoId = Number(inserted.meta.last_row_id);
  const key = movementPhotoKey(ctx.store.id, photoId);
  try {
    await bucket.put(key, bytes, { httpMetadata: { contentType } });
  } catch {
    await c.env.DB.prepare('DELETE FROM movement_photos WHERE id = ?1').bind(photoId).run();
    throw new ApiError(502, 'PHOTO_STORE_FAILED', 'Failed to store the photo');
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE movement_photos SET image_key = ?1 WHERE id = ?2').bind(key, photoId),
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'movement.photo.add',
      targetType: 'stock_movement',
      targetId: String(movementId),
      payload: { photoId },
      storeId: ctx.store.id,
      createdAt: now,
    }),
  ]);
  return c.json({ id: photoId, movementId, imageKey: key, createdBy: user(c).userId, createdAt: now }, 201);
});

/** 伝票に付いた検品写真の一覧 (stocks.read) */
app.get('/api/v1/movements/:id/photos', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  const movementId = Number(c.req.param('id'));
  await loadMovementInStore(c, movementId, ctx.store.id);
  if (!(await hasTable(c, 'movement_photos'))) return c.json([]);
  const { results } = await c.env.DB.prepare(
    'SELECT id, movement_id, image_key, created_by, created_at FROM movement_photos WHERE movement_id = ?1 AND store_id = ?2 ORDER BY id ASC',
  )
    .bind(movementId, ctx.store.id)
    .all<MovementPhotoRow>();
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(
    results.map((r) => ({
      id: r.id,
      movementId: r.movement_id,
      createdBy: anonymizeUserId(r.created_by, hidden),
      createdAt: r.created_at,
    })),
  );
});

/** 検品写真の実体配信 (stocks.read、現在店舗の写真のみ) */
app.get('/api/v1/photos/:photoId', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  const photoId = Number(c.req.param('photoId'));
  if (!(await hasTable(c, 'movement_photos'))) throw notFound('Photo not found');
  const row = await c.env.DB.prepare(
    'SELECT id, movement_id, image_key, created_by, created_at FROM movement_photos WHERE id = ?1 AND store_id = ?2',
  )
    .bind(photoId, ctx.store.id)
    .first<MovementPhotoRow>();
  if (!row) throw notFound('Photo not found');
  const bucket = imagesBucket(c.env);
  if (!bucket) throw new ApiError(503, 'PHOTOS_NOT_CONFIGURED', 'Image storage (R2 binding IMAGES) is not configured');
  const res = imageResponse(await bucket.get(row.image_key));
  if (!res) throw notFound('Photo not found');
  return res;
});

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
  /** 0007 で追加。未適用環境では undefined になるため null に寄せる */
  unit_cost?: number | null;
  /** 0014 で追加 (画像キー・入数・リードタイム)。同上 */
  image_key?: string | null;
  case_size?: number | null;
  lead_time_days?: number | null;
  /** 0015 で追加 (セット品フラグ)。同上 */
  is_bundle?: number;
  /** 0020 で追加 (商品カテゴリ)。同上 */
  category_id?: number | null;
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
    unitCost: r.unit_cost ?? null,
    imageKey: r.image_key ?? null,
    caseSize: r.case_size ?? null,
    leadTimeDays: r.lead_time_days ?? null,
    isBundle: r.is_bundle === 1,
    categoryId: r.category_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** カテゴリ ID が現在の店舗の有効なカテゴリか検証する (0020) */
async function assertCategoryExists(c: AppContext, storeId: number, categoryId: number): Promise<void> {
  if (!(await hasTable(c, 'product_categories'))) {
    throw badRequest('categoryId is not supported in this environment');
  }
  const row = await c.env.DB.prepare(
    'SELECT id FROM product_categories WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
  )
    .bind(categoryId, storeId)
    .first<{ id: number }>();
  if (!row) throw badRequest('categoryId does not exist');
}

/** 店舗のカテゴリ名マップ (id -> name)。テーブルが無い環境では空 */
async function categoryNameMap(c: AppContext, storeId: number): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!(await hasTable(c, 'product_categories'))) return map;
  const { results } = await c.env.DB.prepare(
    'SELECT id, name FROM product_categories WHERE store_id = ?1 AND deleted_at IS NULL',
  )
    .bind(storeId)
    .all<{ id: number; name: string }>();
  for (const r of results) map.set(r.id, r.name);
  return map;
}

async function listProducts(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_READ);
  const ctx = await storeContext(c);
  const skip = Number(c.req.query('skip') ?? 0);
  const take = Math.min(Number(c.req.query('take') ?? 50), 200);
  const categoryFilter = c.req.query('categoryId');
  const conditions = ['store_id = ?1', 'deleted_at IS NULL'];
  const params: (number | string)[] = [ctx.store.id];
  if (categoryFilter !== undefined && categoryFilter !== '' && (await hasColumn(c, 'products', 'category_id'))) {
    if (categoryFilter === 'none') {
      conditions.push('category_id IS NULL');
    } else {
      conditions.push('category_id = ?');
      params.push(Number(categoryFilter));
    }
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM products WHERE ${conditions.join(' AND ')} ORDER BY id ASC LIMIT ? OFFSET ?`,
  )
    .bind(...params, take, skip)
    .all<ProductRow>();
  const catNames = await categoryNameMap(c, ctx.store.id);
  const out: Record<string, unknown>[] = results.map((r) => ({
    ...productJson(r),
    categoryName: r.category_id != null ? (catNames.get(r.category_id) ?? null) : null,
  }));
  // セット品の単価は構成品の合算で出す (0015。セット品自体は単価を持たない)
  if (results.some((r) => r.is_bundle === 1) && (await hasTable(c, 'product_bundles'))) {
    for (let i = 0; i < results.length; i++) {
      if (results[i]?.is_bundle === 1) {
        const avail = await bundleAvailability(c.env.DB, ctx.store.id, results[i]?.id as number);
        out[i] = { ...out[i], unitCost: avail.unitCost, assemblable: avail.assemblable };
      }
    }
  }
  return c.json(out);
}

async function createProduct(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const dto = parseWith(createProductSchema, await parseJson(c));
  // プランの SKU 上限 (0018)。上限到達時は 403 PLAN_LIMIT_REACHED
  await assertSkuLimit(c, ctx.store.id, 1);
  const now = Date.now();
  // 任意列 (unit_cost は 0007、case_size / lead_time_days は 0014) は
  // 列がある環境でのみ INSERT に含める (未適用環境への後方互換)
  const cols: string[] = [
    'store_id', 'sku', 'name', 'unit', 'barcode', 'safety_stock', 'requires_expiry', 'expiry_alert_days',
  ];
  const binds: (string | number | null)[] = [
    ctx.store.id, dto.sku, dto.name, dto.unit, dto.barcode ?? null, dto.safetyStock ?? 0,
    dto.requiresExpiry ? 1 : 0, dto.expiryAlertDays ?? null,
  ];
  if (await hasColumn(c, 'products', 'unit_cost')) { cols.push('unit_cost'); binds.push(dto.unitCost ?? null); }
  if (await hasColumn(c, 'products', 'case_size')) { cols.push('case_size'); binds.push(dto.caseSize ?? null); }
  if (await hasColumn(c, 'products', 'lead_time_days')) { cols.push('lead_time_days'); binds.push(dto.leadTimeDays ?? null); }
  if (await hasColumn(c, 'products', 'is_bundle')) { cols.push('is_bundle'); binds.push(dto.isBundle ? 1 : 0); }
  if (dto.categoryId !== undefined && dto.categoryId !== null) {
    await assertCategoryExists(c, ctx.store.id, dto.categoryId);
  }
  if (await hasColumn(c, 'products', 'category_id')) { cols.push('category_id'); binds.push(dto.categoryId ?? null); }
  cols.push('created_at', 'updated_at');
  binds.push(now, now);
  const placeholders = cols.map((_, i) => `?${i + 1}`).join(', ');
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO products (${cols.join(', ')}) VALUES (${placeholders})`,
    )
      .bind(...binds)
      .run();
    return c.json({ id: Number(res.meta.last_row_id), ...dto }, 201);
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Product with this sku already exists');
  }
}

async function listWarehouses(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_READ);
  const ctx = await storeContext(c);
  const reachable = reachableWarehouseIds(ctx.assignments);
  let sql = 'SELECT id, code, name FROM warehouses WHERE deleted_at IS NULL AND store_id = ?';
  const params: number[] = [ctx.store.id];
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
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const dto = parseWith(createWarehouseSchema, await parseJson(c));
  const now = Date.now();
  try {
    const res = await c.env.DB.prepare(
      'INSERT INTO warehouses (store_id, code, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
    )
      .bind(ctx.store.id, dto.code, dto.name, now)
      .run();
    return c.json({ id: Number(res.meta.last_row_id), code: dto.code, name: dto.name }, 201);
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Warehouse with this code already exists');
  }
}

async function listLocations(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_READ);
  const ctx = await storeContext(c);
  const reachable = reachableWarehouseIds(ctx.assignments);
  const warehouseId = c.req.query('warehouseId');
  const withParent = await hasColumn(c, 'locations', 'parent_id');
  let sql = `SELECT loc.id, loc.warehouse_id AS warehouseId, loc.code, loc.name${withParent ? ', loc.parent_id AS parentId' : ', NULL AS parentId'}
               FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
              WHERE loc.deleted_at IS NULL AND w.store_id = ?`;
  const params: number[] = [ctx.store.id];
  if (reachable !== null) {
    if (reachable.length === 0) return c.json([]);
    sql += ` AND loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`;
    params.push(...reachable);
  }
  if (warehouseId !== undefined) {
    sql += ' AND loc.warehouse_id = ?';
    params.push(Number(warehouseId));
  }
  sql += ' ORDER BY loc.id ASC';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
}

async function createLocation(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const dto = parseWith(createLocationSchema, await parseJson(c));
  // 倉庫は現在店舗のものだけが対象 (他店舗の倉庫は存在しない扱い)
  const warehouse = await c.env.DB.prepare(
    'SELECT id FROM warehouses WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
  )
    .bind(dto.warehouseId, ctx.store.id)
    .first<{ id: number }>();
  if (!warehouse) throw notFound('Warehouse not found');
  if (!canAccessWarehouse(ctx.assignments, dto.warehouseId)) {
    throw forbidden('Out of warehouse scope');
  }
  const withParent = await hasColumn(c, 'locations', 'parent_id');
  let parentId: number | null = null;
  if (withParent && dto.parentId !== undefined && dto.parentId !== null) {
    parentId = await validateLocationParent(c, ctx.store.id, dto.warehouseId, dto.parentId, null);
  }
  const now = Date.now();
  try {
    const res = withParent
      ? await c.env.DB.prepare(
          'INSERT INTO locations (warehouse_id, code, name, parent_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)',
        )
          .bind(dto.warehouseId, dto.code, dto.name, parentId, now)
          .run()
      : await c.env.DB.prepare(
          'INSERT INTO locations (warehouse_id, code, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)',
        )
          .bind(dto.warehouseId, dto.code, dto.name, now)
          .run();
    return c.json({ id: Number(res.meta.last_row_id), warehouseId: dto.warehouseId, code: dto.code, name: dto.name, parentId }, 201);
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Location with this code already exists in the warehouse');
  }
}

/**
 * 親ロケーションの検証: 同じ店舗・同じ倉庫の場所であること、自分自身や
 * 自分の子孫を親にして循環しないこと。問題があれば 422 を投げ、親 ID を返す。
 */
async function validateLocationParent(
  c: AppContext,
  storeId: number,
  warehouseId: number,
  parentId: number,
  selfId: number | null,
): Promise<number> {
  let current: number | null = parentId;
  const seen = new Set<number>();
  while (current !== null) {
    if (selfId !== null && current === selfId) {
      throw new ApiError(422, 'LOCATION_PARENT_CYCLE', 'A location cannot be its own ancestor');
    }
    if (seen.has(current)) {
      throw new ApiError(422, 'LOCATION_PARENT_CYCLE', 'Location parent chain contains a cycle');
    }
    seen.add(current);
    const row: { warehouse_id: number; parent_id: number | null } | null = await c.env.DB.prepare(
      `SELECT loc.warehouse_id AS warehouse_id, loc.parent_id AS parent_id
         FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
        WHERE loc.id = ?1 AND loc.deleted_at IS NULL AND w.store_id = ?2`,
    )
      .bind(current, storeId)
      .first<{ warehouse_id: number; parent_id: number | null }>();
    if (!row) throw notFound('Parent location not found');
    if (current === parentId && row.warehouse_id !== warehouseId) {
      throw new ApiError(422, 'LOCATION_PARENT_WAREHOUSE', 'Parent location must belong to the same warehouse');
    }
    current = row.parent_id ?? null;
  }
  return parentId;
}

async function listLots(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_READ);
  const ctx = await storeContext(c);
  const productId = c.req.query('productId');
  // 論理削除済みは出さない。lots.deleted_at は 0005 で追加されるため、
  // 未適用環境では従来のクエリにフォールバックする
  let sql = 'SELECT id, product_id AS productId, lot_code AS lotCode, expiry_date AS expiryMs, received_at AS receivedAt FROM lots';
  const params: number[] = [ctx.store.id];
  const conditions: string[] = ['store_id = ?'];
  if (productId !== undefined) {
    conditions.push('product_id = ?');
    params.push(Number(productId));
  }
  try {
    const filtered =
      sql +
      (conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')} AND deleted_at IS NULL` : ' WHERE deleted_at IS NULL') +
      ' ORDER BY id ASC LIMIT 200';
    const { results } = await c.env.DB.prepare(filtered)
      .bind(...params)
      .all<{ id: number; productId: number; lotCode: string; expiryMs: number | null; receivedAt: number }>();
    return c.json(
      results.map((r) => ({ ...r, expiryDate: formatDateOnly(r.expiryMs), expiryMs: undefined })),
    );
  } catch {
    // deleted_at 列が無い環境では従来どおり全件を返す
  }
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY id ASC LIMIT 200';
  const { results } = await c.env.DB.prepare(sql)
    .bind(...params)
    .all<{ id: number; productId: number; lotCode: string; expiryMs: number | null; receivedAt: number }>();
  return c.json(
    results.map((r) => ({ ...r, expiryDate: formatDateOnly(r.expiryMs), expiryMs: undefined })),
  );
}

async function createLot(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const dto = parseWith(createLotSchema, await parseJson(c));
  const product = await c.env.DB.prepare('SELECT id, requires_expiry FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL')
    .bind(dto.productId, ctx.store.id)
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
      `INSERT INTO lots (product_id, lot_code, expiry_date, received_at, store_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?4)`,
    )
      .bind(dto.productId, dto.lotCode, expiryMs, now, ctx.store.id)
      .run();
    return c.json(
      { id: Number(res.meta.last_row_id), productId: dto.productId, lotCode: dto.lotCode, expiryDate: dto.expiryDate ?? null },
      201,
    );
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Lot with this lotCode already exists for the product');
  }
}

// ------------------------------------------------------- マスタ編集・削除
// 編集・論理削除はいずれも master.write が必要。論理削除 (deleted_at) のため
// 在庫・台帳などの履歴データには影響しない (README 参照)。

async function updateProduct(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateProductSchema, await parseJson(c));
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL')
    .bind(id, ctx.store.id)
    .first<ProductRow>();
  if (!row) throw notFound('Product not found');
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (dto.name !== undefined) { sets.push('name = ?'); params.push(dto.name); }
  if (dto.unit !== undefined) { sets.push('unit = ?'); params.push(dto.unit); }
  if (dto.barcode !== undefined) { sets.push('barcode = ?'); params.push(dto.barcode); }
  if (dto.safetyStock !== undefined) { sets.push('safety_stock = ?'); params.push(dto.safetyStock); }
  if (dto.requiresExpiry !== undefined) { sets.push('requires_expiry = ?'); params.push(dto.requiresExpiry ? 1 : 0); }
  if (dto.expiryAlertDays !== undefined) { sets.push('expiry_alert_days = ?'); params.push(dto.expiryAlertDays); }
  if (dto.unitCost !== undefined && (await hasColumn(c, 'products', 'unit_cost'))) {
    sets.push('unit_cost = ?');
    params.push(dto.unitCost);
  }
  if (dto.caseSize !== undefined && (await hasColumn(c, 'products', 'case_size'))) {
    sets.push('case_size = ?');
    params.push(dto.caseSize);
  }
  if (dto.leadTimeDays !== undefined && (await hasColumn(c, 'products', 'lead_time_days'))) {
    sets.push('lead_time_days = ?');
    params.push(dto.leadTimeDays);
  }
  if (dto.isBundle !== undefined && (await hasColumn(c, 'products', 'is_bundle'))) {
    sets.push('is_bundle = ?');
    params.push(dto.isBundle ? 1 : 0);
  }
  if (dto.categoryId !== undefined && (await hasColumn(c, 'products', 'category_id'))) {
    if (dto.categoryId !== null) await assertCategoryExists(c, ctx.store.id, dto.categoryId);
    sets.push('category_id = ?');
    params.push(dto.categoryId);
  }
  if (sets.length > 0) {
    const now = Date.now();
    await c.env.DB.prepare(
      `UPDATE products SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(...params, now, id)
      .run();
  }
  const updated = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?1')
    .bind(id)
    .first<ProductRow>();
  return c.json(productJson(updated as ProductRow));
}

async function deleteProduct(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const now = Date.now();
  const res = await c.env.DB.prepare(
    'UPDATE products SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND store_id = ?3 AND deleted_at IS NULL',
  )
    .bind(now, id, ctx.store.id)
    .run();
  if (res.meta.changes === 0) throw notFound('Product not found');
  return c.json({ id, deleted: true });
}

// ------------------------------------------------------- 商品画像 (R2)
// 保存先は R2 (lib/photos.ts)。バインディング IMAGES が無い環境では
// 503 PHOTOS_NOT_CONFIGURED で劣化する。キーは products/{storeId}/{id}.jpg。

async function loadProductForImage(c: AppContext, id: number, storeId: number): Promise<ProductRow> {
  const row = await c.env.DB.prepare(
    'SELECT * FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
  )
    .bind(id, storeId)
    .first<ProductRow>();
  if (!row) throw notFound('Product not found');
  return row;
}

async function putProductImage(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  await loadProductForImage(c, id, ctx.store.id);
  const bucket = requireImagesBucket(c.env);
  const { bytes, contentType } = await readImageBody(c.req.raw);
  const key = productImageKey(ctx.store.id, id);
  await bucket.put(key, bytes, { httpMetadata: { contentType } });
  if (await hasColumn(c, 'products', 'image_key')) {
    await c.env.DB.prepare('UPDATE products SET image_key = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(key, Date.now(), id)
      .run();
  }
  return c.json({ id, imageKey: key });
}

async function getProductImage(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_READ);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  await loadProductForImage(c, id, ctx.store.id);
  const bucket = imagesBucket(c.env);
  if (!bucket) throw new ApiError(503, 'PHOTOS_NOT_CONFIGURED', 'Image storage (R2 binding IMAGES) is not configured');
  const res = imageResponse(await bucket.get(productImageKey(ctx.store.id, id)));
  if (!res) throw notFound('Product image not found');
  return res;
}

async function deleteProductImage(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const row = await loadProductForImage(c, id, ctx.store.id);
  const bucket = requireImagesBucket(c.env);
  const key = productImageKey(ctx.store.id, id);
  const head = await bucket.head(key);
  if (!head && (row.image_key ?? null) === null) throw notFound('Product image not found');
  await bucket.delete(key);
  if (await hasColumn(c, 'products', 'image_key')) {
    await c.env.DB.prepare('UPDATE products SET image_key = NULL, updated_at = ?1 WHERE id = ?2')
      .bind(Date.now(), id)
      .run();
  }
  return c.json({ id, deleted: true });
}

async function updateWarehouse(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateWarehouseSchema, await parseJson(c));
  const row = await c.env.DB.prepare('SELECT id FROM warehouses WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL')
    .bind(id, ctx.store.id)
    .first<{ id: number }>();
  if (!row) throw notFound('Warehouse not found');
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (dto.code !== undefined) { sets.push('code = ?'); params.push(dto.code); }
  if (dto.name !== undefined) { sets.push('name = ?'); params.push(dto.name); }
  if (sets.length > 0) {
    try {
      await c.env.DB.prepare(
        `UPDATE warehouses SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
      )
        .bind(...params, Date.now(), id)
        .run();
    } catch {
      throw new ApiError(409, 'DUPLICATE', 'Warehouse with this code already exists');
    }
  }
  const updated = await c.env.DB.prepare('SELECT id, code, name FROM warehouses WHERE id = ?1')
    .bind(id)
    .first();
  return c.json(updated);
}

async function deleteWarehouse(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const now = Date.now();
  const res = await c.env.DB.prepare(
    'UPDATE warehouses SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND store_id = ?3 AND deleted_at IS NULL',
  )
    .bind(now, id, ctx.store.id)
    .run();
  if (res.meta.changes === 0) throw notFound('Warehouse not found');
  return c.json({ id, deleted: true });
}

async function updateLocation(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateLocationSchema, await parseJson(c));
  const row = await c.env.DB.prepare(
    `SELECT loc.id, loc.warehouse_id FROM locations loc JOIN warehouses w ON w.id = loc.warehouse_id
      WHERE loc.id = ?1 AND loc.deleted_at IS NULL AND w.store_id = ?2`,
  )
    .bind(id, ctx.store.id)
    .first<{ id: number; warehouse_id: number }>();
  if (!row) throw notFound('Location not found');
  if (!canAccessWarehouse(ctx.assignments, row.warehouse_id)) {
    throw forbidden('Out of warehouse scope');
  }
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (dto.code !== undefined) { sets.push('code = ?'); params.push(dto.code); }
  if (dto.name !== undefined) { sets.push('name = ?'); params.push(dto.name); }
  if (dto.parentId !== undefined && (await hasColumn(c, 'locations', 'parent_id'))) {
    let parentId: number | null = null;
    if (dto.parentId !== null) {
      parentId = await validateLocationParent(c, ctx.store.id, row.warehouse_id, dto.parentId, id);
    }
    sets.push('parent_id = ?');
    params.push(parentId);
  }
  if (sets.length > 0) {
    try {
      await c.env.DB.prepare(
        `UPDATE locations SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
      )
        .bind(...params, Date.now(), id)
        .run();
    } catch {
      throw new ApiError(409, 'DUPLICATE', 'Location with this code already exists in the warehouse');
    }
  }
  const withParent = await hasColumn(c, 'locations', 'parent_id');
  const updated = await c.env.DB.prepare(
    `SELECT id, warehouse_id AS warehouseId, code, name${withParent ? ', parent_id AS parentId' : ''} FROM locations WHERE id = ?1`,
  )
    .bind(id)
    .first();
  return c.json(updated);
}

async function deleteLocation(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const warehouseId = await warehouseIdOfLocation(c, id);
  if (!canAccessWarehouse(ctx.assignments, warehouseId)) {
    throw forbidden('Out of warehouse scope');
  }
  const now = Date.now();
  const res = await c.env.DB.prepare(
    'UPDATE locations SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL',
  )
    .bind(now, id)
    .run();
  if (res.meta.changes === 0) throw notFound('Location not found');
  return c.json({ id, deleted: true });
}

interface LotRow {
  id: number;
  product_id: number;
  lot_code: string;
  expiry_date: number | null;
  received_at: number;
}

function lotJson(r: LotRow): Record<string, unknown> {
  return {
    id: r.id,
    productId: r.product_id,
    lotCode: r.lot_code,
    expiryDate: formatDateOnly(r.expiry_date),
    receivedAt: r.received_at,
  };
}

async function updateLot(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateLotSchema, await parseJson(c));
  const row = await c.env.DB.prepare('SELECT * FROM lots WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL')
    .bind(id, ctx.store.id)
    .first<LotRow>();
  if (!row) throw notFound('Lot not found');
  let expiryMs = row.expiry_date;
  if (dto.expiryDate !== undefined) {
    if (dto.expiryDate === null) {
      expiryMs = null;
    } else {
      expiryMs = parseDateOnly(dto.expiryDate);
      if (expiryMs === null) throw badRequest('expiryDate must be a valid YYYY-MM-DD date');
    }
  }
  const product = await c.env.DB.prepare('SELECT requires_expiry FROM products WHERE id = ?1')
    .bind(row.product_id)
    .first<{ requires_expiry: number }>();
  if (product?.requires_expiry === 1 && expiryMs === null) {
    throw badRequest('expiryDate is required for this product');
  }
  const lotCode = dto.lotCode ?? row.lot_code;
  try {
    await c.env.DB.prepare('UPDATE lots SET lot_code = ?1, expiry_date = ?2, updated_at = ?3 WHERE id = ?4')
      .bind(lotCode, expiryMs, Date.now(), id)
      .run();
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Lot with this lotCode already exists for the product');
  }
  const updated = await c.env.DB.prepare('SELECT * FROM lots WHERE id = ?1')
    .bind(id)
    .first<LotRow>();
  return c.json(lotJson(updated as LotRow));
}

async function deleteLot(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const now = Date.now();
  const res = await c.env.DB.prepare(
    'UPDATE lots SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND store_id = ?3 AND deleted_at IS NULL',
  )
    .bind(now, id, ctx.store.id)
    .run();
  if (res.meta.changes === 0) throw notFound('Lot not found');
  return c.json({ id, deleted: true });
}

// ------------------------------------------------------- 仕入先マスタ
// 他のマスタと同じ流儀 (master.read/write、論理削除)。発注書の宛先になる。

interface SupplierRow {
  id: number;
  name: string;
  contact: string | null;
  email: string | null;
  phone: string | null;
  note: string | null;
  /** 0014 で追加。未適用環境では undefined になるため null に寄せる */
  lead_time_days?: number | null;
  created_at: number;
  updated_at: number;
}

function supplierJson(r: SupplierRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    contact: r.contact,
    email: r.email,
    phone: r.phone,
    note: r.note,
    leadTimeDays: r.lead_time_days ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function listSuppliers(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_READ);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM suppliers WHERE store_id = ?1 AND deleted_at IS NULL ORDER BY id ASC LIMIT 200',
  )
    .bind(ctx.store.id)
    .all<SupplierRow>();
  return c.json(results.map(supplierJson));
}

async function createSupplier(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  const dto = parseWith(createSupplierSchema, await parseJson(c));
  const now = Date.now();
  const withLead = await hasColumn(c, 'suppliers', 'lead_time_days');
  const res = withLead
    ? await c.env.DB.prepare(
        `INSERT INTO suppliers (store_id, name, contact, email, phone, note, lead_time_days, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      )
        .bind(ctx.store.id, dto.name, dto.contact ?? null, dto.email ?? null, dto.phone ?? null, dto.note ?? null, dto.leadTimeDays ?? null, now)
        .run()
    : await c.env.DB.prepare(
        `INSERT INTO suppliers (store_id, name, contact, email, phone, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
      )
        .bind(ctx.store.id, dto.name, dto.contact ?? null, dto.email ?? null, dto.phone ?? null, dto.note ?? null, now)
        .run();
  return c.json({ id: Number(res.meta.last_row_id), ...dto }, 201);
}

async function updateSupplier(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateSupplierSchema, await parseJson(c));
  const row = await c.env.DB.prepare('SELECT * FROM suppliers WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL')
    .bind(id, ctx.store.id)
    .first<SupplierRow>();
  if (!row) throw notFound('Supplier not found');
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (dto.name !== undefined) { sets.push('name = ?'); params.push(dto.name); }
  if (dto.contact !== undefined) { sets.push('contact = ?'); params.push(dto.contact); }
  if (dto.email !== undefined) { sets.push('email = ?'); params.push(dto.email); }
  if (dto.phone !== undefined) { sets.push('phone = ?'); params.push(dto.phone); }
  if (dto.note !== undefined) { sets.push('note = ?'); params.push(dto.note); }
  if (dto.leadTimeDays !== undefined && (await hasColumn(c, 'suppliers', 'lead_time_days'))) {
    sets.push('lead_time_days = ?');
    params.push(dto.leadTimeDays);
  }
  if (sets.length > 0) {
    await c.env.DB.prepare(
      `UPDATE suppliers SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(...params, Date.now(), id)
      .run();
  }
  const updated = await c.env.DB.prepare('SELECT * FROM suppliers WHERE id = ?1')
    .bind(id)
    .first<SupplierRow>();
  return c.json(supplierJson(updated as SupplierRow));
}

async function deleteSupplier(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const now = Date.now();
  const res = await c.env.DB.prepare(
    'UPDATE suppliers SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND store_id = ?3 AND deleted_at IS NULL',
  )
    .bind(now, id, ctx.store.id)
    .run();
  if (res.meta.changes === 0) throw notFound('Supplier not found');
  return c.json({ id, deleted: true });
}

// ------------------------------------------------------- 商品 CSV インポート
// CSV (sku,name,unit,requires_expiry) を multipart の file フィールド、
// または text/csv などの生ボディで受け取り、商品を一括登録する。
// 既存 SKU (論理削除済みを含む) はスキップし、行ごとの成否を集計して返す。

async function importProducts(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  await requireFeature(c, 'csv');
  const ctx = await storeContext(c);
  const contentType = c.req.header('content-type') ?? '';
  let text: string;
  if (contentType.includes('multipart/form-data')) {
    let form: FormData | null = null;
    try {
      form = await c.req.formData();
    } catch {
      form = null;
    }
    const file = form?.get('file');
    if (!(file instanceof File)) {
      throw badRequest('multipart field "file" (CSV file) is required');
    }
    text = await file.text();
  } else {
    text = await c.req.text();
  }
  if (text.trim().length === 0) throw badRequest('CSV body is empty');

  const records = parseCsv(text);
  const headerIdx = records.findIndex((r) => r.some((cell) => cell.trim().length > 0));
  const headerRow = headerIdx >= 0 ? records[headerIdx] : undefined;
  if (!headerRow) throw badRequest('CSV header row is required');
  const header = headerRow.map((h) => h.trim().toLowerCase());
  const col = {
    sku: header.indexOf('sku'),
    name: header.indexOf('name'),
    unit: header.indexOf('unit'),
    requiresExpiry: header.indexOf('requires_expiry'),
    unitCost: header.indexOf('unit_cost'),
  };
  // unit_cost 列 (0007) がある環境でのみ CSV の unit_cost を取り込む
  const withCost = col.unitCost >= 0 && (await hasColumn(c, 'products', 'unit_cost'));
  if (col.sku < 0 || col.name < 0 || col.unit < 0) {
    throw badRequest('CSV header must include sku, name, unit');
  }

  const { results: existingRows } = await c.env.DB.prepare('SELECT sku FROM products WHERE store_id = ?1')
    .bind(ctx.store.id)
    .all<{
      sku: string;
    }>();
  const knownSkus = new Set(existingRows.map((r) => r.sku));

  // プランの SKU 上限 (0018): 投入後の合計が上限を超える場合は投入前に止める
  {
    const seenNew = new Set<string>();
    let adding = 0;
    for (let i = headerIdx + 1; i < records.length; i++) {
      const record = records[i] as string[];
      if (record.every((cell) => cell.trim().length === 0)) continue;
      const sku = (record[col.sku] ?? '').trim();
      const name = (record[col.name] ?? '').trim();
      const unit = (record[col.unit] ?? '').trim();
      if (!sku || !name || !unit) continue;
      if (knownSkus.has(sku) || seenNew.has(sku)) continue;
      seenNew.add(sku);
      adding += 1;
    }
    await assertSkuLimit(c, ctx.store.id, adding);
  }

  const now = Date.now();
  let total = 0;
  let created = 0;
  let skipped = 0;
  const failed: { line: number; sku?: string; reason: string }[] = [];

  for (let i = headerIdx + 1; i < records.length; i++) {
    const record = records[i] as string[];
    if (record.every((cell) => cell.trim().length === 0)) continue;
    const line = i + 1;
    total += 1;
    const sku = (record[col.sku] ?? '').trim();
    const name = (record[col.name] ?? '').trim();
    const unit = (record[col.unit] ?? '').trim();
    if (!sku || !name || !unit) {
      failed.push({ line, ...(sku ? { sku } : {}), reason: 'sku, name, unit are required' });
      continue;
    }
    if (knownSkus.has(sku)) {
      skipped += 1;
      continue;
    }
    const expiryRaw = col.requiresExpiry >= 0 ? (record[col.requiresExpiry] ?? '').trim().toLowerCase() : '';
    const requiresExpiry = ['true', '1', 'yes'].includes(expiryRaw) ? 1 : 0;
    let unitCost: number | null = null;
    if (withCost) {
      const rawCost = (record[col.unitCost] ?? '').trim();
      if (rawCost !== '') {
        const parsed = Number(rawCost);
        unitCost = Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
      }
    }
    try {
      if (withCost) {
        await c.env.DB.prepare(
          `INSERT INTO products (store_id, sku, name, unit, barcode, safety_stock, requires_expiry, expiry_alert_days, unit_cost, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, NULL, 0, ?5, NULL, ?6, ?7, ?7)`,
        )
          .bind(ctx.store.id, sku, name, unit, requiresExpiry, unitCost, now)
          .run();
      } else {
        await c.env.DB.prepare(
          `INSERT INTO products (store_id, sku, name, unit, barcode, safety_stock, requires_expiry, expiry_alert_days, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, NULL, 0, ?5, NULL, ?6, ?6)`,
        )
          .bind(ctx.store.id, sku, name, unit, requiresExpiry, now)
          .run();
      }
      knownSkus.add(sku);
      created += 1;
    } catch {
      failed.push({ line, sku, reason: 'failed to insert product' });
    }
  }
  return c.json({ total, created, skipped, failed });
}

for (const base of ['/api/v1/master', '/api/v1'] as const) {
  app.get(`${base}/products`, listProducts);
  app.post(`${base}/products`, createProduct);
  app.post(`${base}/products/import`, importProducts);
  app.put(`${base}/products/:id`, updateProduct);
  app.delete(`${base}/products/:id`, deleteProduct);
  app.put(`${base}/products/:id/image`, putProductImage);
  app.get(`${base}/products/:id/image`, getProductImage);
  app.delete(`${base}/products/:id/image`, deleteProductImage);
  app.get(`${base}/warehouses`, listWarehouses);
  app.post(`${base}/warehouses`, createWarehouse);
  app.put(`${base}/warehouses/:id`, updateWarehouse);
  app.delete(`${base}/warehouses/:id`, deleteWarehouse);
  app.get(`${base}/locations`, listLocations);
  app.post(`${base}/locations`, createLocation);
  app.put(`${base}/locations/:id`, updateLocation);
  app.delete(`${base}/locations/:id`, deleteLocation);
  app.get(`${base}/lots`, listLots);
  app.post(`${base}/lots`, createLot);
  app.put(`${base}/lots/:id`, updateLot);
  app.delete(`${base}/lots/:id`, deleteLot);
  app.get(`${base}/suppliers`, listSuppliers);
  app.post(`${base}/suppliers`, createSupplier);
  app.put(`${base}/suppliers/:id`, updateSupplier);
  app.delete(`${base}/suppliers/:id`, deleteSupplier);
}

// ------------------------------------------------ 店舗設定と運用マスタ (0020)

/** 店舗設定の取得 (現在店舗のメンバーなら誰でも) */
app.get('/api/v1/settings', async (c) => {
  const ctx = await storeContext(c);
  return c.json(await getStoreSettings(c.env.DB, ctx.store.id));
});

/** 店舗設定の更新 (master.write) */
app.put('/api/v1/settings', async (c) => {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const dto = parseWith(storeSettingsSchema, await parseJson(c));
  if (
    dto.currency !== undefined &&
    !(SUPPORTED_CURRENCIES as readonly string[]).includes(dto.currency)
  ) {
    throw badRequest('currency is not supported');
  }
  if (dto.timezone !== undefined && !isValidTimezone(dto.timezone)) {
    throw badRequest('timezone must be a valid IANA timezone name');
  }
  return c.json(await setStoreSettings(c.env.DB, ctx.store.id, dto));
});

/** 無効分も含めてよいか (all=1 は master.write を持つ人だけ) */
async function mayIncludeInactive(c: AppContext, ctx: StoreContext): Promise<boolean> {
  if (c.req.query('all') !== '1') return false;
  if (ctx.isPlatformAdmin) return true;
  const rp = await loadRolePermissions(c);
  return hasPermission(ctx.assignments, rp, Permission.MASTER_WRITE);
}

/** 理由コード一覧。フォーム用は有効分のみ返す */
app.get('/api/v1/master/reason-codes', async (c) => {
  const ctx = await storeContext(c);
  const kindRaw = c.req.query('kind');
  if (kindRaw !== 'return' && kindRaw !== 'disposal') {
    throw badRequest('kind must be return or disposal');
  }
  await ensureReasonCodesSeeded(c.env.DB, ctx.store.id);
  const includeInactive = await mayIncludeInactive(c, ctx);
  return c.json(await listReasonCodes(c.env.DB, ctx.store.id, kindRaw, includeInactive));
});

app.post('/api/v1/master/reason-codes', async (c) => {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const dto = parseWith(createReasonCodeSchema, await parseJson(c));
  await ensureReasonCodesSeeded(c.env.DB, ctx.store.id);
  const dup = await c.env.DB.prepare(
    `SELECT id FROM movement_reason_codes
      WHERE store_id = ?1 AND kind = ?2 AND code = ?3 AND deleted_at IS NULL`,
  )
    .bind(ctx.store.id, dto.kind, dto.code)
    .first<{ id: number }>();
  if (dup) throw new ApiError(409, 'REASON_CODE_EXISTS', 'A reason code with this code already exists');
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `INSERT INTO movement_reason_codes (store_id, kind, code, label, sort_order, is_active, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)`,
  )
    .bind(ctx.store.id, dto.kind, dto.code, dto.label, dto.sortOrder ?? 0, now)
    .run();
  return c.json(
    {
      id: Number(res.meta.last_row_id),
      kind: dto.kind,
      code: dto.code,
      label: dto.label,
      sortOrder: dto.sortOrder ?? 0,
      isActive: true,
    },
    201,
  );
});

app.put('/api/v1/master/reason-codes/:id', async (c) => {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateReasonCodeSchema, await parseJson(c));
  const row = await c.env.DB.prepare(
    'SELECT id FROM movement_reason_codes WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
  )
    .bind(id, ctx.store.id)
    .first<{ id: number }>();
  if (!row) throw notFound('Reason code not found');
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (dto.label !== undefined) { sets.push('label = ?'); params.push(dto.label); }
  if (dto.isActive !== undefined) { sets.push('is_active = ?'); params.push(dto.isActive ? 1 : 0); }
  if (dto.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(dto.sortOrder); }
  if (sets.length > 0) {
    await c.env.DB.prepare(
      `UPDATE movement_reason_codes SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
    )
      .bind(...params, Date.now(), id)
      .run();
  }
  const updated = await c.env.DB.prepare(
    'SELECT id, kind, code, label, sort_order, is_active FROM movement_reason_codes WHERE id = ?1',
  )
    .bind(id)
    .first<{ id: number; kind: string; code: string; label: string; sort_order: number; is_active: number }>();
  return c.json({
    id: updated!.id,
    kind: updated!.kind,
    code: updated!.code,
    label: updated!.label,
    sortOrder: updated!.sort_order,
    isActive: updated!.is_active === 1,
  });
});

app.delete('/api/v1/master/reason-codes/:id', async (c) => {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const res = await c.env.DB.prepare(
    'UPDATE movement_reason_codes SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND store_id = ?3 AND deleted_at IS NULL',
  )
    .bind(Date.now(), id, ctx.store.id)
    .run();
  if (res.meta.changes === 0) throw notFound('Reason code not found');
  return c.json({ ok: true });
});

/** 部門マスタ一覧 (消費フォームの候補) */
app.get('/api/v1/master/departments', async (c) => {
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'departments'))) return c.json([]);
  const includeInactive = await mayIncludeInactive(c, ctx);
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, sort_order, is_active FROM departments
      WHERE store_id = ?1 AND deleted_at IS NULL${includeInactive ? '' : ' AND is_active = 1'}
      ORDER BY sort_order ASC, id ASC`,
  )
    .bind(ctx.store.id)
    .all<{ id: number; name: string; sort_order: number; is_active: number }>();
  return c.json(
    results.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order, isActive: r.is_active === 1 })),
  );
});

app.post('/api/v1/master/departments', async (c) => {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const dto = parseWith(createNamedMasterSchema, await parseJson(c));
  const dup = await c.env.DB.prepare(
    'SELECT id FROM departments WHERE store_id = ?1 AND name = ?2 AND deleted_at IS NULL',
  )
    .bind(ctx.store.id, dto.name)
    .first<{ id: number }>();
  if (dup) throw new ApiError(409, 'DEPARTMENT_EXISTS', 'A department with this name already exists');
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `INSERT INTO departments (store_id, name, sort_order, is_active, created_at, updated_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
  )
    .bind(ctx.store.id, dto.name, dto.sortOrder ?? 0, now)
    .run();
  return c.json(
    { id: Number(res.meta.last_row_id), name: dto.name, sortOrder: dto.sortOrder ?? 0, isActive: true },
    201,
  );
});

app.put('/api/v1/master/departments/:id', async (c) => {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateNamedMasterSchema, await parseJson(c));
  const row = await c.env.DB.prepare(
    'SELECT id FROM departments WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
  )
    .bind(id, ctx.store.id)
    .first<{ id: number }>();
  if (!row) throw notFound('Department not found');
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (dto.name !== undefined) { sets.push('name = ?'); params.push(dto.name); }
  if (dto.isActive !== undefined) { sets.push('is_active = ?'); params.push(dto.isActive ? 1 : 0); }
  if (dto.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(dto.sortOrder); }
  if (sets.length > 0) {
    await c.env.DB.prepare(`UPDATE departments SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...params, Date.now(), id)
      .run();
  }
  const updated = await c.env.DB.prepare(
    'SELECT id, name, sort_order, is_active FROM departments WHERE id = ?1',
  )
    .bind(id)
    .first<{ id: number; name: string; sort_order: number; is_active: number }>();
  return c.json({
    id: updated!.id,
    name: updated!.name,
    sortOrder: updated!.sort_order,
    isActive: updated!.is_active === 1,
  });
});

app.delete('/api/v1/master/departments/:id', async (c) => {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const res = await c.env.DB.prepare(
    'UPDATE departments SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND store_id = ?3 AND deleted_at IS NULL',
  )
    .bind(Date.now(), id, ctx.store.id)
    .run();
  if (res.meta.changes === 0) throw notFound('Department not found');
  return c.json({ ok: true });
});

/** 商品カテゴリ一覧 (商品件数つき) */
app.get('/api/v1/master/categories', async (c) => {
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'product_categories'))) return c.json([]);
  const withCount = await hasColumn(c, 'products', 'category_id');
  const { results } = await c.env.DB.prepare(
    `SELECT cat.id, cat.name, cat.sort_order
            ${withCount ? ', (SELECT COUNT(*) FROM products p WHERE p.category_id = cat.id AND p.deleted_at IS NULL) AS product_count' : ', 0 AS product_count'}
       FROM product_categories cat
      WHERE cat.store_id = ?1 AND cat.deleted_at IS NULL
      ORDER BY cat.sort_order ASC, cat.id ASC`,
  )
    .bind(ctx.store.id)
    .all<{ id: number; name: string; sort_order: number; product_count: number }>();
  return c.json(
    results.map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order, productCount: r.product_count })),
  );
});

app.post('/api/v1/master/categories', async (c) => {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const dto = parseWith(createNamedMasterSchema, await parseJson(c));
  const dup = await c.env.DB.prepare(
    'SELECT id FROM product_categories WHERE store_id = ?1 AND name = ?2 AND deleted_at IS NULL',
  )
    .bind(ctx.store.id, dto.name)
    .first<{ id: number }>();
  if (dup) throw new ApiError(409, 'CATEGORY_EXISTS', 'A category with this name already exists');
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `INSERT INTO product_categories (store_id, name, sort_order, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)`,
  )
    .bind(ctx.store.id, dto.name, dto.sortOrder ?? 0, now)
    .run();
  return c.json(
    { id: Number(res.meta.last_row_id), name: dto.name, sortOrder: dto.sortOrder ?? 0, productCount: 0 },
    201,
  );
});

app.put('/api/v1/master/categories/:id', async (c) => {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateCategorySchema, await parseJson(c));
  const row = await c.env.DB.prepare(
    'SELECT id FROM product_categories WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
  )
    .bind(id, ctx.store.id)
    .first<{ id: number }>();
  if (!row) throw notFound('Category not found');
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (dto.name !== undefined) { sets.push('name = ?'); params.push(dto.name); }
  if (dto.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(dto.sortOrder); }
  if (sets.length > 0) {
    await c.env.DB.prepare(
      `UPDATE product_categories SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
    )
      .bind(...params, Date.now(), id)
      .run();
  }
  const updated = await c.env.DB.prepare(
    'SELECT id, name, sort_order FROM product_categories WHERE id = ?1',
  )
    .bind(id)
    .first<{ id: number; name: string; sort_order: number }>();
  return c.json({ id: updated!.id, name: updated!.name, sortOrder: updated!.sort_order });
});

/** カテゴリ削除: 紐づく商品は未分類に戻してから論理削除する */
app.delete('/api/v1/master/categories/:id', async (c) => {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const row = await c.env.DB.prepare(
    'SELECT id FROM product_categories WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
  )
    .bind(id, ctx.store.id)
    .first<{ id: number }>();
  if (!row) throw notFound('Category not found');
  const now = Date.now();
  if (await hasColumn(c, 'products', 'category_id')) {
    await c.env.DB.prepare(
      'UPDATE products SET category_id = NULL, updated_at = ?1 WHERE category_id = ?2 AND store_id = ?3',
    )
      .bind(now, id, ctx.store.id)
      .run();
  }
  await c.env.DB.prepare(
    'UPDATE product_categories SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2',
  )
    .bind(now, id)
    .run();
  return c.json({ ok: true });
});

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

function stockJson(r: StockViewRow, freeQuantity?: number | null): Record<string, unknown> {
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
    // 引当がある商品の行だけフリー在庫を併記する (無い場合は null)
    freeQuantity: freeQuantity ?? null,
  };
}

/**
 * 在庫行に対するフリー在庫 (stockId -> フリー数量)。
 * 引当が 1 件も無い・0015 未適用の場合は null を返し、呼び出し側は
 * freeQuantity を付けない (画面を煩雑にしないため)。
 */
async function freeQuantitiesForStocks(
  c: AppContext,
  storeId: number,
  rows: readonly StockViewRow[],
): Promise<Map<number, number> | null> {
  if (rows.length === 0) return null;
  if (!(await hasTable(c, 'reservations'))) return null;
  const reservations = await activeReservationRows(c.env.DB, storeId, Date.now());
  if (reservations.length === 0) return null;
  const productIds = [...new Set(rows.map((r) => r.product_id))];
  const relevant = reservations.filter((r) => productIds.includes(r.product_id));
  if (relevant.length === 0) return null;
  const stocks = await storeStockRows(c.env.DB, storeId, productIds);
  const computed = computeFreeQuantities(
    stocks,
    relevant.map((r) => ({ productId: r.product_id, locationId: r.location_id, quantity: r.quantity })),
  );
  // 表示するのは引当がある商品の行だけ (他商品の行にまで付けると煩雑になる)
  const reservedProducts = new Set(relevant.map((r) => r.product_id));
  const out = new Map<number, number>();
  for (const s of stocks) {
    if (!reservedProducts.has(s.productId)) continue;
    const v = computed.get(s.stockId);
    if (v !== undefined) out.set(s.stockId, v);
  }
  return out;
}

const STOCK_VIEW_SQL = `SELECT s.id, s.location_id, s.lot_id, s.quantity, s.version,
                               loc.warehouse_id, l.product_id, p.sku, l.lot_code, l.expiry_date
                          FROM stocks s
                          JOIN locations loc ON loc.id = s.location_id
                          JOIN lots l ON l.id = s.lot_id
                          JOIN products p ON p.id = l.product_id`;

// ------------------------------------------------------------ 横断検索
/** LIKE のワイルドカードを文字として扱うためのエスケープ (ESCAPE '\' と対) */
function escapeLikePattern(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * 商品・保管場所・入出庫履歴をまとめて検索する (stocks.read)。
 * 対象は現在の店舗の中だけ。倉庫スコープは各一覧と同じに適用し、
 * 商品の在庫合計も届く範囲の倉庫だけで数える。
 */
app.get('/api/v1/search', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  const q = (c.req.query('q') ?? '').trim();
  if (q.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'q: a search query is required');
  }
  const takeRaw = Number(c.req.query('take') ?? 8);
  const take = Number.isFinite(takeRaw) ? Math.min(Math.max(Math.trunc(takeRaw), 1), 20) : 8;
  const like = `%${escapeLikePattern(q)}%`;
  const prefix = `${escapeLikePattern(q)}%`;
  const reachable = reachableWarehouseIds(ctx.assignments);
  const reachableIn =
    reachable === null ? null : reachable.length === 0 ? 'IN (NULL)' : `IN (${reachable.map(() => '?').join(',')})`;
  const reachableParams: number[] = reachable === null ? [] : reachable;

  // 商品: バーコード完全一致 → SKU 完全一致 → 名前の前方一致 → 部分一致の順に並べる
  const productSql =
    `SELECT p.id, p.sku, p.name, p.unit, p.barcode,
            COALESCE(SUM(s.quantity), 0) AS totalQuantity,
            COUNT(DISTINCT s.location_id) AS locationCount
       FROM products p
       LEFT JOIN lots l ON l.product_id = p.id
       LEFT JOIN stocks s ON s.lot_id = l.id AND s.store_id = p.store_id` +
    (reachableIn === null
      ? ''
      : ` AND s.location_id IN (SELECT id FROM locations WHERE warehouse_id ${reachableIn})`) +
    ` WHERE p.store_id = ? AND p.deleted_at IS NULL
        AND (p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR p.barcode LIKE ? ESCAPE '\\')
      GROUP BY p.id
      ORDER BY (p.barcode = ?) DESC, (p.sku = ?) DESC, (p.name LIKE ? ESCAPE '\\') DESC, p.name ASC
      LIMIT ?`;
  const productParams: (string | number)[] = [
    ...reachableParams,
    ctx.store.id,
    like,
    like,
    like,
    q,
    q,
    prefix,
    take,
  ];

  // 保管場所: 親の名前も添える (階層が無い環境では parentName は null)
  const withParent = await hasColumn(c, 'locations', 'parent_id');
  const locationSql =
    `SELECT loc.id, loc.code, loc.name, loc.warehouse_id AS warehouseId, w.name AS warehouseName,` +
    (withParent ? ' parent.name AS parentName,' : ' NULL AS parentName,') +
    ` (SELECT COUNT(*) FROM stocks s WHERE s.location_id = loc.id AND s.store_id = ?) AS stockCount
       FROM locations loc
       JOIN warehouses w ON w.id = loc.warehouse_id` +
    (withParent ? ' LEFT JOIN locations parent ON parent.id = loc.parent_id' : '') +
    ` WHERE w.store_id = ? AND loc.deleted_at IS NULL
        AND (loc.name LIKE ? ESCAPE '\\' OR loc.code LIKE ? ESCAPE '\\')` +
    (reachableIn === null ? '' : ` AND loc.warehouse_id ${reachableIn}`) +
    ` ORDER BY loc.name ASC LIMIT ?`;
  const locationParams: (string | number)[] = [
    ctx.store.id,
    ctx.store.id,
    like,
    like,
    ...reachableParams,
    take,
  ];

  // 入出庫履歴: 商品名・SKU・理由から探し、新しい順
  const movementSql =
    `SELECT mv.id, mv.document_id AS documentId, mv.type,
            mv.quantity_change AS quantityChange, mv.quantity_before AS quantityBefore,
            mv.quantity_after AS quantityAfter, mv.actor_id AS actorId, mv.reason,
            mv.created_at AS createdAt, p.name AS productName, p.sku AS productSku,
            loc.name AS locationName, l.lot_code AS lotCode
       FROM stock_movements mv
       JOIN stocks s ON s.id = mv.stock_id
       JOIN locations loc ON loc.id = s.location_id
       JOIN lots l ON l.id = s.lot_id
       JOIN products p ON p.id = l.product_id
      WHERE mv.store_id = ?
        AND (p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\' OR mv.reason LIKE ? ESCAPE '\\')` +
    (reachableIn === null ? '' : ` AND loc.warehouse_id ${reachableIn}`) +
    ` ORDER BY mv.id DESC LIMIT ?`;
  const movementParams: (string | number)[] = [ctx.store.id, like, like, like, ...reachableParams, take];

  const [products, locations, movements] = await Promise.all([
    c.env.DB.prepare(productSql).bind(...productParams).all(),
    c.env.DB.prepare(locationSql).bind(...locationParams).all(),
    c.env.DB.prepare(movementSql).bind(...movementParams).all(),
  ]);
  // 全体管理者の操作は店舗側に actorId を出さない (履歴一覧と同じ扱い)
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json({
    query: q,
    products: products.results,
    locations: locations.results,
    movements: movements.results.map((r) =>
      anonymizeUserFields(r as Record<string, unknown>, hidden, ['actorId']),
    ),
  });
});

// ------------------------------------------------------------ 在庫内訳・ロット追跡
/**
 * 商品の在庫内訳 (stocks.read)。場所・ロットごとの実在庫に、引当と
 * フリー在庫 (実在庫 - 引当) を添えて返す。発注残 (発注済み・未入荷) も付ける。
 */
app.get('/api/v1/products/:id/availability', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  const productId = Number(c.req.param('id'));
  const product = await c.env.DB.prepare(
    `SELECT id, sku, name, unit, barcode, safety_stock AS safetyStock
       FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL`,
  )
    .bind(productId, ctx.store.id)
    .first<{ id: number; sku: string; name: string; unit: string; barcode: string | null; safetyStock: number }>();
  if (!product) throw notFound('Product not found');
  const reachable = reachableWarehouseIds(ctx.assignments);
  let stocks: {
    stockId: number; locationId: number; locationName: string; locationCode: string;
    warehouseId: number; warehouseName: string; lotId: number; lotCode: string;
    expiryDate: number | null; quantity: number;
  }[] = [];
  if (reachable === null || reachable.length > 0) {
    const sql =
      `SELECT s.id AS stockId, s.location_id AS locationId, loc.name AS locationName,
              loc.code AS locationCode, loc.warehouse_id AS warehouseId, w.name AS warehouseName,
              s.lot_id AS lotId, l.lot_code AS lotCode, l.expiry_date AS expiryDate, s.quantity
         FROM stocks s
         JOIN locations loc ON loc.id = s.location_id
         JOIN warehouses w ON w.id = loc.warehouse_id
         JOIN lots l ON l.id = s.lot_id
        WHERE s.store_id = ? AND l.product_id = ?` +
      (reachable === null ? '' : ` AND loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`) +
      ' ORDER BY s.id ASC';
    const params: (number | string)[] = [ctx.store.id, productId, ...(reachable ?? [])];
    stocks = (await c.env.DB.prepare(sql).bind(...params).all()).results as typeof stocks;
  }
  // フリー在庫: 引当テーブルがある環境でのみ計算する (無い場合は全量フリー)
  let freeByStock: Map<number, number> | null = null;
  if (stocks.length > 0 && (await hasTable(c, 'reservations'))) {
    const reservations = await activeReservationRows(c.env.DB, ctx.store.id, Date.now());
    const relevant = reservations.filter((r) => r.product_id === productId);
    if (relevant.length > 0) {
      freeByStock = computeFreeQuantities(
        stocks.map((s) => ({ stockId: s.stockId, productId, locationId: s.locationId, quantity: s.quantity })),
        relevant.map((r) => ({ productId: r.product_id, locationId: r.location_id, quantity: r.quantity })),
      );
    }
  }
  let onOrderQuantity = 0;
  if (await hasTable(c, 'purchase_order_lines')) {
    const row = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(pol.quantity - pol.received_quantity), 0) AS qty
         FROM purchase_order_lines pol
         JOIN purchase_orders po ON po.id = pol.po_id
        WHERE po.store_id = ?1 AND po.status = 'ordered' AND pol.product_id = ?2`,
    )
      .bind(ctx.store.id, productId)
      .first<{ qty: number }>();
    onOrderQuantity = row?.qty ?? 0;
  }
  const stockJson = stocks.map((s) => {
    const free = freeByStock ? (freeByStock.get(s.stockId) ?? s.quantity) : s.quantity;
    return { ...s, freeQuantity: free, reservedQuantity: s.quantity - free };
  });
  return c.json({
    product,
    totals: {
      quantity: stockJson.reduce((a, s) => a + s.quantity, 0),
      reserved: stockJson.reduce((a, s) => a + s.reservedQuantity, 0),
      free: stockJson.reduce((a, s) => a + s.freeQuantity, 0),
    },
    onOrderQuantity,
    stocks: stockJson,
  });
});

/**
 * ロットの追跡 (stocks.read)。そのロットの現在庫 (場所ごと) と、
 * 入庫から消費までの履歴・累計を返す。他店舗のロットは 404。
 */
app.get('/api/v1/lots/:id/history', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  const lotId = Number(c.req.param('id'));
  const lot = await c.env.DB.prepare(
    `SELECT l.id, l.lot_code AS lotCode, l.expiry_date AS expiryDate, l.received_at AS receivedAt,
            l.product_id AS productId, p.sku AS productSku, p.name AS productName, p.unit AS productUnit
       FROM lots l JOIN products p ON p.id = l.product_id
      WHERE l.id = ?1 AND l.store_id = ?2`,
  )
    .bind(lotId, ctx.store.id)
    .first<{
      id: number; lotCode: string; expiryDate: number | null; receivedAt: number | null;
      productId: number; productSku: string; productName: string; productUnit: string;
    }>();
  if (!lot) throw notFound('Lot not found');
  const takeRaw = Number(c.req.query('take') ?? 50);
  const take = Number.isFinite(takeRaw) ? Math.min(Math.max(Math.trunc(takeRaw), 1), 200) : 50;
  const reachable = reachableWarehouseIds(ctx.assignments);
  const reachableClause =
    reachable === null ? '' : reachable.length === 0 ? ' AND 1 = 0' : ` AND loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`;
  const reachableParams: number[] = reachable ?? [];
  const stocks = (
    await c.env.DB.prepare(
      `SELECT s.id AS stockId, s.location_id AS locationId, loc.name AS locationName,
              loc.warehouse_id AS warehouseId, s.quantity
         FROM stocks s JOIN locations loc ON loc.id = s.location_id
        WHERE s.lot_id = ? AND s.store_id = ?${reachableClause}
        ORDER BY s.id ASC`,
    )
      .bind(lotId, ctx.store.id, ...reachableParams)
      .all()
  ).results;
  const totalRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(s.quantity), 0) AS currentQuantity
       FROM stocks s WHERE s.lot_id = ?1 AND s.store_id = ?2`,
  )
    .bind(lotId, ctx.store.id)
    .first<{ currentQuantity: number }>();
  const sumRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN mv.quantity_change > 0 THEN mv.quantity_change ELSE 0 END), 0) AS totalIn,
            COALESCE(SUM(CASE WHEN mv.quantity_change < 0 THEN -mv.quantity_change ELSE 0 END), 0) AS totalOut
       FROM stock_movements mv JOIN stocks s ON s.id = mv.stock_id
      WHERE mv.store_id = ?1 AND s.lot_id = ?2`,
  )
    .bind(ctx.store.id, lotId)
    .first<{ totalIn: number; totalOut: number }>();
  const movements = (
    await c.env.DB.prepare(
      `SELECT mv.id, mv.document_id AS documentId, mv.type,
              mv.quantity_change AS quantityChange, mv.quantity_before AS quantityBefore,
              mv.quantity_after AS quantityAfter, mv.actor_id AS actorId, mv.reason,
              mv.created_at AS createdAt, s.location_id AS locationId, loc.name AS locationName
         FROM stock_movements mv
         JOIN stocks s ON s.id = mv.stock_id
         JOIN locations loc ON loc.id = s.location_id
        WHERE mv.store_id = ? AND s.lot_id = ?${reachableClause}
        ORDER BY mv.id DESC LIMIT ?`,
    )
      .bind(ctx.store.id, lotId, ...reachableParams, take)
      .all()
  ).results;
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json({
    lot,
    totals: {
      totalIn: sumRow?.totalIn ?? 0,
      totalOut: sumRow?.totalOut ?? 0,
      currentQuantity: totalRow?.currentQuantity ?? 0,
    },
    stocks,
    movements: movements.map((r) =>
      anonymizeUserFields(r as Record<string, unknown>, hidden, ['actorId']),
    ),
  });
});

app.get('/api/v1/stocks', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  const reachable = reachableWarehouseIds(ctx.assignments);
  const conditions: string[] = ['s.store_id = ?'];
  const params: (number | string)[] = [ctx.store.id];
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
  const freeMap = await freeQuantitiesForStocks(c, ctx.store.id, results);
  return c.json(results.map((r) => stockJson(r, freeMap ? (freeMap.get(r.id) ?? null) : null)));
});

app.get('/api/v1/stocks/:id', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const row = await c.env.DB.prepare(`${STOCK_VIEW_SQL} WHERE s.id = ?1 AND s.store_id = ?2`)
    .bind(id, ctx.store.id)
    .first<StockViewRow>();
  if (!row) throw notFound('Stock not found');
  if (!canAccessWarehouse(ctx.assignments, row.warehouse_id)) {
    // スコープ外は存在自体を漏らさない (Nest 版の方針)
    throw notFound('Stock not found');
  }
  const freeMap = await freeQuantitiesForStocks(c, ctx.store.id, [row]);
  return c.json(stockJson(row, freeMap ? (freeMap.get(row.id) ?? null) : null));
});

/** 在庫一覧の CSV エクスポート (stocks.read、倉庫スコープ適用) */
app.get('/api/v1/stocks.csv', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  await requireFeature(c, 'csv');
  const ctx = await storeContext(c);
  const reachable = reachableWarehouseIds(ctx.assignments);
  let sql = `SELECT p.sku, p.name AS product_name, w.name AS warehouse_name,
                    loc.name AS location_name, loc.code AS location_code,
                    l.lot_code, l.expiry_date, s.quantity
               FROM stocks s
               JOIN locations loc ON loc.id = s.location_id
               JOIN warehouses w ON w.id = loc.warehouse_id
               JOIN lots l ON l.id = s.lot_id
               JOIN products p ON p.id = l.product_id
              WHERE s.store_id = ?`;
  const params: number[] = [ctx.store.id];
  if (reachable !== null) {
    if (reachable.length === 0) {
      return csvDownload(c, []);
    }
    sql += ` AND loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`;
    params.push(...reachable);
  }
  sql += ' ORDER BY s.id ASC LIMIT 5000';
  const { results } = await c.env.DB.prepare(sql)
    .bind(...params)
    .all<{
      sku: string;
      product_name: string;
      warehouse_name: string;
      location_name: string;
      location_code: string;
      lot_code: string;
      expiry_date: number | null;
      quantity: number;
    }>();
  return csvDownload(
    c,
    results.map((r) => [
      r.sku,
      r.product_name,
      r.warehouse_name,
      `${r.location_name} (${r.location_code})`,
      r.lot_code,
      formatDateOnly(r.expiry_date) ?? '',
      r.quantity,
    ]),
  );
});

function csvDownload(c: AppContext, rows: readonly (readonly unknown[])[]): Response {
  const header = ['商品コード', '商品名', '倉庫', '保管場所', 'ロット', '期限', '数量'];
  // Excel での文字化けを避けるため UTF-8 BOM を付ける
  return c.body('\uFEFF' + toCsv(header, rows), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="stocks.csv"',
  });
}

// ---------------------------------------------------------------- 入出庫

app.post('/api/v1/movements/inbound', async (c) => {
  const rp = await requirePermission(c, Permission.MOVEMENTS_INBOUND);
  const ctx = await storeContext(c);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(inboundSchema, raw);
  const warehouseId = await warehouseIdOfLocation(c, dto.locationId);
  if (!canPerformInStore(ctx, rp, warehouseId, Permission.MOVEMENTS_INBOUND)) {
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
    storeId: ctx.store.id,
    locationId: dto.locationId,
    productId: dto.productId,
    lotCode: dto.lotCode,
    expiryDateMs,
    quantity: dto.quantity,
  });
  return respond(c, envelope);
});

app.post('/api/v1/movements/consumption', async (c) => {
  const rp = await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const ctx = await storeContext(c);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(consumptionSchema, raw);
  if (dto.locationId !== undefined) {
    const warehouseId = await warehouseIdOfLocation(c, dto.locationId);
    if (!canPerformInStore(ctx, rp, warehouseId, Permission.MOVEMENTS_CONSUME)) {
      throw forbidden('Out of warehouse scope');
    }
  }
  const envelope = await coordinator(c).consume({
    actorId: user(c).userId,
    endpoint: 'POST /api/v1/movements/consumption',
    idempotencyKey: requireIdempotencyKey(c),
    requestHash: await sha256Hex(JSON.stringify(raw)),
    storeId: ctx.store.id,
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

/**
 * 一括入出庫 (最大 50 行)。全行を先に検証し、1 行でも規則違反・在庫不足が
 * あれば全体を止める。通過した行は 1 つの伝票 (documentId) で順に適用する。
 * セット品とマイナス在庫 (承認フロー) は一括の対象外。
 */
app.post('/api/v1/movements/bulk', async (c) => {
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(bulkMovementsSchema, raw);
  const ctx = await storeContext(c);
  const hasIn = dto.lines.some((l) => l.type === 'IN');
  const hasOut = dto.lines.some((l) => l.type === 'OUT');
  // メンテナンス (features レベル): 一括は inbound / outbound 両グループに触れる
  const maintenance = c.get('maintenance');
  if (
    maintenance?.active &&
    maintenance.active.level === 'features' &&
    !isPlatformAdmin(user(c).assignments)
  ) {
    const active = maintenance.active;
    const stopped = (key: string): boolean => {
      const stage = active.features[key];
      return stage === 'full' || stage === 'write';
    };
    if ((hasIn && stopped('inbound')) || (hasOut && stopped('outbound'))) {
      return c.json(
        {
          statusCode: 503,
          error: 'MAINTENANCE',
          message: resolvedMaintenanceMessage(active),
          level: active.level,
          endsAt: active.endsAt,
          features: active.features,
        },
        503,
      );
    }
  }
  const rpIn = hasIn ? await requirePermission(c, Permission.MOVEMENTS_INBOUND) : null;
  const rpOut = hasOut ? await requirePermission(c, Permission.MOVEMENTS_CONSUME) : null;
  const lines: BulkLineInput[] = [];
  for (const line of dto.lines) {
    if (line.type === 'IN') {
      const warehouseId = await warehouseIdOfLocation(c, line.locationId);
      if (!canPerformInStore(ctx, rpIn!, warehouseId, Permission.MOVEMENTS_INBOUND)) {
        throw forbidden('Out of warehouse scope');
      }
      let expiryDateMs: number | null = null;
      if (line.expiryDate !== undefined) {
        expiryDateMs = parseDateOnly(line.expiryDate);
        if (expiryDateMs === null) throw badRequest('expiryDate must be a valid YYYY-MM-DD date');
      }
      lines.push({
        type: 'IN',
        locationId: line.locationId,
        productId: line.productId,
        lotCode: line.lotCode,
        expiryDateMs,
        quantity: line.quantity,
        ...(line.reason !== undefined ? { reason: line.reason } : {}),
      });
    } else {
      if (line.locationId !== undefined) {
        const warehouseId = await warehouseIdOfLocation(c, line.locationId);
        if (!canPerformInStore(ctx, rpOut!, warehouseId, Permission.MOVEMENTS_CONSUME)) {
          throw forbidden('Out of warehouse scope');
        }
      }
      lines.push({
        type: 'OUT',
        productId: line.productId,
        ...(line.locationId !== undefined ? { locationId: line.locationId } : {}),
        quantity: line.quantity,
        department: line.department,
        purpose: line.purpose,
      });
    }
  }
  const envelope = await coordinator(c).bulkMovements({
    actorId: user(c).userId,
    endpoint: 'POST /api/v1/movements/bulk',
    idempotencyKey: requireIdempotencyKey(c),
    requestHash: await sha256Hex(JSON.stringify(raw)),
    storeId: ctx.store.id,
    lines,
    allowedLocationIds: await allowedLocationIds(c),
  });
  return respond(c, envelope);
});

app.post('/api/v1/movements/transfer', async (c) => {
  const rp = await requirePermission(c, Permission.MOVEMENTS_TRANSFER);
  await requireFeature(c, 'transfers');
  const ctx = await storeContext(c);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(transferSchema, raw);
  // 移動元・移動先の両方の倉庫に到達できることが必要
  const fromWarehouseId = await warehouseIdOfLocation(c, dto.fromLocationId);
  const toWarehouseId = await warehouseIdOfLocation(c, dto.toLocationId);
  if (
    !canPerformInStore(ctx, rp, fromWarehouseId, Permission.MOVEMENTS_TRANSFER) ||
    !canPerformInStore(ctx, rp, toWarehouseId, Permission.MOVEMENTS_TRANSFER)
  ) {
    throw forbidden('Out of warehouse scope');
  }
  const envelope = await coordinator(c).transfer({
    actorId: user(c).userId,
    endpoint: 'POST /api/v1/movements/transfer',
    idempotencyKey: requireIdempotencyKey(c),
    requestHash: await sha256Hex(JSON.stringify(raw)),
    storeId: ctx.store.id,
    fromLocationId: dto.fromLocationId,
    toLocationId: dto.toLocationId,
    productId: dto.productId,
    ...(dto.lotId !== undefined ? { lotId: dto.lotId } : {}),
    quantity: dto.quantity,
  });
  return respond(c, envelope);
});

// ------------------------------------------------------- 返品・廃棄・セット品消費 (0015)

/** 返品 (社内から戻り = 在庫+)。理由コードとメモが必須。台帳は type='RETURN' */
app.post('/api/v1/movements/return', async (c) => {
  await requireModule(c, 'returns_disposals');
  const rp = await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const ctx = await storeContext(c);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(returnMovementSchema, raw);
  await assertReasonCodeUsable(c.env.DB, ctx.store.id, 'return', dto.reasonCode);
  const warehouseId = await warehouseIdOfLocation(c, dto.locationId);
  if (!canPerformInStore(ctx, rp, warehouseId, Permission.MOVEMENTS_CONSUME)) {
    throw forbidden('Out of warehouse scope');
  }
  let expiryDateMs: number | null = null;
  if (dto.expiryDate !== undefined) {
    expiryDateMs = parseDateOnly(dto.expiryDate);
    if (expiryDateMs === null) throw badRequest('expiryDate must be a valid YYYY-MM-DD date');
  }
  const envelope = await coordinator(c).inbound({
    actorId: user(c).userId,
    endpoint: 'POST /api/v1/movements/return',
    idempotencyKey: requireIdempotencyKey(c),
    requestHash: await sha256Hex(JSON.stringify(raw)),
    storeId: ctx.store.id,
    locationId: dto.locationId,
    productId: dto.productId,
    lotCode: dto.lotCode,
    expiryDateMs,
    quantity: dto.quantity,
    kind: 'RETURN',
    reasonCode: dto.reasonCode,
    reason: dto.reason,
  });
  return respond(c, envelope);
});

/** 廃棄 (在庫-)。通常の消費と同じ在庫検証で、マイナス在庫フローには乗せない */
app.post('/api/v1/movements/disposal', async (c) => {
  await requireModule(c, 'returns_disposals');
  const rp = await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const ctx = await storeContext(c);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(disposalSchema, raw);
  await assertReasonCodeUsable(c.env.DB, ctx.store.id, 'disposal', dto.reasonCode);
  if (dto.locationId !== undefined) {
    const warehouseId = await warehouseIdOfLocation(c, dto.locationId);
    if (!canPerformInStore(ctx, rp, warehouseId, Permission.MOVEMENTS_CONSUME)) {
      throw forbidden('Out of warehouse scope');
    }
  }
  const envelope = await coordinator(c).consume({
    actorId: user(c).userId,
    endpoint: 'POST /api/v1/movements/disposal',
    idempotencyKey: requireIdempotencyKey(c),
    requestHash: await sha256Hex(JSON.stringify(raw)),
    storeId: ctx.store.id,
    productId: dto.productId,
    ...(dto.locationId !== undefined ? { locationId: dto.locationId } : {}),
    quantity: dto.quantity,
    department: '廃棄',
    purpose: dto.reason,
    movementType: 'DISPOSAL',
    reasonCode: dto.reasonCode,
    reason: dto.reason,
    auditAction: 'stock.disposal',
    allowedLocationIds: await allowedLocationIds(c),
  });
  return respond(c, envelope);
});

/** セット品の消費 (構成品へ FEFO 展開し、同一 group_id で記録する) */
app.post('/api/v1/movements/bundle-consumption', async (c) => {
  await requireModule(c, 'bundles');
  const rp = await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const ctx = await storeContext(c);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(bundleConsumptionSchema, raw);
  if (dto.locationId !== undefined) {
    const warehouseId = await warehouseIdOfLocation(c, dto.locationId);
    if (!canPerformInStore(ctx, rp, warehouseId, Permission.MOVEMENTS_CONSUME)) {
      throw forbidden('Out of warehouse scope');
    }
  }
  if (!(await hasTable(c, 'product_bundles'))) {
    throw new ApiError(422, 'NOT_A_BUNDLE', 'Product is not a bundle');
  }
  const components = await bundleComponentRows(c.env.DB, dto.productId);
  const envelope = await coordinator(c).consumeBundle({
    actorId: user(c).userId,
    endpoint: 'POST /api/v1/movements/bundle-consumption',
    idempotencyKey: requireIdempotencyKey(c),
    requestHash: await sha256Hex(JSON.stringify(raw)),
    storeId: ctx.store.id,
    bundleProductId: dto.productId,
    ...(dto.locationId !== undefined ? { locationId: dto.locationId } : {}),
    quantity: dto.quantity,
    department: dto.department,
    purpose: dto.purpose,
    allowedLocationIds: await allowedLocationIds(c),
    components: components.map((comp) => ({
      productId: comp.component_product_id,
      quantity: comp.quantity,
    })),
  });
  return respond(c, envelope);
});

/** セット品の一覧 (組立可能数つき)。在庫表示と消費画面で使う */
app.get('/api/v1/bundles', async (c) => {
  await requireModule(c, 'bundles');
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'product_bundles')) || !(await hasColumn(c, 'products', 'is_bundle'))) {
    return c.json([]);
  }
  const { results } = await c.env.DB.prepare(
    'SELECT id, sku, name, unit FROM products WHERE store_id = ?1 AND deleted_at IS NULL AND is_bundle = 1 ORDER BY id ASC',
  )
    .bind(ctx.store.id)
    .all<{ id: number; sku: string; name: string; unit: string }>();
  const out: Record<string, unknown>[] = [];
  for (const p of results) {
    const avail = await bundleAvailability(c.env.DB, ctx.store.id, p.id);
    out.push({
      productId: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      assemblable: avail.assemblable,
      unitCost: avail.unitCost,
      components: avail.components,
    });
  }
  return c.json(out);
});

/** セット品 1 件の構成品と組立可能数 (商品詳細) */
app.get('/api/v1/products/:id/bundle', async (c) => {
  await requireModule(c, 'bundles');
  await requirePermission(c, Permission.MASTER_READ);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const product = await c.env.DB.prepare(
    'SELECT id, sku, name, unit FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
  )
    .bind(id, ctx.store.id)
    .first<{ id: number; sku: string; name: string; unit: string }>();
  if (!product) throw notFound('Product not found');
  if (!(await hasTable(c, 'product_bundles'))) {
    return c.json({ productId: id, sku: product.sku, name: product.name, unit: product.unit, assemblable: 0, unitCost: 0, components: [] });
  }
  const avail = await bundleAvailability(c.env.DB, ctx.store.id, id);
  return c.json({
    productId: id,
    sku: product.sku,
    name: product.name,
    unit: product.unit,
    assemblable: avail.assemblable,
    unitCost: avail.unitCost,
    components: avail.components,
  });
});

/**
 * セット品の構成品を置き換える (master.write)。
 * セットの中にセットは入れない (循環防止を単純化)。自分自身も不可。
 * 構成が 1 件以上あれば is_bundle を自動で有効にする。
 */
app.put('/api/v1/products/:id/bundle', async (c) => {
  await requireModule(c, 'bundles');
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  if (!(await hasTable(c, 'product_bundles'))) {
    throw new ApiError(503, 'BUNDLES_NOT_CONFIGURED', 'Bundles are not configured (migration 0015)');
  }
  const dto = parseWith(bundleComponentsSchema, await parseJson(c));
  const product = await c.env.DB.prepare(
    'SELECT id FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
  )
    .bind(id, ctx.store.id)
    .first<{ id: number }>();
  if (!product) throw notFound('Product not found');
  const seen = new Set<number>();
  for (const comp of dto.components) {
    if (comp.productId === id) {
      throw new ApiError(422, 'BUNDLE_SELF_REFERENCE', 'A bundle cannot contain itself');
    }
    if (seen.has(comp.productId)) {
      throw badRequest(`Duplicate component product: ${comp.productId}`);
    }
    seen.add(comp.productId);
    const target = await c.env.DB.prepare(
      'SELECT id, is_bundle FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
    )
      .bind(comp.productId, ctx.store.id)
      .first<{ id: number; is_bundle: number }>();
    if (!target) throw notFound(`Component product not found: ${comp.productId}`);
    if (target.is_bundle === 1) {
      throw new ApiError(422, 'BUNDLE_NESTING_FORBIDDEN', 'Bundles cannot contain other bundles');
    }
  }
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare('DELETE FROM product_bundles WHERE bundle_product_id = ?1').bind(id),
  ];
  for (const comp of dto.components) {
    stmts.push(
      c.env.DB
        .prepare('INSERT INTO product_bundles (bundle_product_id, component_product_id, quantity) VALUES (?1, ?2, ?3)')
        .bind(id, comp.productId, comp.quantity),
    );
  }
  if (dto.components.length > 0 && (await hasColumn(c, 'products', 'is_bundle'))) {
    stmts.push(
      c.env.DB.prepare('UPDATE products SET is_bundle = 1, updated_at = ?1 WHERE id = ?2').bind(now, id),
    );
  }
  stmts.push(
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'product.bundle.update',
      targetType: 'product',
      targetId: String(id),
      payload: { components: dto.components },
      storeId: ctx.store.id,
      createdAt: now,
    }),
  );
  await c.env.DB.batch(stmts);
  const avail = await bundleAvailability(c.env.DB, ctx.store.id, id);
  return c.json({ productId: id, assemblable: avail.assemblable, unitCost: avail.unitCost, components: avail.components });
});

/**
 * 商品の一括編集 (master.write)。安全在庫・単価・入数・リードタイム・
 * 有効/無効 (論理削除) を複数商品へ一括 PUT する。監査は 1 件に集約。
 */
app.put('/api/v1/admin/products/bulk', async (c) => {
  await requireModule(c, 'bulk_edit');
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const dto = parseWith(bulkProductsSchema, await parseJson(c));
  const now = Date.now();
  const patch = dto.patch;
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.safetyStock !== undefined) { sets.push('safety_stock = ?'); params.push(patch.safetyStock); }
  if (patch.unitCost !== undefined && (await hasColumn(c, 'products', 'unit_cost'))) { sets.push('unit_cost = ?'); params.push(patch.unitCost); }
  if (patch.caseSize !== undefined && (await hasColumn(c, 'products', 'case_size'))) { sets.push('case_size = ?'); params.push(patch.caseSize); }
  if (patch.leadTimeDays !== undefined && (await hasColumn(c, 'products', 'lead_time_days'))) { sets.push('lead_time_days = ?'); params.push(patch.leadTimeDays); }
  if (patch.active !== undefined) {
    sets.push(patch.active ? 'deleted_at = NULL' : 'deleted_at = ?');
    if (!patch.active) params.push(now);
  }
  if (sets.length === 0) throw badRequest('patch has no applicable fields');
  const ids = [...new Set(dto.ids)];
  const placeholders = ids.map(() => '?').join(',');
  // 有効/無効の切替は論理削除状態によらず対象にする。それ以外の項目変更は
  // 削除済み商品には適用しない (通常の一覧に出ないため)
  const deletedCond = patch.active !== undefined ? '' : ' AND deleted_at IS NULL';
  const res = await c.env.DB.prepare(
    `UPDATE products SET ${sets.join(', ')}, updated_at = ? WHERE store_id = ? AND id IN (${placeholders})${deletedCond}`,
  )
    .bind(...params, now, ctx.store.id, ...ids)
    .run();
  await insertAudit(c.env.DB, {
    actorId: user(c).userId,
    action: 'product.bulk_update',
    targetType: 'product',
    targetId: ids.join(','),
    payload: { ids, patch, updated: res.meta.changes },
    storeId: ctx.store.id,
    createdAt: now,
  });
  return c.json({ updated: res.meta.changes, ids });
});

// ------------------------------------------------------- 在庫の引当 (0015)

async function loadReservationInStore(
  c: AppContext,
  id: number,
  storeId: number,
): Promise<ReservationDbRow> {
  const row = await c.env.DB.prepare('SELECT * FROM reservations WHERE id = ?1 AND store_id = ?2')
    .bind(id, storeId)
    .first<ReservationDbRow>();
  if (!row) throw notFound('Reservation not found');
  return row;
}

/** 引当の作成 (movements.consume)。フリー在庫を超える引当は 422 */
app.post('/api/v1/reservations', async (c) => {
  await requireModule(c, 'reservations');
  const rp = await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'reservations'))) {
    throw new ApiError(503, 'RESERVATIONS_NOT_CONFIGURED', 'Reservations are not configured (migration 0015)');
  }
  const dto = parseWith(createReservationSchema, await parseJson(c));
  const withBundle = await hasColumn(c, 'products', 'is_bundle');
  const productRow = await c.env.DB.prepare(
    `SELECT id${withBundle ? ', is_bundle' : ''} FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL`,
  )
    .bind(dto.productId, ctx.store.id)
    .first<{ id: number; is_bundle?: number }>();
  if (!productRow) throw notFound('Product not found');
  if (productRow.is_bundle === 1) {
    throw new ApiError(422, 'BUNDLE_NO_STOCK', 'Bundle products do not hold stock and cannot be reserved');
  }
  let locationId: number | null = null;
  if (dto.locationId !== undefined && dto.locationId !== null) {
    locationId = dto.locationId;
    const warehouseId = await warehouseIdOfLocation(c, locationId);
    if (!canPerformInStore(ctx, rp, warehouseId, Permission.MOVEMENTS_CONSUME)) {
      throw forbidden('Out of warehouse scope');
    }
  }
  // フリー在庫の判定: 場所指定があればその場所、無ければ店舗全体
  const now = Date.now();
  const stocks = await storeStockRows(c.env.DB, ctx.store.id, [dto.productId]);
  const reservations = await activeReservationRows(c.env.DB, ctx.store.id, now);
  const free = computeFreeQuantities(
    stocks,
    reservations
      .filter((r) => r.product_id === dto.productId)
      .map((r) => ({ productId: r.product_id, locationId: r.location_id, quantity: r.quantity })),
  );
  let available = 0;
  for (const s of stocks) {
    if (locationId !== null && s.locationId !== locationId) continue;
    available += free.get(s.stockId) ?? 0;
  }
  if (dto.quantity > available) {
    throw new ApiError(
      422,
      'RESERVATION_EXCEEDS_FREE_STOCK',
      `Requested ${dto.quantity} exceeds free stock ${available}`,
    );
  }
  const res = await c.env.DB.prepare(
    `INSERT INTO reservations (store_id, product_id, location_id, quantity, reason, status, expires_at, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?8)`,
  )
    .bind(ctx.store.id, dto.productId, locationId, dto.quantity, dto.reason, dto.expiresAt ?? null, user(c).userId, now)
    .run();
  const created = await loadReservationInStore(c, Number(res.meta.last_row_id), ctx.store.id);
  return c.json(reservationJson(created), 201);
});

/** 有効な引当の一覧 (期限切れは自動で除外する) */
app.get('/api/v1/reservations', async (c) => {
  await requireModule(c, 'reservations');
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'reservations'))) return c.json([]);
  const rows = await activeReservationRows(c.env.DB, ctx.store.id, Date.now());
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(rows.map((r) => anonymizeUserFields(reservationJson(r), hidden, ['createdBy'])));
});

/** 引当の解放 */
app.post('/api/v1/reservations/:id/release', async (c) => {
  await requireModule(c, 'reservations');
  await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'reservations'))) throw notFound('Reservation not found');
  const id = Number(c.req.param('id'));
  const row = await loadReservationInStore(c, id, ctx.store.id);
  if (row.status !== 'active') {
    throw new ApiError(409, 'RESERVATION_NOT_ACTIVE', `Reservation is ${row.status}`);
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare("UPDATE reservations SET status = 'released', updated_at = ?1 WHERE id = ?2")
      .bind(now, id),
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'reservation.release',
      targetType: 'reservation',
      targetId: String(id),
      payload: { productId: row.product_id, quantity: row.quantity },
      storeId: ctx.store.id,
      createdAt: now,
    }),
  ]);
  const updated = await loadReservationInStore(c, id, ctx.store.id);
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(anonymizeUserFields(reservationJson(updated), hidden, ['createdBy']));
});

/** 引当を消費に変換する: 実消費を Coordinator 経由で実行し、引当を consumed にする */
app.post('/api/v1/reservations/:id/consume', async (c) => {
  await requireModule(c, 'reservations');
  const rp = await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'reservations'))) throw notFound('Reservation not found');
  const id = Number(c.req.param('id'));
  const raw = (await parseJson(c).catch(() => ({}))) as Record<string, unknown>;
  const dto = parseWith(consumeReservationSchema, raw);
  const row = await loadReservationInStore(c, id, ctx.store.id);
  if (row.status !== 'active' || (row.expires_at !== null && row.expires_at <= Date.now())) {
    throw new ApiError(409, 'RESERVATION_NOT_ACTIVE', 'Reservation is not active');
  }
  const locationId = dto.locationId ?? row.location_id ?? undefined;
  if (locationId !== undefined) {
    const warehouseId = await warehouseIdOfLocation(c, locationId);
    if (!canPerformInStore(ctx, rp, warehouseId, Permission.MOVEMENTS_CONSUME)) {
      throw forbidden('Out of warehouse scope');
    }
  }
  const envelope = await coordinator(c).consume({
    actorId: user(c).userId,
    endpoint: 'POST /api/v1/reservations/:id/consume',
    idempotencyKey: requireIdempotencyKey(c),
    requestHash: await sha256Hex(JSON.stringify({ reservationId: id, ...raw })),
    storeId: ctx.store.id,
    productId: row.product_id,
    ...(locationId !== undefined ? { locationId } : {}),
    quantity: row.quantity,
    department: '引当消費',
    purpose: row.reason,
    auditAction: 'stock.consume_reservation',
    allowedLocationIds: await allowedLocationIds(c),
  });
  if (envelope.status !== 201) return respond(c, envelope);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare("UPDATE reservations SET status = 'consumed', updated_at = ?1 WHERE id = ?2 AND status = 'active'")
      .bind(now, id),
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'reservation.consume',
      targetType: 'reservation',
      targetId: String(id),
      payload: {
        productId: row.product_id,
        quantity: row.quantity,
        documentId: (envelope.body as { documentId?: string }).documentId ?? null,
      },
      storeId: ctx.store.id,
      createdAt: now,
    }),
  ]);
  const updated = await loadReservationInStore(c, id, ctx.store.id);
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(
    {
      reservation: anonymizeUserFields(reservationJson(updated), hidden, ['createdBy']),
      movement: envelope.body,
    },
    201,
  );
});

// ------------------------------------------------------- ピッキングリスト (0015)

interface PickListDbRow {
  id: number;
  store_id: number;
  type: string;
  to_location_id: number | null;
  status: string;
  created_by: number;
  created_at: number;
  completed_at: number | null;
}

interface PickItemDbRow {
  id: number;
  list_id: number;
  product_id: number;
  from_location_id: number;
  planned_qty: number;
  picked_qty: number;
}

function pickItemJson(r: PickItemDbRow): Record<string, unknown> {
  return {
    id: r.id,
    listId: r.list_id,
    productId: r.product_id,
    fromLocationId: r.from_location_id,
    plannedQty: r.planned_qty,
    pickedQty: r.picked_qty,
  };
}

async function loadPickList(c: AppContext, id: number, storeId: number): Promise<Record<string, unknown>> {
  const list = await c.env.DB.prepare('SELECT * FROM pick_lists WHERE id = ?1 AND store_id = ?2')
    .bind(id, storeId)
    .first<PickListDbRow>();
  if (!list) throw notFound('Pick list not found');
  const { results: items } = await c.env.DB.prepare(
    'SELECT * FROM pick_items WHERE list_id = ?1 ORDER BY id ASC',
  )
    .bind(id)
    .all<PickItemDbRow>();
  return {
    id: list.id,
    type: list.type,
    toLocationId: list.to_location_id,
    status: list.status,
    createdBy: list.created_by,
    createdAt: list.created_at,
    completedAt: list.completed_at,
    items: items.map(pickItemJson),
  };
}

function requirePickTables(c: AppContext): Promise<boolean> {
  return hasTable(c, 'pick_lists');
}

/** ピッキングリストの作成 (予定) */
app.post('/api/v1/pick-lists', async (c) => {
  await requireModule(c, 'picking');
  await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const ctx = await storeContext(c);
  if (!(await requirePickTables(c))) {
    throw new ApiError(503, 'PICKING_NOT_CONFIGURED', 'Picking is not configured (migration 0015)');
  }
  const dto = parseWith(createPickListSchema, await parseJson(c));
  if (dto.type === 'transfer') {
    await requirePermission(c, Permission.MOVEMENTS_TRANSFER);
    if (dto.toLocationId === undefined || dto.toLocationId === null) {
      throw badRequest('toLocationId is required for transfer pick lists');
    }
  }
  for (const item of dto.items) {
    const product = await c.env.DB.prepare(
      'SELECT id FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
    )
      .bind(item.productId, ctx.store.id)
      .first<{ id: number }>();
    if (!product) throw notFound(`Product not found: ${item.productId}`);
    await warehouseIdOfLocation(c, item.fromLocationId);
    if (dto.type === 'transfer' && item.fromLocationId === dto.toLocationId) {
      throw badRequest('fromLocationId and toLocationId must differ');
    }
  }
  if (dto.type === 'transfer') await warehouseIdOfLocation(c, dto.toLocationId as number);
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `INSERT INTO pick_lists (store_id, type, to_location_id, status, created_by, created_at)
     VALUES (?1, ?2, ?3, 'open', ?4, ?5)`,
  )
    .bind(ctx.store.id, dto.type, dto.type === 'transfer' ? dto.toLocationId : null, user(c).userId, now)
    .run();
  const listId = Number(res.meta.last_row_id);
  await c.env.DB.batch(
    dto.items.map((item) =>
      c.env.DB
        .prepare('INSERT INTO pick_items (list_id, product_id, from_location_id, planned_qty, picked_qty) VALUES (?1, ?2, ?3, ?4, 0)')
        .bind(listId, item.productId, item.fromLocationId, item.plannedQty),
    ),
  );
  return c.json(await loadPickList(c, listId, ctx.store.id), 201);
});

/** ピッキングリストの一覧と詳細 */
app.get('/api/v1/pick-lists', async (c) => {
  await requireModule(c, 'picking');
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  if (!(await requirePickTables(c))) return c.json([]);
  const { results } = await c.env.DB.prepare(
    'SELECT id FROM pick_lists WHERE store_id = ?1 ORDER BY id DESC LIMIT 100',
  )
    .bind(ctx.store.id)
    .all<{ id: number }>();
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  const out: Record<string, unknown>[] = [];
  for (const r of results) {
    out.push(anonymizeUserFields(await loadPickList(c, r.id, ctx.store.id), hidden, ['createdBy']));
  }
  return c.json(out);
});

app.get('/api/v1/pick-lists/:id', async (c) => {
  await requireModule(c, 'picking');
  await requirePermission(c, Permission.STOCKS_READ);
  const ctx = await storeContext(c);
  if (!(await requirePickTables(c))) throw notFound('Pick list not found');
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(
    anonymizeUserFields(
      await loadPickList(c, Number(c.req.param('id')), ctx.store.id),
      hidden,
      ['createdBy'],
    ),
  );
});

/** 明細の数量修正 (検品の手入力・計画の調整)。open の間だけ変更できる */
app.put('/api/v1/pick-lists/:id/items/:itemId', async (c) => {
  await requireModule(c, 'picking');
  await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const ctx = await storeContext(c);
  if (!(await requirePickTables(c))) throw notFound('Pick list not found');
  const listId = Number(c.req.param('id'));
  const itemId = Number(c.req.param('itemId'));
  const dto = parseWith(updatePickItemSchema, await parseJson(c));
  const list = await c.env.DB.prepare('SELECT * FROM pick_lists WHERE id = ?1 AND store_id = ?2')
    .bind(listId, ctx.store.id)
    .first<PickListDbRow>();
  if (!list) throw notFound('Pick list not found');
  if (list.status !== 'open') throw new ApiError(409, 'PICK_LIST_NOT_OPEN', `Pick list is ${list.status}`);
  const item = await c.env.DB.prepare('SELECT * FROM pick_items WHERE id = ?1 AND list_id = ?2')
    .bind(itemId, listId)
    .first<PickItemDbRow>();
  if (!item) throw notFound('Pick item not found');
  const plannedQty = dto.plannedQty ?? item.planned_qty;
  const pickedQty = dto.pickedQty ?? item.picked_qty;
  if (pickedQty > plannedQty) {
    throw new ApiError(422, 'PICKED_EXCEEDS_PLANNED', 'pickedQty cannot exceed plannedQty');
  }
  await c.env.DB.prepare('UPDATE pick_items SET planned_qty = ?1, picked_qty = ?2 WHERE id = ?3')
    .bind(plannedQty, pickedQty, itemId)
    .run();
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(
    anonymizeUserFields(await loadPickList(c, listId, ctx.store.id), hidden, ['createdBy']),
  );
});

/** 確定: 検品済み数量を Coordinator 経由で一括・原子的に実行する */
app.post('/api/v1/pick-lists/:id/confirm', async (c) => {
  await requireModule(c, 'picking');
  const rp = await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const ctx = await storeContext(c);
  if (!(await requirePickTables(c))) throw notFound('Pick list not found');
  const listId = Number(c.req.param('id'));
  const list = await c.env.DB.prepare('SELECT * FROM pick_lists WHERE id = ?1 AND store_id = ?2')
    .bind(listId, ctx.store.id)
    .first<PickListDbRow>();
  if (!list) throw notFound('Pick list not found');
  if (list.status !== 'open') {
    // 冪等キーが同じ再送は Coordinator が保存済み応答を返すため、done でも通す
    const key = c.req.header('idempotency-key');
    if (!(list.status === 'done' && key)) {
      throw new ApiError(409, 'PICK_LIST_NOT_OPEN', `Pick list is ${list.status}`);
    }
  }
  if (list.type === 'transfer') {
    await requirePermission(c, Permission.MOVEMENTS_TRANSFER);
    if (list.to_location_id !== null) {
      const toWarehouseId = await warehouseIdOfLocation(c, list.to_location_id);
      if (!canPerformInStore(ctx, rp, toWarehouseId, Permission.MOVEMENTS_TRANSFER)) {
        throw forbidden('Out of warehouse scope');
      }
    }
  }
  const { results: items } = await c.env.DB.prepare(
    'SELECT * FROM pick_items WHERE list_id = ?1 ORDER BY id ASC',
  )
    .bind(listId)
    .all<PickItemDbRow>();
  const movable = items.filter((i) => i.picked_qty > 0);
  if (movable.length === 0) throw badRequest('No picked items to confirm');
  for (const item of movable) {
    const warehouseId = await warehouseIdOfLocation(c, item.from_location_id);
    const perm = list.type === 'transfer' ? Permission.MOVEMENTS_TRANSFER : Permission.MOVEMENTS_CONSUME;
    if (!canPerformInStore(ctx, rp, warehouseId, perm)) {
      throw forbidden('Out of warehouse scope');
    }
  }
  const raw = { pickListId: listId, items: movable.map((i) => ({ productId: i.product_id, fromLocationId: i.from_location_id, quantity: i.picked_qty })) };
  const envelope = await coordinator(c).confirmPick({
    actorId: user(c).userId,
    endpoint: 'POST /api/v1/pick-lists/:id/confirm',
    idempotencyKey: requireIdempotencyKey(c),
    requestHash: await sha256Hex(JSON.stringify(raw)),
    storeId: ctx.store.id,
    pickListId: listId,
    type: list.type as 'consume' | 'transfer',
    ...(list.to_location_id !== null ? { toLocationId: list.to_location_id } : {}),
    items: raw.items,
  });
  return respond(c, envelope);
});

/** ピッキングリストの取消 */
app.post('/api/v1/pick-lists/:id/cancel', async (c) => {
  await requireModule(c, 'picking');
  await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const ctx = await storeContext(c);
  if (!(await requirePickTables(c))) throw notFound('Pick list not found');
  const listId = Number(c.req.param('id'));
  const list = await c.env.DB.prepare('SELECT * FROM pick_lists WHERE id = ?1 AND store_id = ?2')
    .bind(listId, ctx.store.id)
    .first<PickListDbRow>();
  if (!list) throw notFound('Pick list not found');
  if (list.status !== 'open') {
    throw new ApiError(409, 'PICK_LIST_NOT_OPEN', `Pick list is ${list.status}`);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE pick_lists SET status = 'cancelled' WHERE id = ?1").bind(listId),
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'pick_list.cancel',
      targetType: 'pick_list',
      targetId: String(listId),
      payload: {},
      storeId: ctx.store.id,
      createdAt: Date.now(),
    }),
  ]);
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(
    anonymizeUserFields(await loadPickList(c, listId, ctx.store.id), hidden, ['createdBy']),
  );
});

// ------------------------------------------------------- 発注テンプレート・定期発注 (0015)

interface PoTemplateDbRow {
  id: number;
  store_id: number;
  name: string;
  supplier_id: number;
  lines: string;
  created_by: number;
  created_at: number;
}

interface PoScheduleDbRow {
  id: number;
  template_id: number;
  interval_days: number;
  next_run_at: number;
  enabled: number;
  last_run_at: number | null;
}

async function poTemplateJson(c: AppContext, row: PoTemplateDbRow): Promise<Record<string, unknown>> {
  let lines: unknown = [];
  try {
    lines = JSON.parse(row.lines) as unknown;
  } catch {
    lines = [];
  }
  let schedule: Record<string, unknown> | null = null;
  if (await hasTable(c, 'po_schedules')) {
    const s = await c.env.DB.prepare('SELECT * FROM po_schedules WHERE template_id = ?1')
      .bind(row.id)
      .first<PoScheduleDbRow>();
    if (s) {
      schedule = {
        id: s.id,
        intervalDays: s.interval_days,
        nextRunAt: s.next_run_at,
        enabled: s.enabled === 1,
        lastRunAt: s.last_run_at,
      };
    }
  }
  return {
    id: row.id,
    name: row.name,
    supplierId: row.supplier_id,
    lines,
    createdBy: row.created_by,
    createdAt: row.created_at,
    schedule,
  };
}

async function loadPoTemplate(c: AppContext, id: number, storeId: number): Promise<PoTemplateDbRow> {
  const row = await c.env.DB.prepare('SELECT * FROM po_templates WHERE id = ?1 AND store_id = ?2')
    .bind(id, storeId)
    .first<PoTemplateDbRow>();
  if (!row) throw notFound('Purchase order template not found');
  return row;
}

app.get('/api/v1/purchase-order-templates', async (c) => {
  await requireModule(c, 'po_templates');
  await requirePermission(c, Permission.PURCHASES_READ);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'po_templates'))) return c.json([]);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM po_templates WHERE store_id = ?1 ORDER BY id DESC LIMIT 100',
  )
    .bind(ctx.store.id)
    .all<PoTemplateDbRow>();
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  const out: Record<string, unknown>[] = [];
  for (const row of results) {
    out.push(anonymizeUserFields(await poTemplateJson(c, row), hidden, ['createdBy']));
  }
  return c.json(out);
});

app.post('/api/v1/purchase-order-templates', async (c) => {
  await requireModule(c, 'po_templates');
  await requirePermission(c, Permission.PURCHASES_WRITE);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'po_templates'))) {
    throw new ApiError(503, 'PO_TEMPLATES_NOT_CONFIGURED', 'PO templates are not configured (migration 0015)');
  }
  const dto = parseWith(createPoTemplateSchema, await parseJson(c));
  const supplier = await c.env.DB.prepare('SELECT id FROM suppliers WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL')
    .bind(dto.supplierId, ctx.store.id)
    .first<{ id: number }>();
  if (!supplier) throw notFound('Supplier not found');
  for (const line of dto.lines) {
    const product = await c.env.DB.prepare('SELECT id FROM products WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL')
      .bind(line.productId, ctx.store.id)
      .first<{ id: number }>();
    if (!product) throw notFound(`Product not found: ${line.productId}`);
  }
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `INSERT INTO po_templates (store_id, name, supplier_id, lines, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(ctx.store.id, dto.name, dto.supplierId, JSON.stringify(dto.lines), user(c).userId, now)
    .run();
  const row = await loadPoTemplate(c, Number(res.meta.last_row_id), ctx.store.id);
  return c.json(await poTemplateJson(c, row), 201);
});

app.delete('/api/v1/purchase-order-templates/:id', async (c) => {
  await requireModule(c, 'po_templates');
  await requirePermission(c, Permission.PURCHASES_WRITE);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'po_templates'))) throw notFound('Purchase order template not found');
  const id = Number(c.req.param('id'));
  await loadPoTemplate(c, id, ctx.store.id);
  const stmts: D1PreparedStatement[] = [];
  if (await hasTable(c, 'po_schedules')) {
    stmts.push(c.env.DB.prepare('DELETE FROM po_schedules WHERE template_id = ?1').bind(id));
  }
  stmts.push(c.env.DB.prepare('DELETE FROM po_templates WHERE id = ?1').bind(id));
  stmts.push(
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'po_template.delete',
      targetType: 'po_template',
      targetId: String(id),
      payload: {},
      storeId: ctx.store.id,
      createdAt: Date.now(),
    }),
  );
  await c.env.DB.batch(stmts);
  return c.json({ id, deleted: true });
});

/** テンプレートから下書き PO を生成する (source='template') */
app.post('/api/v1/purchase-order-templates/:id/generate', async (c) => {
  await requireModule(c, 'po_templates');
  await requirePermission(c, Permission.PURCHASES_WRITE);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'po_templates'))) throw notFound('Purchase order template not found');
  const id = Number(c.req.param('id'));
  const row = await loadPoTemplate(c, id, ctx.store.id);
  let lines: { productId: number; quantity?: number; inputQuantity?: number; inputUnit?: 'base' | 'case'; unitCost?: number }[] = [];
  try {
    lines = JSON.parse(row.lines) as typeof lines;
  } catch {
    throw badRequest('Template lines are corrupted');
  }
  const now = Date.now();
  const poId = await createDraftPurchaseOrder(c.env.DB, {
    storeId: ctx.store.id,
    supplierId: row.supplier_id,
    actorId: user(c).userId,
    source: 'template',
    lines,
    nowMs: now,
  });
  await insertAudit(c.env.DB, {
    actorId: user(c).userId,
    action: 'purchase_order.create_from_template',
    targetType: 'po_template',
    targetId: String(id),
    payload: { purchaseOrderId: poId },
    storeId: ctx.store.id,
    createdAt: now,
  });
  return c.json(await loadPurchaseOrder(c, poId, ctx.store.id), 201);
});

/** 定期発注スケジュールの設定 (テンプレートに 1 つ、間隔日数と有効/無効) */
app.put('/api/v1/purchase-order-templates/:id/schedule', async (c) => {
  await requireModule(c, 'po_templates');
  await requirePermission(c, Permission.PURCHASES_WRITE);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  if (!(await hasTable(c, 'po_schedules'))) {
    throw new ApiError(503, 'PO_TEMPLATES_NOT_CONFIGURED', 'PO schedules are not configured (migration 0015)');
  }
  const id = Number(c.req.param('id'));
  await loadPoTemplate(c, id, ctx.store.id);
  const dto = parseWith(poScheduleSchema, await parseJson(c));
  const now = Date.now();
  const existing = await c.env.DB.prepare('SELECT * FROM po_schedules WHERE template_id = ?1')
    .bind(id)
    .first<PoScheduleDbRow>();
  if (existing) {
    // 間隔を変えたら次回は「最終実行 (無ければ作成時) + 間隔」で組み直す
    const base = existing.last_run_at ?? now;
    await c.env.DB.prepare(
      'UPDATE po_schedules SET interval_days = ?1, enabled = ?2, next_run_at = ?3 WHERE template_id = ?4',
    )
      .bind(dto.intervalDays, dto.enabled ? 1 : 0, base + dto.intervalDays * 86_400_000, id)
      .run();
  } else {
    await c.env.DB.prepare(
      'INSERT INTO po_schedules (template_id, interval_days, next_run_at, enabled, last_run_at) VALUES (?1, ?2, ?3, ?4, NULL)',
    )
      .bind(id, dto.intervalDays, now + dto.intervalDays * 86_400_000, dto.enabled ? 1 : 0)
      .run();
  }
  const row = await loadPoTemplate(c, id, ctx.store.id);
  return c.json(await poTemplateJson(c, row));
});

// ------------------------------------------------------- マイナス在庫承認

app.post('/api/v1/negative-approvals', async (c) => {
  const rp = await requirePermission(c, Permission.NEGATIVE_REQUEST);
  await requireFeature(c, 'negative_stock');
  const ctx = await storeContext(c);
  const dto = parseWith(createApprovalSchema, await parseJson(c));
  const warehouseId = await warehouseIdOfStock(c, dto.stockId);
  if (!canPerformInStore(ctx, rp, warehouseId, Permission.NEGATIVE_REQUEST)) {
    throw forbidden('Out of warehouse scope');
  }
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `INSERT INTO negative_stock_approvals (stock_id, quantity, reason, status, requested_by, store_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?6)`,
  )
    .bind(dto.stockId, dto.quantity, dto.reason, user(c).userId, ctx.store.id, now)
    .run();
  return c.json(
    { id: Number(res.meta.last_row_id), stockId: dto.stockId, quantity: dto.quantity, reason: dto.reason, status: 'pending', requestedBy: user(c).userId },
    201,
  );
});

app.get('/api/v1/negative-approvals', async (c) => {
  const ctx = await storeContext(c);
  const reachable = reachableWarehouseIds(ctx.assignments);
  if (reachable !== null && reachable.length === 0) return c.json([]);
  let sql = `SELECT a.id, a.stock_id AS stockId, a.quantity, a.reason, a.status,
                    a.requested_by AS requestedBy, a.approved_by AS approvedBy,
                    a.decided_at AS decidedAt, a.movement_id AS movementId, a.created_at AS createdAt
               FROM negative_stock_approvals a
               JOIN stocks s ON s.id = a.stock_id
               JOIN locations loc ON loc.id = s.location_id
              WHERE a.store_id = ?`;
  const params: number[] = [ctx.store.id];
  if (reachable !== null) {
    sql += ` AND loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`;
    params.push(...reachable);
  }
  sql += ' ORDER BY a.id DESC LIMIT 100';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  // 申請者・承認者が全体管理者なら ID を伏せる
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(
    results.map((r) =>
      anonymizeUserFields(r as Record<string, unknown>, hidden, ['requestedBy', 'approvedBy']),
    ),
  );
});

app.post('/api/v1/negative-approvals/:id/decide', async (c) => {
  const rp = await requirePermission(c, Permission.NEGATIVE_DECIDE);
  await requireFeature(c, 'negative_stock');
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const dto = parseWith(decideApprovalSchema, await parseJson(c));
  const approval = await approvalRow(c, id);
  const warehouseId = await warehouseIdOfStock(c, approval.stock_id);
  if (!canPerformInStore(ctx, rp, warehouseId, Permission.NEGATIVE_DECIDE)) {
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
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: `negative_approval.${dto.decision}`,
      targetType: 'negative_stock_approval',
      targetId: String(id),
      payload: { decision: dto.decision },
      storeId: ctx.store.id,
      createdAt: now,
    }),
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
  const ctx = await storeContext(c);
  const row = await c.env.DB.prepare(
    'SELECT id, stock_id, status, requested_by FROM negative_stock_approvals WHERE id = ?1 AND store_id = ?2',
  )
    .bind(id, ctx.store.id)
    .first<ApprovalDbRow>();
  if (!row) throw notFound('Negative stock approval not found');
  return row;
}

// ---------------------------------------------------------------- 棚卸し

app.post('/api/v1/stocktakes', async (c) => {
  await requirePermission(c, Permission.STOCKTAKES_MANAGE);
  await requireFeature(c, 'stocktakes');
  const ctx = await storeContext(c);
  // ボディは任意: 無ければ全件・非盲検 (従来どおり)。壊れた JSON も無しとして扱う
  let raw: unknown = {};
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const dto = parseWith(createStocktakeSchema, raw ?? {});
  const envelope = await coordinator(c).startStocktake({
    actorId: user(c).userId,
    storeId: ctx.store.id,
    scopeType: dto.scopeType ?? 'full',
    ...(dto.locationIds !== undefined ? { locationIds: dto.locationIds } : {}),
    blind: dto.blind ?? false,
  });
  return respond(c, envelope);
});

interface StocktakeHeadRow {
  id: number;
  status: string;
  startedBy: number;
  startedAt: number;
  confirmedAt: number | null;
  scopeType?: string;
  scopeJson?: string | null;
  blind?: number;
}

/** 棚卸しの見出し行を API 形式へ (scope/blind は 0014 適用環境のみ値が入る) */
function stocktakeHeadJson(r: StocktakeHeadRow): Record<string, unknown> {
  let locationIds: number[] | null = null;
  if (typeof r.scopeJson === 'string') {
    try {
      const parsed = JSON.parse(r.scopeJson) as unknown;
      if (Array.isArray(parsed)) locationIds = parsed.filter((v): v is number => typeof v === 'number');
    } catch {
      locationIds = null;
    }
  }
  return {
    id: r.id,
    status: r.status,
    startedBy: r.startedBy,
    startedAt: r.startedAt,
    confirmedAt: r.confirmedAt,
    scopeType: r.scopeType ?? 'full',
    locationIds,
    blind: r.blind === 1,
  };
}

/** 棚卸しヘッダの startedBy を匿名化する (全体管理者が開始した棚卸し) */
function anonymizeStocktakeHead(
  json: Record<string, unknown>,
  hidden: ReadonlySet<number>,
): Record<string, unknown> {
  return anonymizeUserFields(json, hidden, ['startedBy']);
}

const STOCKTAKE_HEAD_SQL = `SELECT id, status, started_by AS startedBy, started_at AS startedAt,
       confirmed_at AS confirmedAt, scope_type AS scopeType, scope_json AS scopeJson, blind
  FROM stocktakes`;
const STOCKTAKE_HEAD_SQL_LEGACY = `SELECT id, status, started_by AS startedBy, started_at AS startedAt,
       confirmed_at AS confirmedAt
  FROM stocktakes`;

async function stocktakeHeadSql(c: AppContext): Promise<string> {
  return (await hasColumn(c, 'stocktakes', 'scope_type'))
    ? STOCKTAKE_HEAD_SQL
    : STOCKTAKE_HEAD_SQL_LEGACY;
}

app.get('/api/v1/stocktakes', async (c) => {
  const ctx = await storeContext(c);
  const headSql = await stocktakeHeadSql(c);
  const { results } = await c.env.DB.prepare(
    `${headSql} WHERE store_id = ?1 ORDER BY id DESC LIMIT 50`,
  )
    .bind(ctx.store.id)
    .all<StocktakeHeadRow>();
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(results.map((r) => anonymizeStocktakeHead(stocktakeHeadJson(r), hidden)));
});

app.post('/api/v1/stocktakes/:id/finish', async (c) => {
  await requirePermission(c, Permission.STOCKTAKES_MANAGE);
  await requireFeature(c, 'stocktakes');
  const ctx = await storeContext(c);
  const envelope = await coordinator(c).finishStocktake({
    actorId: user(c).userId,
    stocktakeId: Number(c.req.param('id')),
    storeId: ctx.store.id,
  });
  return respond(c, envelope);
});

interface StocktakeLineView {
  id: number;
  stockId: number;
  bookQuantity: number;
  countedQuantity: number | null;
  locationId: number;
  warehouseId: number;
  productId: number;
  sku: string;
  productName: string;
  lotCode: string;
  expiryDate: number | null;
}

function stocktakeLineJson(r: StocktakeLineView): Record<string, unknown> {
  return {
    id: r.id,
    stockId: r.stockId,
    bookQuantity: r.bookQuantity,
    countedQuantity: r.countedQuantity,
    difference: r.countedQuantity === null ? null : r.countedQuantity - r.bookQuantity,
    locationId: r.locationId,
    warehouseId: r.warehouseId,
    productId: r.productId,
    sku: r.sku,
    productName: r.productName,
    lotCode: r.lotCode,
    expiryDate: formatDateOnly(r.expiryDate),
  };
}

const STOCKTAKE_LINE_SQL = `SELECT sl.id, sl.stock_id AS stockId, sl.book_quantity AS bookQuantity,
           sl.counted_quantity AS countedQuantity, s.location_id AS locationId,
           loc.warehouse_id AS warehouseId, l.product_id AS productId, p.sku,
           p.name AS productName, l.lot_code AS lotCode, l.expiry_date AS expiryDate
      FROM stocktake_lines sl
      JOIN stocks s ON s.id = sl.stock_id
      JOIN locations loc ON loc.id = s.location_id
      JOIN lots l ON l.id = s.lot_id
      JOIN products p ON p.id = l.product_id`;

/**
 * 盲検の秘匿: 盲検 (blind=1) かつ実施中の間は、実数入力のためのレスポンスから
 * 帳簿数 (bookQuantity) と差異 (difference) を落とす。差異が見えるのは
 * 承認待ち以降 (差異承認の画面) だけ。
 */
function applyBlind(
  lineJson: Record<string, unknown>,
  stocktake: { blind?: number; status: string },
): Record<string, unknown> {
  if (stocktake.blind === 1 && stocktake.status === 'in_progress') {
    const out = { ...lineJson };
    delete out.bookQuantity;
    delete out.difference;
    return out;
  }
  return lineJson;
}

/** 棚卸しの詳細 (lines: 帳簿数・実数・差異つき)。一覧と同じく現在店舗の割当が条件 */
app.get('/api/v1/stocktakes/:id', async (c) => {
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const headSql = await stocktakeHeadSql(c);
  const stocktake = await c.env.DB.prepare(`${headSql} WHERE id = ?1 AND store_id = ?2`)
    .bind(id, ctx.store.id)
    .first<StocktakeHeadRow>();
  if (!stocktake) throw notFound('Stocktake not found');
  const { results } = await c.env.DB.prepare(
    `${STOCKTAKE_LINE_SQL} WHERE sl.stocktake_id = ?1 ORDER BY sl.id ASC`,
  )
    .bind(id)
    .all<StocktakeLineView>();
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json({
    ...anonymizeStocktakeHead(stocktakeHeadJson(stocktake), hidden),
    lines: results.map((r) => applyBlind(stocktakeLineJson(r), stocktake)),
  });
});

/** 棚卸し lines への実数入力 (実施中のみ)。lines は stocks ではないため Worker が直接更新する */
app.put('/api/v1/stocktakes/:id/lines/:lineId', async (c) => {
  await requirePermission(c, Permission.STOCKTAKES_MANAGE);
  const ctx = await storeContext(c);
  const stocktakeId = Number(c.req.param('id'));
  const lineId = Number(c.req.param('lineId'));
  const dto = parseWith(countedQuantitySchema, await parseJson(c));
  const headSql = await stocktakeHeadSql(c);
  const stocktake = await c.env.DB.prepare(`${headSql} WHERE id = ?1 AND store_id = ?2`)
    .bind(stocktakeId, ctx.store.id)
    .first<StocktakeHeadRow>();
  if (!stocktake) throw notFound('Stocktake not found');
  if (stocktake.status !== 'in_progress') {
    throw new ApiError(409, 'STOCKTAKE_NOT_IN_PROGRESS', 'Counted quantities can only be entered while the stocktake is in progress');
  }
  const res = await c.env.DB.prepare(
    'UPDATE stocktake_lines SET counted_quantity = ?1 WHERE id = ?2 AND stocktake_id = ?3',
  )
    .bind(dto.countedQuantity, lineId, stocktakeId)
    .run();
  if (res.meta.changes === 0) throw notFound('Stocktake line not found');
  const line = await c.env.DB.prepare(`${STOCKTAKE_LINE_SQL} WHERE sl.id = ?1`)
    .bind(lineId)
    .first<StocktakeLineView>();
  return c.json(applyBlind(stocktakeLineJson(line as StocktakeLineView), stocktake));
});

/** 棚卸しの差異承認/差し戻し (pending_approval のときのみ Coordinator が処理する) */
app.post('/api/v1/stocktakes/:id/decide', async (c) => {
  await requirePermission(c, Permission.STOCKTAKES_MANAGE);
  await requireFeature(c, 'stocktakes');
  const ctx = await storeContext(c);
  const dto = parseWith(decideStocktakeSchema, await parseJson(c));
  const envelope = await coordinator(c).decideStocktake({
    actorId: user(c).userId,
    stocktakeId: Number(c.req.param('id')),
    approve: dto.approve,
    storeId: ctx.store.id,
  });
  return respond(c, envelope);
});

// ---------------------------------------------------------------- アラート

interface AlertRow extends StockViewRow {
  safety_stock: number;
  expiry_alert_days: number | null;
}

app.get('/api/v1/alerts', async (c) => {
  await requirePermission(c, Permission.ALERTS_READ);
  await requireFeature(c, 'alerts');
  const ctx = await storeContext(c);
  const reachable = reachableWarehouseIds(ctx.assignments);
  if (reachable !== null && reachable.length === 0) return c.json([]);
  let sql = `SELECT s.id, s.location_id, s.lot_id, s.quantity, s.version,
                    loc.warehouse_id, l.product_id, p.sku, l.lot_code, l.expiry_date,
                    p.safety_stock, p.expiry_alert_days
               FROM stocks s
               JOIN locations loc ON loc.id = s.location_id
               JOIN lots l ON l.id = s.lot_id
               JOIN products p ON p.id = l.product_id
              WHERE s.store_id = ?`;
  const params: number[] = [ctx.store.id];
  if (reachable !== null) {
    sql += ` AND loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`;
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

// ---------------------------------------------------------------- 発注 (発注書・入荷・提案)

/** idempotency_keys の保存済みレスポンスを引く (Coordinator と同じ店舗スコープのセマンティクス) */
async function findStoredIdempotentResponse(
  c: AppContext,
  key: string,
  requestHash: string,
  storeId: number,
): Promise<{ status: number; body: unknown } | null> {
  const row = await c.env.DB.prepare(
    'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE key = ?1 AND user_id = ?2 AND store_id = ?3',
  )
    .bind(key, user(c).userId, storeId)
    .first<{ request_hash: string; response_status: number | null; response_body: string | null }>();
  if (!row || row.response_status === null || row.response_body === null) return null;
  if (row.request_hash !== requestHash) {
    throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request body');
  }
  return { status: row.response_status, body: JSON.parse(row.response_body) as unknown };
}

interface PurchaseOrderDbRow {
  id: number;
  supplier_id: number;
  supplier_name: string | null;
  status: string;
  expected_date: string | null;
  note: string | null;
  created_by: number;
  created_at: number;
  updated_at: number;
  /** 0015 で追加 (manual | template | schedule)。未適用環境では undefined */
  source?: string;
}

interface PurchaseOrderLineDbRow {
  id: number;
  po_id: number;
  product_id: number;
  quantity: number;
  received_quantity: number;
  unit_cost: number | null;
  /** 0014 で追加 (入力時の数量・単位)。未適用環境では undefined になるため null に寄せる */
  input_quantity?: number | null;
  input_unit?: string | null;
}

const PO_SELECT = `SELECT po.id, po.supplier_id, sup.name AS supplier_name, po.status,
                          po.expected_date, po.note, po.created_by, po.created_at, po.updated_at
                     FROM purchase_orders po
                     LEFT JOIN suppliers sup ON sup.id = po.supplier_id`;

/** source 列 (0015) がある環境ではそれも引く PO_SELECT */
async function poSelect(c: AppContext): Promise<string> {
  if (await hasColumn(c, 'purchase_orders', 'source')) {
    return PO_SELECT.replace('po.updated_at', 'po.updated_at, po.source');
  }
  return PO_SELECT;
}

function purchaseOrderJson(po: PurchaseOrderDbRow, lines: PurchaseOrderLineDbRow[]): Record<string, unknown> {
  const today = formatDateOnly(Date.now());
  const hasRemaining = lines.some((l) => l.quantity - l.received_quantity > 0);
  // 納期超過: 未完了 (下書き・発注済み) で残があり、納期日を過ぎている
  const overdue =
    (po.status === 'draft' || po.status === 'ordered') &&
    hasRemaining &&
    po.expected_date !== null &&
    today !== null &&
    po.expected_date < today;
  return {
    id: po.id,
    supplierId: po.supplier_id,
    supplierName: po.supplier_name,
    status: po.status,
    expectedDate: po.expected_date,
    note: po.note,
    createdBy: po.created_by,
    createdAt: po.created_at,
    updatedAt: po.updated_at,
    source: po.source ?? 'manual',
    overdue,
    lines: lines.map((l) => ({
      id: l.id,
      productId: l.product_id,
      quantity: l.quantity,
      receivedQuantity: l.received_quantity,
      remainingQuantity: l.quantity - l.received_quantity,
      inputQuantity: l.input_quantity ?? null,
      inputUnit: l.input_unit ?? null,
      unitCost: l.unit_cost,
    })),
  };
}

async function loadPurchaseOrder(c: AppContext, id: number, storeId: number): Promise<Record<string, unknown>> {
  const po = await c.env.DB.prepare(`${await poSelect(c)} WHERE po.id = ?1 AND po.store_id = ?2`)
    .bind(id, storeId)
    .first<PurchaseOrderDbRow>();
  if (!po) throw notFound('Purchase order not found');
  const { results: lines } = await c.env.DB.prepare(
    'SELECT * FROM purchase_order_lines WHERE po_id = ?1 ORDER BY id ASC',
  )
    .bind(id)
    .all<PurchaseOrderLineDbRow>();
  return purchaseOrderJson(po, lines);
}

app.get('/api/v1/purchase-orders', async (c) => {
  await requirePermission(c, Permission.PURCHASES_READ);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  const { results: orders } = await c.env.DB.prepare(`${await poSelect(c)} WHERE po.store_id = ?1 ORDER BY po.id DESC LIMIT 100`)
    .bind(ctx.store.id)
    .all<PurchaseOrderDbRow>();
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  const out: Record<string, unknown>[] = [];
  for (const po of orders) {
    const { results: lines } = await c.env.DB.prepare(
      'SELECT * FROM purchase_order_lines WHERE po_id = ?1 ORDER BY id ASC',
    )
      .bind(po.id)
      .all<PurchaseOrderLineDbRow>();
    out.push(anonymizeUserFields(purchaseOrderJson(po, lines), hidden, ['createdBy']));
  }
  return c.json(out);
});

/**
 * 発注提案 (0014 で高度化):
 * - 発注点 = 平均日次消費 (直近90日の消費量 / 90) × リードタイム + 安全在庫。
 *   リードタイムは商品の指定 → 直近の発注先の既定 → 7日 の順で解決する。
 *   平均消費が 0 のときは発注点 = 安全在庫 (従来と同じ判定になる)。
 * - 判定は論理在庫 = 実在庫 + 発注残 (status='ordered' の未入荷数量) で行い、
 *   発注残で発注点以上になる商品は提案しない。
 * - 提案数量は発注点 + 安全在庫まで補充する量。入数 (case_size) がある商品は
 *   ケース単位に切り上げる。
 * - レスポンスには内訳 (実在庫・発注残・発注点・平均日次消費・リードタイム) を含む。
 */
app.get('/api/v1/purchase-orders/suggestions', async (c) => {
  await requirePermission(c, Permission.PURCHASES_READ);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  const reachable = reachableWarehouseIds(ctx.assignments);
  if (reachable !== null && reachable.length === 0) return c.json([]);
  const storeId = ctx.store.id;
  const DAY = 86_400_000;
  const since = Date.now() - 90 * DAY;
  const scopeCondition =
    reachable === null ? '' : ` AND sloc.warehouse_id IN (${reachable.map(() => '?').join(',')})`;
  const scopeParams = reachable ?? [];

  const withCase = await hasColumn(c, 'products', 'case_size');
  const withLead = await hasColumn(c, 'products', 'lead_time_days');
  const withSupplierLead = await hasColumn(c, 'suppliers', 'lead_time_days');

  const { results: products } = await c.env.DB.prepare(
    `SELECT p.id AS productId, p.sku, p.name, p.safety_stock AS safetyStock
            ${withCase ? ', p.case_size AS caseSize' : ', NULL AS caseSize'}
            ${withLead ? ', p.lead_time_days AS leadTimeDays' : ', NULL AS leadTimeDays'}
       FROM products p
      WHERE p.deleted_at IS NULL AND p.safety_stock > 0 AND p.store_id = ?1
      ORDER BY p.id ASC`,
  )
    .bind(storeId)
    .all<{
      productId: number;
      sku: string;
      name: string;
      safetyStock: number;
      caseSize: number | null;
      leadTimeDays: number | null;
    }>();
  if (products.length === 0) return c.json([]);

  // 実在庫 (倉庫スコープ適用)
  const { results: onHandRows } = await c.env.DB.prepare(
    `SELECT sl.product_id AS productId, COALESCE(SUM(s.quantity), 0) AS qty
       FROM stocks s
       JOIN lots sl ON sl.id = s.lot_id
       JOIN locations sloc ON sloc.id = s.location_id
      WHERE s.store_id = ?${scopeCondition}
      GROUP BY sl.product_id`,
  )
    .bind(storeId, ...scopeParams)
    .all<{ productId: number; qty: number }>();
  const onHand = new Map(onHandRows.map((r) => [r.productId, r.qty]));

  // 直近90日の消費 (OUT) 合計
  const { results: consumedRows } = await c.env.DB.prepare(
    `SELECT sl.product_id AS productId, COALESCE(SUM(-mv.quantity_change), 0) AS qty
       FROM stock_movements mv
       JOIN stocks s ON s.id = mv.stock_id
       JOIN lots sl ON sl.id = s.lot_id
       JOIN locations sloc ON sloc.id = s.location_id
      WHERE mv.type = 'OUT' AND mv.created_at >= ? AND mv.store_id = ?${scopeCondition}
      GROUP BY sl.product_id`,
  )
    .bind(since, storeId, ...scopeParams)
    .all<{ productId: number; qty: number }>();
  const consumed = new Map(consumedRows.map((r) => [r.productId, r.qty]));

  // 発注残: 発注済み (ordered) で未入荷の数量
  const { results: onOrderRows } = await c.env.DB.prepare(
    `SELECT pol.product_id AS productId, COALESCE(SUM(pol.quantity - pol.received_quantity), 0) AS qty
       FROM purchase_order_lines pol
       JOIN purchase_orders po ON po.id = pol.po_id
      WHERE po.store_id = ?1 AND po.status = 'ordered'
      GROUP BY pol.product_id`,
  )
    .bind(storeId)
    .all<{ productId: number; qty: number }>();
  const onOrder = new Map(onOrderRows.map((r) => [r.productId, r.qty]));

  // 商品にリードタイム指定が無い場合の fallback: 直近の発注先の既定リードタイム
  const supplierLead = new Map<number, number>();
  if (withSupplierLead) {
    const { results: leadRows } = await c.env.DB.prepare(
      `SELECT pol.product_id AS productId, sup.lead_time_days AS leadTimeDays
         FROM purchase_order_lines pol
         JOIN purchase_orders po ON po.id = pol.po_id
         JOIN suppliers sup ON sup.id = po.supplier_id
        WHERE po.store_id = ?1 AND sup.lead_time_days IS NOT NULL
        ORDER BY po.created_at DESC, pol.id DESC`,
    )
      .bind(storeId)
      .all<{ productId: number; leadTimeDays: number }>();
    for (const r of leadRows) {
      if (!supplierLead.has(r.productId)) supplierLead.set(r.productId, r.leadTimeDays);
    }
  }

  const suggestions: Record<string, unknown>[] = [];
  for (const p of products) {
    const hand = onHand.get(p.productId) ?? 0;
    const ordered = onOrder.get(p.productId) ?? 0;
    const logical = hand + ordered;
    const avgDailyRaw = (consumed.get(p.productId) ?? 0) / 90;
    const leadTimeDays = p.leadTimeDays ?? supplierLead.get(p.productId) ?? 7;
    const reorderPoint = Math.ceil(avgDailyRaw * leadTimeDays) + p.safetyStock;
    if (logical >= reorderPoint) continue;
    const shortage = reorderPoint - logical;
    const rawSuggested = reorderPoint + p.safetyStock - logical;
    let suggestedQuantity = rawSuggested;
    let suggestedCases: number | null = null;
    if (p.caseSize !== null && p.caseSize > 1) {
      suggestedCases = Math.ceil(rawSuggested / p.caseSize);
      suggestedQuantity = suggestedCases * p.caseSize;
    }
    suggestions.push({
      productId: p.productId,
      sku: p.sku,
      name: p.name,
      safetyStock: p.safetyStock,
      totalQuantity: hand,
      onHand: hand,
      onOrder: ordered,
      logicalStock: logical,
      reorderPoint,
      avgDailyConsumption: Math.round(avgDailyRaw * 100) / 100,
      leadTimeDays,
      shortage,
      suggestedQuantity,
      caseSize: p.caseSize,
      suggestedCases,
    });
  }
  return c.json(suggestions);
});

app.post('/api/v1/purchase-orders', async (c) => {
  await requirePermission(c, Permission.PURCHASES_WRITE);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  const key = requireIdempotencyKey(c);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(createPurchaseOrderSchema, raw);
  const requestHash = await sha256Hex(JSON.stringify(raw));
  const stored = await findStoredIdempotentResponse(c, key, requestHash, ctx.store.id);
  if (stored) return c.json(stored.body as Record<string, unknown>, stored.status as 201);

  // 明細の数量解決 (ケース → 基本単位) と下書き作成は lib/commercial.ts に集約し、
  // テンプレート生成・定期生成と同一の規則で動かす (source='manual')
  const now = Date.now();
  const poId = await createDraftPurchaseOrder(c.env.DB, {
    storeId: ctx.store.id,
    supplierId: dto.supplierId,
    expectedDate: dto.expectedDate ?? null,
    note: dto.note ?? null,
    actorId: user(c).userId,
    source: 'manual',
    lines: dto.lines,
    nowMs: now,
  });
  // 作成した発注書の完全な形は lines 挿入後に組み立てるため、冪等レコードと監査は後段で入れる
  const created = await loadPurchaseOrder(c, poId, ctx.store.id);
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, response_status, response_body, store_id, created_at)
         VALUES (?1, ?2, 'POST /api/v1/purchase-orders', ?3, 201, ?4, ?5, ?6)`,
      )
      .bind(key, user(c).userId, requestHash, JSON.stringify(created), ctx.store.id, now),
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'purchase_order.create',
      targetType: 'purchase_order',
      targetId: String(poId),
      payload: { supplierId: dto.supplierId, lines: dto.lines.length },
      storeId: ctx.store.id,
      createdAt: now,
    }),
  ]);
  return c.json(created, 201);
});

/**
 * 入荷登録: 発注明細ごとに Coordinator の inbound を再利用して在庫へ入れる。
 * 行単位の冪等キー (親キー + lineId) で再送時の二重入庫を防ぎ、入荷済み数量を
 * 超える登録は 422。棚卸しロック中は inbound の 423 をそのまま返す。
 * 全行が揃ったら received、途中なら ordered に進める。
 */
app.post('/api/v1/purchase-orders/:id/receive', async (c) => {
  const rp = await requirePermission(c, Permission.PURCHASES_WRITE);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  const poId = Number(c.req.param('id'));
  const key = requireIdempotencyKey(c);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(receivePurchaseOrderSchema, raw);

  const warehouseId = await warehouseIdOfLocation(c, dto.locationId);
  if (!canPerformInStore(ctx, rp, warehouseId, Permission.PURCHASES_WRITE)) {
    throw forbidden('Out of warehouse scope');
  }

  const po = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ?1 AND store_id = ?2')
    .bind(poId, ctx.store.id)
    .first<{ id: number; status: string }>();
  if (!po) throw notFound('Purchase order not found');
  if (po.status === 'received' || po.status === 'cancelled' || po.status === 'closed') {
    throw new ApiError(409, 'PO_NOT_RECEIVABLE', `Purchase order is ${po.status} and cannot receive items`);
  }

  const { results: lineRows } = await c.env.DB.prepare(
    'SELECT * FROM purchase_order_lines WHERE po_id = ?1',
  )
    .bind(poId)
    .all<PurchaseOrderLineDbRow>();
  const lineById = new Map(lineRows.map((l) => [l.id, l]));
  const seen = new Set<number>();
  for (const line of dto.lines) {
    if (seen.has(line.lineId)) throw badRequest('duplicate lineId in lines');
    seen.add(line.lineId);
    const target = lineById.get(line.lineId);
    if (!target) throw badRequest(`lineId ${line.lineId} does not belong to this purchase order`);
    if (target.received_quantity + line.quantity > target.quantity) {
      throw new ApiError(
        422,
        'OVER_RECEIVE',
        `Receiving ${line.quantity} exceeds the remaining quantity for line ${line.lineId}`,
      );
    }
  }

  // 受入で生成された入庫伝票 (検品写真を付ける導線のためレスポンスに含める)
  const receivedMovements: { lineId: number; movementId: number; documentId: string }[] = [];
  for (const line of dto.lines) {
    const target = lineById.get(line.lineId) as PurchaseOrderLineDbRow;
    let expiryDateMs: number | null = null;
    if (line.expiryDate !== undefined) {
      expiryDateMs = parseDateOnly(line.expiryDate);
      if (expiryDateMs === null) throw badRequest('expiryDate must be a valid YYYY-MM-DD date');
    }
    const lineKey = `${key}:${line.lineId}`;
    const lineHash = await sha256Hex(
      JSON.stringify({
        poId,
        lineId: line.lineId,
        locationId: dto.locationId,
        quantity: line.quantity,
        lotCode: line.lotCode,
        expiryDate: line.expiryDate ?? null,
      }),
    );
    const prior = await findStoredIdempotentResponse(c, lineKey, lineHash, ctx.store.id);
    let documentId: string | null = null;
    if (prior) {
      documentId = (prior.body as { documentId?: string }).documentId ?? null;
    } else {
      const envelope = await coordinator(c).inbound({
        actorId: user(c).userId,
        endpoint: 'POST /api/v1/purchase-orders/:id/receive',
        idempotencyKey: lineKey,
        requestHash: lineHash,
        storeId: ctx.store.id,
        locationId: dto.locationId,
        productId: target.product_id,
        lotCode: line.lotCode,
        expiryDateMs,
        quantity: line.quantity,
      });
      if (envelope.status !== 201) return respond(c, envelope);
      documentId = (envelope.body as { documentId?: string }).documentId ?? null;
      await c.env.DB.prepare(
        'UPDATE purchase_order_lines SET received_quantity = received_quantity + ?1 WHERE id = ?2',
      )
        .bind(line.quantity, line.lineId)
        .run();
      target.received_quantity += line.quantity;
    }
    if (documentId) {
      const mv = await c.env.DB.prepare(
        'SELECT id FROM stock_movements WHERE document_id = ?1 AND store_id = ?2',
      )
        .bind(documentId, ctx.store.id)
        .first<{ id: number }>();
      if (mv) receivedMovements.push({ lineId: line.lineId, movementId: mv.id, documentId });
    }
  }

  const { results: afterLines } = await c.env.DB.prepare(
    'SELECT * FROM purchase_order_lines WHERE po_id = ?1',
  )
    .bind(poId)
    .all<PurchaseOrderLineDbRow>();
  const complete = afterLines.every((l) => l.received_quantity >= l.quantity);
  const nextStatus = complete ? 'received' : 'ordered';
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare('UPDATE purchase_orders SET status = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(nextStatus, now, poId),
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'purchase_order.receive',
      targetType: 'purchase_order',
      targetId: String(poId),
      payload: { locationId: dto.locationId, lines: dto.lines, status: nextStatus },
      storeId: ctx.store.id,
      createdAt: now,
    }),
  ]);
  const poJson = await loadPurchaseOrder(c, poId, ctx.store.id);
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json({
    ...anonymizeUserFields(poJson, hidden, ['createdBy']),
    receivedMovements,
  });
});

/**
 * 残クローズ: 未入荷の残数量を打ち切って発注を完了 (closed) にする。
 * 分納で残が届かない場合の運用クローズ。監査ログに残数量を残す。
 */
app.post('/api/v1/purchase-orders/:id/close-residual', async (c) => {
  await requirePermission(c, Permission.PURCHASES_WRITE);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  const poId = Number(c.req.param('id'));
  const po = await c.env.DB.prepare('SELECT id, status FROM purchase_orders WHERE id = ?1 AND store_id = ?2')
    .bind(poId, ctx.store.id)
    .first<{ id: number; status: string }>();
  if (!po) throw notFound('Purchase order not found');
  if (po.status !== 'draft' && po.status !== 'ordered') {
    throw new ApiError(409, 'PO_NOT_CLOSABLE', `Purchase order is ${po.status} and cannot be closed`);
  }
  const { results: lineRows } = await c.env.DB.prepare(
    'SELECT * FROM purchase_order_lines WHERE po_id = ?1',
  )
    .bind(poId)
    .all<PurchaseOrderLineDbRow>();
  const remaining = lineRows
    .map((l) => ({ lineId: l.id, productId: l.product_id, remaining: l.quantity - l.received_quantity }))
    .filter((l) => l.remaining > 0);
  if (remaining.length === 0) {
    throw new ApiError(409, 'PO_NOT_CLOSABLE', 'Purchase order has no remaining quantity to close');
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB
      .prepare("UPDATE purchase_orders SET status = 'closed', updated_at = ?1 WHERE id = ?2")
      .bind(now, poId),
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'purchase_order.close_residual',
      targetType: 'purchase_order',
      targetId: String(poId),
      payload: { remaining },
      storeId: ctx.store.id,
      createdAt: now,
    }),
  ]);
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(
    anonymizeUserFields(await loadPurchaseOrder(c, poId, ctx.store.id), hidden, ['createdBy']),
  );
});

// ---------------------------------------------------------------- 分析レポート

/**
 * 分析レポート (stocks.read):
 * - monthly: 直近 6 ヶ月 (当月含む) の月別入庫/消費合計。IN 側は IN + TRANSFER_IN、
 *   OUT 側は OUT + TRANSFER_OUT の数量合計 (ADJUST / CANCEL は含めない)
 * - valuation: 在庫評価額 Σ(数量 × 商品単価) と単価設定済み商品のカバー率
 * - deadStock: 在庫があるのに最終移動から 90 日超 (または移動履歴なし) の商品
 * - topConsumed: 直近 90 日の消費 (OUT) 数量上位
 */
app.get('/api/v1/analytics', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  await requireFeature(c, 'analytics');
  const ctx = await storeContext(c);
  const reachable = reachableWarehouseIds(ctx.assignments);
  const now = Date.now();
  const DAY = 86_400_000;
  // 現在店舗の ID (自 DB 由来の整数) は SQL に直接埋め込む
  const storeId = ctx.store.id;

  // 月別集計 (UTC の YYYY-MM でバケットする)
  const monthKeys: string[] = [];
  const base = new Date(now);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
    monthKeys.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
    );
  }
  const sixMonthsAgo = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - 5, 1);
  const { results: movementRows } = await c.env.DB.prepare(
    `SELECT mv.type, mv.quantity_change AS quantityChange, mv.created_at AS createdAt
       FROM stock_movements mv
       JOIN stocks s ON s.id = mv.stock_id
       JOIN locations loc ON loc.id = s.location_id
      WHERE mv.created_at >= ?1 AND mv.store_id = ${storeId}${reachable !== null && reachable.length > 0 ? ` AND loc.warehouse_id IN (${reachable.map(() => '?').join(',')})` : ''}${reachable !== null && reachable.length === 0 ? ' AND 1 = 0' : ''}`,
  )
    .bind(sixMonthsAgo, ...(reachable !== null && reachable.length > 0 ? reachable : []))
    .all<{ type: string; quantityChange: number; createdAt: number }>();
  const byMonth = new Map(monthKeys.map((k) => [k, { month: k, in: 0, out: 0 }]));
  for (const r of movementRows) {
    const d = new Date(r.createdAt);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucket = byMonth.get(key);
    if (!bucket) continue;
    if (r.type === 'IN' || r.type === 'TRANSFER_IN' || r.type === 'RETURN') bucket.in += r.quantityChange;
    else if (r.type === 'OUT' || r.type === 'TRANSFER_OUT' || r.type === 'DISPOSAL') bucket.out += -r.quantityChange;
  }

  // 在庫評価額とカバー率
  const valuationRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(s.quantity * COALESCE(p.unit_cost, 0)), 0) AS totalValue
       FROM stocks s
       JOIN lots l ON l.id = s.lot_id
       JOIN products p ON p.id = l.product_id
      WHERE s.store_id = ${storeId}`,
  ).first<{ totalValue: number }>();
  const productCounts = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN unit_cost IS NOT NULL THEN 1 ELSE 0 END), 0) AS priced
       FROM products WHERE deleted_at IS NULL AND store_id = ${storeId}`,
  ).first<{ total: number; priced: number }>();
  const totalProducts = productCounts?.total ?? 0;
  const pricedProducts = productCounts?.priced ?? 0;

  const scopeCondition =
    reachable === null
      ? ''
      : reachable.length === 0
        ? ' AND 1 = 0'
        : ` AND loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`;
  const scopeParams = reachable !== null && reachable.length > 0 ? reachable : [];

  // 滞留在庫
  const { results: deadRows } = await c.env.DB.prepare(
    `SELECT p.id AS productId, p.sku, p.name,
            SUM(s.quantity) AS totalQuantity, MAX(mv.created_at) AS lastMovementAt
       FROM products p
       JOIN lots l ON l.product_id = p.id
       JOIN stocks s ON s.lot_id = l.id
       JOIN locations loc ON loc.id = s.location_id
       LEFT JOIN stock_movements mv ON mv.stock_id = s.id
      WHERE p.deleted_at IS NULL AND p.store_id = ${storeId} AND s.store_id = ${storeId}${scopeCondition}
      GROUP BY p.id
     HAVING totalQuantity > 0 AND (lastMovementAt IS NULL OR lastMovementAt < ?)
      ORDER BY (lastMovementAt IS NULL) DESC, lastMovementAt ASC
      LIMIT 20`,
  )
    .bind(...scopeParams, now - 90 * DAY)
    .all<{ productId: number; sku: string; name: string; totalQuantity: number; lastMovementAt: number | null }>();

  // 消費上位 (直近 90 日)
  const { results: topRows } = await c.env.DB.prepare(
    `SELECT p.id AS productId, p.sku, p.name, SUM(-mv.quantity_change) AS quantity
       FROM stock_movements mv
       JOIN stocks s ON s.id = mv.stock_id
       JOIN locations loc ON loc.id = s.location_id
       JOIN lots l ON l.id = s.lot_id
       JOIN products p ON p.id = l.product_id
      WHERE mv.type = 'OUT' AND mv.created_at >= ?1 AND mv.store_id = ${storeId}${scopeCondition}
      GROUP BY p.id
      ORDER BY quantity DESC
      LIMIT 10`,
  )
    .bind(now - 90 * DAY, ...scopeParams)
    .all<{ productId: number; sku: string; name: string; quantity: number }>();

  // 廃棄集計 (0015): 直近 6 か月の廃棄数量と評価額 (数量 × 商品単価)
  const disposalRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(-mv.quantity_change), 0) AS quantity,
            COALESCE(SUM(-mv.quantity_change * COALESCE(p.unit_cost, 0)), 0) AS value
       FROM stock_movements mv
       JOIN stocks s ON s.id = mv.stock_id
       JOIN locations loc ON loc.id = s.location_id
       JOIN lots l ON l.id = s.lot_id
       JOIN products p ON p.id = l.product_id
      WHERE mv.type = 'DISPOSAL' AND mv.created_at >= ?1 AND mv.store_id = ${storeId}${scopeCondition}`,
  )
    .bind(sixMonthsAgo, ...scopeParams)
    .first<{ quantity: number; value: number }>()
    .catch(() => null);

  return c.json({
    monthly: monthKeys.map((k) => byMonth.get(k)),
    disposal: {
      quantity: disposalRow?.quantity ?? 0,
      value: disposalRow?.value ?? 0,
      months: 6,
    },
    valuation: {
      totalValue: valuationRow?.totalValue ?? 0,
      pricedProducts,
      totalProducts,
      coverageRate: totalProducts === 0 ? 0 : pricedProducts / totalProducts,
    },
    deadStock: deadRows.map((r) => ({
      productId: r.productId,
      sku: r.sku,
      name: r.name,
      totalQuantity: r.totalQuantity,
      lastMovementAt: r.lastMovementAt,
    })),
    topConsumed: topRows,
  });
});

// ---------------------------------------------------------------- 管理 (権限・ユーザー)

// ロール一覧 (roles テーブルが空なら既知の 5 ロールで代替)
async function listRoles(c: AppContext): Promise<{ code: string; name: string }[]> {
  try {
    const { results } = await c.env.DB.prepare('SELECT code, name FROM roles ORDER BY code ASC').all<{
      code: string;
      name: string;
    }>();
    if (results.length > 0) return results;
  } catch {
    // roles 未投入の環境ではフォールバックする
  }
  return ALL_ROLE_CODES.map((code) => ({ code, name: code }));
}

const rolePermissionsBodySchema = z.object({
  permissions: z.array(z.string().min(1)),
});

const userRolesBodySchema = z.object({
  assignments: z.array(
    z.object({
      roleCode: z.string().min(1),
      warehouseId: z.union([z.number().int().positive(), z.null()]),
    }),
  ),
});

app.get('/api/v1/admin/permissions', async (c) => {
  assertHasAssignments(user(c));
  const rp = await loadRolePermissions(c);
  if (
    !isPlatformAdmin(user(c).assignments) &&
    !hasPermission(user(c).assignments, rp, Permission.ADMIN_PERMISSIONS) &&
    !hasPermission(user(c).assignments, rp, Permission.ADMIN_USERS)
  ) {
    throw forbidden('Insufficient permission');
  }
  // カタログは DB が正。未投入ならコード側カタログを返す
  let catalog: readonly { key: string; label: string; description: string | null }[] = PERMISSION_CATALOG;
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT key, label, description FROM permissions ORDER BY rowid ASC',
    ).all<{ key: string; label: string; description: string | null }>();
    if (results.length > 0) catalog = results;
  } catch {
    // permissions 未適用の環境ではカタログ定数を使う
  }
  const roles = await listRoles(c);
  const matrix: Record<string, string[]> = {};
  for (const role of roles) {
    matrix[role.code] = [...(rp.get(role.code as RoleCode) ?? [])].sort();
  }
  return c.json({ permissions: catalog, roles, matrix });
});

app.put('/api/v1/admin/role-permissions/:roleCode', async (c) => {
  // マトリクスは店舗横断の概念のため、全体権限チェック (店舗未選択でも可)
  await requireGlobalPermission(c, Permission.ADMIN_PERMISSIONS);
  // 重要操作: 再認証 (ステップアップ) が新しいセッションだけ許可する
  await requireStepUp(c);
  const roleCode = c.req.param('roleCode');
  const roles = await listRoles(c);
  if (!roles.some((r) => r.code === roleCode)) throw notFound('Role not found');
  const dto = parseWith(rolePermissionsBodySchema, await parseJson(c));
  const keys = [...new Set(dto.permissions)];
  const unknown = keys.filter((k) => !PERMISSION_KEYS.has(k));
  if (unknown.length > 0) {
    throw new ApiError(422, 'UNKNOWN_PERMISSION', `Unknown permission keys: ${unknown.join(', ')}`);
  }
  // platform.admin は全体管理専用で、店舗ロールには付けない (全体 API は割当で判定)
  if (keys.includes(Permission.PLATFORM_ADMIN)) {
    throw new ApiError(422, 'PLATFORM_PERMISSION', 'platform.admin is not assignable to store roles');
  }
  // 締め出し防止: 権限管理そのものを失う変更は誰も自分を救えなくなるため拒否する
  if (roleCode === RoleCode.SYSTEM_ADMIN && !keys.includes(Permission.ADMIN_PERMISSIONS)) {
    throw new ApiError(
      422,
      'LOCKOUT_PREVENTION',
      'SYSTEM_ADMIN must keep admin.permissions (lockout prevention)',
    );
  }
  const now = Date.now();
  // 監査は「操作した文脈の店舗」で記録する (未選択なら全体操作として NULL)
  const auditStoreId = (await softStoreContext(c))?.store.id ?? null;
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare('DELETE FROM role_permissions WHERE role_code = ?1').bind(roleCode),
    ...keys.map((k) =>
      c.env.DB
        .prepare('INSERT INTO role_permissions (role_code, permission_key) VALUES (?1, ?2)')
        .bind(roleCode, k),
    ),
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'role_permissions.update',
      targetType: 'role',
      targetId: roleCode,
      payload: { permissions: keys },
      storeId: auditStoreId,
      createdAt: now,
    }),
  ];
  await c.env.DB.batch(stmts);
  return c.json({ roleCode, permissions: keys });
});

/**
 * ユーザー一覧 (店舗管理者用)。割当は「現在店舗の分」だけを返す
 * (他店舗・全体の割当は全体管理コンソールでのみ扱う)。
 */
app.get('/api/v1/admin/users', async (c) => {
  await requirePermission(c, Permission.ADMIN_USERS);
  const ctx = await storeContext(c);
  const { results: users } = await c.env.DB.prepare(
    `SELECT id, external_id AS externalId, email, display_name AS displayName, status
       FROM users ORDER BY id ASC`,
  ).all<{
    id: number;
    externalId: string;
    email: string;
    displayName: string;
    status: string;
  }>();
  const { results: roleRows } = await c.env.DB.prepare(
    'SELECT user_id AS userId, role_code AS roleCode, warehouse_id AS warehouseId FROM user_roles WHERE store_id = ?1 ORDER BY id ASC',
  )
    .bind(ctx.store.id)
    .all<{ userId: number; roleCode: string; warehouseId: number | null }>();
  const byUser = new Map<number, { roleCode: string; warehouseId: number | null }[]>();
  for (const r of roleRows) {
    const list = byUser.get(r.userId) ?? [];
    list.push({ roleCode: r.roleCode, warehouseId: r.warehouseId });
    byUser.set(r.userId, list);
  }
  // 全体管理者 (現在店舗の割当を持たない) は店舗側の管理対象ではないため一覧に出さない
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json(
    users
      .filter((u) => !hidden.has(u.id))
      .map((u) => ({ ...u, assignments: byUser.get(u.id) ?? [] })),
  );
});

/**
 * ロール付与の変更 (店舗管理者用)。置き換えるのは「現在店舗の割当」だけで、
 * 他店舗の割当と全体割当は保持する。割当には現在店舗が自動で付く。
 */
app.put('/api/v1/admin/users/:userId/roles', async (c) => {
  await requirePermission(c, Permission.ADMIN_USERS);
  const ctx = await storeContext(c);
  const userId = Number(c.req.param('userId'));
  if (!Number.isInteger(userId) || userId <= 0) throw notFound('User not found');
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ id: number }>();
  if (!target) throw notFound('User not found');
  // 全体管理者は店舗側の管理対象ではない (一覧に出ないユーザーには触れない)
  if ((await hiddenPlatformUserIds(c, ctx.store.id)).has(userId)) {
    throw notFound('User not found');
  }
  const dto = parseWith(userRolesBodySchema, await parseJson(c));
  const roles = await listRoles(c);
  const knownRoles = new Set(roles.map((r) => r.code));
  for (const a of dto.assignments) {
    if (!knownRoles.has(a.roleCode)) {
      throw new ApiError(422, 'UNKNOWN_ROLE', `Unknown role: ${a.roleCode}`);
    }
  }
  // 重複割当を除く (SQLite の UNIQUE は NULL スコープを区別しないためアプリ層でも担保)
  const seen = new Set<string>();
  const assignments = dto.assignments.filter((a) => {
    const key = `${a.roleCode}:${a.warehouseId ?? 'null'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const a of assignments) {
    if (a.warehouseId !== null) {
      const wh = await c.env.DB.prepare(
        'SELECT id FROM warehouses WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
      )
        .bind(a.warehouseId, ctx.store.id)
        .first<{ id: number }>();
      if (!wh) {
        throw new ApiError(422, 'WAREHOUSE_NOT_FOUND', `Warehouse not found: ${a.warehouseId}`);
      }
    }
  }
  // プランのユーザー上限 (0018): 組織の全店舗で distinct に数える。
  // 既に組織に所属するユーザーのロール変更・追加は増員として数えない
  if (assignments.length > 0) {
    const plan = await resolveStorePlan(c.env.DB, ctx.store.id);
    if (plan.organization && plan.def.limits.users !== null) {
      const member = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM user_roles
          WHERE user_id = ?1 AND store_id IN (SELECT id FROM stores WHERE organization_id = ?2)`,
      )
        .bind(userId, plan.organization.id)
        .first<{ n: number }>();
      if ((member?.n ?? 0) === 0) {
        const usage = await organizationUsage(c.env.DB, plan.organization.id);
        if (exceedsLimit(plan.def.limits.users, usage.users, 1)) {
          throw planLimitError(plan.def.key, 'users', plan.def.limits.users, usage.users);
        }
      }
    }
  }
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    c.env.DB
      .prepare('DELETE FROM user_roles WHERE user_id = ?1 AND store_id = ?2')
      .bind(userId, ctx.store.id),
    ...assignments.map((a) =>
      c.env.DB
        .prepare('INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id) VALUES (?1, ?2, ?3, ?4)')
        .bind(userId, a.roleCode, a.warehouseId, ctx.store.id),
    ),
    await buildAuditInsert(c.env.DB, {
      actorId: user(c).userId,
      action: 'user_roles.update',
      targetType: 'user',
      targetId: String(userId),
      payload: { assignments, storeId: ctx.store.id },
      storeId: ctx.store.id,
      createdAt: now,
    }),
  ];
  await c.env.DB.batch(stmts);
  return c.json({ userId, assignments });
});

// ------------------------------------------------------- 監査ログ / エクスポート

interface AuditLogRow {
  id: number;
  actor_id: number | null;
  action: string;
  target_type: string;
  target_id: string;
  payload: string | null;
  created_at: number;
}

function auditLogJson(r: AuditLogRow): Record<string, unknown> {
  let payload: unknown = null;
  if (r.payload !== null) {
    try {
      payload = JSON.parse(r.payload);
    } catch {
      payload = r.payload;
    }
  }
  return {
    id: r.id,
    actorId: r.actor_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    payload,
    createdAt: r.created_at,
  };
}

/**
 * 監査ログの閲覧 (admin.users)。新しい順にページングして返す。
 * クエリ: actor (actor_id), action (完全一致), from / to (created_at の ms 範囲),
 * limit (既定 50、最大 200) / offset (既定 0)。
 */
app.get('/api/v1/admin/audit-logs', async (c) => {
  await requirePermission(c, Permission.ADMIN_USERS);
  const ctx = await storeContext(c);
  // 閲覧は現在店舗の監査だけ (全体操作 = store_id NULL は店舗側には出さない)
  const conditions: string[] = ['store_id = ?'];
  const params: (number | string)[] = [ctx.store.id];
  // 全体管理者の行は存在自体を見せないため、件数・一覧の両方から除外する。
  // actor フィルタで対象者の ID を指定されても、この条件で結果は空になる。
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  if (hidden.size > 0) {
    const ids = [...hidden];
    conditions.push(`(actor_id IS NULL OR actor_id NOT IN (${ids.map(() => '?').join(',')}))`);
    params.push(...ids);
  }
  const actor = c.req.query('actor');
  if (actor !== undefined && actor !== '') {
    const actorId = Number(actor);
    if (!Number.isInteger(actorId)) throw badRequest('actor must be a user id (integer)');
    conditions.push('actor_id = ?');
    params.push(actorId);
  }
  const action = c.req.query('action');
  if (action !== undefined && action !== '') {
    conditions.push('action = ?');
    params.push(action);
  }
  const from = c.req.query('from');
  if (from !== undefined && from !== '') {
    const fromMs = Number(from);
    if (!Number.isFinite(fromMs)) throw badRequest('from must be a millisecond timestamp');
    conditions.push('created_at >= ?');
    params.push(fromMs);
  }
  const to = c.req.query('to');
  if (to !== undefined && to !== '') {
    const toMs = Number(to);
    if (!Number.isFinite(toMs)) throw badRequest('to must be a millisecond timestamp');
    conditions.push('created_at <= ?');
    params.push(toMs);
  }
  const limitRaw = Number(c.req.query('limit') ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
  const offsetRaw = Number(c.req.query('offset') ?? 0);
  const offset = Number.isFinite(offsetRaw) ? Math.max(Math.trunc(offsetRaw), 0) : 0;
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs${where}`)
    .bind(...params)
    .first<{ n: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT id, actor_id, action, target_type, target_id, payload, created_at
       FROM audit_logs${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all<AuditLogRow>();
  return c.json({
    items: results.map((r) => auditLogJson(r)),
    total: totalRow?.n ?? 0,
    limit,
    offset,
  });
});

/**
 * 監査ログのハッシュチェーン検証 (admin.users、0017)。
 * 行の書き換え・削除があると { ok: false, brokenAtId } で検出する。
 * チェーン開始前 (row_hash が NULL) の行は検証対象外。
 */
app.get('/api/v1/admin/audit-integrity', async (c) => {
  await requirePermission(c, Permission.ADMIN_USERS);
  await storeContext(c);
  const result = await verifyAuditChain(c.env.DB);
  return c.json(result);
});

/**
 * データエクスポート (admin.users)。業務データの主要テーブルを丸ごと JSON で返す。
 * sessions (認証情報)、idempotency_keys と write_guards (配送・整合性担保の内部状態)
 * は含めない (README「バックアップとデータエクスポート」参照)。
 */
const EXPORT_TABLES = [
  'users',
  'roles',
  'user_roles',
  'warehouses',
  'locations',
  'products',
  'lots',
  'stocks',
  'stock_movements',
  'stocktakes',
  'stocktake_lines',
  'negative_stock_approvals',
  'audit_logs',
  'permissions',
  'role_permissions',
] as const;

/**
 * エクスポート時の店舗スコープ条件 (テーブル名 -> WHERE 句)。
 * store_id を直接持つテーブルは現在店舗で絞り、user_roles は全体割当
 * (store_id NULL) もその店舗のユーザーデータとして含める。locations と
 * stocktake_lines は親 (倉庫・棚卸し) 経由で絞る。
 */
const EXPORT_STORE_SCOPES: Record<string, string> = {
  warehouses: 'store_id = ?',
  products: 'store_id = ?',
  lots: 'store_id = ?',
  stocks: 'store_id = ?',
  stock_movements: 'store_id = ?',
  stocktakes: 'store_id = ?',
  negative_stock_approvals: 'store_id = ?',
  audit_logs: 'store_id = ?',
  user_roles: '(store_id = ? OR store_id IS NULL)',
  locations: 'warehouse_id IN (SELECT id FROM warehouses WHERE store_id = ?)',
  stocktake_lines: 'stocktake_id IN (SELECT id FROM stocktakes WHERE store_id = ?)',
};

app.get('/api/v1/admin/export.json', async (c) => {
  await requirePermission(c, Permission.ADMIN_USERS);
  // 重要操作: 全データの持ち出しには再認証 (ステップアップ) を要求する
  await requireStepUp(c);
  const ctx = await storeContext(c);
  // 全体管理者 (現在店舗の割当を持たない) の users 行と、その全体割当の行は
  // 店舗側のエクスポートに含めない (名前・メール・外部 ID を出さない)
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  const tables: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    const scope = EXPORT_STORE_SCOPES[table];
    let rows: Record<string, unknown>[] = [];
    try {
      const stmt = c.env.DB.prepare(
        `SELECT * FROM ${table}${scope ? ` WHERE ${scope}` : ''} ORDER BY rowid ASC`,
      );
      const { results } = await (scope ? stmt.bind(ctx.store.id) : stmt).all();
      rows = results as Record<string, unknown>[];
    } catch {
      // スコープ列が無い環境では無条件で出し、それも無ければ空配列にする
      try {
        const { results } = await c.env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all();
        rows = results as Record<string, unknown>[];
      } catch {
        rows = [];
      }
    }
    if (table === 'users') rows = rows.filter((r) => !hidden.has(Number(r.id)));
    if (table === 'user_roles') rows = rows.filter((r) => !hidden.has(Number(r.user_id)));
    tables[table] = rows;
  }
  return c.json(
    { exportedAt: Date.now(), storeId: ctx.store.id, tables },
    200,
    { 'Content-Disposition': 'attachment; filename="inventory-export.json"' },
  );
});


// ------------------------------------------------------------ お知らせ / Web プッシュ
// 閲覧は全ログインユーザー (現在店舗で見える掲載中のみ)、投稿管理は
// announcements.write 権限。機能フラグ announcements が OFF の店舗では
// 閲覧・管理とも 403 FEATURE_DISABLED。プッシュ購読はフラグ対象外
// (鍵未設定の環境でも購読 UI 側の出し分けで扱う)。

const announcementBodySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  priority: z.enum(['normal', 'important']).optional(),
  /** 省略時は現在店舗宛。null は全店舗宛 (SYSTEM_ADMIN のみ) */
  storeId: z.number().int().positive().nullable().optional(),
  /** 省略時は即時掲載 (現在時刻) */
  startsAt: z.number().int().positive().optional(),
  /** 省略時・null は無期限 */
  endsAt: z.number().int().positive().nullable().optional(),
  push: z.boolean().optional(),
});

const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(128),
  }),
  userAgent: z.string().max(512).optional(),
});

const pushUnsubscribeSchema = z.object({ endpoint: z.string().min(1).max(2048) });

async function loadAnnouncementRow(c: AppContext, id: number): Promise<AnnouncementRow> {
  const row = await c.env.DB.prepare('SELECT * FROM announcements WHERE id = ?1')
    .bind(id)
    .first<AnnouncementRow>();
  if (!row) throw notFound('Announcement not found');
  return row;
}

/**
 * 店舗側の管理応答用のお知らせ JSON。全体管理者は存在自体を見せないため、
 * 投稿者 ID を伏せるだけでなく、既読数 (readCount) と対象ユーザー数
 * (targetUsers) の母数からも全体管理者を除く。共有 lib の
 * announcementAdminJson は全体管理コンソールでも使うため、ここで店舗側
 * だけに効く調整を行う。
 * - 店舗宛の対象数は現在店舗の割当ベースで、対象者は割当を持たないため不変。
 * - 全店舗宛の対象数は有効な全ユーザー数のため、有効な対象者の分を引く。
 */
async function announcementAdminJsonForStore(
  c: AppContext,
  ctx: StoreContext,
  row: AnnouncementRow,
): Promise<Record<string, unknown>> {
  const json = await announcementAdminJson(c.env.DB, row);
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  if (hidden.size === 0) return { ...json };
  const out: Record<string, unknown> = {
    ...json,
    createdBy: anonymizeUserId(json.createdBy, hidden),
  };
  const ids = [...hidden];
  const marks = ids.map(() => '?').join(',');
  const reads = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM announcement_reads
        WHERE announcement_id = ?1 AND user_id NOT IN (${marks})`,
    )
    .bind(row.id, ...ids)
    .first<{ n: number }>();
  out.readCount = reads?.n ?? 0;
  if (row.store_id === null && typeof json.targetUsers === 'number') {
    const hiddenActive = await c.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND id IN (${marks})`)
      .bind(...ids)
      .first<{ n: number }>();
    out.targetUsers = Math.max(0, json.targetUsers - (hiddenActive?.n ?? 0));
  }
  return out;
}

/** 全店舗宛 (store_id NULL) を扱えるか: 全体管理者、または現在店舗の SYSTEM_ADMIN */
function canPostToAllStores(ctx: StoreContext): boolean {
  return (
    ctx.isPlatformAdmin || ctx.assignments.some((a) => a.roleCode === RoleCode.SYSTEM_ADMIN)
  );
}

/** このお知らせを管理 (編集・削除) できるか */
function canManageAnnouncement(ctx: StoreContext, row: AnnouncementRow): boolean {
  if (row.store_id === ctx.store.id) return true;
  if (row.store_id === null) return canPostToAllStores(ctx);
  return false;
}

async function announcementAudit(
  c: AppContext,
  action: string,
  row: AnnouncementRow,
  auditStoreId: number,
): Promise<void> {
  await insertAudit(c.env.DB, {
    actorId: user(c).userId,
    action,
    targetType: 'announcement',
    targetId: String(row.id), // target_id は TEXT。数値のままだと D1 が "7.0" 形式で保存する
    payload: {
      title: row.title,
      storeId: row.store_id,
      priority: row.priority,
      push: row.push === 1,
    },
    storeId: auditStoreId,
    createdAt: Date.now(),
  });
}

app.get('/api/v1/announcements', async (c) => {
  const ctx = await storeContext(c);
  await requireFeature(c, 'announcements');
  const { items, unreadCount } = await listVisibleAnnouncements(
    c.env.DB,
    ctx.store.id,
    user(c).userId,
    Date.now(),
  );
  // 全体管理コンソールから投稿されたお知らせは投稿者の ID を店舗側に出さない
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json({
    items: items.map((i) => ({ ...i, createdBy: anonymizeUserId(i.createdBy, hidden) })),
    unreadCount,
  });
});

app.get('/api/v1/announcements/:id', async (c) => {
  const ctx = await storeContext(c);
  await requireFeature(c, 'announcements');
  const item = await getVisibleAnnouncement(
    c.env.DB,
    ctx.store.id,
    user(c).userId,
    Number(c.req.param('id')),
    Date.now(),
  );
  if (!item) throw notFound('Announcement not found');
  const hidden = await hiddenPlatformUserIds(c, ctx.store.id);
  return c.json({ ...item, createdBy: anonymizeUserId(item.createdBy, hidden) });
});

app.post('/api/v1/announcements/:id/read', async (c) => {
  const ctx = await storeContext(c);
  await requireFeature(c, 'announcements');
  const id = Number(c.req.param('id'));
  const item = await getVisibleAnnouncement(
    c.env.DB,
    ctx.store.id,
    user(c).userId,
    id,
    Date.now(),
  );
  if (!item) throw notFound('Announcement not found');
  await markAnnouncementRead(c.env.DB, id, user(c).userId, Date.now());
  const { unreadCount } = await listVisibleAnnouncements(
    c.env.DB,
    ctx.store.id,
    user(c).userId,
    Date.now(),
  );
  return c.json({ read: true, unreadCount });
});

/** 投稿管理の一覧 (掲載前・終了を含む。自店舗宛 + 管理できる全店舗宛) */
app.get('/api/v1/admin/announcements', async (c) => {
  await requirePermission(c, Permission.ANNOUNCEMENTS_WRITE);
  await requireFeature(c, 'announcements');
  const ctx = await storeContext(c);
  const { results } = await c.env.DB
    .prepare(
      canPostToAllStores(ctx)
        ? 'SELECT * FROM announcements WHERE store_id = ?1 OR store_id IS NULL ORDER BY created_at DESC, id DESC'
        : 'SELECT * FROM announcements WHERE store_id = ?1 ORDER BY created_at DESC, id DESC',
    )
    .bind(ctx.store.id)
    .all<AnnouncementRow>();
  const items: Record<string, unknown>[] = [];
  for (const row of results) items.push(await announcementAdminJsonForStore(c, ctx, row));
  return c.json({ items });
});

app.post('/api/v1/admin/announcements', async (c) => {
  await requirePermission(c, Permission.ANNOUNCEMENTS_WRITE);
  await requireFeature(c, 'announcements');
  const ctx = await storeContext(c);
  const dto = parseWith(announcementBodySchema, await parseJson(c));
  const storeId = dto.storeId === undefined ? ctx.store.id : dto.storeId;
  if (storeId !== null && storeId !== ctx.store.id) {
    throw forbidden('storeId must be the current store or null');
  }
  if (storeId === null && !canPostToAllStores(ctx)) {
    throw forbidden('Only SYSTEM_ADMIN can post to all stores');
  }
  const now = Date.now();
  const startsAt = dto.startsAt ?? now;
  const endsAt = dto.endsAt ?? null;
  if (endsAt !== null && endsAt <= startsAt) {
    throw new ApiError(422, 'INVALID_PERIOD', 'endsAt must be after startsAt');
  }
  const res = await c.env.DB
    .prepare(
      `INSERT INTO announcements
         (store_id, title, body, priority, starts_at, ends_at, push, push_sent_at, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?9)`,
    )
    .bind(
      storeId,
      dto.title,
      dto.body,
      dto.priority ?? 'normal',
      startsAt,
      endsAt,
      dto.push ? 1 : 0,
      user(c).userId,
      now,
    )
    .run();
  const row = await loadAnnouncementRow(c, Number(res.meta.last_row_id));
  await announcementAudit(c, 'announcement.create', row, ctx.store.id);
  // 掲載中なら即時プッシュ (未設定環境ではスキップされる)
  await maybeSendAnnouncementPush(c.env.DB, c.env, row, now);
  const fresh = await loadAnnouncementRow(c, row.id);
  return c.json(await announcementAdminJsonForStore(c, ctx, fresh), 201);
});

app.put('/api/v1/admin/announcements/:id', async (c) => {
  await requirePermission(c, Permission.ANNOUNCEMENTS_WRITE);
  await requireFeature(c, 'announcements');
  const ctx = await storeContext(c);
  const row = await loadAnnouncementRow(c, Number(c.req.param('id')));
  if (!canManageAnnouncement(ctx, row)) throw forbidden('Cannot manage this announcement');
  const dto = parseWith(announcementBodySchema, await parseJson(c));
  const storeId = dto.storeId === undefined ? row.store_id : dto.storeId;
  if (storeId !== null && storeId !== ctx.store.id) {
    throw forbidden('storeId must be the current store or null');
  }
  if (storeId === null && !canPostToAllStores(ctx)) {
    throw forbidden('Only SYSTEM_ADMIN can post to all stores');
  }
  const now = Date.now();
  const startsAt = dto.startsAt ?? row.starts_at;
  const endsAt = dto.endsAt === undefined ? row.ends_at : dto.endsAt;
  if (endsAt !== null && endsAt <= startsAt) {
    throw new ApiError(422, 'INVALID_PERIOD', 'endsAt must be after startsAt');
  }
  await c.env.DB
    .prepare(
      `UPDATE announcements
          SET store_id = ?1, title = ?2, body = ?3, priority = ?4, starts_at = ?5,
              ends_at = ?6, push = ?7, updated_at = ?8
        WHERE id = ?9`,
    )
    .bind(
      storeId,
      dto.title,
      dto.body,
      dto.priority ?? row.priority,
      startsAt,
      endsAt,
      dto.push === undefined ? row.push : dto.push ? 1 : 0,
      now,
      row.id,
    )
    .run();
  const fresh = await loadAnnouncementRow(c, row.id);
  await announcementAudit(c, 'announcement.update', fresh, ctx.store.id);
  await maybeSendAnnouncementPush(c.env.DB, c.env, fresh, now);
  return c.json(await announcementAdminJsonForStore(c, ctx, await loadAnnouncementRow(c, row.id)));
});

app.delete('/api/v1/admin/announcements/:id', async (c) => {
  await requirePermission(c, Permission.ANNOUNCEMENTS_WRITE);
  await requireFeature(c, 'announcements');
  const ctx = await storeContext(c);
  const row = await loadAnnouncementRow(c, Number(c.req.param('id')));
  if (!canManageAnnouncement(ctx, row)) throw forbidden('Cannot manage this announcement');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM announcement_reads WHERE announcement_id = ?1').bind(row.id),
    c.env.DB.prepare('DELETE FROM announcements WHERE id = ?1').bind(row.id),
  ]);
  await announcementAudit(c, 'announcement.delete', row, ctx.store.id);
  return c.json({ deleted: true });
});

/** プッシュ購読用の公開鍵。VAPID 未設定なら 503 PUSH_NOT_CONFIGURED */
app.get('/api/v1/push/public-key', (c) => {
  const publicKey = c.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    throw new ApiError(503, 'PUSH_NOT_CONFIGURED', 'Web Push is not configured');
  }
  return c.json({ publicKey });
});

/** 自分の購読を登録 (endpoint で upsert。他ユーザーの endpoint は自分へ付け替える) */
app.post('/api/v1/push/subscribe', async (c) => {
  const dto = parseWith(pushSubscribeSchema, await parseJson(c));
  const now = Date.now();
  await c.env.DB
    .prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, updated_at = excluded.updated_at`,
    )
    .bind(
      user(c).userId,
      dto.endpoint,
      dto.keys.p256dh,
      dto.keys.auth,
      dto.userAgent ?? c.req.header('user-agent') ?? null,
      now,
    )
    .run();
  return c.json({ subscribed: true });
});

/** 自分の購読を解除 */
app.delete('/api/v1/push/subscribe', async (c) => {
  const dto = parseWith(pushUnsubscribeSchema, await parseJson(c));
  await c.env.DB
    .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2')
    .bind(dto.endpoint, user(c).userId)
    .run();
  return c.json({ unsubscribed: true });
});

// ------------------------------------------------------- リアルタイム (WS)

app.get('/api/v1/realtime', async (c) => {
  assertHasAssignments(user(c));
  // 接続を現在店舗でタグ付けし、Coordinator の配信を同店舗だけに絞る
  const ctx = await softStoreContext(c);
  const url = new URL(c.req.url);
  if (ctx) url.searchParams.set('store', String(ctx.store.id));
  return coordinator(c).fetch(new Request(url, c.req.raw));
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

/**
 * scheduled (Cron) ではお知らせプッシュの予約送信を行う
 * (push=1・未送信・掲載期間に入ったものを送って push_sent_at を記録)。
 * Cron トリガの登録自体は wrangler 側の設定 (デプロイ時)。
 */
const worker: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (_controller, env, ctx) => {
    ctx.waitUntil(runScheduledAnnouncementPushes(env.DB, env));
    // 定期発注: 期限を過ぎた有効スケジュールを下書き PO 化する (0015)
    ctx.waitUntil(runScheduledPoDrafts(env.DB, Date.now()));
    // バックアップ: 最後の auto から 24 時間以上経っていれば 1 件作る (0016)
    ctx.waitUntil(
      (async () => {
        try {
          await maybeAutoBackup(env.DB, Date.now());
        } catch (e) {
          console.error('maybeAutoBackup failed', e);
        }
      })(),
    );
  },
};
export default worker;
