import { APP_CSS } from '../../workers/src/app/styles';

/**
 * 全体管理コンソール画面 (GET /)。
 * 店舗アプリにあった /platform ページを、この Worker 用に移植したもの。
 * デザインは店舗アプリの APP_CSS を流用して見た目を維持する。
 * 認証は admin_session Cookie (platform スコープのセッション) のみで、
 * API はこの Worker の /api/platform/* を呼ぶ。ログインしていない場合は
 * 案内だけを出し、データは API 側でも 401/403 で守る。
 */
export const CONSOLE_HTML = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>全体管理 | 在庫管理システム</title>
<style>${APP_CSS}</style></head>
<body>
<header class="app-header">
  <h1>全体管理</h1>
  <span class="spacer"></span>
  <span id="who" class="ws-label"></span>
  <button class="btn secondary small" id="logoutBtn" style="display:none;">ログアウト</button>
</header>
<main>
<p id="status" style="color: var(--ok);"></p>
<p id="error" style="color: var(--danger); white-space: pre-wrap;"></p>
<div id="loginGuide" class="section-box" style="display:none;">
  <p>ログインが必要です（セッションの有効期限は2時間です）。全体管理者だけがログインできます。</p>
  <p><a class="btn" href="/auth/login">Google でログインする</a></p>
</div>
<div id="guide" class="section-box" style="display:none;">
  <p>この画面はシステム全体の管理者 (全体管理者) 専用です。店舗内の管理は店舗アプリの「権限管理」から行ってください。</p>
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
function setStatus(msg) { document.getElementById('status').textContent = msg; }
function setError(msg) { document.getElementById('error').textContent = msg; }
async function api(path, opts) {
  const headers = { 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) };
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
      const st = await api('/api/platform/stores/' + s.id + '/stats');
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
    await api('/api/platform/stores/' + id, {
      method: 'PUT',
      body: JSON.stringify({ status: act === 'suspend' ? 'suspended' : 'active' }),
    });
    storeList = await api('/api/platform/stores');
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
    await api('/api/platform/stores', { method: 'POST', body: JSON.stringify({ code, name }) });
    document.getElementById('newStoreCode').value = '';
    document.getElementById('newStoreName').value = '';
    storeList = await api('/api/platform/stores');
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
    const data = await api('/api/platform/stores/' + storeId + '/features');
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
    await api('/api/platform/stores/' + storeId + '/features/' + encodeURIComponent(key), {
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
      await api('/api/platform/users/' + userId + '/assignments', {
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
    me = await api('/api/platform/me');
    document.getElementById('who').textContent = (me.email || '') + ' でログイン中';
    document.getElementById('logoutBtn').style.display = '';
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
    storeList = await api('/api/platform/stores');
    await renderStores();
    await loadFeatures();
  } catch (e) {
    setError(String(e && e.message ? e.message : e));
    return;
  }
  try {
    const roleData = await api('/api/platform/roles');
    roleList = roleData.roles;
  } catch (e) { roleList = []; }
  try {
    userList = await api('/api/platform/users');
    renderUsers();
  } catch (e) {
    setError(String(e && e.message ? e.message : e));
  }
}

document.getElementById('logoutBtn').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* セッションが既に無い場合も画面は戻す */ }
  location.reload();
};
document.getElementById('createStore').onclick = createStore;
document.getElementById('featureStore').onchange = loadFeatures;
loadAll();
</script>
</body>
</html>`;
