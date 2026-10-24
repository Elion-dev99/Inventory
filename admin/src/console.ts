import { APP_CSS } from '../../workers/src/app/styles';

/**
 * 全体管理コンソール画面 (GET /)。
 * 左サイドバー + 5 セクション (概要 / 店舗 / ユーザー / 監査 / システム) の
 * 単一ページ。デザインは店舗アプリの APP_CSS を流用し、サイドバー等の
 * 不足分だけ EXTRA_CSS で補う (フラットな単色と影のみ)。
 * 認証は admin_session Cookie (platform スコープのセッション) のみで、
 * API はこの Worker の /api/platform/* を呼ぶ。ログインしていない場合は
 * 案内だけを出し、データは API 側でも 401/403 で守る。
 */
const EXTRA_CSS = `
.console-layout { display: flex; align-items: flex-start; max-width: 1200px; margin: 0 auto; }
.console-side { position: sticky; top: 4.2rem; flex: 0 0 10rem; display: flex; flex-direction: column; gap: 0.25rem; padding: 1rem 0.5rem; }
.side-btn { text-align: left; border: 0; background: transparent; color: var(--fg); font: inherit; font-weight: 600; padding: 0.55rem 0.8rem; border-radius: var(--r-md); cursor: pointer; }
.side-btn:hover { background: var(--surface-2); }
.side-btn.active { background: var(--control); }
.console-main { flex: 1; min-width: 0; padding: 0 1rem 3rem; }
.feed-row { padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
.feed-row:last-child { border-bottom: 0; }
.detail-box { margin-top: 1.5rem; }
.user-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.6rem; }
@media (max-width: 720px) {
  .console-layout { flex-direction: column; }
  .console-side { position: static; flex-direction: row; flex-wrap: wrap; flex-basis: auto; padding: 0.5rem; }
  .console-main { width: 100%; }
}
`;

export const CONSOLE_HTML = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>全体管理 | 在庫管理システム</title>
<style>${APP_CSS}</style>
<style>${EXTRA_CSS}</style></head>
<body>
<header class="app-header">
  <h1>全体管理</h1>
  <span class="spacer"></span>
  <span id="who" class="ws-label"></span>
  <button class="btn secondary small" id="logoutBtn" style="display:none;">ログアウト</button>
</header>
<div class="console-layout">
  <aside class="console-side" id="sideNav" style="display:none">
    <button class="side-btn active" data-sec="overview">概要</button>
    <button class="side-btn" data-sec="stores">店舗</button>
    <button class="side-btn" data-sec="users">ユーザー</button>
    <button class="side-btn" data-sec="audit">監査</button>
    <button class="side-btn" data-sec="system">システム</button>
  </aside>
  <main class="console-main">
<p id="status" style="color: var(--ok);"></p>
<p id="error" style="color: var(--danger); white-space: pre-wrap;"></p>
<div id="loginGuide" class="section-box" style="display:none;">
  <p>ログインが必要です（セッションの有効期限は2時間です）。全体管理者だけがログインできます。</p>
  <p><a class="btn" href="/auth/login">Google でログインする</a></p>
</div>
<div id="guide" class="section-box" style="display:none;">
  <p>この画面はシステム全体の管理者 (全体管理者) 専用です。店舗内の管理は店舗アプリの「権限管理」から行ってください。</p>
</div>

<section id="sec-overview" class="console-sec" style="display:none;">
  <h2>概要</h2>
  <div id="ovKpis" class="cards"></div>
  <h3>店舗サマリ</h3>
  <div id="ovStores"><div class="skl skl-row"></div></div>
  <h3>最近の全体操作</h3>
  <div id="ovAudit"><div class="skl skl-row"></div></div>
</section>

<section id="sec-stores" class="console-sec" style="display:none;">
  <h2>店舗一覧</h2>
  <div id="stores"><div class="skl skl-row"></div><div class="skl skl-row"></div></div>
  <h3>店舗を作成</h3>
  <div class="group"><div class="group-row static">
    <input id="newStoreCode" type="text" placeholder="店舗コード (例: TOKYO1)" style="width: 12em;">
    <input id="newStoreName" type="text" placeholder="店舗名" style="width: 14em;">
    <button class="btn" id="createStore">作成</button>
  </div></div>
  <div id="storeDetail" class="detail-box"></div>
</section>

<section id="sec-users" class="console-sec" style="display:none;">
  <h2>ユーザー</h2>
  <p class="small muted">停止するとそのユーザーは店舗アプリ・全体管理の両方にログインできなくなり、既存セッションも即時失効します。</p>
  <div class="group"><div class="group-row static">
    <input id="userQuery" type="search" placeholder="名前・メールで検索" style="flex:1;">
    <button class="btn small" id="userSearchBtn">検索</button>
  </div></div>
  <div id="users"><div class="skl skl-row"></div><div class="skl skl-row"></div></div>
</section>

<section id="sec-audit" class="console-sec" style="display:none;">
  <h2>監査ログ</h2>
  <div class="group"><div class="group-row static">
    <label>店舗 <select id="auditStore"></select></label>
    <label>ユーザー <select id="auditUser"></select></label>
    <input id="auditQ" type="search" placeholder="キーワード (操作・詳細)">
    <button class="btn small" id="auditSearchBtn">検索</button>
  </div></div>
  <p class="small muted" id="auditTotal"></p>
  <div id="auditList"><div class="skl skl-row"></div></div>
</section>

<section id="sec-system" class="console-sec" style="display:none;">
  <h2>システム</h2>
  <h3>メンテナンス</h3>
  <p class="small muted">実施中・予定は店舗アプリへ自動で反映されます (最大30秒)。全体管理者はメンテナンス中も店舗アプリを操作できます。</p>
  <div id="mntNow"><div class="skl skl-row"></div></div>
  <h4>今すぐ開始</h4>
  <div class="group">
    <div class="group-row static">
      <label>止め方 <select id="mntStartLevel">
        <option value="read_only">読み取り専用 (書き込み停止)</option>
        <option value="features">機能別停止</option>
        <option value="full">全面停止</option>
      </select></label>
      <label>対象店舗 <select id="mntStartStore"></select></label>
      <input id="mntStartMessage" type="text" placeholder="告知文 (任意)" style="flex:1;">
      <button class="btn small" id="mntStartBtn">開始</button>
    </div>
    <div class="group-row static" id="mntStartFeatures" style="display:none;"></div>
  </div>
  <h4>予定を追加</h4>
  <div class="group">
    <div class="group-row static">
      <label>種別 <select id="mntKind">
        <option value="once">単発</option>
        <option value="weekly">毎週</option>
      </select></label>
      <label>止め方 <select id="mntLevel">
        <option value="read_only">読み取り専用 (書き込み停止)</option>
        <option value="features">機能別停止</option>
        <option value="full">全面停止</option>
      </select></label>
      <label>対象店舗 <select id="mntStore"></select></label>
    </div>
    <div class="group-row static" id="mntOnceFields">
      <label>開始 <input id="mntOnceStart" type="datetime-local"></label>
      <label>終了 <input id="mntOnceEnd" type="datetime-local"></label>
      <span class="small muted">終了を空にすると終了未定</span>
    </div>
    <div class="group-row static" id="mntWeeklyFields" style="display:none;">
      <label>曜日 <select id="mntWeekday">
        <option value="0">日</option><option value="1">月</option><option value="2">火</option>
        <option value="3">水</option><option value="4">木</option><option value="5">金</option>
        <option value="6">土</option>
      </select></label>
      <label>開始 <input id="mntWeeklyStart" type="time"></label>
      <label>終了 <input id="mntWeeklyEnd" type="time"></label>
      <span class="small muted">終了が開始より前なら翌日まで</span>
    </div>
    <div class="group-row static" id="mntFeatures" style="display:none;"></div>
    <div class="group-row static">
      <input id="mntMessage" type="text" placeholder="告知文 (任意)" style="flex:1;">
      <button class="btn small" id="mntAddBtn">予定を追加</button>
    </div>
  </div>
  <h4>実施中・予定</h4>
  <div id="mntList"><div class="skl skl-row"></div></div>
  <h4>履歴</h4>
  <div id="mntRecent"></div>
  <h3>データベース</h3>
  <div id="sysTables"><div class="skl skl-row"></div></div>
  <p class="small muted" id="sysSessions"></p>
  <h3>操作</h3>
  <div class="group">
    <div class="group-row"><span class="row-label">全データエクスポート (全店舗)</span><a class="btn small" href="/api/platform/export.json">ダウンロード</a></div>
    <div class="group-row"><span class="row-label">全セッション失効 <small class="muted">自分のセッションは残ります</small></span><button class="btn small danger" id="revokeAllBtn">失効させる</button></div>
  </div>
</section>
  </main>
</div>

<script>
function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtDate(ms) { return ms ? new Date(ms).toLocaleString('ja-JP') : '—'; }
function setStatus(msg) { el('status').textContent = msg; }
function setError(msg) { el('error').textContent = msg; }
function errText(e) { return String(e && e.message ? e.message : e); }
async function api(path, opts) {
  const headers = { 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) };
  const res = await fetch(path, { credentials: 'same-origin', ...(opts || {}), headers });
  const text = await res.text();
  if (res.status === 401) {
    el('loginGuide').style.display = '';
    throw new Error('未ログインです。下のボタンからログインしてください。');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text);
  return text ? JSON.parse(text) : null;
}

let myId = null;
let storeList = [];
let roleList = [];
let userList = [];
let currentSection = '';

function storeName(id) {
  if (id === null || id === undefined) return '全体';
  const s = storeList.find((x) => x.id === id);
  return s ? s.name + ' (' + s.code + ')' : '店舗#' + id;
}

/* ---------------- セクション切り替え ---------------- */
function showSection(name) {
  currentSection = name;
  document.querySelectorAll('.console-sec').forEach((sec) => { sec.style.display = 'none'; });
  const target = el('sec-' + name);
  if (target) target.style.display = '';
  document.querySelectorAll('.side-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.sec === name);
  });
  if (name === 'overview') loadOverview();
  if (name === 'users') loadUsers();
  if (name === 'audit') loadAudit();
  if (name === 'system') loadSystem();
}
document.querySelectorAll('.side-btn').forEach((btn) => {
  btn.onclick = () => showSection(btn.dataset.sec);
});

/* ---------------- 概要 ---------------- */
async function loadOverview() {
  try {
    const data = await api('/api/platform/overview');
    const t = data.totals || {};
    const kpis = [
      ['店舗', t.stores], ['ユーザー', t.users], ['商品', t.products],
      ['在庫レコード', t.stockRecords], ['移動 (30日)', t.movements30d],
    ];
    el('ovKpis').innerHTML = kpis.map((k) =>
      '<div class="card"><div class="num">' + (k[1] || 0) + '</div><div class="lbl">' + k[0] + '</div></div>'
    ).join('');
    const sums = data.storeSummaries || [];
    if (sums.length === 0) {
      el('ovStores').textContent = '店舗がありません。';
    } else {
      let html = '<div class="table-wrap"><table><thead><tr><th>店舗</th><th>状態</th><th>ユーザー</th><th>商品</th><th>在庫レコード</th></tr></thead><tbody>';
      for (const s of sums) {
        html += '<tr><td>' + esc(s.name) + ' <small class="muted">' + esc(s.code) + '</small></td>' +
          '<td>' + (s.status === 'suspended' ? '<span class="badge badge-danger">停止中</span>' : '<span class="badge">稼働中</span>') + '</td>' +
          '<td>' + s.users + '</td><td>' + s.products + '</td><td>' + s.stockRecords + '</td></tr>';
      }
      el('ovStores').innerHTML = html + '</tbody></table></div>';
    }
    const feed = data.recentPlatformAudit || [];
    if (feed.length === 0) {
      el('ovAudit').textContent = '全体操作の記録はまだありません。';
    } else {
      el('ovAudit').innerHTML = feed.map((a) =>
        '<div class="feed-row"><small class="muted">' + fmtDate(a.createdAt) + '</small> ' +
        esc(a.actorEmail || ('#' + a.actorId)) + ' : ' + esc(a.action) +
        ' <small class="muted">' + esc(a.targetType) + ' ' + esc(a.targetId) + '</small></div>'
      ).join('');
    }
  } catch (e) {
    setError(errText(e));
  }
}

/* ---------------- 店舗 ---------------- */
async function renderStores() {
  const box = el('stores');
  if (storeList.length === 0) { box.textContent = '店舗がありません。'; return; }
  let html = '<div class="table-wrap"><table><thead><tr><th>ID</th><th>コード</th><th>店舗名</th><th>状態</th><th>統計 (ユーザー/商品/在庫/30日移動)</th><th>操作</th></tr></thead><tbody>';
  for (const s of storeList) {
    html += '<tr><td>' + s.id + '</td><td><code>' + esc(s.code) + '</code></td><td>' + esc(s.name) + '</td>' +
      '<td>' + (s.status === 'suspended' ? '<span class="badge badge-danger">停止中</span>' : '<span class="badge">稼働中</span>') + '</td>' +
      '<td id="stats-' + s.id + '">-</td>' +
      '<td><button data-store-detail="' + s.id + '">詳細</button> ' + (s.status === 'suspended'
        ? '<button data-store-act="resume" data-id="' + s.id + '">再開</button>'
        : '<button data-store-act="suspend" data-id="' + s.id + '">停止</button>') + '</td></tr>';
  }
  box.innerHTML = html + '</tbody></table></div>';
  box.querySelectorAll('button[data-store-act]').forEach((btn) => {
    btn.onclick = () => onStoreToggle(btn.dataset.storeAct, Number(btn.dataset.id));
  });
  box.querySelectorAll('button[data-store-detail]').forEach((btn) => {
    btn.onclick = () => openStoreDetail(Number(btn.dataset.storeDetail));
  });
  for (const s of storeList) {
    try {
      const st = await api('/api/platform/stores/' + s.id + '/stats');
      const cell = el('stats-' + s.id);
      if (cell) cell.textContent = st.users + ' / ' + st.products + ' / ' + st.stockRecords + ' / ' + st.movementsLast30Days;
    } catch (e) { /* 統計が取れなくても一覧は出す */ }
  }
}

async function reloadStores() {
  storeList = await api('/api/platform/stores');
  await renderStores();
  fillAuditFilters();
}

async function onStoreToggle(act, id) {
  setError(''); setStatus('保存中…');
  try {
    await api('/api/platform/stores/' + id, {
      method: 'PUT',
      body: JSON.stringify({ status: act === 'suspend' ? 'suspended' : 'active' }),
    });
    await reloadStores();
    setStatus('店舗 #' + id + ' を' + (act === 'suspend' ? '停止' : '再開') + 'しました。');
  } catch (e) {
    setStatus('');
    setError(errText(e));
  }
}

async function createStore() {
  const code = el('newStoreCode').value.trim();
  const name = el('newStoreName').value.trim();
  if (!code || !name) { setError('店舗コードと店舗名を入力してください。'); return; }
  setError(''); setStatus('作成中…');
  try {
    await api('/api/platform/stores', { method: 'POST', body: JSON.stringify({ code, name }) });
    el('newStoreCode').value = '';
    el('newStoreName').value = '';
    await reloadStores();
    setStatus('店舗「' + name + '」を作成しました。');
  } catch (e) {
    setStatus('');
    setError(errText(e));
  }
}

async function openStoreDetail(id) {
  const box = el('storeDetail');
  box.innerHTML = '<div class="skl skl-row"></div>';
  try {
    const data = await api('/api/platform/stores/' + id + '/detail');
    const s = data.store;
    let html = '<div class="section-box"><div style="display:flex; align-items:center; gap:0.75rem;">' +
      '<h3 style="margin:0;">店舗詳細: ' + esc(s.name) + ' (' + esc(s.code) + ')</h3>' +
      '<span>' + (s.status === 'suspended' ? '<span class="badge badge-danger">停止中</span>' : '<span class="badge">稼働中</span>') + '</span>' +
      '<button class="btn small secondary" id="detailClose" style="margin-left:auto;">閉じる</button></div>';
    html += '<h4>倉庫</h4>';
    if ((data.warehouses || []).length === 0) {
      html += '<p class="muted">倉庫がありません。</p>';
    } else {
      html += '<div class="table-wrap"><table><thead><tr><th>ID</th><th>コード</th><th>名前</th></tr></thead><tbody>' +
        data.warehouses.map((w) => '<tr><td>' + w.id + '</td><td><code>' + esc(w.code) + '</code></td><td>' + esc(w.name) + '</td></tr>').join('') +
        '</tbody></table></div>';
    }
    html += '<h4>所属ユーザー</h4>';
    if ((data.users || []).length === 0) {
      html += '<p class="muted">割当ユーザーがいません。</p>';
    } else {
      html += '<div class="table-wrap"><table><thead><tr><th>ユーザー</th><th>ロール</th><th>倉庫</th><th>状態</th></tr></thead><tbody>' +
        data.users.map((u) => '<tr><td>' + esc(u.email) + '</td><td>' + esc(u.roleCode) + '</td><td>' +
          (u.warehouseId === null ? '全倉庫' : u.warehouseId) + '</td><td>' + esc(u.status) + '</td></tr>').join('') +
        '</tbody></table></div>';
    }
    html += '<h4>機能フラグ (この店舗)</h4><div id="detailFeatures"><div class="skl skl-row"></div></div>';
    html += '<h4>最近の監査 (この店舗)</h4>';
    if ((data.recentAudit || []).length === 0) {
      html += '<p class="muted">記録がありません。</p>';
    } else {
      html += data.recentAudit.map((a) =>
        '<div class="feed-row"><small class="muted">' + fmtDate(a.createdAt) + '</small> ' +
        esc(a.actorEmail || ('#' + a.actorId)) + ' : ' + esc(a.action) +
        ' <small class="muted">' + esc(a.targetType) + ' ' + esc(a.targetId) + '</small></div>'
      ).join('');
    }
    html += '</div>';
    box.innerHTML = html;
    el('detailClose').onclick = () => { box.innerHTML = ''; };
    await loadStoreFeatures(id);
  } catch (e) {
    box.innerHTML = '';
    setError(errText(e));
  }
}

async function loadStoreFeatures(storeId) {
  const box = el('detailFeatures');
  if (!box) return;
  try {
    const data = await api('/api/platform/stores/' + storeId + '/features');
    let html = '<div class="group">';
    for (const f of data.features) {
      html += '<div class="group-row"><span class="row-label">' + esc(f.label) + ' <small class="muted">' + esc(f.key) + '</small></span>' +
        '<label class="switch"><input type="checkbox" data-feature="' + esc(f.key) + '"' + (f.enabled ? ' checked' : '') + '><span class="track"></span></label></div>';
    }
    box.innerHTML = html + '</div>';
    box.querySelectorAll('input[type=checkbox][data-feature]').forEach((input) => {
      input.onchange = () => toggleFeature(storeId, input.dataset.feature, input.checked, input);
    });
  } catch (e) {
    box.textContent = '機能一覧を読み込めませんでした。';
  }
}

async function toggleFeature(storeId, key, enabled, input) {
  setError(''); setStatus('保存中…');
  input.disabled = true;
  try {
    await api('/api/platform/stores/' + storeId + '/features/' + encodeURIComponent(key), {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
    setStatus('店舗 ' + storeName(storeId) + ' の機能「' + key + '」を' + (enabled ? 'オン' : 'オフ') + 'にしました。');
  } catch (e) {
    input.checked = !enabled;
    setStatus('');
    setError(errText(e));
  } finally {
    input.disabled = false;
  }
}

/* ---------------- ユーザー ---------------- */
async function loadUsers() {
  const q = el('userQuery').value.trim();
  try {
    userList = await api('/api/platform/users' + (q ? '?q=' + encodeURIComponent(q) : ''));
    renderUsers();
  } catch (e) {
    setError(errText(e));
  }
}

function renderUsers() {
  const box = el('users');
  if (userList.length === 0) { box.textContent = 'ユーザーがいません。'; return; }
  box.innerHTML = '';
  const roleOptions = roleList.map((r) => '<option value="' + esc(r.code) + '">' + esc(r.code) + '</option>').join('');
  const storeOptions = '<option value="">全体 (プラットフォーム)</option>' +
    storeList.map((s) => '<option value="' + s.id + '">' + esc(s.name) + ' (' + esc(s.code) + ')</option>').join('');
  for (const u of userList) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginBottom = '0.75rem';
    let rows = '';
    u.assignments.forEach((a, i) => {
      rows += '<li>' + esc(a.roleCode) + ' / 店舗: ' + esc(storeName(a.storeId)) + ' / 倉庫: ' + (a.warehouseId === null ? '全倉庫' : a.warehouseId) +
        ' <button data-act="remove" data-user="' + u.id + '" data-idx="' + i + '">削除</button></li>';
    });
    const summary = u.assignmentSummary || {};
    const summaryText = summary.isPlatformAdmin ? '全体管理者' : '所属 ' + (summary.storeCount || 0) + ' 店舗';
    card.innerHTML =
      '<strong>#' + u.id + ' ' + esc(u.email) + '</strong> (' + esc(u.displayName) + ') ' +
      (u.status === 'disabled' ? '<span class="badge badge-danger">停止中</span>' : '<span class="badge badge-ok">有効</span>') +
      '<div class="small muted">' + summaryText + ' ・ 最終ログイン: ' + fmtDate(u.lastLoginAt) + '</div>' +
      '<ul>' + rows + '</ul>' +
      '<select id="role-' + u.id + '">' + roleOptions + '</select> ' +
      '<select id="store-' + u.id + '">' + storeOptions + '</select> ' +
      '<input id="wh-' + u.id + '" type="number" min="1" placeholder="倉庫ID (空=全倉庫)" style="width: 11em;"> ' +
      '<button data-act="add" data-user="' + u.id + '">割当を追加</button> ' +
      '<button data-act="save" data-user="' + u.id + '">割当を保存</button>' +
      '<div class="user-actions">' +
      '<button class="btn small secondary" data-act="revoke" data-user="' + u.id + '">セッション失効</button>' +
      (u.status === 'disabled'
        ? '<button class="btn small" data-act="enable" data-user="' + u.id + '">有効化する</button>'
        : '<button class="btn small danger" data-act="disable" data-user="' + u.id + '">停止する</button>') +
      '</div>';
    box.appendChild(card);
  }
  box.querySelectorAll('button[data-act]').forEach((btn) => {
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
    setStatus('割当を外しました (「割当を保存」で確定します)。');
    return;
  }
  if (act === 'add') {
    const roleCode = el('role-' + userId).value;
    const storeRaw = el('store-' + userId).value;
    const storeId = storeRaw === '' ? null : Number(storeRaw);
    const whRaw = el('wh-' + userId).value;
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
    setStatus('割当を追加しました (「割当を保存」で確定します)。');
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
      setError(errText(e));
    }
    return;
  }
  if (act === 'revoke') {
    if (!confirm('ユーザー #' + userId + ' の全セッションを失効させますか？')) return;
    try {
      const res = await api('/api/platform/users/' + userId + '/revoke-sessions', { method: 'POST' });
      setStatus('ユーザー #' + userId + ' のセッションを ' + res.revoked + ' 件失効させました。');
    } catch (e) {
      setError(errText(e));
    }
    return;
  }
  if (act === 'disable' || act === 'enable') {
    const next = act === 'disable' ? 'disabled' : 'active';
    if (act === 'disable' && !confirm('ユーザー #' + userId + ' を停止しますか？ ログインできなくなり、全セッションが失効します。')) return;
    try {
      await api('/api/platform/users/' + userId + '/status', {
        method: 'PUT',
        body: JSON.stringify({ status: next }),
      });
      setStatus('ユーザー #' + userId + ' を' + (next === 'disabled' ? '停止' : '有効化') + 'しました。');
      await loadUsers();
    } catch (e) {
      setError(errText(e));
    }
  }
}

/* ---------------- 監査 ---------------- */
function fillAuditFilters() {
  const storeSel = el('auditStore');
  if (storeSel) {
    const current = storeSel.value;
    storeSel.innerHTML = '<option value="">全店舗</option><option value="platform">全体操作のみ</option>' +
      storeList.map((s) => '<option value="' + s.id + '">' + esc(s.name) + ' (' + esc(s.code) + ')</option>').join('');
    storeSel.value = current;
  }
  const userSel = el('auditUser');
  if (userSel) {
    const current = userSel.value;
    userSel.innerHTML = '<option value="">全ユーザー</option>' +
      userList.map((u) => '<option value="' + u.id + '">' + esc(u.email) + '</option>').join('');
    userSel.value = current;
  }
}

async function loadAudit() {
  const params = new URLSearchParams();
  const storeId = el('auditStore').value;
  if (storeId) params.set('storeId', storeId);
  const userId = el('auditUser').value;
  if (userId) params.set('userId', userId);
  const q = el('auditQ').value.trim();
  if (q) params.set('q', q);
  params.set('limit', '100');
  try {
    const data = await api('/api/platform/audit-logs?' + params.toString());
    el('auditTotal').textContent = '全 ' + data.total + ' 件 (新しい順に ' + data.items.length + ' 件表示)';
    if (data.items.length === 0) {
      el('auditList').textContent = '該当する監査ログがありません。';
      return;
    }
    let html = '<div class="table-wrap"><table><thead><tr><th>日時</th><th>店舗</th><th>ユーザー</th><th>操作</th><th>対象</th><th>詳細</th></tr></thead><tbody>';
    for (const a of data.items) {
      let detail = a.payload === null || a.payload === undefined ? '' : JSON.stringify(a.payload);
      if (detail.length > 120) detail = detail.substring(0, 120) + '…';
      html += '<tr><td>' + fmtDate(a.createdAt) + '</td><td>' + esc(a.storeName || (a.storeId === null ? '全体' : '店舗#' + a.storeId)) + '</td>' +
        '<td>' + esc(a.actorEmail || ('#' + a.actorId)) + '</td><td>' + esc(a.action) + '</td>' +
        '<td>' + esc(a.targetType) + ' ' + esc(a.targetId) + '</td><td><small>' + esc(detail) + '</small></td></tr>';
    }
    el('auditList').innerHTML = html + '</tbody></table></div>';
  } catch (e) {
    setError(errText(e));
  }
}

/* ---------------- システム ---------------- */
async function loadSystem() {
  try {
    const data = await api('/api/platform/system');
    const labels = {
      stores: '店舗', users: 'ユーザー', products: '商品', stocks: '在庫',
      stock_movements: '在庫移動', audit_logs: '監査ログ', sessions: 'セッション', purchase_orders: '発注',
    };
    let html = '<div class="table-wrap"><table><thead><tr><th>テーブル</th><th>行数</th></tr></thead><tbody>';
    for (const key of Object.keys(data.tables || {})) {
      html += '<tr><td>' + esc(labels[key] || key) + ' <small class="muted">' + esc(key) + '</small></td><td>' + data.tables[key] + '</td></tr>';
    }
    el('sysTables').innerHTML = html + '</tbody></table></div>';
    el('sysSessions').textContent = '有効なセッション: ' + data.activeSessions + ' 件';
  } catch (e) {
    setError(errText(e));
  }
  fillMaintenanceForms();
  loadMaintenance();
}

/* ---------------- メンテナンス ---------------- */
const MNT_FEATURE_OPTS = [
  ['movements', '入庫・消費'], ['transfers', '移動'], ['stocktakes', '棚卸し'],
  ['purchase_orders', '発注'], ['csv', 'CSV'], ['master', 'マスタ編集'], ['analytics', '分析'],
];
const MNT_LEVEL_LABELS = { read_only: '読み取り専用', features: '機能別停止', full: '全面停止' };
const MNT_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const MNT_STATE_LABELS = { active: '実施中', scheduled: '予定', finished: '終了', cancelled: '取消' };
let mntFormsFilled = false;

function mntFeatureLabel(key) {
  const found = MNT_FEATURE_OPTS.find((o) => o[0] === key);
  return found ? found[1] : key;
}
function fmtMinutesOfDay(m) {
  const mm = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(mm / 60)).padStart(2, '0') + ':' + String(mm % 60).padStart(2, '0');
}
function windowPeriod(w) {
  if (w.kind === 'weekly') {
    return '毎週' + MNT_WEEKDAYS[w.weekday] + '曜 ' + fmtMinutesOfDay(w.startMinute) + '〜' +
      fmtMinutesOfDay(w.endMinute) + (w.endMinute > 1440 ? ' (翌日)' : '');
  }
  return fmtDate(w.startsAt) + ' 〜 ' + (w.endsAt ? fmtDate(w.endsAt) : '終了未定');
}
function windowDesc(w) {
  let s = MNT_STATE_LABELS[w.state] + ': ' + MNT_LEVEL_LABELS[w.level];
  if (w.level === 'features') {
    s += ' (' + (w.features || []).map(mntFeatureLabel).join('・') + ')';
  }
  s += ' / ' + (w.storeId === null ? '全店舗' : storeName(w.storeId));
  s += ' / ' + windowPeriod(w);
  if (w.kind === 'weekly' && (w.state === 'active' || w.state === 'scheduled')) {
    s += ' (今回: ' + fmtDate(w.occurrenceStartsAt) + '〜' + (w.occurrenceEndsAt ? fmtDate(w.occurrenceEndsAt) : '終了未定') + ')';
  }
  if (w.message) s += ' / ' + w.message;
  return s;
}
function fillFeatureChecks(boxId) {
  el(boxId).innerHTML = MNT_FEATURE_OPTS.map((o) =>
    '<label style="margin-right:0.9rem;"><input type="checkbox" value="' + o[0] + '"> ' + o[1] + '</label>'
  ).join('');
}
function checkedFeatures(boxId) {
  return Array.from(el(boxId).querySelectorAll('input[type=checkbox]:checked')).map((i) => i.value);
}
function fillStoreSelect(selId) {
  el(selId).innerHTML = '<option value="">全店舗</option>' + storeList.map((s) =>
    '<option value="' + s.id + '">' + esc(s.name) + '</option>'
  ).join('');
}
function storeSelectValue(selId) {
  const v = el(selId).value;
  return v === '' ? null : Number(v);
}
function syncMaintenanceFormVisibility() {
  el('mntStartFeatures').style.display = el('mntStartLevel').value === 'features' ? '' : 'none';
  el('mntFeatures').style.display = el('mntLevel').value === 'features' ? '' : 'none';
  const weekly = el('mntKind').value === 'weekly';
  el('mntWeeklyFields').style.display = weekly ? '' : 'none';
  el('mntOnceFields').style.display = weekly ? 'none' : '';
}
function fillMaintenanceForms() {
  if (mntFormsFilled) return;
  mntFormsFilled = true;
  fillFeatureChecks('mntStartFeatures');
  fillFeatureChecks('mntFeatures');
  fillStoreSelect('mntStartStore');
  fillStoreSelect('mntStore');
  el('mntStartLevel').onchange = syncMaintenanceFormVisibility;
  el('mntLevel').onchange = syncMaintenanceFormVisibility;
  el('mntKind').onchange = syncMaintenanceFormVisibility;
  syncMaintenanceFormVisibility();
}

async function loadMaintenance() {
  try {
    const data = await api('/api/platform/maintenance');
    const active = data.active || [];
    if (active.length === 0) {
      el('mntNow').innerHTML = '<div class="group"><div class="group-row"><span class="row-label">現在の状態</span><span>実施中のメンテナンスはありません</span></div></div>';
    } else {
      el('mntNow').innerHTML = '<div class="group">' + active.map((w) =>
        '<div class="group-row"><span class="row-label">' + esc(windowDesc(w)) + '</span><span class="badge badge-danger">実施中</span></div>'
      ).join('') + '</div>';
    }
    const items = active.concat(data.scheduled || []);
    if (items.length === 0) {
      el('mntList').textContent = '実施中・予定のメンテナンスはありません。';
    } else {
      el('mntList').innerHTML = items.map((w) => {
        let btns = '';
        if (w.kind === 'once') {
          btns += '<button data-mnt-ext="30" data-id="' + w.id + '">+30分</button> ' +
            '<button data-mnt-ext="60" data-id="' + w.id + '">+1時間</button> ';
        }
        btns += '<button data-mnt-end="' + w.id + '">' + (w.state === 'active' ? '終了' : '取消') + '</button>';
        return '<div class="feed-row">' + esc(windowDesc(w)) + ' ' + btns + '</div>';
      }).join('');
      el('mntList').querySelectorAll('button[data-mnt-ext]').forEach((b) => {
        b.onclick = () => extendWindow(Number(b.dataset.id), Number(b.dataset.mntExt));
      });
      el('mntList').querySelectorAll('button[data-mnt-end]').forEach((b) => {
        b.onclick = () => endWindow(Number(b.dataset.mntEnd));
      });
    }
    const recent = data.recent || [];
    el('mntRecent').innerHTML = recent.length === 0 ? '履歴はありません。' : recent.map((w) =>
      '<div class="feed-row"><small class="muted">' + fmtDate(w.cancelledAt || w.endsAt || w.createdAt) + '</small> ' + esc(windowDesc(w)) + '</div>'
    ).join('');
  } catch (e) {
    setError(errText(e));
  }
}

async function startMaintenanceNow() {
  setError(''); setStatus('開始中…');
  try {
    const level = el('mntStartLevel').value;
    const body = {
      kind: 'once', startsAt: Date.now(), endsAt: null, level: level,
      storeId: storeSelectValue('mntStartStore'),
      message: el('mntStartMessage').value || null,
    };
    if (level === 'features') body.features = checkedFeatures('mntStartFeatures');
    await api('/api/platform/maintenance/windows', { method: 'POST', body: JSON.stringify(body) });
    el('mntStartMessage').value = '';
    setStatus('メンテナンスを開始しました。');
    loadMaintenance();
  } catch (e) {
    setStatus('');
    setError(errText(e));
  }
}

function timeToMinutes(v) {
  const p = v.split(':');
  return Number(p[0]) * 60 + Number(p[1]);
}

async function addWindow() {
  setError(''); setStatus('追加中…');
  try {
    const kind = el('mntKind').value;
    const level = el('mntLevel').value;
    const body = {
      kind: kind, level: level, storeId: storeSelectValue('mntStore'),
      message: el('mntMessage').value || null,
    };
    if (level === 'features') body.features = checkedFeatures('mntFeatures');
    if (kind === 'once') {
      const s = el('mntOnceStart').value;
      const e = el('mntOnceEnd').value;
      if (!s) { setStatus(''); setError('開始日時を入力してください。'); return; }
      body.startsAt = new Date(s).getTime();
      body.endsAt = e ? new Date(e).getTime() : null;
    } else {
      const st = el('mntWeeklyStart').value;
      const en = el('mntWeeklyEnd').value;
      if (!st || !en) { setStatus(''); setError('開始・終了時刻を入力してください。'); return; }
      const sm = timeToMinutes(st);
      let em = timeToMinutes(en);
      if (em <= sm) em += 1440;
      body.weekday = Number(el('mntWeekday').value);
      body.startMinute = sm;
      body.endMinute = em;
    }
    await api('/api/platform/maintenance/windows', { method: 'POST', body: JSON.stringify(body) });
    el('mntMessage').value = '';
    setStatus('メンテナンス予定を追加しました。');
    loadMaintenance();
  } catch (e) {
    setStatus('');
    setError(errText(e));
  }
}

async function extendWindow(id, minutes) {
  setError(''); setStatus('延長中…');
  try {
    await api('/api/platform/maintenance/windows/' + id + '/extend', {
      method: 'POST', body: JSON.stringify({ minutes: minutes }),
    });
    setStatus('メンテナンス #' + id + ' を ' + minutes + ' 分延長しました。');
    loadMaintenance();
  } catch (e) {
    setStatus('');
    setError(errText(e));
  }
}

async function endWindow(id) {
  if (!confirm('このメンテナンスを終了/取消しますか？')) return;
  setError(''); setStatus('');
  try {
    await api('/api/platform/maintenance/windows/' + id + '/end', { method: 'POST' });
    setStatus('メンテナンス #' + id + ' を終了/取消しました。');
    loadMaintenance();
  } catch (e) {
    setError(errText(e));
  }
}

async function revokeAllSessions() {
  if (!confirm('自分以外の全セッションを失効させますか？')) return;
  setError(''); setStatus('');
  try {
    const res = await api('/api/platform/revoke-all-sessions', { method: 'POST' });
    setStatus(res.revoked + ' 件のセッションを失効させました。');
    loadSystem();
  } catch (e) {
    setError(errText(e));
  }
}

/* ---------------- 起動 ---------------- */
async function loadAll() {
  let me;
  try {
    me = await api('/api/platform/me');
    myId = me.id;
    el('who').textContent = (me.email || '') + ' でログイン中';
    el('logoutBtn').style.display = '';
  } catch (e) {
    el('who').textContent = '未ログイン';
    setError(errText(e));
    return;
  }
  if (!me.isPlatformAdmin) {
    el('guide').style.display = '';
    return;
  }
  el('sideNav').style.display = '';
  try {
    storeList = await api('/api/platform/stores');
    await renderStores();
  } catch (e) {
    setError(errText(e));
    return;
  }
  try {
    const roleData = await api('/api/platform/roles');
    roleList = roleData.roles;
  } catch (e) { roleList = []; }
  try {
    userList = await api('/api/platform/users');
  } catch (e) { userList = []; }
  fillAuditFilters();
  showSection('overview');
}

el('logoutBtn').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* セッションが既に無い場合も画面は戻す */ }
  location.reload();
};
el('createStore').onclick = createStore;
el('userSearchBtn').onclick = loadUsers;
el('auditSearchBtn').onclick = loadAudit;
el('mntStartBtn').onclick = startMaintenanceNow;
el('mntAddBtn').onclick = addWindow;
el('revokeAllBtn').onclick = revokeAllSessions;
loadAll();
</script>
</body>
</html>`;
