import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from './env';
import {
  InventoryCoordinator,
  type ConsumeInput,
  type Envelope,
  type InboundInput,
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
  canAccessWarehouse,
  canPerformPermission,
  hasPermission,
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
  clearSessionCookieHeader,
  createSession,
  destroySession,
  sessionCookieHeader,
} from './lib/session';
import { APP_HTML } from './app/page';
import { ApiError, badRequest, forbidden, notFound } from './lib/errors';
import { isExpired } from './fefo';
import {
  consumptionSchema,
  countedQuantitySchema,
  createApprovalSchema,
  createLocationSchema,
  createLotSchema,
  createProductSchema,
  createWarehouseSchema,
  decideApprovalSchema,
  decideStocktakeSchema,
  formatDateOnly,
  inboundSchema,
  parseDateOnly,
  transferSchema,
  updateLocationSchema,
  updateLotSchema,
  updateProductSchema,
  updateWarehouseSchema,
} from './lib/schemas';
import { parseCsv, toCsv } from './lib/csv';

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

// ------------------------------------------------------------ 権限管理画面 (最小)
// 静的ページ。/login と同様に localStorage の idToken を Authorization に使って
// 管理 API を呼ぶ。権限が無い場合は API が 403 を返し、画面にエラー表示する。
app.get('/admin/permissions', (c) =>
  c.html(`<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>権限管理 | 在庫管理システム</title></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.6;">
<h1>権限管理</h1>
<p id="who"></p>
<p id="status" style="color: #27632a;"></p>
<p id="error" style="color: #b00020; white-space: pre-wrap;"></p>

<h2>ロール × 権限マトリクス</h2>
<div id="matrix">読み込み中…</div>
<button id="saveMatrix" style="padding: 0.5rem 1rem; margin-top: 0.5rem;">マトリクスを保存</button>

<h2>ユーザーとロール付与</h2>
<div id="users">読み込み中…</div>

<script>
function getToken() {
  return localStorage.getItem('idToken') || sessionStorage.getItem('idToken') || '';
}
function decodeJwt(t) {
  const p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(p))));
}
function setStatus(msg) { document.getElementById('status').textContent = msg; }
function setError(msg) { document.getElementById('error').textContent = msg; }
async function api(path, opts) {
  const t = getToken();
  if (!t) throw new Error('未ログインです。先に /login でログインしてください。');
  const res = await fetch(path, {
    ...(opts || {}),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t, ...((opts && opts.headers) || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text);
  return text ? JSON.parse(text) : null;
}

let catalog = [];
let roleList = [];
let matrix = {};
let userList = [];

function renderMatrix() {
  const el = document.getElementById('matrix');
  if (roleList.length === 0) { el.textContent = 'ロールがありません。'; return; }
  let html = '<table border="1" cellspacing="0" cellpadding="4"><thead><tr><th>権限</th>';
  for (const r of roleList) html += '<th>' + r.code + '<br><small>' + r.name + '</small></th>';
  html += '</tr></thead><tbody>';
  for (const p of catalog) {
    html += '<tr><td><code>' + p.key + '</code><br><small>' + (p.label || '') + '</small></td>';
    for (const r of roleList) {
      const checked = (matrix[r.code] || []).includes(p.key) ? ' checked' : '';
      html += '<td style="text-align:center"><input type="checkbox" data-role="' + r.code + '" data-perm="' + p.key + '"' + checked + '></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

async function saveMatrix() {
  setError(''); setStatus('保存中…');
  try {
    for (const r of roleList) {
      const boxes = document.querySelectorAll('input[type=checkbox][data-role="' + r.code + '"]:checked');
      const permissions = [...boxes].map((b) => b.dataset.perm);
      await api('/api/v1/admin/role-permissions/' + encodeURIComponent(r.code), {
        method: 'PUT',
        body: JSON.stringify({ permissions }),
      });
      matrix[r.code] = permissions;
    }
    setStatus('マトリクスを保存しました。');
  } catch (e) {
    setStatus('');
    setError(String(e && e.message ? e.message : e));
  }
}

function renderUsers() {
  const el = document.getElementById('users');
  if (userList.length === 0) { el.textContent = 'ユーザーがいません。'; return; }
  el.innerHTML = '';
  for (const u of userList) {
    const box = document.createElement('div');
    box.style.border = '1px solid #ccc';
    box.style.padding = '0.75rem';
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
  const t = getToken();
  if (!t) {
    document.getElementById('who').textContent = '未ログインです。';
    setError('先に /login でログインしてください。');
    document.getElementById('matrix').textContent = '';
    document.getElementById('users').textContent = '';
    return;
  }
  try {
    const d = decodeJwt(t);
    document.getElementById('who').textContent = 'ログイン中: ' + (d.email || d.sub);
  } catch (e) {}
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
    userList = await api('/api/v1/admin/users');
    renderUsers();
  } catch (e) {
    document.getElementById('users').textContent = '';
    setError(String(e && e.message ? e.message : e));
  }
}

document.getElementById('saveMatrix').onclick = saveMatrix;
loadAll();
</script>
</body>
</html>`),
);

// ログイン開始 (サーバー側リダイレクト、認可コードフロー)。
// ブラウザ側の JS に依存せず、通常のリンク遷移だけで進める。nonce/state は Cookie で保持する。
app.get('/auth/login', (c) => {
  const clientId = c.env.OIDC_CLIENT_ID ?? '';
  if (!clientId) return c.text('OIDC is not configured', 503);
  const nonce = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: new URL('/auth/callback', c.req.url).toString(),
    response_type: 'code',
    scope: 'openid email profile',
    nonce,
    state: nonce,
    prompt: 'select_account',
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      'Set-Cookie': `oauth_nonce=${nonce}; Path=/; Max-Age=600; SameSite=Lax`,
    },
  });
});

// OAuth リダイレクト受け口 (サーバー側で完結)。
// 認可コードを Google と交換して ID トークンを得て、検証し、users を同期して
// 結果をそのまま表示する。画面側のボタン操作は不要。
app.get('/auth/callback', async (c) => {
  const page = (title: string, body: string, status: 200 | 400 | 500 = 200) =>
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
  try {
    const payload = await verifyToken(c.env, tokenJson.id_token);
    const cookieNonce = (c.req.header('cookie') ?? '').match(/(?:^|;\s*)oauth_nonce=([^;]*)/)?.[1] ?? '';
    if (cookieNonce && payload.nonce !== cookieNonce) {
      return page('ログインに失敗しました', '<p>nonce が一致しません。もう一度ログインしてください。</p>', 400);
    }
    authUser = await syncUserFromPayload(c.env, payload);
  } catch {
    return page('ログインに失敗しました', '<p>ID トークンの検証に失敗しました。</p>', 400);
  }

  const roles =
    authUser.assignments.length > 0
      ? authUser.assignments.map((a) => a.roleCode).join(', ')
      : '未付与';
  const note =
    authUser.assignments.length > 0
      ? '<p>このまま業務 API を利用できます。</p>'
      : '<p>アカウントは作成されましたが、権限はまだ付いていません。この画面が出たことをチャットで教えてください。管理者ロールを付与します。</p>';
  // ブラウザ向けにログインセッションを発行する (Cookie は HttpOnly)。
  // 以後の API / WebSocket はこのセッションで認証できる。
  const sessionToken = await createSession(c.env.DB, authUser.userId);
  const res = page(
    'ログインしました',
    `<p>メールアドレス: ${authUser.email}</p><p>ユーザー ID: ${authUser.userId}</p><p>現在のロール: ${roles}</p>${note}<p><a href="/app">アプリを開く</a></p>`,
  );
  res.headers.append('Set-Cookie', sessionCookieHeader(sessionToken));
  return res;
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

/** 権限が無ければ 403。解決済みマトリクスを返すのでスコープ判定にも再利用できる */
async function requirePermission(
  c: AppContext,
  permission: PermissionKey,
  preloaded?: RolePermissionMap,
): Promise<RolePermissionMap> {
  assertHasAssignments(user(c));
  const rp = preloaded ?? (await loadRolePermissions(c));
  if (!hasPermission(user(c).assignments, rp, permission)) {
    throw forbidden('Insufficient permission');
  }
  return rp;
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
  transfer: (input: TransferInput) => Promise<Envelope>;
  startStocktake: (input: { actorId: number }) => Promise<Envelope>;
  finishStocktake: (input: { actorId: number; stocktakeId: number }) => Promise<Envelope>;
  decideStocktake: (input: { actorId: number; stocktakeId: number; approve: boolean }) => Promise<Envelope>;
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

// ------------------------------------------------- セッション / 自分自身 / 履歴

/** 自分の情報と実効権限。/app の初期表示と権限出し分けに使う */
app.get('/api/v1/me', async (c) => {
  const rp = await loadRolePermissions(c);
  const me = user(c);
  return c.json({
    id: me.userId,
    email: me.email,
    displayName: me.displayName,
    assignments: me.assignments,
    permissions: [...permissionsOf(me.assignments, rp)].sort(),
  });
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

/** 入出庫履歴 (stock_movements の参照)。スコープ外倉庫の履歴は出さない */
app.get('/api/v1/movements', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  const reachable = reachableWarehouseIds(user(c).assignments);
  if (reachable !== null && reachable.length === 0) return c.json([]);
  const conditions: string[] = [];
  const params: (number | string)[] = [];
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
  const skip = Number(c.req.query('skip') ?? 0);
  const take = Math.min(Number(c.req.query('take') ?? 50), 200);
  const sql =
    `SELECT mv.id, mv.document_id AS documentId, mv.stock_id AS stockId, mv.type,
            mv.quantity_change AS quantityChange, mv.quantity_before AS quantityBefore,
            mv.quantity_after AS quantityAfter, mv.actor_id AS actorId,
            mv.department, mv.purpose, mv.reason, mv.created_at AS createdAt,
            s.location_id AS locationId, loc.warehouse_id AS warehouseId,
            l.product_id AS productId, l.lot_code AS lotCode, p.sku
       FROM stock_movements mv
       JOIN stocks s ON s.id = mv.stock_id
       JOIN locations loc ON loc.id = s.location_id
       JOIN lots l ON l.id = s.lot_id
       JOIN products p ON p.id = l.product_id` +
    (conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '') +
    ' ORDER BY mv.id DESC LIMIT ? OFFSET ?';
  params.push(take, skip);
  const { results } = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(results);
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
  await requirePermission(c, Permission.MASTER_READ);
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
  await requirePermission(c, Permission.MASTER_WRITE);
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
  await requirePermission(c, Permission.MASTER_READ);
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
  await requirePermission(c, Permission.MASTER_WRITE);
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
  await requirePermission(c, Permission.MASTER_READ);
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
  await requirePermission(c, Permission.MASTER_WRITE);
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
  await requirePermission(c, Permission.MASTER_READ);
  const productId = c.req.query('productId');
  // 論理削除済みは出さない。lots.deleted_at は 0005 で追加されるため、
  // 未適用環境では従来のクエリにフォールバックする
  let sql = 'SELECT id, product_id AS productId, lot_code AS lotCode, expiry_date AS expiryMs, received_at AS receivedAt FROM lots';
  const params: number[] = [];
  const conditions: string[] = [];
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

// ------------------------------------------------------- マスタ編集・削除
// 編集・論理削除はいずれも master.write が必要。論理削除 (deleted_at) のため
// 在庫・台帳などの履歴データには影響しない (README 参照)。

async function updateProduct(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateProductSchema, await parseJson(c));
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?1 AND deleted_at IS NULL')
    .bind(id)
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
  const id = Number(c.req.param('id'));
  const now = Date.now();
  const res = await c.env.DB.prepare(
    'UPDATE products SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL',
  )
    .bind(now, id)
    .run();
  if (res.meta.changes === 0) throw notFound('Product not found');
  return c.json({ id, deleted: true });
}

async function updateWarehouse(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateWarehouseSchema, await parseJson(c));
  const row = await c.env.DB.prepare('SELECT id FROM warehouses WHERE id = ?1 AND deleted_at IS NULL')
    .bind(id)
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
  const id = Number(c.req.param('id'));
  const now = Date.now();
  const res = await c.env.DB.prepare(
    'UPDATE warehouses SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL',
  )
    .bind(now, id)
    .run();
  if (res.meta.changes === 0) throw notFound('Warehouse not found');
  return c.json({ id, deleted: true });
}

async function updateLocation(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateLocationSchema, await parseJson(c));
  const row = await c.env.DB.prepare('SELECT id, warehouse_id FROM locations WHERE id = ?1 AND deleted_at IS NULL')
    .bind(id)
    .first<{ id: number; warehouse_id: number }>();
  if (!row) throw notFound('Location not found');
  if (!canAccessWarehouse(user(c).assignments, row.warehouse_id)) {
    throw forbidden('Out of warehouse scope');
  }
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (dto.code !== undefined) { sets.push('code = ?'); params.push(dto.code); }
  if (dto.name !== undefined) { sets.push('name = ?'); params.push(dto.name); }
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
  const updated = await c.env.DB.prepare(
    'SELECT id, warehouse_id AS warehouseId, code, name FROM locations WHERE id = ?1',
  )
    .bind(id)
    .first();
  return c.json(updated);
}

async function deleteLocation(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const id = Number(c.req.param('id'));
  const warehouseId = await warehouseIdOfLocation(c, id);
  if (!canAccessWarehouse(user(c).assignments, warehouseId)) {
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
  const id = Number(c.req.param('id'));
  const dto = parseWith(updateLotSchema, await parseJson(c));
  const row = await c.env.DB.prepare('SELECT * FROM lots WHERE id = ?1 AND deleted_at IS NULL')
    .bind(id)
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
  const id = Number(c.req.param('id'));
  const now = Date.now();
  const res = await c.env.DB.prepare(
    'UPDATE lots SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL',
  )
    .bind(now, id)
    .run();
  if (res.meta.changes === 0) throw notFound('Lot not found');
  return c.json({ id, deleted: true });
}

// ------------------------------------------------------- 商品 CSV インポート
// CSV (sku,name,unit,requires_expiry) を multipart の file フィールド、
// または text/csv などの生ボディで受け取り、商品を一括登録する。
// 既存 SKU (論理削除済みを含む) はスキップし、行ごとの成否を集計して返す。

async function importProducts(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
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
  };
  if (col.sku < 0 || col.name < 0 || col.unit < 0) {
    throw badRequest('CSV header must include sku, name, unit');
  }

  const { results: existingRows } = await c.env.DB.prepare('SELECT sku FROM products').all<{
    sku: string;
  }>();
  const knownSkus = new Set(existingRows.map((r) => r.sku));

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
    try {
      await c.env.DB.prepare(
        `INSERT INTO products (sku, name, unit, barcode, safety_stock, requires_expiry, expiry_alert_days, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, 0, ?4, NULL, ?5, ?5)`,
      )
        .bind(sku, name, unit, requiresExpiry, now)
        .run();
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
  await requirePermission(c, Permission.STOCKS_READ);
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
  await requirePermission(c, Permission.STOCKS_READ);
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

/** 在庫一覧の CSV エクスポート (stocks.read、倉庫スコープ適用) */
app.get('/api/v1/stocks.csv', async (c) => {
  await requirePermission(c, Permission.STOCKS_READ);
  const reachable = reachableWarehouseIds(user(c).assignments);
  let sql = `SELECT p.sku, p.name AS product_name, w.name AS warehouse_name,
                    loc.name AS location_name, loc.code AS location_code,
                    l.lot_code, l.expiry_date, s.quantity
               FROM stocks s
               JOIN locations loc ON loc.id = s.location_id
               JOIN warehouses w ON w.id = loc.warehouse_id
               JOIN lots l ON l.id = s.lot_id
               JOIN products p ON p.id = l.product_id`;
  const params: number[] = [];
  if (reachable !== null) {
    if (reachable.length === 0) {
      return csvDownload(c, []);
    }
    sql += ` WHERE loc.warehouse_id IN (${reachable.map(() => '?').join(',')})`;
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
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(inboundSchema, raw);
  const warehouseId = await warehouseIdOfLocation(c, dto.locationId);
  if (!canPerformPermission(user(c).assignments, rp, warehouseId, Permission.MOVEMENTS_INBOUND)) {
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
  const rp = await requirePermission(c, Permission.MOVEMENTS_CONSUME);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(consumptionSchema, raw);
  if (dto.locationId !== undefined) {
    const warehouseId = await warehouseIdOfLocation(c, dto.locationId);
    if (!canPerformPermission(user(c).assignments, rp, warehouseId, Permission.MOVEMENTS_CONSUME)) {
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

app.post('/api/v1/movements/transfer', async (c) => {
  const rp = await requirePermission(c, Permission.MOVEMENTS_TRANSFER);
  const raw = (await parseJson(c)) as Record<string, unknown>;
  const dto = parseWith(transferSchema, raw);
  // 移動元・移動先の両方の倉庫に到達できることが必要
  const fromWarehouseId = await warehouseIdOfLocation(c, dto.fromLocationId);
  const toWarehouseId = await warehouseIdOfLocation(c, dto.toLocationId);
  if (
    !canPerformPermission(user(c).assignments, rp, fromWarehouseId, Permission.MOVEMENTS_TRANSFER) ||
    !canPerformPermission(user(c).assignments, rp, toWarehouseId, Permission.MOVEMENTS_TRANSFER)
  ) {
    throw forbidden('Out of warehouse scope');
  }
  const envelope = await coordinator(c).transfer({
    actorId: user(c).userId,
    endpoint: 'POST /api/v1/movements/transfer',
    idempotencyKey: requireIdempotencyKey(c),
    requestHash: await sha256Hex(JSON.stringify(raw)),
    fromLocationId: dto.fromLocationId,
    toLocationId: dto.toLocationId,
    productId: dto.productId,
    ...(dto.lotId !== undefined ? { lotId: dto.lotId } : {}),
    quantity: dto.quantity,
  });
  return respond(c, envelope);
});

// ------------------------------------------------------- マイナス在庫承認

app.post('/api/v1/negative-approvals', async (c) => {
  const rp = await requirePermission(c, Permission.NEGATIVE_REQUEST);
  const dto = parseWith(createApprovalSchema, await parseJson(c));
  const warehouseId = await warehouseIdOfStock(c, dto.stockId);
  if (!canPerformPermission(user(c).assignments, rp, warehouseId, Permission.NEGATIVE_REQUEST)) {
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
  const rp = await requirePermission(c, Permission.NEGATIVE_DECIDE);
  const id = Number(c.req.param('id'));
  const dto = parseWith(decideApprovalSchema, await parseJson(c));
  const approval = await approvalRow(c, id);
  const warehouseId = await warehouseIdOfStock(c, approval.stock_id);
  if (!canPerformPermission(user(c).assignments, rp, warehouseId, Permission.NEGATIVE_DECIDE)) {
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
  await requirePermission(c, Permission.STOCKTAKES_MANAGE);
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
  await requirePermission(c, Permission.STOCKTAKES_MANAGE);
  const envelope = await coordinator(c).finishStocktake({
    actorId: user(c).userId,
    stocktakeId: Number(c.req.param('id')),
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

/** 棚卸しの詳細 (lines: 帳簿数・実数・差異つき)。一覧と同じく割当が条件 */
app.get('/api/v1/stocktakes/:id', async (c) => {
  assertHasAssignments(user(c));
  const id = Number(c.req.param('id'));
  const stocktake = await c.env.DB.prepare(
    `SELECT id, status, started_by AS startedBy, started_at AS startedAt, confirmed_at AS confirmedAt
       FROM stocktakes WHERE id = ?1`,
  )
    .bind(id)
    .first();
  if (!stocktake) throw notFound('Stocktake not found');
  const { results } = await c.env.DB.prepare(
    `${STOCKTAKE_LINE_SQL} WHERE sl.stocktake_id = ?1 ORDER BY sl.id ASC`,
  )
    .bind(id)
    .all<StocktakeLineView>();
  return c.json({ ...stocktake, lines: results.map(stocktakeLineJson) });
});

/** 棚卸し lines への実数入力 (実施中のみ)。lines は stocks ではないため Worker が直接更新する */
app.put('/api/v1/stocktakes/:id/lines/:lineId', async (c) => {
  await requirePermission(c, Permission.STOCKTAKES_MANAGE);
  const stocktakeId = Number(c.req.param('id'));
  const lineId = Number(c.req.param('lineId'));
  const dto = parseWith(countedQuantitySchema, await parseJson(c));
  const stocktake = await c.env.DB.prepare('SELECT id, status FROM stocktakes WHERE id = ?1')
    .bind(stocktakeId)
    .first<{ id: number; status: string }>();
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
  return c.json(stocktakeLineJson(line as StocktakeLineView));
});

/** 棚卸しの差異承認/差し戻し (pending_approval のときのみ Coordinator が処理する) */
app.post('/api/v1/stocktakes/:id/decide', async (c) => {
  await requirePermission(c, Permission.STOCKTAKES_MANAGE);
  const dto = parseWith(decideStocktakeSchema, await parseJson(c));
  const envelope = await coordinator(c).decideStocktake({
    actorId: user(c).userId,
    stocktakeId: Number(c.req.param('id')),
    approve: dto.approve,
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
  await requirePermission(c, Permission.ADMIN_PERMISSIONS);
  const roleCode = c.req.param('roleCode');
  const roles = await listRoles(c);
  if (!roles.some((r) => r.code === roleCode)) throw notFound('Role not found');
  const dto = parseWith(rolePermissionsBodySchema, await parseJson(c));
  const keys = [...new Set(dto.permissions)];
  const unknown = keys.filter((k) => !PERMISSION_KEYS.has(k));
  if (unknown.length > 0) {
    throw new ApiError(422, 'UNKNOWN_PERMISSION', `Unknown permission keys: ${unknown.join(', ')}`);
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
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare('DELETE FROM role_permissions WHERE role_code = ?1').bind(roleCode),
    ...keys.map((k) =>
      c.env.DB
        .prepare('INSERT INTO role_permissions (role_code, permission_key) VALUES (?1, ?2)')
        .bind(roleCode, k),
    ),
    c.env.DB
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, created_at)
         VALUES (?1, 'role_permissions.update', 'role', ?2, ?3, ?4)`,
      )
      .bind(user(c).userId, roleCode, JSON.stringify({ permissions: keys }), now),
  ];
  await c.env.DB.batch(stmts);
  return c.json({ roleCode, permissions: keys });
});

app.get('/api/v1/admin/users', async (c) => {
  await requirePermission(c, Permission.ADMIN_USERS);
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
    'SELECT user_id AS userId, role_code AS roleCode, warehouse_id AS warehouseId FROM user_roles ORDER BY id ASC',
  ).all<{ userId: number; roleCode: string; warehouseId: number | null }>();
  const byUser = new Map<number, { roleCode: string; warehouseId: number | null }[]>();
  for (const r of roleRows) {
    const list = byUser.get(r.userId) ?? [];
    list.push({ roleCode: r.roleCode, warehouseId: r.warehouseId });
    byUser.set(r.userId, list);
  }
  return c.json(users.map((u) => ({ ...u, assignments: byUser.get(u.id) ?? [] })));
});

app.put('/api/v1/admin/users/:userId/roles', async (c) => {
  await requirePermission(c, Permission.ADMIN_USERS);
  const userId = Number(c.req.param('userId'));
  if (!Number.isInteger(userId) || userId <= 0) throw notFound('User not found');
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ id: number }>();
  if (!target) throw notFound('User not found');
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
        'SELECT id FROM warehouses WHERE id = ?1 AND deleted_at IS NULL',
      )
        .bind(a.warehouseId)
        .first<{ id: number }>();
      if (!wh) {
        throw new ApiError(422, 'WAREHOUSE_NOT_FOUND', `Warehouse not found: ${a.warehouseId}`);
      }
    }
  }
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?1').bind(userId),
    ...assignments.map((a) =>
      c.env.DB
        .prepare('INSERT INTO user_roles (user_id, role_code, warehouse_id) VALUES (?1, ?2, ?3)')
        .bind(userId, a.roleCode, a.warehouseId),
    ),
    c.env.DB
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, created_at)
         VALUES (?1, 'user_roles.update', 'user', ?2, ?3, ?4)`,
      )
      .bind(user(c).userId, String(userId), JSON.stringify({ assignments }), now),
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
  const conditions: string[] = [];
  const params: (number | string)[] = [];
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
  return c.json({ items: results.map(auditLogJson), total: totalRow?.n ?? 0, limit, offset });
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

app.get('/api/v1/admin/export.json', async (c) => {
  await requirePermission(c, Permission.ADMIN_USERS);
  const tables: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    try {
      const { results } = await c.env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all();
      tables[table] = results;
    } catch {
      // マイグレーション未適用で存在しないテーブルは空配列にする
      tables[table] = [];
    }
  }
  return c.json(
    { exportedAt: Date.now(), tables },
    200,
    { 'Content-Disposition': 'attachment; filename="inventory-export.json"' },
  );
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
