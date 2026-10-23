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
  destroySession,
  sessionCookieHeader,
  setSessionStore,
} from './lib/session';
import { APP_HTML } from './app/page';
import { APP_CSS } from './app/styles';
import { PWA_HEAD, manifestResponse, iconResponse } from './pwa';
import { ApiError, badRequest, forbidden, notFound } from './lib/errors';
import { isExpired } from './fefo';
import {
  consumptionSchema,
  countedQuantitySchema,
  createApprovalSchema,
  createLocationSchema,
  createLotSchema,
  createProductSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  createWarehouseSchema,
  decideApprovalSchema,
  decideStocktakeSchema,
  formatDateOnly,
  inboundSchema,
  parseDateOnly,
  receivePurchaseOrderSchema,
  transferSchema,
  updateLocationSchema,
  updateLotSchema,
  updateProductSchema,
  updateSupplierSchema,
  updateWarehouseSchema,
} from './lib/schemas';
import {
  defaultFeatures,
  FEATURE_CATALOG,
  FEATURE_KEYS,
  getFeatures,
  isFeatureEnabled,
} from './lib/features';
import { parseCsv, toCsv } from './lib/csv';

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
};
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
<p><a href="/platform">全体管理</a> (全体管理者用: 店舗の管理とユーザー×店舗の割当)</p>
</body>
</html>`),
);

// ------------------------------------------------------------ フロントエンド SPA
// /app で配信する単一ページアプリ (src/app/)。認証は Cookie セッションで、
// 未ログイン時はアプリ側が /api/v1/me の 401 を見てログイン導線を出す。
app.get('/app', (c) => c.html(APP_HTML));

// PWA: ホーム画面追加でブラウザのバーを出さずにフルスクリーン起動する
app.get('/manifest.webmanifest', () => manifestResponse());
app.get('/icons/:name', (c) => iconResponse(c.req.param('name')) ?? c.notFound());

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
td.perm-cell { text-align: center; }
td.perm-cell input[type=checkbox] { width: 1.25rem; height: 1.25rem; }
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

<h2>ロール × 権限マトリクス</h2>
<div class="table-wrap"><div id="matrix"><div class="skl skl-row"></div><div class="skl skl-row"></div><div class="skl skl-row"></div></div></div>
<button id="saveMatrix" class="btn" style="margin-top: 0.75rem;">マトリクスを保存</button>

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

function renderMatrix() {
  const el = document.getElementById('matrix');
  if (roleList.length === 0) { el.textContent = 'ロールがありません。'; return; }
  let html = '<table><thead><tr><th>権限</th>';
  for (const r of roleList) html += '<th>' + r.code + '<br><small>' + r.name + '</small></th>';
  html += '</tr></thead><tbody>';
  for (const p of catalog) {
    html += '<tr><td><code>' + p.key + '</code><br><small>' + (p.label || '') + '</small></td>';
    for (const r of roleList) {
      const checked = (matrix[r.code] || []).includes(p.key) ? ' checked' : '';
      html += '<td class="perm-cell"><input type="checkbox" data-role="' + r.code + '" data-perm="' + p.key + '"' + checked + '></td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  el.innerHTML = html;
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

document.getElementById('saveMatrix').onclick = saveMatrix;
loadAll();
</script>
</body>
</html>`),
);

// ------------------------------------------------------------ 全体管理コンソール
// /admin/permissions と同じ Cookie セッション + APP_CSS で配信する。
// 店舗ではなくシステム全体 (全店舗) を扱う画面で、全体管理者以外には
// 案内だけを出す (API 側でも全エンドポイントが 403 で守る)。
app.get('/platform', (c) =>
  c.html(`<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>全体管理 | 在庫管理システム</title>${PWA_HEAD}
<style>${APP_CSS}</style></head>
<body>
<header class="app-header">
  <img class="app-icon" src="/icons/icon-192.png" alt="">
  <h1>全体管理</h1>
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
<div id="guide" class="section-box" style="display:none;">
  <p>この画面はシステム全体の管理者 (全体管理者) 専用です。店舗内の管理はアプリの「権限管理」から行ってください。</p>
</div>

<div id="console" style="display:none;">
<h2>店舗一覧</h2>
<div id="stores"><div class="skl skl-row"></div><div class="skl skl-row"></div></div>
<h3>店舗を作成</h3>
<div class="group"><div class="group-row static">
  <input id="newStoreCode" type="text" placeholder="店舗コード (例: TOKYO1)" style="width: 12em;">
  <input id="newStoreName" type="text" placeholder="店舗名" style="width: 14em;">
  <button class="btn" id="createStore">作成</button>
</div></div>

<h2>店舗ごとの機能フラグ</h2>
<p class="small muted">対象店舗を選ぶと、その店舗の機能フラグを切り替えられます (店舗ごとに独立しています)。</p>
<div class="group"><div class="group-row static">
  <label>対象店舗 <select id="featureStore"></select></label>
</div></div>
<div id="features"><div class="skl skl-row"></div></div>

<h2>ユーザー × 店舗の割当</h2>
<p class="small muted">店舗セレクトで「全体」を選ぶと全体管理者の割当になります (SYSTEM_ADMIN のみ)。倉庫IDは任意です (空 = その店舗の全倉庫)。</p>
<div id="users"><div class="skl skl-row"></div><div class="skl skl-row"></div></div>
</div>
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

let storeList = [];
let roleList = [];
let userList = [];
let featureList = [];

function storeName(id) {
  if (id === null || id === undefined) return '全体';
  const s = storeList.find((x) => x.id === id);
  return s ? s.name + ' (' + s.code + ')' : '店舗#' + id;
}

async function renderStores() {
  const el = document.getElementById('stores');
  if (storeList.length === 0) { el.textContent = '店舗がありません。'; return; }
  let html = '<div class="table-wrap"><table><thead><tr><th>ID</th><th>コード</th><th>店舗名</th><th>状態</th><th>統計 (ユーザー/商品/在庫/30日移動)</th><th>操作</th></tr></thead><tbody>';
  for (const s of storeList) {
    html += '<tr><td>' + s.id + '</td><td><code>' + s.code + '</code></td><td>' + s.name + '</td>' +
      '<td>' + (s.status === 'suspended' ? '<span class="badge badge-danger">停止中</span>' : '<span class="badge">稼働中</span>') + '</td>' +
      '<td id="stats-' + s.id + '">-</td>' +
      '<td>' + (s.status === 'suspended'
        ? '<button data-store-act="resume" data-id="' + s.id + '">再開</button>'
        : '<button data-store-act="suspend" data-id="' + s.id + '">停止</button>') + '</td></tr>';
  }
  html += '</tbody></table></div>';
  el.innerHTML = html;
  el.querySelectorAll('button[data-store-act]').forEach((btn) => {
    btn.onclick = () => onStoreToggle(btn.dataset.storeAct, Number(btn.dataset.id));
  });
  for (const s of storeList) {
    try {
      const st = await api('/api/v1/platform/stores/' + s.id + '/stats');
      const cell = document.getElementById('stats-' + s.id);
      if (cell) cell.textContent = st.users + ' / ' + st.products + ' / ' + st.stockRecords + ' / ' + st.movementsLast30Days;
    } catch (e) { /* 統計が取れなくても一覧は出す */ }
  }
  const sel = document.getElementById('featureStore');
  sel.innerHTML = storeList.map((s) => '<option value="' + s.id + '">' + s.name + ' (' + s.code + ')</option>').join('');
}

async function onStoreToggle(act, id) {
  setError(''); setStatus('保存中…');
  try {
    await api('/api/v1/platform/stores/' + id, {
      method: 'PUT',
      body: JSON.stringify({ status: act === 'suspend' ? 'suspended' : 'active' }),
    });
    storeList = await api('/api/v1/platform/stores');
    await renderStores();
    setStatus('店舗 #' + id + ' を' + (act === 'suspend' ? '停止' : '再開') + 'しました。');
  } catch (e) {
    setStatus('');
    setError(String(e && e.message ? e.message : e));
  }
}

async function createStore() {
  const code = document.getElementById('newStoreCode').value.trim();
  const name = document.getElementById('newStoreName').value.trim();
  if (!code || !name) { setError('店舗コードと店舗名を入力してください。'); return; }
  setError(''); setStatus('作成中…');
  try {
    await api('/api/v1/platform/stores', { method: 'POST', body: JSON.stringify({ code, name }) });
    document.getElementById('newStoreCode').value = '';
    document.getElementById('newStoreName').value = '';
    storeList = await api('/api/v1/platform/stores');
    await renderStores();
    renderUsers();
    setStatus('店舗「' + name + '」を作成しました。');
  } catch (e) {
    setStatus('');
    setError(String(e && e.message ? e.message : e));
  }
}

async function loadFeatures() {
  const storeId = document.getElementById('featureStore').value;
  const el = document.getElementById('features');
  if (!storeId) { el.textContent = '店舗がありません。'; return; }
  try {
    const data = await api('/api/v1/platform/stores/' + storeId + '/features');
    featureList = data.features;
    let html = '<div class="group">';
    for (const f of featureList) {
      html += '<div class="group-row"><span class="row-label">' + f.label + ' <small class="muted">' + f.key + '</small></span>' +
        '<label class="switch"><input type="checkbox" data-feature="' + f.key + '"' + (f.enabled ? ' checked' : '') + '><span class="track"></span></label></div>';
    }
    html += '</div>';
    el.innerHTML = html;
    el.querySelectorAll('input[type=checkbox][data-feature]').forEach((box) => {
      box.onchange = () => toggleFeature(storeId, box.dataset.feature, box.checked, box);
    });
  } catch (e) {
    el.textContent = '機能一覧を読み込めませんでした。';
  }
}

async function toggleFeature(storeId, key, enabled, box) {
  setError(''); setStatus('保存中…');
  box.disabled = true;
  try {
    await api('/api/v1/platform/stores/' + storeId + '/features/' + encodeURIComponent(key), {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    setStatus('店舗 ' + storeName(Number(storeId)) + ' の機能「' + key + '」を' + (enabled ? 'オン' : 'オフ') + 'にしました。');
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
  const roleOptions = roleList.map((r) => '<option value="' + r.code + '">' + r.code + '</option>').join('');
  const storeOptions = '<option value="">全体 (プラットフォーム)</option>' +
    storeList.map((s) => '<option value="' + s.id + '">' + s.name + ' (' + s.code + ')</option>').join('');
  for (const u of userList) {
    const box = document.createElement('div');
    box.className = 'card';
    box.style.marginBottom = '0.75rem';
    let rows = '';
    u.assignments.forEach((a, i) => {
      rows += '<li>' + a.roleCode + ' / 店舗: ' + storeName(a.storeId) + ' / 倉庫: ' + (a.warehouseId === null ? '全倉庫' : a.warehouseId) +
        ' <button data-act="remove" data-user="' + u.id + '" data-idx="' + i + '">削除</button></li>';
    });
    box.innerHTML =
      '<strong>#' + u.id + ' ' + u.email + '</strong> (' + u.displayName + ', ' + u.status + ')' +
      '<ul>' + rows + '</ul>' +
      '<select id="role-' + u.id + '">' + roleOptions + '</select> ' +
      '<select id="store-' + u.id + '">' + storeOptions + '</select> ' +
      '<input id="wh-' + u.id + '" type="number" min="1" placeholder="倉庫ID (空=全倉庫)" style="width: 11em;"> ' +
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
    const storeRaw = document.getElementById('store-' + userId).value;
    const storeId = storeRaw === '' ? null : Number(storeRaw);
    const whRaw = document.getElementById('wh-' + userId).value;
    const warehouseId = whRaw === '' ? null : Number(whRaw);
    if (storeId === null && roleCode !== 'SYSTEM_ADMIN') {
      setError('全体割当は SYSTEM_ADMIN のみです。');
      return;
    }
    if (u.assignments.some((a) => a.roleCode === roleCode && a.warehouseId === warehouseId && a.storeId === storeId)) {
      setError('同じ割当が既にあります。');
      return;
    }
    u.assignments.push({ roleCode, warehouseId, storeId });
    renderUsers();
    setStatus('割当を追加しました (保存ボタンで確定します)。');
    return;
  }
  if (act === 'save') {
    try {
      await api('/api/v1/platform/users/' + userId + '/assignments', {
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
  let me;
  try {
    me = await api('/api/v1/me');
    document.getElementById('who').textContent = (me.email || '') + ' でログイン中';
  } catch (e) {
    document.getElementById('who').textContent = '未ログイン';
    setError(String(e && e.message ? e.message : e));
    return;
  }
  if (!me.isPlatformAdmin) {
    document.getElementById('guide').style.display = '';
    return;
  }
  document.getElementById('console').style.display = '';
  try {
    storeList = await api('/api/v1/platform/stores');
    await renderStores();
    await loadFeatures();
  } catch (e) {
    setError(String(e && e.message ? e.message : e));
    return;
  }
  try {
    const permData = await api('/api/v1/admin/permissions');
    roleList = permData.roles;
  } catch (e) { roleList = []; }
  try {
    userList = await api('/api/v1/platform/users');
    renderUsers();
  } catch (e) {
    setError(String(e && e.message ? e.message : e));
  }
}

document.getElementById('createStore').onclick = createStore;
document.getElementById('featureStore').onchange = loadFeatures;
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
 * 全体管理者チェック (プラットフォーム API のガード)。
 * 権限キーではなく「SYSTEM_ADMIN かつ store_id NULL の割当」で判定する。
 */
function requirePlatformAdmin(c: AppContext): void {
  assertHasAssignments(user(c));
  if (!isPlatformAdmin(user(c).assignments)) {
    throw forbidden('Platform admin only');
  }
}

/**
 * 機能フラグのサーバー側強制。管理者がオフにした機能は、権限があっても
 * 403 FEATURE_DISABLED で止める (画面の出し分けだけに頼らない)。
 */
async function requireFeature(c: AppContext, key: string): Promise<void> {
  const ctx = await storeContext(c);
  if (!(await isFeatureEnabled(c.env.DB, key, ctx.store.id))) {
    throw new ApiError(403, 'FEATURE_DISABLED', `Feature is disabled: ${key}`);
  }
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
  startStocktake: (input: { actorId: number; storeId: number }) => Promise<Envelope>;
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
  const rp = await loadRolePermissions(c);
  const me = user(c);
  const ctx = await softStoreContext(c);
  const platform = isPlatformAdmin(me.assignments);
  let stores: StoreInfo[] = [];
  try {
    stores = await accessibleStores(c.env.DB, me);
  } catch {
    // stores 未適用の環境では店舗なしとして扱う
  }
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
    features: ctx ? await getFeatures(c.env.DB, ctx.store.id) : defaultFeatures(),
    stores,
    currentStore: ctx ? ctx.store : null,
    isPlatformAdmin: platform,
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

// ------------------------------------------------------------ 機能フラグ

/** 解決済みの機能フラグ (現在店舗)。/app の出し分けと管理画面の初期表示用 */
app.get('/api/v1/features', async (c) => {
  const ctx = await storeContext(c);
  return c.json({ features: await getFeatures(c.env.DB, ctx.store.id) });
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
    c.env.DB
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at)
         VALUES (?1, 'feature_flag.update', 'feature_flag', ?2, ?3, ?4, ?5)`,
      )
      .bind(user(c).userId, key, JSON.stringify({ enabled, storeId, via }), storeId, now),
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
  /** 0007 で追加。未適用環境では undefined になるため null に寄せる */
  unit_cost?: number | null;
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function listProducts(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_READ);
  const ctx = await storeContext(c);
  const skip = Number(c.req.query('skip') ?? 0);
  const take = Math.min(Number(c.req.query('take') ?? 50), 200);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM products WHERE store_id = ?1 AND deleted_at IS NULL ORDER BY id ASC LIMIT ?2 OFFSET ?3',
  )
    .bind(ctx.store.id, take, skip)
    .all<ProductRow>();
  return c.json(results.map(productJson));
}

async function createProduct(c: AppContext): Promise<Response> {
  await requirePermission(c, Permission.MASTER_WRITE);
  const ctx = await storeContext(c);
  const dto = parseWith(createProductSchema, await parseJson(c));
  const now = Date.now();
  // unit_cost 列は 0007 で追加される。未適用環境では列なし INSERT に落とす
  const withCost = await hasColumn(c, 'products', 'unit_cost');
  const sql = withCost
    ? `INSERT INTO products (store_id, sku, name, unit, barcode, safety_stock, requires_expiry, expiry_alert_days, unit_cost, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`
    : `INSERT INTO products (store_id, sku, name, unit, barcode, safety_stock, requires_expiry, expiry_alert_days, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`;
  const binds: (string | number | null)[] = [
    ctx.store.id, dto.sku, dto.name, dto.unit, dto.barcode ?? null, dto.safetyStock ?? 0,
    dto.requiresExpiry ? 1 : 0, dto.expiryAlertDays ?? null,
  ];
  if (withCost) binds.push(dto.unitCost ?? null);
  binds.push(now);
  try {
    const res = await c.env.DB.prepare(sql).bind(...binds).run();
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
  let sql = `SELECT loc.id, loc.warehouse_id AS warehouseId, loc.code, loc.name
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
  const res = await c.env.DB.prepare(
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
  return c.json(results.map(stockJson));
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
  return c.json(stockJson(row));
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
  return c.json(results);
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
    c.env.DB
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at)
         VALUES (?1, ?2, 'negative_stock_approval', ?3, ?4, ?5, ?6)`,
      )
      .bind(user(c).userId, `negative_approval.${dto.decision}`, String(id), JSON.stringify({ decision: dto.decision }), ctx.store.id, now),
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
  const envelope = await coordinator(c).startStocktake({ actorId: user(c).userId, storeId: ctx.store.id });
  return respond(c, envelope);
});

app.get('/api/v1/stocktakes', async (c) => {
  const ctx = await storeContext(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, status, started_by AS startedBy, started_at AS startedAt, confirmed_at AS confirmedAt
       FROM stocktakes WHERE store_id = ?1 ORDER BY id DESC LIMIT 50`,
  )
    .bind(ctx.store.id)
    .all();
  return c.json(results);
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

/** 棚卸しの詳細 (lines: 帳簿数・実数・差異つき)。一覧と同じく現在店舗の割当が条件 */
app.get('/api/v1/stocktakes/:id', async (c) => {
  const ctx = await storeContext(c);
  const id = Number(c.req.param('id'));
  const stocktake = await c.env.DB.prepare(
    `SELECT id, status, started_by AS startedBy, started_at AS startedAt, confirmed_at AS confirmedAt
       FROM stocktakes WHERE id = ?1 AND store_id = ?2`,
  )
    .bind(id, ctx.store.id)
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
  const ctx = await storeContext(c);
  const stocktakeId = Number(c.req.param('id'));
  const lineId = Number(c.req.param('lineId'));
  const dto = parseWith(countedQuantitySchema, await parseJson(c));
  const stocktake = await c.env.DB.prepare('SELECT id, status FROM stocktakes WHERE id = ?1 AND store_id = ?2')
    .bind(stocktakeId, ctx.store.id)
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
}

interface PurchaseOrderLineDbRow {
  id: number;
  po_id: number;
  product_id: number;
  quantity: number;
  received_quantity: number;
  unit_cost: number | null;
}

const PO_SELECT = `SELECT po.id, po.supplier_id, sup.name AS supplier_name, po.status,
                          po.expected_date, po.note, po.created_by, po.created_at, po.updated_at
                     FROM purchase_orders po
                     LEFT JOIN suppliers sup ON sup.id = po.supplier_id`;

function purchaseOrderJson(po: PurchaseOrderDbRow, lines: PurchaseOrderLineDbRow[]): Record<string, unknown> {
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
    lines: lines.map((l) => ({
      id: l.id,
      productId: l.product_id,
      quantity: l.quantity,
      receivedQuantity: l.received_quantity,
      unitCost: l.unit_cost,
    })),
  };
}

async function loadPurchaseOrder(c: AppContext, id: number, storeId: number): Promise<Record<string, unknown>> {
  const po = await c.env.DB.prepare(`${PO_SELECT} WHERE po.id = ?1 AND po.store_id = ?2`)
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
  const { results: orders } = await c.env.DB.prepare(`${PO_SELECT} WHERE po.store_id = ?1 ORDER BY po.id DESC LIMIT 100`)
    .bind(ctx.store.id)
    .all<PurchaseOrderDbRow>();
  const out: Record<string, unknown>[] = [];
  for (const po of orders) {
    const { results: lines } = await c.env.DB.prepare(
      'SELECT * FROM purchase_order_lines WHERE po_id = ?1 ORDER BY id ASC',
    )
      .bind(po.id)
      .all<PurchaseOrderLineDbRow>();
    out.push(purchaseOrderJson(po, lines));
  }
  return c.json(out);
});

/**
 * 発注提案: 安全在庫を下回った商品について、不足分と提案数量を返す。
 * 提案数量は「安全在庫の 2 倍まで補充する」ルール (safety*2 - 現在庫)。
 */
app.get('/api/v1/purchase-orders/suggestions', async (c) => {
  await requirePermission(c, Permission.PURCHASES_READ);
  await requireFeature(c, 'purchase_orders');
  const ctx = await storeContext(c);
  const reachable = reachableWarehouseIds(ctx.assignments);
  if (reachable !== null && reachable.length === 0) return c.json([]);
  const scopeJoin =
    reachable === null
      ? ''
      : ` AND sloc.warehouse_id IN (${reachable.map(() => '?').join(',')})`;
  const sql = `SELECT p.id AS productId, p.sku, p.name, p.safety_stock AS safetyStock,
                      COALESCE((SELECT SUM(s.quantity)
                                  FROM stocks s
                                  JOIN lots sl ON sl.id = s.lot_id
                                  JOIN locations sloc ON sloc.id = s.location_id
                                 WHERE sl.product_id = p.id AND s.store_id = ?${scopeJoin}), 0) AS totalQuantity
                 FROM products p
                WHERE p.deleted_at IS NULL AND p.safety_stock > 0 AND p.store_id = ?
                ORDER BY p.id ASC`;
  const { results } = await c.env.DB.prepare(sql)
    .bind(ctx.store.id, ...(reachable ?? []), ctx.store.id)
    .all<{ productId: number; sku: string; name: string; safetyStock: number; totalQuantity: number }>();
  const suggestions = results
    .filter((r) => r.safetyStock - r.totalQuantity > 0)
    .map((r) => ({
      productId: r.productId,
      sku: r.sku,
      name: r.name,
      safetyStock: r.safetyStock,
      totalQuantity: r.totalQuantity,
      shortage: r.safetyStock - r.totalQuantity,
      suggestedQuantity: r.safetyStock * 2 - r.totalQuantity,
    }));
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
  const poRes = await c.env.DB.prepare(
    `INSERT INTO purchase_orders (supplier_id, status, expected_date, note, created_by, store_id, created_at, updated_at)
     VALUES (?1, 'draft', ?2, ?3, ?4, ?5, ?6, ?6)`,
  )
    .bind(dto.supplierId, dto.expectedDate ?? null, dto.note ?? null, user(c).userId, ctx.store.id, now)
    .run();
  const poId = Number(poRes.meta.last_row_id);
  const stmts: D1PreparedStatement[] = dto.lines.map((line) =>
    c.env.DB
      .prepare(
        `INSERT INTO purchase_order_lines (po_id, product_id, quantity, received_quantity, unit_cost)
         VALUES (?1, ?2, ?3, 0, ?4)`,
      )
      .bind(poId, line.productId, line.quantity, line.unitCost ?? null),
  );
  // 作成した発注書の完全な形は lines 挿入後に組み立てるため、冪等レコードと監査は後段で入れる
  await c.env.DB.batch(stmts);
  const created = await loadPurchaseOrder(c, poId, ctx.store.id);
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO idempotency_keys (key, user_id, endpoint, request_hash, response_status, response_body, store_id, created_at)
         VALUES (?1, ?2, 'POST /api/v1/purchase-orders', ?3, 201, ?4, ?5, ?6)`,
      )
      .bind(key, user(c).userId, requestHash, JSON.stringify(created), ctx.store.id, now),
    c.env.DB
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at)
         VALUES (?1, 'purchase_order.create', 'purchase_order', ?2, ?3, ?4, ?5)`,
      )
      .bind(
        user(c).userId,
        String(poId),
        JSON.stringify({ supplierId: dto.supplierId, lines: dto.lines.length }),
        ctx.store.id,
        now,
      ),
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
  if (po.status === 'received' || po.status === 'cancelled') {
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
    if (!prior) {
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
      await c.env.DB.prepare(
        'UPDATE purchase_order_lines SET received_quantity = received_quantity + ?1 WHERE id = ?2',
      )
        .bind(line.quantity, line.lineId)
        .run();
      target.received_quantity += line.quantity;
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
    c.env.DB
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at)
         VALUES (?1, 'purchase_order.receive', 'purchase_order', ?2, ?3, ?4, ?5)`,
      )
      .bind(
        user(c).userId,
        String(poId),
        JSON.stringify({ locationId: dto.locationId, lines: dto.lines, status: nextStatus }),
        ctx.store.id,
        now,
      ),
  ]);
  return c.json(await loadPurchaseOrder(c, poId, ctx.store.id));
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
    if (r.type === 'IN' || r.type === 'TRANSFER_IN') bucket.in += r.quantityChange;
    else if (r.type === 'OUT' || r.type === 'TRANSFER_OUT') bucket.out += -r.quantityChange;
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

  return c.json({
    monthly: monthKeys.map((k) => byMonth.get(k)),
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
    c.env.DB
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at)
         VALUES (?1, 'role_permissions.update', 'role', ?2, ?3, ?4, ?5)`,
      )
      .bind(user(c).userId, roleCode, JSON.stringify({ permissions: keys }), auditStoreId, now),
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
  return c.json(users.map((u) => ({ ...u, assignments: byUser.get(u.id) ?? [] })));
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
    c.env.DB
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at)
         VALUES (?1, 'user_roles.update', 'user', ?2, ?3, ?4, ?5)`,
      )
      .bind(
        user(c).userId,
        String(userId),
        JSON.stringify({ assignments, storeId: ctx.store.id }),
        ctx.store.id,
        now,
      ),
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
  const ctx = await storeContext(c);
  const tables: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    const scope = EXPORT_STORE_SCOPES[table];
    try {
      const stmt = c.env.DB.prepare(
        `SELECT * FROM ${table}${scope ? ` WHERE ${scope}` : ''} ORDER BY rowid ASC`,
      );
      const { results } = await (scope ? stmt.bind(ctx.store.id) : stmt).all();
      tables[table] = results;
    } catch {
      // スコープ列が無い環境では無条件で出し、それも無ければ空配列にする
      try {
        const { results } = await c.env.DB.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`).all();
        tables[table] = results;
      } catch {
        tables[table] = [];
      }
    }
  }
  return c.json(
    { exportedAt: Date.now(), storeId: ctx.store.id, tables },
    200,
    { 'Content-Disposition': 'attachment; filename="inventory-export.json"' },
  );
});

// ------------------------------------------------------- 全体管理 (プラットフォーム)
// 店舗ではなくシステム全体を扱う管理 API。ガードは権限キーではなく
// 「全体管理者かどうか (SYSTEM_ADMIN かつ store_id NULL の割当)」で判定する。
// 全体操作は監査ログに残す (対象店舗がある操作は store_id = 対象店舗、
// 店舗横断の操作は store_id = NULL)。

interface StoreDbRow {
  id: number;
  code: string;
  name: string;
  status: string;
  created_at: number;
  updated_at: number;
}

function storeJson(r: StoreDbRow): Record<string, unknown> {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function storeRow(c: AppContext, id: number): Promise<StoreDbRow> {
  const row = await c.env.DB.prepare('SELECT * FROM stores WHERE id = ?1')
    .bind(id)
    .first<StoreDbRow>();
  if (!row) throw notFound('Store not found');
  return row;
}

async function platformAudit(
  c: AppContext,
  action: string,
  targetType: string,
  targetId: string,
  payload: unknown,
  storeId: number | null,
): Promise<void> {
  await c.env.DB.prepare(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, payload, store_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(user(c).userId, action, targetType, targetId, JSON.stringify(payload), storeId, Date.now())
    .run();
}

app.get('/api/v1/platform/stores', async (c) => {
  requirePlatformAdmin(c);
  const { results } = await c.env.DB.prepare('SELECT * FROM stores ORDER BY id ASC').all<StoreDbRow>();
  return c.json(results.map(storeJson));
});

const createStoreBodySchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
});

app.post('/api/v1/platform/stores', async (c) => {
  requirePlatformAdmin(c);
  const dto = parseWith(createStoreBodySchema, await parseJson(c));
  const now = Date.now();
  let res: D1Result;
  try {
    res = await c.env.DB.prepare(
      `INSERT INTO stores (code, name, status, created_at, updated_at) VALUES (?1, ?2, 'active', ?3, ?3)`,
    )
      .bind(dto.code, dto.name, now)
      .run();
  } catch {
    throw new ApiError(409, 'DUPLICATE', 'Store with this code already exists');
  }
  const id = Number(res.meta.last_row_id);
  await platformAudit(c, 'platform.store.create', 'store', String(id), { code: dto.code, name: dto.name }, id);
  return c.json(storeJson(await storeRow(c, id)), 201);
});

const updateStoreBodySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

app.put('/api/v1/platform/stores/:id', async (c) => {
  requirePlatformAdmin(c);
  const id = Number(c.req.param('id'));
  const row = await storeRow(c, id);
  const dto = parseWith(updateStoreBodySchema, await parseJson(c));
  const name = dto.name ?? row.name;
  const status = dto.status ?? row.status;
  await c.env.DB.prepare('UPDATE stores SET name = ?1, status = ?2, updated_at = ?3 WHERE id = ?4')
    .bind(name, status, Date.now(), id)
    .run();
  await platformAudit(c, 'platform.store.update', 'store', String(id), { name, status }, id);
  return c.json(storeJson(await storeRow(c, id)));
});

app.get('/api/v1/platform/stores/:id/stats', async (c) => {
  requirePlatformAdmin(c);
  const id = Number(c.req.param('id'));
  await storeRow(c, id);
  const since = Date.now() - 30 * 86_400_000;
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(DISTINCT user_id) FROM user_roles WHERE store_id = ?1) AS users,
       (SELECT COUNT(*) FROM products WHERE store_id = ?1 AND deleted_at IS NULL) AS products,
       (SELECT COUNT(*) FROM stocks WHERE store_id = ?1) AS stockRecords,
       (SELECT COUNT(*) FROM stock_movements WHERE store_id = ?1 AND created_at >= ?2) AS movements30d`,
  )
    .bind(id, since)
    .first<{ users: number; products: number; stockRecords: number; movements30d: number }>();
  return c.json({
    storeId: id,
    users: row?.users ?? 0,
    products: row?.products ?? 0,
    stockRecords: row?.stockRecords ?? 0,
    movementsLast30Days: row?.movements30d ?? 0,
  });
});

app.get('/api/v1/platform/stores/:id/features', async (c) => {
  requirePlatformAdmin(c);
  const id = Number(c.req.param('id'));
  await storeRow(c, id);
  const features = await getFeatures(c.env.DB, id);
  return c.json({
    storeId: id,
    features: FEATURE_CATALOG.map((f) => ({ key: f.key, label: f.label, enabled: features[f.key] === true })),
  });
});

app.put('/api/v1/platform/stores/:id/features/:key', async (c) => {
  requirePlatformAdmin(c);
  const id = Number(c.req.param('id'));
  await storeRow(c, id);
  const key = c.req.param('key');
  if (!FEATURE_KEYS.has(key)) {
    throw new ApiError(422, 'UNKNOWN_FEATURE', `Unknown feature key: ${key}`);
  }
  const dto = parseWith(featureFlagBodySchema, await parseJson(c));
  await upsertFeatureFlag(c, id, key, dto.enabled, 'platform');
  return c.json({ storeId: id, key, enabled: dto.enabled });
});

/** 全ユーザーと、全店舗・全体を含む全割当の一覧 (全体管理用) */
app.get('/api/v1/platform/users', async (c) => {
  requirePlatformAdmin(c);
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
    'SELECT user_id AS userId, role_code AS roleCode, warehouse_id AS warehouseId, store_id AS storeId FROM user_roles ORDER BY id ASC',
  ).all<{ userId: number; roleCode: string; warehouseId: number | null; storeId: number | null }>();
  const byUser = new Map<number, { roleCode: string; warehouseId: number | null; storeId: number | null }[]>();
  for (const r of roleRows) {
    const list = byUser.get(r.userId) ?? [];
    list.push({ roleCode: r.roleCode, warehouseId: r.warehouseId, storeId: r.storeId });
    byUser.set(r.userId, list);
  }
  return c.json(users.map((u) => ({ ...u, assignments: byUser.get(u.id) ?? [] })));
});

const platformAssignmentsBodySchema = z.object({
  assignments: z.array(
    z.object({
      roleCode: z.string().min(1),
      warehouseId: z.union([z.number().int().positive(), z.null()]),
      storeId: z.union([z.number().int().positive(), z.null()]),
    }),
  ),
});

/**
 * 割当の横断編集 (全体管理用)。ユーザーの全割当を置き換える。
 * storeId = null は全体割当で、SYSTEM_ADMIN のみ許可する。倉庫スコープは
 * その店舗の倉庫だけに付けられる。最後の全体管理者を消す変更は 422。
 */
app.put('/api/v1/platform/users/:userId/assignments', async (c) => {
  requirePlatformAdmin(c);
  const userId = Number(c.req.param('userId'));
  if (!Number.isInteger(userId) || userId <= 0) throw notFound('User not found');
  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ id: number }>();
  if (!target) throw notFound('User not found');
  const dto = parseWith(platformAssignmentsBodySchema, await parseJson(c));
  const roles = await listRoles(c);
  const knownRoles = new Set(roles.map((r) => r.code));

  const seen = new Set<string>();
  const assignments = dto.assignments.filter((a) => {
    const key = `${a.roleCode}:${a.warehouseId ?? 'null'}:${a.storeId ?? 'null'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const a of assignments) {
    if (!knownRoles.has(a.roleCode)) {
      throw new ApiError(422, 'UNKNOWN_ROLE', `Unknown role: ${a.roleCode}`);
    }
    if (a.storeId === null) {
      // 全体割当は全体管理者の印そのものなので SYSTEM_ADMIN 以外には付けない
      if (a.roleCode !== RoleCode.SYSTEM_ADMIN) {
        throw new ApiError(422, 'PLATFORM_ASSIGNMENT_ROLE', 'Platform assignment (storeId=null) requires SYSTEM_ADMIN');
      }
      if (a.warehouseId !== null) {
        throw new ApiError(422, 'PLATFORM_ASSIGNMENT_WAREHOUSE', 'Platform assignment cannot have a warehouse scope');
      }
    } else {
      const store = await getStore(c.env.DB, a.storeId);
      if (!store) {
        throw new ApiError(422, 'STORE_NOT_FOUND', `Store not found: ${a.storeId}`);
      }
    }
    if (a.warehouseId !== null) {
      const wh = await c.env.DB.prepare('SELECT id, store_id FROM warehouses WHERE id = ?1 AND deleted_at IS NULL')
        .bind(a.warehouseId)
        .first<{ id: number; store_id: number }>();
      if (!wh) {
        throw new ApiError(422, 'WAREHOUSE_NOT_FOUND', `Warehouse not found: ${a.warehouseId}`);
      }
      if (a.storeId !== null && wh.store_id !== a.storeId) {
        throw new ApiError(422, 'WAREHOUSE_STORE_MISMATCH', `Warehouse ${a.warehouseId} does not belong to store ${a.storeId}`);
      }
    }
  }

  // 締め出し防止: 全体管理者が 1 人もいなくなる変更は拒否する
  const hasPlatform = assignments.some((a) => a.roleCode === RoleCode.SYSTEM_ADMIN && a.storeId === null);
  if (!hasPlatform) {
    const others = await c.env.DB.prepare(
      `SELECT COUNT(DISTINCT user_id) AS n FROM user_roles
        WHERE role_code = 'SYSTEM_ADMIN' AND store_id IS NULL AND user_id <> ?1`,
    )
      .bind(userId)
      .first<{ n: number }>();
    const targetIsPlatform = user(c).userId === userId
      ? true
      : ((
          await c.env.DB.prepare(
            `SELECT COUNT(*) AS n FROM user_roles
              WHERE user_id = ?1 AND role_code = 'SYSTEM_ADMIN' AND store_id IS NULL`,
          )
            .bind(userId)
            .first<{ n: number }>()
        )?.n ?? 0) > 0;
    if (targetIsPlatform && (others?.n ?? 0) === 0) {
      throw new ApiError(
        422,
        'LOCKOUT_PREVENTION',
        'At least one platform admin must remain (lockout prevention)',
      );
    }
  }

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare('DELETE FROM user_roles WHERE user_id = ?1').bind(userId),
    ...assignments.map((a) =>
      c.env.DB
        .prepare('INSERT INTO user_roles (user_id, role_code, warehouse_id, store_id) VALUES (?1, ?2, ?3, ?4)')
        .bind(userId, a.roleCode, a.warehouseId, a.storeId),
    ),
  ];
  await c.env.DB.batch(stmts);
  await platformAudit(c, 'platform.user_roles.update', 'user', String(userId), { assignments }, null);
  return c.json({ userId, assignments });
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
export default app;
