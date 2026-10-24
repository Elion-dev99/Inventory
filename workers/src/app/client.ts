/**
 * /app のクライアント JS。TS のテンプレート文字列として埋め込むため、
 * この中ではバッククォート・ドル記号付きの補間記法・バックスラッシュ
 * 付きエスケープ・終了 script タグの文字列を使わない (文字列連結で書く)。
 */
export const APP_JS = `
'use strict';

/* ---------------- helpers ---------------- */
function el(id) { return document.getElementById(id); }
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function fmtDateTime(ms) {
  if (!ms) return '-';
  var d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  var hex = '0123456789abcdef';
  var s = '';
  for (var i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else s += hex[Math.floor(Math.random() * 16)];
  }
  return s;
}
function api(path, opts) {
  opts = opts || {};
  var headers = { 'Content-Type': 'application/json' };
  if (opts.headers) { for (var k in opts.headers) headers[k] = opts.headers[k]; }
  var init = { method: opts.method || 'GET', headers: headers, credentials: 'same-origin' };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  return fetch(path, init).then(function (res) {
    return res.text().then(function (text) {
      var data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
      if (!res.ok) {
        var msg = data && data.message ? data.message : 'HTTP ' + res.status;
        var err = new Error(msg);
        err.status = res.status;
        err.code = data && data.error ? data.error : '';
        throw err;
      }
      if ((opts.method || 'GET') !== 'GET') invalidateCache();
      return data;
    });
  });
}
/* ---------------- data cache (画面遷移を即時にするための先読みキャッシュ) ---------------- */
var dataCache = {};
var CACHE_TTL = 20000;
function getJson(path) {
  var c = dataCache[path];
  if (c && Date.now() - c.at < CACHE_TTL) return Promise.resolve(c.data);
  return api(path).then(function (d) { dataCache[path] = { at: Date.now(), data: d }; return d; });
}
function invalidateCache() { dataCache = {}; }

/* ---------------- skeleton (読み込み中テキストの代わりの骨格表示) ---------------- */
var keepContent = false; /* リアルタイム更新時は前の画面を残してちらつかせない */
function skeletonHtml(kind) {
  if (kind === 'cards') {
    return '<div class="cards"><div class="skl skl-card"></div><div class="skl skl-card"></div><div class="skl skl-card"></div><div class="skl skl-card"></div></div>' +
      '<div class="skl skl-line" style="width:55%"></div><div class="skl skl-line" style="width:85%"></div><div class="skl skl-line" style="width:70%"></div>';
  }
  if (kind === 'form') {
    return '<div class="skl skl-form"></div><div class="skl skl-line" style="width:40%"></div>';
  }
  var h = '<div class="group">';
  for (var i = 0; i < 6; i++) h += '<div class="skl skl-row"></div>';
  return h + '</div>';
}
function skeletonRows() {
  var h = '';
  for (var i = 0; i < 6; i++) h += '<div class="skl skl-row"></div>';
  return h;
}
function viewLoading(title, kind) {
  if (keepContent) return;
  el('view').innerHTML = '<h2>' + esc(title) + '</h2>' + skeletonHtml(kind);
}
function errMsg(e) {
  if (e && e.status === 423) return '棚卸し実施中のため、この操作は停止しています (423)。棚卸しが終了するまでお待ちください。';
  if (e && e.code === 'STORE_SUSPENDED') return 'この店舗は現在停止中です。全体管理者に連絡してください。';
  if (e && e.code === 'STORE_NOT_SELECTED') return '店舗が選択されていません。画面を再読み込みして、店舗を選んでください。';
  return e && e.message ? e.message : String(e);
}
function msgHtml(kind, text) {
  if (!text) return '';
  return '<div class="msg ' + kind + '">' + esc(text) + '</div>';
}

/* ---------------- state ---------------- */
var state = {
  me: null,
  perms: {},
  features: {},
  view: 'dashboard',
  master: null,
  masterError: '',
  flash: '',
  refreshTimer: null,
};
function can(p) { return state.perms[p] === true; }
/* 機能フラグ (管理者がオフにした機能は画面からも消す。サーバー側でも 403 で強制される) */
function feat(key) { return state.features[key] !== false; }

/* マスタ (商品・倉庫・場所・ロット) を一度だけ読み込む */
function ensureMaster() {
  if (state.master) return Promise.resolve(state.master);
  if (!can('master.read')) {
    state.master = { products: [], warehouses: [], locations: [], lots: [], suppliers: [] };
    return Promise.resolve(state.master);
  }
  return Promise.all([
    api('/api/v1/master/products?take=200'),
    api('/api/v1/master/warehouses'),
    api('/api/v1/master/locations'),
    api('/api/v1/master/lots'),
    api('/api/v1/master/suppliers').catch(function () { return []; }),
  ]).then(function (r) {
    state.master = { products: r[0] || [], warehouses: r[1] || [], locations: r[2] || [], lots: r[3] || [], suppliers: r[4] || [] };
    return state.master;
  }).catch(function (e) {
    state.masterError = errMsg(e);
    state.master = { products: [], warehouses: [], locations: [], lots: [], suppliers: [] };
    return state.master;
  });
}
function productLabel(id) {
  var m = state.master;
  if (m) {
    for (var i = 0; i < m.products.length; i++) {
      if (m.products[i].id === id) return m.products[i].sku + ' ' + m.products[i].name;
    }
  }
  return '商品#' + id;
}
function productOf(id) {
  var m = state.master;
  if (m) { for (var i = 0; i < m.products.length; i++) { if (m.products[i].id === id) return m.products[i]; } }
  return null;
}
function warehouseOf(id) {
  var m = state.master;
  if (m) { for (var i = 0; i < m.warehouses.length; i++) { if (m.warehouses[i].id === id) return m.warehouses[i]; } }
  return null;
}
function locationOf(id) {
  var m = state.master;
  if (m) { for (var i = 0; i < m.locations.length; i++) { if (m.locations[i].id === id) return m.locations[i]; } }
  return null;
}
function lotOf(id) {
  var m = state.master;
  if (m) { for (var i = 0; i < m.lots.length; i++) { if (m.lots[i].id === id) return m.lots[i]; } }
  return null;
}
function supplierOf(id) {
  var m = state.master;
  if (m && m.suppliers) { for (var i = 0; i < m.suppliers.length; i++) { if (m.suppliers[i].id === id) return m.suppliers[i]; } }
  return null;
}
function lotLabel(id) {
  var m = state.master;
  if (m) { for (var i = 0; i < m.lots.length; i++) { if (m.lots[i].id === id) return m.lots[i].lotCode; } }
  return 'ロット#' + id;
}
function locationLabel(id) {
  var m = state.master;
  if (m) {
    for (var i = 0; i < m.locations.length; i++) {
      if (m.locations[i].id === id) {
        var loc = m.locations[i];
        var wh = '';
        for (var j = 0; j < m.warehouses.length; j++) {
          if (m.warehouses[j].id === loc.warehouseId) wh = m.warehouses[j].name + ' / ';
        }
        return wh + loc.name + ' (' + loc.code + ')';
      }
    }
  }
  return '場所#' + id;
}
function optionsHtml(items, value, label, selected, emptyLabel) {
  var h = '';
  if (emptyLabel !== undefined) h += '<option value="">' + esc(emptyLabel) + '</option>';
  for (var i = 0; i < items.length; i++) {
    var v = value(items[i]);
    h += '<option value="' + esc(v) + '"' + (String(v) === String(selected) ? ' selected' : '') + '>' + esc(label(items[i])) + '</option>';
  }
  return h;
}
/* 期限の状態判定: expired / expiring / ok と残り日数を返す (バッジと絞り込みチップで共用) */
function expiryInfo(dateStr, alertDays) {
  if (!dateStr) return null;
  var parts = dateStr.split('-');
  var exp = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var nowD = new Date();
  var today = Date.UTC(nowD.getFullYear(), nowD.getMonth(), nowD.getDate());
  var days = Math.round((exp - today) / 86400000);
  var limit = alertDays === null || alertDays === undefined ? 30 : alertDays;
  var state = days < 0 ? 'expired' : (days <= limit ? 'expiring' : 'ok');
  return { state: state, days: days };
}
/* 期限バッジ: 期限切れ=赤、接近 (商品のアラート日数、既定30日) =黄 */
function expiryBadge(dateStr, alertDays) {
  if (!dateStr) return '<span class="muted">-</span>';
  var info = expiryInfo(dateStr, alertDays);
  if (info.state === 'expired') return '<span class="badge badge-danger">' + esc(dateStr) + ' 期限切れ</span>';
  if (info.state === 'expiring') return '<span class="badge badge-warn">' + esc(dateStr) + ' あと' + info.days + '日</span>';
  return '<span>' + esc(dateStr) + '</span>';
}

/* ---------------- quantity stepper ---------------- */
/* 大きな − / ＋ ボタンと中央の数字入力。input の id は従来どおりで送信ロジックは不変 */
function qtyStepperHtml(id) {
  return '<div class="stepper">' +
    '<button type="button" class="stepper-btn" data-step="-1" data-target="' + id + '" aria-label="数量を減らす">−</button>' +
    '<input id="' + id + '" type="number" min="1" step="1" required value="1" inputmode="numeric">' +
    '<button type="button" class="stepper-btn" data-step="1" data-target="' + id + '" aria-label="数量を増やす">＋</button></div>';
}
function bindSteppers() {
  var btns = document.querySelectorAll('button[data-step][data-target]');
  for (var i = 0; i < btns.length; i++) {
    btns[i].onclick = function () {
      var input = el(this.getAttribute('data-target'));
      if (!input) return;
      var v = parseInt(input.value, 10);
      if (isNaN(v)) v = 0;
      v += Number(this.getAttribute('data-step'));
      if (v < 1) v = 1;
      input.value = v;
    };
  }
}

/* ---------------- form presets (在庫行タップ → フォームへ対象を引き継ぐ) ---------------- */
function saveFormPreset(view, preset) {
  try { sessionStorage.setItem('formPreset:' + view, JSON.stringify(preset)); } catch (e) { /* ignore */ }
}
function takeFormPreset(view) {
  try {
    var raw = sessionStorage.getItem('formPreset:' + view);
    if (!raw) return null;
    sessionStorage.removeItem('formPreset:' + view);
    return JSON.parse(raw);
  } catch (e) { return null; }
}

/* ---------------- navigation (iOS 風: 下部タブバー + アクションシート) ---------------- */
var VIEWS = [
  { id: 'dashboard', label: 'ダッシュボード', visible: function () { return true; } },
  { id: 'stocks', label: '在庫一覧', visible: function () { return can('stocks.read'); } },
  { id: 'inbound', label: '入庫', visible: function () { return can('movements.inbound'); } },
  { id: 'consume', label: '消費', visible: function () { return can('movements.consume'); } },
  { id: 'transfer', label: '移動', visible: function () { return can('movements.transfer') && feat('transfers'); } },
  { id: 'history', label: '履歴', visible: function () { return can('stocks.read'); } },
  { id: 'master', label: 'マスタ管理', visible: function () { return can('master.read'); } },
  { id: 'negative', label: 'マイナス在庫', visible: function () { return (can('negative.request') || can('negative.decide')) && feat('negative_stock'); } },
  { id: 'stocktakes', label: '棚卸し', visible: function () { return feat('stocktakes'); } },
  { id: 'alerts', label: 'アラート', visible: function () { return can('alerts.read') && feat('alerts'); } },
  { id: 'purchases', label: '発注', visible: function () { return can('purchases.read') && feat('purchase_orders'); } },
  { id: 'analytics', label: '分析', visible: function () { return can('stocks.read') && feat('analytics'); } },
  { id: 'audit', label: '監査ログ', visible: function () { return can('admin.users'); } },
];
function viewDef(id) { for (var i = 0; i < VIEWS.length; i++) { if (VIEWS[i].id === id) return VIEWS[i]; } return null; }
function viewVisible(id) { var v = viewDef(id); return v ? v.visible() : false; }

/* SF Symbols 風の線画アイコン (stroke=currentColor の inline SVG) */
var ICON_PATHS = {
  home: '<path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M5.5 9.8V20h13V9.8"/><path d="M9.8 20v-5.5h4.4V20"/>',
  box: '<path d="M3.5 7.8 12 3.5l8.5 4.3v8.4L12 20.5l-8.5-4.3z"/><path d="M3.5 7.8 12 12l8.5-4.2"/><path d="M12 12v8.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m15.8 15.8 4.7 4.7"/>',
  grid: '<path d="M4.5 4.5h6.5v6.5H4.5zM13 4.5h6.5v6.5H13zM4.5 13h6.5v6.5H4.5zM13 13h6.5v6.5H13z"/>',
  in: '<path d="M12 4v10.5m0 0 4.3-4.3M12 14.5 7.7 10.2"/><path d="M4.5 19.5h15"/>',
  out: '<path d="M12 14.5V4m0 0 4.3 4.3M12 4 7.7 8.3"/><path d="M4.5 19.5h15"/>',
  swap: '<path d="M4 8h12.5m0 0L13 4.5M16.5 8 13 11.5"/><path d="M20 16H7.5m0 0L11 12.5M7.5 16l3.5 3.5"/>',
  list: '<path d="M9 6.2h10.5M9 12h10.5M9 17.8h10.5"/><circle cx="4.8" cy="6.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.8" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.8" cy="17.8" r="1.15" fill="currentColor" stroke="none"/>',
  clip: '<path d="M7 4.8h10a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5.8a1 1 0 0 1 1-1z"/><path d="m9.3 13.6 2 2 3.6-4.2"/>',
  bell: '<path d="M6.2 16v-4.8a5.8 5.8 0 0 1 11.6 0V16l1.1 2.6a.6.6 0 0 1-.55.85H5.65a.6.6 0 0 1-.55-.85z"/><path d="M10.2 21a2 2 0 0 0 3.6 0"/>',
  minus: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12h7"/>',
  doc: '<path d="M7 3.8h6.8L18.5 8.5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-14.7a1 1 0 0 1 1-1z"/><path d="M13.8 3.8v4.7h4.7"/>',
  shield: '<path d="M12 3.5 5.5 6v5.2c0 4.6 2.8 7.5 6.5 9.3 3.7-1.8 6.5-4.7 6.5-9.3V6z"/>',
  cart: '<circle cx="9.5" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/><path d="M3 3.5h2.2l2.3 12h10.2l2-8.5H7"/>',
  chart: '<path d="M4 20.5h16"/><path d="M7.5 20v-6M12 20V6.5M16.5 20v-9.5"/>',
  chevL: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  chevR: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
};
function icon(name, size) {
  var s = size || 24;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON_PATHS[name] || '') + '</svg>';
}

/* ビューの所属グループ: record=記録シート配下 / more=その他リスト配下 */
var RECORD_VIEWS = ['inbound', 'consume', 'transfer'];
var MORE_VIEWS = ['master', 'negative', 'stocktakes', 'alerts', 'purchases', 'analytics', 'audit'];
function tabOf(view) {
  if (view === 'dashboard') return 'dashboard';
  if (view === 'stocks') return 'stocks';
  if (view === 'history') return 'history';
  if (RECORD_VIEWS.indexOf(view) >= 0) return 'record';
  return 'more';
}
function buildNav() {
  var active = tabOf(state.view);
  var h = '';
  h += '<button class="tab-item' + (active === 'dashboard' ? ' active' : '') + '" data-tab="dashboard">' + icon('home', 25) + '<span>ホーム</span></button>';
  if (can('stocks.read')) {
    h += '<button class="tab-item' + (active === 'stocks' ? ' active' : '') + '" data-tab="stocks">' + icon('box', 25) + '<span>在庫</span></button>';
  }
  var anyRecord = RECORD_VIEWS.some(viewVisible) || viewVisible('negative');
  if (anyRecord) {
    h += '<button class="tab-plus' + (active === 'record' ? ' active' : '') + '" data-tab="record" aria-label="記録する"><span class="plus-circle">' + icon('plus', 26) + '</span><span>記録</span></button>';
  }
  if (can('stocks.read')) {
    h += '<button class="tab-item' + (active === 'history' ? ' active' : '') + '" data-tab="history">' + icon('clock', 25) + '<span>履歴</span></button>';
  }
  h += '<button class="tab-item' + (active === 'more' ? ' active' : '') + '" data-tab="more">' + icon('grid', 25) + '<span>その他</span></button>';
  el('tabbar').innerHTML = h;
  var btns = el('tabbar').querySelectorAll('button[data-tab]');
  for (var j = 0; j < btns.length; j++) {
    btns[j].onclick = function () {
      var t = this.getAttribute('data-tab');
      if (t === 'record') openSheet();
      else showView(t === 'more' ? 'more' : t);
    };
  }
  updateSubbar();
}
function updateSubbar() {
  var bar = el('subbar');
  if (!bar) return;
  var v = state.view;
  var parent = null;
  var parentLabel = '';
  if (RECORD_VIEWS.indexOf(v) >= 0) { parent = 'dashboard'; parentLabel = 'ホーム'; }
  else if (MORE_VIEWS.indexOf(v) >= 0) { parent = 'more'; parentLabel = 'その他'; }
  if (!parent) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = '';
  bar.innerHTML = '<button class="back-btn">' + icon('chevL', 20) + esc(parentLabel) + '</button>';
  bar.querySelector('.back-btn').onclick = function () { showView(parent); };
}
/* ---- 記録アクションシート ---- */
var SHEET_ITEMS = [
  { view: 'inbound', icon: 'in', color: '#34c759', label: '入庫する' },
  { view: 'consume', icon: 'out', color: '#ff9500', label: '消費する' },
  { view: 'transfer', icon: 'swap', color: '#0071e3', label: '移動する' },
  { view: 'negative', icon: 'minus', color: '#af52de', label: 'マイナス在庫 (申請・承認)' },
];
function openSheet() {
  var h = '<div class="sheet-title">記録する</div>';
  for (var i = 0; i < SHEET_ITEMS.length; i++) {
    var it = SHEET_ITEMS[i];
    if (!viewVisible(it.view)) continue;
    h += '<button class="sheet-row" data-view="' + it.view + '"><span class="row-icon" style="background:' + it.color + '">' + icon(it.icon, 18) + '</span><span class="row-label">' + esc(it.label) + '</span><span class="chev">' + icon('chevR', 18) + '</span></button>';
  }
  el('sheetBox').innerHTML = h;
  el('sheetOverlay').style.display = '';
  var rows = el('sheetBox').querySelectorAll('button[data-view]');
  for (var j = 0; j < rows.length; j++) {
    rows[j].onclick = function () { closeSheet(); showView(this.getAttribute('data-view')); };
  }
}
function closeSheet() { el('sheetOverlay').style.display = 'none'; }
/* ---- その他 (iOS 設定風グループリスト) ---- */
var MORE_ITEMS = [
  { view: 'master', icon: 'list', color: '#0071e3', label: 'マスタ管理' },
  { view: 'purchases', icon: 'cart', color: '#5e5ce6', label: '発注' },
  { view: 'analytics', icon: 'chart', color: '#0091ff', label: '分析レポート' },
  { view: 'stocktakes', icon: 'clip', color: '#ff9500', label: '棚卸し' },
  { view: 'alerts', icon: 'bell', color: '#ff3b30', label: 'アラート' },
  { view: 'negative', icon: 'minus', color: '#af52de', label: 'マイナス在庫' },
  { view: 'audit', icon: 'doc', color: '#8e8e93', label: '監査ログ' },
];
function loadMore() {
  var h = '<h2>その他</h2>';
  h += '<div class="group">';
  for (var i = 0; i < MORE_ITEMS.length; i++) {
    var it = MORE_ITEMS[i];
    if (!viewVisible(it.view)) continue;
    h += '<button class="group-row" data-view="' + it.view + '"><span class="row-icon" style="background:' + it.color + '">' + icon(it.icon, 17) + '</span><span class="row-label">' + esc(it.label) + '</span><span class="chev">' + icon('chevR', 18) + '</span></button>';
  }
  if (can('admin.permissions') || can('admin.users')) {
    h += '<a class="group-row" href="/admin/permissions"><span class="row-icon" style="background:#30b0c7">' + icon('shield', 17) + '</span><span class="row-label">権限管理</span><span class="chev">' + icon('chevR', 18) + '</span></a>';
  }
  if (state.me && state.me.isPlatformAdmin) {
    h += '<a class="group-row" href="/platform"><span class="row-icon" style="background:#5856d6">' + icon('grid', 17) + '</span><span class="row-label">全体管理 (店舗・全体設定)</span><span class="chev">' + icon('chevR', 18) + '</span></a>';
  }
  h += '</div>';
  h += '<h3>アカウント</h3><div class="group">';
  if (state.me) {
    h += '<div class="group-row static"><span class="row-label">' + esc(state.me.email) + (state.me.displayName ? ' (' + esc(state.me.displayName) + ')' : '') + '</span></div>';
    if (state.me.currentStore) {
      h += '<div class="group-row static"><span class="row-label">現在の店舗: ' + esc(state.me.currentStore.name) + ' (' + esc(state.me.currentStore.code) + ')</span></div>';
    }
  }
  h += '<button class="group-row danger" id="moreLogout"><span class="row-label">ログアウト</span></button>';
  h += '</div>';
  el('view').innerHTML = h;
  var rows = el('view').querySelectorAll('button[data-view]');
  for (var j = 0; j < rows.length; j++) {
    rows[j].onclick = function () { showView(this.getAttribute('data-view')); };
  }
  var lo = el('moreLogout');
  if (lo) lo.onclick = doLogout;
}
function doLogout() {
  api('/api/v1/auth/logout', { method: 'POST' }).then(function () { location.href = '/'; })
    .catch(function () { location.href = '/'; });
}
function showView(id) {
  state.view = id;
  buildNav();
  var loaders = {
    dashboard: loadDashboard,
    stocks: loadStocks,
    inbound: loadInbound,
    consume: loadConsume,
    transfer: loadTransfer,
    history: loadHistory,
    master: loadMasterView,
    negative: loadNegative,
    stocktakes: loadStocktakes,
    alerts: loadAlerts,
    purchases: loadPurchases,
    analytics: loadAnalytics,
    audit: loadAudit,
    more: loadMore,
  };
  var fn = loaders[id];
  if (fn) fn();
  window.scrollTo(0, 0);
}
function refreshCurrent() {
  keepContent = true;
  try { showView(state.view); } finally { keepContent = false; }
}
function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(function () {
    state.refreshTimer = null;
    if (state.me) refreshCurrent();
  }, 400);
}

/* ---------------- dashboard ---------------- */
function loadDashboard() {
  viewLoading('ダッシュボード', 'cards');
  var jobs = [];
  jobs.push(can('alerts.read') && feat('alerts') ? getJson('/api/v1/alerts') : Promise.resolve(null));
  jobs.push(can('stocks.read') ? getJson('/api/v1/stocks?take=200') : Promise.resolve(null));
  jobs.push(getJson('/api/v1/stocktakes'));
  /* 「やること」用: 承認待ち・発注提案は失敗してもダッシュボード全体を落とさない */
  jobs.push(can('negative.decide') && feat('negative_stock')
    ? getJson('/api/v1/negative-approvals?status=pending').catch(function () { return null; })
    : Promise.resolve(null));
  jobs.push(can('purchases.read') && feat('purchase_orders')
    ? getJson('/api/v1/purchase-orders/suggestions').catch(function () { return null; })
    : Promise.resolve(null));
  Promise.all(jobs).then(function (r) {
    var alerts = r[0];
    var stocks = r[1];
    var stocktakes = r[2] || [];
    var negApprovals = r[3];
    var suggestions = r[4];
    var h = '<h2>ダッシュボード</h2>';
    var active = null;
    for (var i = 0; i < stocktakes.length; i++) {
      if (stocktakes[i].status === 'in_progress' || stocktakes[i].status === 'pending_approval') { active = stocktakes[i]; break; }
    }
    if (active && active.status === 'pending_approval') {
      h += msgHtml('warn', '棚卸し #' + active.id + ' が差異承認待ちです。在庫更新は停止しています。');
    } else if (active) {
      h += msgHtml('warn', '棚卸し実施中です (開始: ' + fmtDateTime(active.startedAt) + ')。入庫・消費・移動は停止しています。');
    }
    /* 状態ヒーロー: 一目で全体像が分かる大きなステータス表示 */
    var hCounts = { EXPIRED: 0, EXPIRING: 0, LOW_STOCK: 0, NEGATIVE_STOCK: 0 };
    if (alerts) { for (var ai = 0; ai < alerts.length; ai++) { if (hCounts[alerts[ai].type] !== undefined) hCounts[alerts[ai].type]++; } }
    var hTotal = 0;
    if (stocks) { for (var si = 0; si < stocks.length; si++) hTotal += stocks[si].quantity; }
    var dangerN = hCounts.EXPIRED + hCounts.NEGATIVE_STOCK;
    var warnN = hCounts.EXPIRING + hCounts.LOW_STOCK;
    var heroCls = 'ok';
    var heroTitle = 'アラートなし';
    var heroSub = '';
    if (active) { heroCls = 'warn'; heroTitle = '棚卸し実施中'; heroSub = '在庫の更新は停止中'; }
    else if (dangerN > 0) { heroCls = 'danger'; heroTitle = '要対応 ' + dangerN + ' 件'; heroSub = '期限切れ・マイナス在庫'; }
    else if (warnN > 0) { heroCls = 'warn'; heroTitle = '注意 ' + warnN + ' 件'; heroSub = '期限接近・在庫不足'; }
    if (stocks) heroSub = (heroSub ? heroSub + ' ・ ' : '') + '在庫 ' + stocks.length + ' 件 / 総数量 ' + hTotal;
    h += '<div class="hero ' + heroCls + '"><span class="hero-dot"></span><div class="hero-body"><div class="hero-title">' + heroTitle + '</div><div class="hero-sub">' + esc(heroSub) + '</div></div></div>';
    /* 「やること」タスクカード: 件数バッジ付きで、タップすると該当画面へ */
    var tasks = [];
    if (negApprovals) {
      var negPending = 0;
      for (var ni = 0; ni < negApprovals.length; ni++) { if (negApprovals[ni].status === 'pending') negPending++; }
      if (negPending > 0) tasks.push({ view: 'negative', icon: 'minus', color: '#af52de', label: 'マイナス在庫の承認待ち', count: negPending, amber: false });
    }
    if (stocktakes && can('stocktakes.manage') && feat('stocktakes')) {
      var tkPending = 0;
      for (var ti = 0; ti < stocktakes.length; ti++) { if (stocktakes[ti].status === 'pending_approval') tkPending++; }
      if (tkPending > 0) tasks.push({ view: 'stocktakes', icon: 'clip', color: '#ff9500', label: '棚卸しの差異承認待ち', count: tkPending, amber: false });
    }
    if (suggestions && suggestions.length > 0) {
      tasks.push({ view: 'purchases', icon: 'cart', color: '#5e5ce6', label: '発注提案 (安全在庫割れ)', count: suggestions.length, amber: true });
    }
    if (tasks.length > 0) {
      h += '<h3>やること</h3><div class="task-list">';
      for (var t = 0; t < tasks.length; t++) {
        h += '<button class="task-card" data-task="' + tasks[t].view + '"><span class="row-icon" style="background:' + tasks[t].color + '">' + icon(tasks[t].icon, 19) + '</span><span class="row-label">' + esc(tasks[t].label) + '</span><span class="count-badge' + (tasks[t].amber ? ' amber' : '') + '">' + tasks[t].count + '</span><span class="chev">' + icon('chevR', 18) + '</span></button>';
      }
      h += '</div>';
    }
    if (can('stocks.read')) {
      h += '<form class="search-hero" id="dashSearch"><span class="search-ic">' + icon('search', 18) + '</span><input id="dashQ" type="search" placeholder="商品名・SKU・ロットで検索" autocomplete="off"></form>';
    }
    h += '<div class="cards">';
    if (alerts) {
      var counts = { EXPIRED: 0, EXPIRING: 0, LOW_STOCK: 0, NEGATIVE_STOCK: 0 };
      for (var a = 0; a < alerts.length; a++) { if (counts[alerts[a].type] !== undefined) counts[alerts[a].type]++; }
      h += '<div class="card"><div class="num">' + alerts.length + '</div><div class="lbl">アラート総数</div></div>';
      h += '<div class="card"><div class="num' + (counts.EXPIRED > 0 ? ' qty-neg' : '') + '">' + counts.EXPIRED + '</div><div class="lbl">期限切れ</div></div>';
      h += '<div class="card"><div class="num">' + counts.EXPIRING + '</div><div class="lbl">期限接近</div></div>';
      h += '<div class="card"><div class="num">' + counts.LOW_STOCK + '</div><div class="lbl">在庫不足</div></div>';
      h += '<div class="card"><div class="num' + (counts.NEGATIVE_STOCK > 0 ? ' qty-neg' : '') + '">' + counts.NEGATIVE_STOCK + '</div><div class="lbl">マイナス在庫</div></div>';
    }
    if (stocks) {
      var total = 0;
      for (var s = 0; s < stocks.length; s++) total += stocks[s].quantity;
      h += '<div class="card"><div class="num">' + stocks.length + '</div><div class="lbl">在庫レコード数</div></div>';
      h += '<div class="card"><div class="num">' + total + '</div><div class="lbl">総数量 (表示分)</div></div>';
    }
    h += '</div>';
    var qa = [];
    if (can('movements.inbound')) qa.push({ view: 'inbound', icon: 'in', color: '#34c759', label: '入庫する' });
    if (can('movements.consume')) qa.push({ view: 'consume', icon: 'out', color: '#ff9500', label: '消費する' });
    if (viewVisible('transfer')) qa.push({ view: 'transfer', icon: 'swap', color: '#0071e3', label: '移動する' });
    if (qa.length > 0) {
      h += '<div class="quick-grid">';
      for (var q = 0; q < qa.length; q++) {
        h += '<button class="quick-btn" data-view="' + qa[q].view + '"><span class="row-icon" style="background:' + qa[q].color + '">' + icon(qa[q].icon, 20) + '</span>' + esc(qa[q].label) + '</button>';
      }
      h += '</div>';
    }
    if (alerts) {
      var exp = alerts.filter(function (x) { return x.type === 'EXPIRED' || x.type === 'EXPIRING'; });
      exp.sort(function (x, y) { return String(x.expiryDate) < String(y.expiryDate) ? -1 : 1; });
      h += '<h3>期限が近い在庫</h3>';
      if (exp.length === 0) h += '<p class="muted">期限切れ・期限接近の在庫はありません。</p>';
      else {
        h += '<div class="table-wrap"><table><thead><tr><th>SKU</th><th>数量</th><th>期限</th><th>種別</th></tr></thead><tbody>';
        for (var k = 0; k < Math.min(exp.length, 5); k++) {
          h += '<tr><td>' + esc(exp[k].sku) + '</td><td>' + exp[k].quantity + '</td><td>' + esc(exp[k].expiryDate || '-') + '</td><td>' +
            (exp[k].type === 'EXPIRED' ? '<span class="badge badge-danger">期限切れ</span>' : '<span class="badge badge-warn">期限接近</span>') + '</td></tr>';
        }
        h += '</tbody></table></div>';
        h += '<p><button class="btn secondary" id="dashToAlerts">アラート一覧を見る</button></p>';
      }
    }
    el('view').innerHTML = h;
    var b = el('dashToAlerts');
    if (b) b.onclick = function () { showView('alerts'); };
    var tcs = el('view').querySelectorAll('.task-card[data-task]');
    for (var tci = 0; tci < tcs.length; tci++) {
      tcs[tci].onclick = function () { showView(this.getAttribute('data-task')); };
    }
    var dsf = el('dashSearch');
    if (dsf) dsf.onsubmit = function (e) {
      e.preventDefault();
      try { sessionStorage.setItem('pendingStockQuery', el('dashQ').value || ''); } catch (err) {}
      showView('stocks');
    };
    var qbs = el('view').querySelectorAll('.quick-btn[data-view]');
    for (var qi = 0; qi < qbs.length; qi++) {
      qbs[qi].onclick = function () { showView(this.getAttribute('data-view')); };
    }
  }).catch(function (e) {
    el('view').innerHTML = '<h2>ダッシュボード</h2>' + msgHtml('error', errMsg(e));
  });
}

/* ---------------- barcode scan ---------------- */
/* BarcodeDetector + getUserMedia が使える環境でのみ有効 (未対応ではボタンを出さない) */
var scanStream = null;
var scanTimer = null;
function scanSupported() {
  return feat('barcode_scan') &&
    'BarcodeDetector' in window &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
function stopScan() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (scanStream) {
    scanStream.getTracks().forEach(function (t) { t.stop(); });
    scanStream = null;
  }
}
function productByBarcode(code) {
  var m = state.master;
  if (!m) return null;
  for (var i = 0; i < m.products.length; i++) {
    if (m.products[i].barcode && String(m.products[i].barcode) === String(code)) return m.products[i];
  }
  return null;
}
function openScanner(onDetect) {
  el('modalBox').innerHTML = '<h3>バーコードをスキャン</h3><div id="scanMsg"></div>' +
    '<video id="scanVideo" autoplay playsinline muted style="width:100%; border-radius:12px; background:#000;"></video>' +
    '<p class="small muted">カメラをバーコードに向けてください。読み取ると自動で反映します。</p>' +
    '<p><button class="btn secondary" type="button" id="scanCancel">キャンセル</button></p>';
  el('modalOverlay').style.display = '';
  el('scanCancel').onclick = function () { stopScan(); closeModal(); };
  var detector;
  try {
    detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
  } catch (e) {
    try { detector = new window.BarcodeDetector(); }
    catch (e2) {
      el('scanMsg').innerHTML = msgHtml('error', 'バーコード読み取りを開始できませんでした。');
      return;
    }
  }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
    scanStream = stream;
    var video = el('scanVideo');
    if (!video) { stopScan(); return; }
    video.srcObject = stream;
    var busy = false;
    scanTimer = setInterval(function () {
      if (busy || !video.videoWidth) return;
      busy = true;
      detector.detect(video).then(function (codes) {
        busy = false;
        if (codes && codes.length > 0 && codes[0].rawValue) {
          var value = codes[0].rawValue;
          stopScan();
          closeModal();
          onDetect(value);
        }
      }).catch(function () { busy = false; });
    }, 350);
  }).catch(function (e) {
    var msg = el('scanMsg');
    if (msg) msg.innerHTML = msgHtml('error', 'カメラを利用できませんでした: ' + errMsg(e));
  });
}

/* ---------------- stocks ---------------- */
var STOCK_CHIPS = [
  { id: 'all', label: 'すべて' },
  { id: 'low', label: '在庫不足' },
  { id: 'expiring', label: '期限接近' },
  { id: 'expired', label: '期限切れ' },
  { id: 'negative', label: 'マイナス' },
];
var stocksChip = 'all';
/* 在庫不足の判定はサーバーのアラート定義 (行の数量 <= 安全在庫) に合わせる */
function stockIsLow(s) {
  var p = productOf(s.productId);
  return p !== null && s.quantity >= 0 && s.quantity <= p.safetyStock;
}
function stockChipMatch(s, chip) {
  if (chip === 'all') return true;
  if (chip === 'negative') return s.quantity < 0;
  if (chip === 'low') return stockIsLow(s);
  if (chip === 'expired' || chip === 'expiring') {
    var p = productOf(s.productId);
    var info = expiryInfo(s.expiryDate, p ? p.expiryAlertDays : null);
    return info !== null && info.state === chip;
  }
  return true;
}
function stockRowHtml(s, idx) {
  var p = productOf(s.productId);
  var low = s.quantity < 0 || stockIsLow(s);
  return '<tr data-stock="' + idx + '"><td>' + esc(productLabel(s.productId)) + '</td>' +
    '<td>' + esc(s.lotCode) + '</td>' +
    '<td>' + esc(locationLabel(s.locationId)) + '</td>' +
    '<td class="stock-qty' + (low ? ' qty-neg' : '') + '">' + s.quantity + '</td>' +
    '<td>' + expiryBadge(s.expiryDate, p ? p.expiryAlertDays : null) + '</td></tr>';
}
/* 在庫行タップ: その在庫を対象に記録画面へ進むアクションシート */
function openStockSheet(s) {
  var p = productOf(s.productId);
  var h = '<div class="sheet-head"><div class="sh-name">' + esc(productLabel(s.productId)) + '</div>' +
    '<div class="sh-meta">ロット ' + esc(s.lotCode) + ' ・ ' + esc(locationLabel(s.locationId)) + ' ・ 現在 ' + s.quantity + (p ? ' ' + esc(p.unit) : '') + '</div></div>';
  var items = [];
  if (viewVisible('inbound')) items.push({ view: 'inbound', icon: 'in', color: '#34c759', label: '入庫する' });
  if (viewVisible('consume')) items.push({ view: 'consume', icon: 'out', color: '#ff9500', label: '消費する' });
  if (viewVisible('transfer')) items.push({ view: 'transfer', icon: 'swap', color: '#0071e3', label: '移動する' });
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    h += '<button class="sheet-row" data-view="' + it.view + '"><span class="row-icon" style="background:' + it.color + '">' + icon(it.icon, 18) + '</span><span class="row-label">' + esc(it.label) + '</span><span class="chev">' + icon('chevR', 18) + '</span></button>';
  }
  if (items.length === 0) {
    h += '<div class="sheet-title">この在庫に対して実行できる操作がありません</div>';
  }
  el('sheetBox').innerHTML = h;
  el('sheetOverlay').style.display = '';
  var rows = el('sheetBox').querySelectorAll('button[data-view]');
  for (var j = 0; j < rows.length; j++) {
    rows[j].onclick = function () {
      saveFormPreset(this.getAttribute('data-view'), {
        productId: s.productId,
        warehouseId: s.warehouseId,
        locationId: s.locationId,
        lotId: s.lotId,
      });
      closeSheet();
      showView(this.getAttribute('data-view'));
    };
  }
}
function loadStocks() {
  var chipsHtml = '<div class="chips" id="stChips">';
  for (var ci = 0; ci < STOCK_CHIPS.length; ci++) {
    chipsHtml += '<button type="button" class="chip' + (stocksChip === STOCK_CHIPS[ci].id ? ' active' : '') + '" data-chip="' + STOCK_CHIPS[ci].id + '">' + esc(STOCK_CHIPS[ci].label) + '</button>';
  }
  chipsHtml += '</div>';
  el('view').innerHTML =
    '<h2>在庫一覧</h2>' +
    '<div class="sticky-bar">' +
    '<div class="toolbar">' +
    '<div style="flex:1 1 11rem"><label>キーワード (SKU / 商品名 / ロット)</label><input id="stQ" type="search" placeholder="検索"></div>' +
    (scanSupported() ? '<div><label>&nbsp;</label><button class="btn secondary" id="stScan" type="button">スキャン</button></div>' : '') +
    '<div><label>倉庫</label><select id="stWh"><option value="">すべて</option></select></div>' +
    '<div><label>保管場所</label><select id="stLoc"><option value="">すべて</option></select></div>' +
    '<div><button class="btn" id="stReload">再読み込み</button></div>' +
    (feat('csv') ? '<div><label>&nbsp;</label><a class="btn secondary" href="/api/v1/stocks.csv">CSV ダウンロード</a></div>' : '') +
    '</div>' +
    chipsHtml +
    '</div>' +
    '<div id="stMsg"></div><div id="stBody">' + skeletonRows() + '</div>';
  try {
    var pq = sessionStorage.getItem('pendingStockQuery');
    if (pq) { el('stQ').value = pq; sessionStorage.removeItem('pendingStockQuery'); }
  } catch (e) {}
  var chipBtns = el('stChips').querySelectorAll('button[data-chip]');
  for (var cj = 0; cj < chipBtns.length; cj++) {
    chipBtns[cj].onclick = function () {
      stocksChip = this.getAttribute('data-chip');
      var all = el('stChips').querySelectorAll('button[data-chip]');
      for (var ck = 0; ck < all.length; ck++) {
        if (all[ck].getAttribute('data-chip') === stocksChip) all[ck].classList.add('active');
        else all[ck].classList.remove('active');
      }
      fetchStocks();
    };
  }
  ensureMaster().then(function (m) {
    el('stWh').innerHTML = '<option value="">すべて</option>' + optionsHtml(m.warehouses, function (w) { return w.id; }, function (w) { return w.name; }, '');
    var fillLocs = function () {
      var wh = el('stWh').value;
      var locs = m.locations.filter(function (l) { return !wh || String(l.warehouseId) === String(wh); });
      el('stLoc').innerHTML = '<option value="">すべて</option>' + optionsHtml(locs, function (l) { return l.id; }, function (l) { return l.name + ' (' + l.code + ')'; }, '');
    };
    fillLocs();
    el('stWh').onchange = function () { fillLocs(); fetchStocks(); };
    el('stLoc').onchange = fetchStocks;
    el('stQ').oninput = fetchStocks;
    el('stReload').onclick = fetchStocks;
    var scanBtn = el('stScan');
    if (scanBtn) scanBtn.onclick = function () {
      openScanner(function (code) {
        var p = productByBarcode(code);
        el('stQ').value = p ? p.sku : code;
        fetchStocks();
        if (!p) el('stMsg').innerHTML = msgHtml('warn', 'バーコード ' + code + ' の商品が見つかりませんでした。');
      });
    };
    fetchStocks();
  });
  function fetchStocks() {
    var loc = el('stLoc') ? el('stLoc').value : '';
    var path = '/api/v1/stocks?take=200' + (loc ? '&locationId=' + encodeURIComponent(loc) : '');
    el('stMsg').innerHTML = '';
    getJson(path).then(function (rows) {
      var q = (el('stQ').value || '').toLowerCase();
      var wh = el('stWh').value;
      var filtered = rows.filter(function (s) {
        if (wh && String(s.warehouseId) !== String(wh)) return false;
        if (!stockChipMatch(s, stocksChip)) return false;
        if (!q) return true;
        var text = (s.sku + ' ' + s.lotCode + ' ' + productLabel(s.productId)).toLowerCase();
        return text.indexOf(q) >= 0;
      });
      if (filtered.length === 0) {
        el('stBody').innerHTML = '<p class="muted">在庫がありません。</p>';
        return;
      }
      var h = '<div class="table-wrap"><table class="stocks-table"><thead><tr><th>商品</th><th>ロット</th><th>保管場所</th><th class="stock-qty-head">数量</th><th>期限</th></tr></thead><tbody>';
      for (var i = 0; i < filtered.length; i++) h += stockRowHtml(filtered[i], i);
      h += '</tbody></table></div><p class="small muted">' + filtered.length + ' 件 (行をタップすると記録できます)</p>';
      el('stBody').innerHTML = h;
      var trs = el('stBody').querySelectorAll('tr[data-stock]');
      for (var ri = 0; ri < trs.length; ri++) {
        trs[ri].onclick = function () {
          var s = filtered[Number(this.getAttribute('data-stock'))];
          if (s) openStockSheet(s);
        };
      }
    }).catch(function (e) {
      el('stBody').innerHTML = msgHtml('error', errMsg(e));
    });
  }
}

/* ---------------- inbound ---------------- */
function loadInbound() {
  viewLoading('入庫', 'form');
  ensureMaster().then(function (m) {
    if (state.masterError) {
      el('view').innerHTML = '<h2>入庫</h2>' + msgHtml('error', 'マスタの読み込みに失敗しました: ' + state.masterError);
      return;
    }
    var h = '<h2>入庫</h2><div id="inMsg"></div>' +
      '<form class="grid" id="inForm">' +
      '<div><label>商品</label><select id="inProduct" required>' +
      optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select>' +
      '<span class="small muted" id="inProdHint"></span>' +
      (scanSupported() ? ' <button class="btn small secondary" type="button" id="inScan">スキャン</button>' : '') + '</div>' +
      '<div><label>保管場所</label><select id="inLocation" required>' +
      optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '') + '</select></div>' +
      '<div><label>ロット番号</label><input id="inLot" type="text" required placeholder="例: LOT-2026-001"></div>' +
      '<div><label>有効期限 (期限管理対象の商品は必須)</label><input id="inExpiry" type="date"></div>' +
      '<div><label>数量</label>' + qtyStepperHtml('inQty') + '</div>' +
      '<div class="sticky-actions"><button class="btn" type="submit" id="inSubmit">入庫を登録</button></div>' +
      '</form>';
    el('view').innerHTML = h;
    bindSteppers();
    var updateHint = function () {
      var p = productOf(Number(el('inProduct').value));
      el('inProdHint').textContent = p && p.requiresExpiry ? 'この商品は有効期限が必須です' : '';
    };
    el('inProduct').onchange = updateHint;
    /* 在庫一覧の行タップから来た場合は対象をプリセットする */
    var inPreset = takeFormPreset('inbound');
    if (inPreset) {
      if (inPreset.productId) el('inProduct').value = String(inPreset.productId);
      if (inPreset.locationId) el('inLocation').value = String(inPreset.locationId);
      if (inPreset.lotId) {
        var inLot = lotOf(inPreset.lotId);
        if (inLot) {
          el('inLot').value = inLot.lotCode;
          if (inLot.expiryDate) el('inExpiry').value = inLot.expiryDate;
        }
      }
    }
    updateHint();
    var inScan = el('inScan');
    if (inScan) inScan.onclick = function () {
      openScanner(function (code) {
        var p = productByBarcode(code);
        if (p) { el('inProduct').value = String(p.id); updateHint(); }
        else el('inMsg').innerHTML = msgHtml('warn', 'バーコード ' + code + ' の商品が見つかりませんでした。');
      });
    };
    el('inForm').onsubmit = function (ev) {
      ev.preventDefault();
      var btn = el('inSubmit');
      btn.disabled = true;
      el('inMsg').innerHTML = '';
      var body = {
        locationId: Number(el('inLocation').value),
        productId: Number(el('inProduct').value),
        lotCode: el('inLot').value,
        quantity: Number(el('inQty').value),
      };
      var exp = el('inExpiry').value;
      if (exp) body.expiryDate = exp;
      api('/api/v1/movements/inbound', { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: body })
        .then(function (r) {
          el('inMsg').innerHTML = msgHtml('success', '入庫を登録しました。在庫ID: ' + r.stockId + ' / 現在数量: ' + r.quantity);
          btn.disabled = false;
        })
        .catch(function (e) {
          el('inMsg').innerHTML = msgHtml('error', errMsg(e));
          btn.disabled = false;
        });
    };
  });
}

/* ---------------- consume ---------------- */
function loadConsume() {
  viewLoading('消費', 'form');
  ensureMaster().then(function (m) {
    if (state.masterError) {
      el('view').innerHTML = '<h2>消費</h2>' + msgHtml('error', 'マスタの読み込みに失敗しました: ' + state.masterError);
      return;
    }
    var h = '<h2>消費 (FEFO: 期限の早いロットから自動で引きます)</h2><div id="coMsg"></div>' +
      '<form class="grid" id="coForm">' +
      '<div><label>商品</label><select id="coProduct" required>' +
      optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select>' +
      (scanSupported() ? '<div style="margin-top:0.4rem;"><button class="btn small secondary" type="button" id="coScan">スキャンで商品を選ぶ</button></div>' : '') + '</div>' +
      '<div><label>保管場所 (任意: 指定しない場合は全場所から)</label><select id="coLocation">' +
      optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '', '指定しない') + '</select></div>' +
      '<div><label>数量</label>' + qtyStepperHtml('coQty') + '</div>' +
      '<div><label>部署</label><input id="coDept" type="text" required></div>' +
      '<div><label>用途</label><input id="coPurpose" type="text" required></div>' +
      '<div><label>マイナス在庫承認 ID (任意: 承認済みの申請を使う場合)</label><input id="coApproval" type="number" min="1" step="1"></div>' +
      '<div class="sticky-actions"><button class="btn" type="submit" id="coSubmit">消費を登録</button></div>' +
      '</form><div id="coResult"></div>';
    el('view').innerHTML = h;
    bindSteppers();
    /* 在庫一覧の行タップから来た場合は対象をプリセットする */
    var coPreset = takeFormPreset('consume');
    if (coPreset) {
      if (coPreset.productId) el('coProduct').value = String(coPreset.productId);
      if (coPreset.locationId) el('coLocation').value = String(coPreset.locationId);
    }
    var coScan = el('coScan');
    if (coScan) coScan.onclick = function () {
      openScanner(function (code) {
        var p = productByBarcode(code);
        if (p) el('coProduct').value = String(p.id);
        else el('coMsg').innerHTML = msgHtml('warn', 'バーコード ' + code + ' の商品が見つかりませんでした。');
      });
    };
    el('coForm').onsubmit = function (ev) {
      ev.preventDefault();
      var btn = el('coSubmit');
      btn.disabled = true;
      el('coMsg').innerHTML = '';
      el('coResult').innerHTML = '';
      var body = {
        productId: Number(el('coProduct').value),
        quantity: Number(el('coQty').value),
        department: el('coDept').value,
        purpose: el('coPurpose').value,
      };
      var loc = el('coLocation').value;
      if (loc) body.locationId = Number(loc);
      var ap = el('coApproval').value;
      if (ap) body.negativeApprovalId = Number(ap);
      api('/api/v1/movements/consumption', { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: body })
        .then(function (r) {
          var hh = msgHtml('success', '消費を登録しました。') +
            '<div class="table-wrap"><table><thead><tr><th>ロット</th><th>保管場所</th><th>引当数量</th><th>備考</th></tr></thead><tbody>';
          for (var i = 0; i < r.allocations.length; i++) {
            var a = r.allocations[i];
            hh += '<tr><td>' + esc(lotLabel(a.lotId)) + '</td><td>' + esc(locationLabel(a.locationId)) + '</td><td>' + a.quantity + '</td><td>' +
              (a.negative ? '<span class="badge badge-danger">マイナス在庫 (承認済み)</span>' : '') + '</td></tr>';
          }
          hh += '</tbody></table></div>';
          el('coResult').innerHTML = hh;
          btn.disabled = false;
        })
        .catch(function (e) {
          el('coMsg').innerHTML = msgHtml('error', errMsg(e));
          btn.disabled = false;
        });
    };
  });
}

/* ---------------- transfer ---------------- */
function loadTransfer() {
  viewLoading('移動', 'form');
  ensureMaster().then(function (m) {
    if (state.masterError) {
      el('view').innerHTML = '<h2>移動</h2>' + msgHtml('error', 'マスタの読み込みに失敗しました: ' + state.masterError);
      return;
    }
    var h = '<h2>在庫移動</h2><div id="trMsg"></div>' +
      '<form class="grid" id="trForm">' +
      '<div><label>商品</label><select id="trProduct" required>' +
      optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select></div>' +
      '<div><label>移動元 保管場所</label><select id="trFrom" required>' +
      optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '') + '</select></div>' +
      '<div><label>移動先 保管場所</label><select id="trTo" required>' +
      optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '') + '</select></div>' +
      '<div><label>ロット (任意: 指定しない場合は FEFO 順)</label><select id="trLot"></select></div>' +
      '<div><label>数量</label>' + qtyStepperHtml('trQty') + '</div>' +
      '<div class="sticky-actions"><button class="btn" type="submit" id="trSubmit">移動を登録</button></div>' +
      '</form><div id="trResult"></div>';
    el('view').innerHTML = h;
    bindSteppers();
    var fillLots = function () {
      var pid = Number(el('trProduct').value);
      var lots = m.lots.filter(function (l) { return l.productId === pid; });
      el('trLot').innerHTML = optionsHtml(lots, function (l) { return l.id; }, function (l) { return l.lotCode; }, '', 'FEFO (自動)');
    };
    el('trProduct').onchange = fillLots;
    /* 在庫一覧の行タップから来た場合は対象をプリセットする (移動元 = その在庫の場所) */
    var trPreset = takeFormPreset('transfer');
    if (trPreset) {
      if (trPreset.productId) el('trProduct').value = String(trPreset.productId);
      if (trPreset.locationId) el('trFrom').value = String(trPreset.locationId);
    }
    fillLots();
    if (trPreset && trPreset.lotId) el('trLot').value = String(trPreset.lotId);
    el('trForm').onsubmit = function (ev) {
      ev.preventDefault();
      var btn = el('trSubmit');
      btn.disabled = true;
      el('trMsg').innerHTML = '';
      el('trResult').innerHTML = '';
      var body = {
        fromLocationId: Number(el('trFrom').value),
        toLocationId: Number(el('trTo').value),
        productId: Number(el('trProduct').value),
        quantity: Number(el('trQty').value),
      };
      var lot = el('trLot').value;
      if (lot) body.lotId = Number(lot);
      api('/api/v1/movements/transfer', { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: body })
        .then(function (r) {
          var hh = msgHtml('success', '移動を登録しました。') +
            '<div class="table-wrap"><table><thead><tr><th>ロット</th><th>移動元 在庫ID</th><th>移動先 在庫ID</th><th>数量</th></tr></thead><tbody>';
          for (var i = 0; i < r.allocations.length; i++) {
            var a = r.allocations[i];
            hh += '<tr><td>' + esc(lotLabel(a.lotId)) + '</td><td>' + a.fromStockId + '</td><td>' + a.toStockId + '</td><td>' + a.quantity + '</td></tr>';
          }
          hh += '</tbody></table></div>';
          el('trResult').innerHTML = hh;
          btn.disabled = false;
        })
        .catch(function (e) {
          el('trMsg').innerHTML = msgHtml('error', errMsg(e));
          btn.disabled = false;
        });
    };
  });
}

/* ---------------- history ---------------- */
var MOVEMENT_TYPE_LABELS = {
  IN: ['入庫', 'badge-ok'],
  OUT: ['消費', ''],
  TRANSFER_IN: ['移動 (入)', 'badge-ok'],
  TRANSFER_OUT: ['移動 (出)', ''],
  ADJUST: ['調整', 'badge-warn'],
  CANCEL: ['取消', 'badge-danger'],
};
function loadHistory() {
  viewLoading('入出庫履歴', 'list');
  ensureMaster().then(function () {
    getJson('/api/v1/movements?take=100').then(function (rows) {
      if (!rows || rows.length === 0) {
        el('view').innerHTML = '<h2>入出庫履歴</h2><p class="muted">履歴がありません。</p>';
        return;
      }
      var h = '<h2>入出庫履歴</h2><div class="table-wrap"><table><thead><tr>' +
        '<th>日時</th><th>種別</th><th>商品</th><th>ロット</th><th>保管場所</th><th>変化</th><th>数量 (前 → 後)</th><th>部署 / 用途</th></tr></thead><tbody>';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var tl = MOVEMENT_TYPE_LABELS[r.type] || [r.type, ''];
        h += '<tr><td>' + fmtDateTime(r.createdAt) + '</td>' +
          '<td><span class="badge ' + tl[1] + '">' + esc(tl[0]) + '</span></td>' +
          '<td>' + esc(productLabel(r.productId)) + '</td>' +
          '<td>' + esc(r.lotCode || '') + '</td>' +
          '<td>' + esc(locationLabel(r.locationId)) + '</td>' +
          '<td>' + (r.quantityChange > 0 ? '<span class="qty-pos">+' + r.quantityChange + '</span>' : '<span class="qty-neg">' + r.quantityChange + '</span>') + '</td>' +
          '<td>' + r.quantityBefore + ' → ' + r.quantityAfter + '</td>' +
          '<td>' + esc([r.department, r.purpose].filter(Boolean).join(' / ') || r.reason || '') + '</td></tr>';
      }
      h += '</tbody></table></div>';
      el('view').innerHTML = h;
    }).catch(function (e) {
      el('view').innerHTML = '<h2>入出庫履歴</h2>' + msgHtml('error', errMsg(e));
    });
  });
}

/* ---------------- master ---------------- */
/* 編集はモーダル内のフォームで行う (prompt は使わない) */
function closeModal() {
  el('modalOverlay').style.display = 'none';
  el('modalBox').innerHTML = '';
}
function fieldHtml(label, inputHtml) {
  return '<div><label>' + esc(label) + '</label>' + inputHtml + '</div>';
}
/* submitFn は保存処理を行い、完了メッセージ文字列を resolve する Promise を返す */
function openModal(title, fieldsHtml, submitFn) {
  el('modalBox').innerHTML = '<h3>' + esc(title) + '</h3><div id="mdMsg"></div>' +
    '<form class="grid" id="mdForm">' + fieldsHtml +
    '<div><label>&nbsp;</label><span><button class="btn" type="submit">保存</button> ' +
    '<button class="btn secondary" type="button" id="mdCancel">キャンセル</button></span></div></form>';
  el('modalOverlay').style.display = '';
  el('mdCancel').onclick = closeModal;
  el('mdForm').onsubmit = function (ev) {
    ev.preventDefault();
    el('mdMsg').innerHTML = '';
    submitFn().then(function (flash) {
      closeModal();
      masterDone(flash);
    }).catch(function (e) {
      el('mdMsg').innerHTML = msgHtml('error', errMsg(e));
    });
  };
}
function masterDone(flash) {
  state.flash = flash;
  state.master = null;
  loadMasterView();
}
function masterFail(e) {
  var box = el('maMsg');
  if (box) box.innerHTML = msgHtml('error', errMsg(e));
}
function onMasterAction(act, id) {
  var kind = act.split('-')[1];
  var base = '/api/v1/master/' + kind + 's/' + id;
  if (act.indexOf('del-') === 0) {
    if (!window.confirm('削除しますか? (論理削除のため、在庫や履歴には影響しません)')) return;
    api(base, { method: 'DELETE' }).then(function () { masterDone('削除しました。'); }).catch(masterFail);
    return;
  }
  if (kind === 'product') {
    var p = productOf(id);
    if (!p) return;
    var pFields =
      fieldHtml('商品名', '<input id="edName" required value="' + esc(p.name) + '">') +
      fieldHtml('単位', '<input id="edUnit" required value="' + esc(p.unit) + '">') +
      fieldHtml('バーコード (任意)', '<input id="edBarcode" value="' + esc(p.barcode || '') + '">') +
      fieldHtml('安全在庫', '<input id="edSafety" type="number" min="0" step="1" value="' + p.safetyStock + '">') +
      fieldHtml('単価 (円、空欄で未設定)', '<input id="edCost" type="number" min="0" step="1" value="' + (p.unitCost === null || p.unitCost === undefined ? '' : p.unitCost) + '">') +
      fieldHtml('有効期限', '<select id="edExpiry"><option value="">不要</option><option value="1"' + (p.requiresExpiry ? ' selected' : '') + '>必須</option></select>') +
      fieldHtml('アラート日数 (空欄で解除)', '<input id="edDays" type="number" min="0" step="1" value="' + (p.expiryAlertDays === null || p.expiryAlertDays === undefined ? '' : p.expiryAlertDays) + '">');
    openModal('商品を編集: ' + p.sku, pFields, function () {
      var body = {
        name: el('edName').value,
        unit: el('edUnit').value,
        barcode: el('edBarcode').value === '' ? null : el('edBarcode').value,
        safetyStock: Number(el('edSafety').value || 0),
        requiresExpiry: el('edExpiry').value === '1',
        expiryAlertDays: el('edDays').value === '' ? null : Number(el('edDays').value),
        unitCost: el('edCost').value === '' ? null : Number(el('edCost').value),
      };
      return api(base, { method: 'PUT', body: body }).then(function () { return '商品を更新しました。'; });
    });
    return;
  }
  if (kind === 'supplier') {
    var sup = supplierOf(id);
    if (!sup) return;
    var sFields =
      fieldHtml('仕入先名', '<input id="edSupName" required value="' + esc(sup.name) + '">') +
      fieldHtml('担当者 (任意)', '<input id="edSupContact" value="' + esc(sup.contact || '') + '">') +
      fieldHtml('メール (任意)', '<input id="edSupEmail" value="' + esc(sup.email || '') + '">') +
      fieldHtml('電話 (任意)', '<input id="edSupPhone" value="' + esc(sup.phone || '') + '">') +
      fieldHtml('メモ (任意)', '<input id="edSupNote" value="' + esc(sup.note || '') + '">');
    openModal('仕入先を編集', sFields, function () {
      var sBody = {
        name: el('edSupName').value,
        contact: el('edSupContact').value === '' ? null : el('edSupContact').value,
        email: el('edSupEmail').value === '' ? null : el('edSupEmail').value,
        phone: el('edSupPhone').value === '' ? null : el('edSupPhone').value,
        note: el('edSupNote').value === '' ? null : el('edSupNote').value,
      };
      return api(base, { method: 'PUT', body: sBody }).then(function () { return '仕入先を更新しました。'; });
    });
    return;
  }
  if (kind === 'warehouse' || kind === 'location') {
    var row = kind === 'warehouse' ? warehouseOf(id) : locationOf(id);
    if (!row) return;
    var wFields =
      fieldHtml('コード', '<input id="edCode" required value="' + esc(row.code) + '">') +
      fieldHtml('名前', '<input id="edWName" required value="' + esc(row.name) + '">');
    openModal((kind === 'warehouse' ? '倉庫' : '保管場所') + 'を編集', wFields, function () {
      return api(base, { method: 'PUT', body: { code: el('edCode').value, name: el('edWName').value } })
        .then(function () { return '更新しました。'; });
    });
    return;
  }
  if (kind === 'lot') {
    var lot = lotOf(id);
    if (!lot) return;
    var lFields =
      fieldHtml('ロット番号', '<input id="edLotCode" required value="' + esc(lot.lotCode) + '">') +
      fieldHtml('有効期限 (空欄で期限なし)', '<input id="edLotExpiry" type="date" value="' + esc(lot.expiryDate || '') + '">');
    openModal('ロットを編集', lFields, function () {
      var exp = el('edLotExpiry').value;
      return api(base, { method: 'PUT', body: { lotCode: el('edLotCode').value, expiryDate: exp === '' ? null : exp } })
        .then(function () { return 'ロットを更新しました。'; });
    });
  }
}
function onCsvImport() {
  var input = el('maCsvFile');
  var out = el('maCsvResult');
  var f = input && input.files ? input.files[0] : null;
  if (!f) { out.innerHTML = msgHtml('error', 'CSV ファイルを選んでください。'); return; }
  var fd = new FormData();
  fd.append('file', f);
  fetch('/api/v1/master/products/import', { method: 'POST', body: fd, credentials: 'same-origin' })
    .then(function (res) {
      return res.text().then(function (t) {
        var d = null;
        try { d = JSON.parse(t); } catch (e) { /* ignore */ }
        if (!res.ok) throw new Error(d && d.message ? d.message : 'HTTP ' + res.status);
        return d;
      });
    })
    .then(function (r) {
      var hh = msgHtml('success', 'インポート完了: 対象 ' + r.total + ' 件 / 登録 ' + r.created + ' 件 / スキップ ' + r.skipped + ' 件 / 失敗 ' + r.failed.length + ' 件');
      if (r.failed.length) {
        hh += '<ul>';
        r.failed.forEach(function (x) {
          hh += '<li>' + x.line + ' 行目' + (x.sku ? ' (' + esc(x.sku) + ')' : '') + ': ' + esc(x.reason) + '</li>';
        });
        hh += '</ul>';
      }
      if (r.created > 0) hh += '<p class="small muted">一覧へ反映するには画面を開き直してください。</p>';
      out.innerHTML = hh;
      state.master = null;
    })
    .catch(function (e) { out.innerHTML = msgHtml('error', errMsg(e)); });
}
function masterSection(title, tableHtml, formHtml) {
  return '<div class="section-box"><h3>' + esc(title) + '</h3>' + tableHtml + formHtml + '</div>';
}
function simpleTable(head, rowsHtml) {
  if (!rowsHtml) return '<p class="muted">データがありません。</p>';
  return '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}
function loadMasterView() {
  viewLoading('マスタ管理', 'list');
  state.master = null;
  ensureMaster().then(function (m) {
    var writable = can('master.write');
    var h = '<h2>マスタ管理</h2><div id="maMsg"></div>';
    if (state.flash) { h += msgHtml('success', state.flash); state.flash = ''; }
    if (state.masterError) h += msgHtml('error', state.masterError);

    var actHead = writable ? '<th>操作</th>' : '';
    function actCell(kind, id) {
      if (!writable) return '';
      return '<td><button class="btn small secondary" data-mact="edit-' + kind + '" data-mid="' + id + '">編集</button> ' +
        '<button class="btn small danger" data-mact="del-' + kind + '" data-mid="' + id + '">削除</button></td>';
    }
    var prow = '';
    m.products.forEach(function (p) {
      prow += '<tr><td>' + esc(p.sku) + '</td><td>' + esc(p.name) + '</td><td>' + esc(p.unit) + '</td><td>' + p.safetyStock + '</td><td>' +
        (p.unitCost === null || p.unitCost === undefined ? '-' : '¥' + Number(p.unitCost).toLocaleString('ja-JP')) + '</td><td>' +
        (p.requiresExpiry ? '必須' : '-') + '</td><td>' + (p.expiryAlertDays === null || p.expiryAlertDays === undefined ? '-' : p.expiryAlertDays + '日前') + '</td>' +
        actCell('product', p.id) + '</tr>';
    });
    var pform = '';
    if (writable) {
      pform = '<form class="grid" id="maProductForm">' +
        '<div><label>SKU</label><input id="mpSku" required></div>' +
        '<div><label>商品名</label><input id="mpName" required></div>' +
        '<div><label>単位</label><input id="mpUnit" required value="個"></div>' +
        '<div><label>バーコード (任意)</label><input id="mpBarcode"></div>' +
        '<div><label>安全在庫</label><input id="mpSafety" type="number" min="0" value="0"></div>' +
        '<div><label>単価 (円、任意)</label><input id="mpCost" type="number" min="0"></div>' +
        '<div><label>アラート日数 (任意)</label><input id="mpAlertDays" type="number" min="0"></div>' +
        '<div><label>有効期限</label><select id="mpExpiry"><option value="">不要</option><option value="1">必須</option></select></div>' +
        '<div><label>&nbsp;</label><button class="btn" type="submit">商品を追加</button></div></form>';
    }
    h += masterSection('商品', simpleTable('<th>SKU</th><th>商品名</th><th>単位</th><th>安全在庫</th><th>単価</th><th>期限</th><th>アラート</th>' + actHead, prow), pform);

    if (writable && feat('csv')) {
      h += '<div class="section-box"><h3>商品 CSV インポート</h3>' +
        '<p class="small muted">ヘッダが sku,name,unit,requires_expiry の CSV を読み込みます (任意列: unit_cost)。既存の SKU はスキップされます。</p>' +
        '<input type="file" id="maCsvFile" accept=".csv,text/csv"> ' +
        '<button class="btn" id="maCsvBtn">インポート</button>' +
        '<div id="maCsvResult"></div></div>';
    }

    var wrow = '';
    m.warehouses.forEach(function (w) {
      wrow += '<tr><td>' + esc(w.code) + '</td><td>' + esc(w.name) + '</td>' + actCell('warehouse', w.id) + '</tr>';
    });
    var wform = '';
    if (writable) {
      wform = '<form class="grid" id="maWarehouseForm">' +
        '<div><label>倉庫コード</label><input id="mwCode" required></div>' +
        '<div><label>倉庫名</label><input id="mwName" required></div>' +
        '<div><label>&nbsp;</label><button class="btn" type="submit">倉庫を追加</button></div></form>';
    }
    h += masterSection('倉庫', simpleTable('<th>コード</th><th>名前</th>' + actHead, wrow), wform);

    var lrow = '';
    m.locations.forEach(function (l) {
      lrow += '<tr><td>' + esc(locationLabel(l.id)) + '</td><td>' + esc(l.code) + '</td>' + actCell('location', l.id) + '</tr>';
    });
    var lform = '';
    if (writable) {
      lform = '<form class="grid" id="maLocationForm">' +
        '<div><label>倉庫</label><select id="mlWarehouse">' + optionsHtml(m.warehouses, function (w) { return w.id; }, function (w) { return w.name; }, '') + '</select></div>' +
        '<div><label>場所コード</label><input id="mlCode" required></div>' +
        '<div><label>場所名</label><input id="mlName" required></div>' +
        '<div><label>&nbsp;</label><button class="btn" type="submit">保管場所を追加</button></div></form>';
    }
    h += masterSection('保管場所', simpleTable('<th>場所</th><th>コード</th>' + actHead, lrow), lform);

    var lotrow = '';
    m.lots.forEach(function (l) {
      lotrow += '<tr><td>' + esc(productLabel(l.productId)) + '</td><td>' + esc(l.lotCode) + '</td><td>' + esc(l.expiryDate || '-') + '</td>' +
        actCell('lot', l.id) + '</tr>';
    });
    var lotform = '';
    if (writable) {
      lotform = '<form class="grid" id="maLotForm">' +
        '<div><label>商品</label><select id="mlotProduct">' + optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select></div>' +
        '<div><label>ロット番号</label><input id="mlotCode" required></div>' +
        '<div><label>有効期限 (任意)</label><input id="mlotExpiry" type="date"></div>' +
        '<div><label>&nbsp;</label><button class="btn" type="submit">ロットを追加</button></div></form>';
    }
    h += masterSection('ロット', simpleTable('<th>商品</th><th>ロット番号</th><th>期限</th>' + actHead, lotrow), lotform);

    if (feat('purchase_orders')) {
      var srow = '';
      (m.suppliers || []).forEach(function (s) {
        srow += '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.contact || '-') + '</td><td>' + esc(s.email || '-') + '</td><td>' + esc(s.phone || '-') + '</td><td>' + esc(s.note || '-') + '</td>' +
          actCell('supplier', s.id) + '</tr>';
      });
      var sform = '';
      if (writable) {
        sform = '<form class="grid" id="maSupplierForm">' +
          '<div><label>仕入先名</label><input id="msName" required></div>' +
          '<div><label>担当者 (任意)</label><input id="msContact"></div>' +
          '<div><label>メール (任意)</label><input id="msEmail"></div>' +
          '<div><label>電話 (任意)</label><input id="msPhone"></div>' +
          '<div><label>メモ (任意)</label><input id="msNote"></div>' +
          '<div><label>&nbsp;</label><button class="btn" type="submit">仕入先を追加</button></div></form>';
      }
      h += masterSection('仕入先', simpleTable('<th>仕入先名</th><th>担当者</th><th>メール</th><th>電話</th><th>メモ</th>' + actHead, srow), sform);
    }

    el('view').innerHTML = h;

    var actBtns = el('view').querySelectorAll('button[data-mact]');
    for (var bi = 0; bi < actBtns.length; bi++) {
      actBtns[bi].onclick = function () { onMasterAction(this.getAttribute('data-mact'), Number(this.getAttribute('data-mid'))); };
    }
    var csvBtn = el('maCsvBtn');
    if (csvBtn) csvBtn.onclick = onCsvImport;

    function bindForm(id, build, done) {
      var f = el(id);
      if (!f) return;
      f.onsubmit = function (ev) {
        ev.preventDefault();
        api(build.path, { method: 'POST', body: build.body() }).then(function () {
          state.flash = done;
          state.master = null;
          loadMasterView();
        }).catch(function (e) {
          el('maMsg').innerHTML = msgHtml('error', errMsg(e));
        });
      };
    }
    bindForm('maProductForm', { path: '/api/v1/master/products', body: function () {
      var b = { sku: el('mpSku').value, name: el('mpName').value, unit: el('mpUnit').value, safetyStock: Number(el('mpSafety').value || 0), requiresExpiry: el('mpExpiry').value === '1' };
      if (el('mpBarcode').value) b.barcode = el('mpBarcode').value;
      if (el('mpAlertDays').value) b.expiryAlertDays = Number(el('mpAlertDays').value);
      if (el('mpCost').value) b.unitCost = Number(el('mpCost').value);
      return b;
    } }, '商品を追加しました。');
    bindForm('maWarehouseForm', { path: '/api/v1/master/warehouses', body: function () {
      return { code: el('mwCode').value, name: el('mwName').value };
    } }, '倉庫を追加しました。');
    bindForm('maLocationForm', { path: '/api/v1/master/locations', body: function () {
      return { warehouseId: Number(el('mlWarehouse').value), code: el('mlCode').value, name: el('mlName').value };
    } }, '保管場所を追加しました。');
    bindForm('maLotForm', { path: '/api/v1/master/lots', body: function () {
      var b = { productId: Number(el('mlotProduct').value), lotCode: el('mlotCode').value };
      if (el('mlotExpiry').value) b.expiryDate = el('mlotExpiry').value;
      return b;
    } }, 'ロットを追加しました。');
    bindForm('maSupplierForm', { path: '/api/v1/master/suppliers', body: function () {
      var b = { name: el('msName').value };
      if (el('msContact').value) b.contact = el('msContact').value;
      if (el('msEmail').value) b.email = el('msEmail').value;
      if (el('msPhone').value) b.phone = el('msPhone').value;
      if (el('msNote').value) b.note = el('msNote').value;
      return b;
    } }, '仕入先を追加しました。');
  });
}

/* ---------------- negative stock ---------------- */
function statusBadge(st) {
  if (st === 'approved') return '<span class="badge badge-ok">承認済み</span>';
  if (st === 'rejected') return '<span class="badge badge-danger">却下</span>';
  return '<span class="badge badge-warn">承認待ち</span>';
}
function loadNegative() {
  viewLoading('マイナス在庫', 'list');
  ensureMaster().then(function () {
    var jobs = [getJson('/api/v1/negative-approvals')];
    if (can('stocks.read')) jobs.push(getJson('/api/v1/stocks?take=200'));
    Promise.all(jobs).then(function (r) {
      var approvals = r[0] || [];
      var stocks = r[1] || [];
      var h = '<h2>マイナス在庫</h2><div id="ngMsg"></div>';
      if (can('negative.request')) {
        h += '<div class="section-box"><h3>例外申請 (在庫不足でも消費できるようにする申請)</h3>' +
          '<form class="grid" id="ngForm">' +
          '<div><label>対象の在庫</label><select id="ngStock">' +
          optionsHtml(stocks, function (s) { return s.id; }, function (s) { return productLabel(s.productId) + ' / ' + s.lotCode + ' / ' + locationLabel(s.locationId) + ' / 現在 ' + s.quantity; }, '') + '</select></div>' +
          '<div><label>許容数量</label><input id="ngQty" type="number" min="1" value="1" required></div>' +
          '<div><label>理由 (必須)</label><input id="ngReason" type="text" required></div>' +
          '<div><label>&nbsp;</label><button class="btn" type="submit">申請する</button></div></form></div>';
      }
      h += '<h3>申請一覧</h3>';
      if (approvals.length === 0) h += '<p class="muted">申請はありません。</p>';
      else {
        h += '<div class="table-wrap"><table><thead><tr><th>ID</th><th>在庫ID</th><th>数量</th><th>理由</th><th>状態</th><th>申請者</th><th>申請日時</th><th></th></tr></thead><tbody>';
        approvals.forEach(function (a) {
          var decide = '';
          if (a.status === 'pending' && can('negative.decide')) {
            if (a.requestedBy === state.me.id) decide = '<span class="small muted">自分の申請は承認できません</span>';
            else decide = '<button class="btn small" data-decide="approved" data-id="' + a.id + '">承認</button> ' +
              '<button class="btn small danger" data-decide="rejected" data-id="' + a.id + '">却下</button>';
          }
          h += '<tr><td>' + a.id + '</td><td>' + a.stockId + '</td><td>' + a.quantity + '</td><td>' + esc(a.reason) + '</td><td>' +
            statusBadge(a.status) + '</td><td>' + a.requestedBy + '</td><td>' + fmtDateTime(a.createdAt) + '</td><td>' + decide + '</td></tr>';
        });
        h += '</tbody></table></div>';
      }
      el('view').innerHTML = h;
      var form = el('ngForm');
      if (form) {
        form.onsubmit = function (ev) {
          ev.preventDefault();
          api('/api/v1/negative-approvals', { method: 'POST', body: {
            stockId: Number(el('ngStock').value),
            quantity: Number(el('ngQty').value),
            reason: el('ngReason').value,
          } }).then(function () { loadNegative(); }).catch(function (e) {
            el('ngMsg').innerHTML = msgHtml('error', errMsg(e));
          });
        };
      }
      var btns = el('view').querySelectorAll('button[data-decide]');
      for (var i = 0; i < btns.length; i++) {
        btns[i].onclick = function () {
          var id = this.getAttribute('data-id');
          var decision = this.getAttribute('data-decide');
          api('/api/v1/negative-approvals/' + id + '/decide', { method: 'POST', body: { decision: decision } })
            .then(function () { loadNegative(); })
            .catch(function (e) { el('ngMsg').innerHTML = msgHtml('error', errMsg(e)); });
        };
      }
    }).catch(function (e) {
      el('view').innerHTML = '<h2>マイナス在庫</h2>' + msgHtml('error', errMsg(e));
    });
  });
}

/* ---------------- stocktakes ---------------- */
function stocktakeStatusBadge(st) {
  if (st === 'in_progress') return '<span class="badge badge-warn">実施中</span>';
  if (st === 'pending_approval') return '<span class="badge badge-danger">差異承認待ち</span>';
  if (st === 'confirmed') return '<span class="badge badge-ok">確定済み</span>';
  return '<span class="badge">' + esc(st) + '</span>';
}
function loadStocktakes() {
  viewLoading('棚卸し', 'list');
  ensureMaster().then(function () {
    return getJson('/api/v1/stocktakes');
  }).then(function (rows) {
    var active = null;
    rows.forEach(function (t) {
      if (t.status === 'in_progress' || t.status === 'pending_approval') active = t;
    });
    var manage = can('stocktakes.manage');
    var h = '<h2>棚卸し</h2><div id="tkMsg"></div>';
    h += msgHtml('info', '棚卸し実施中・差異承認待ちの間は、入庫・消費・移動などの在庫更新がすべて停止します (API は 423 を返します)。');
    if (active && active.status === 'in_progress') {
      h += msgHtml('warn', '棚卸し #' + active.id + ' が実施中です (開始: ' + fmtDateTime(active.startedAt) + ')。各在庫の実数を入力し、終了してください。');
      if (manage) h += '<p><button class="btn" id="tkFinish">棚卸しを終了する</button></p>';
    }
    if (active && active.status === 'pending_approval') {
      h += msgHtml('warn', '棚卸し #' + active.id + ' に差異があり、承認待ちです。承認すると差異が在庫へ反映されます。');
      if (manage) {
        h += '<p><button class="btn" id="tkApprove">承認して在庫へ反映</button> ' +
          '<button class="btn danger" id="tkReject">差し戻す (実数入力に戻る)</button></p>';
      }
    }
    if (!active && manage) {
      h += '<p><button class="btn" id="tkStart">棚卸しを開始する</button></p>';
    }
    h += '<div id="tkDetail"></div>';
    if (!rows || rows.length === 0) h += '<p class="muted">棚卸しの履歴はありません。</p>';
    else {
      h += '<div class="table-wrap"><table><thead><tr><th>ID</th><th>状態</th><th>開始者</th><th>開始日時</th><th>確定日時</th></tr></thead><tbody>';
      rows.forEach(function (t) {
        h += '<tr><td>' + t.id + '</td><td>' + stocktakeStatusBadge(t.status) +
          '</td><td>' + t.startedBy + '</td><td>' + fmtDateTime(t.startedAt) + '</td><td>' + fmtDateTime(t.confirmedAt) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    el('view').innerHTML = h;
    var start = el('tkStart');
    if (start) start.onclick = function () {
      api('/api/v1/stocktakes', { method: 'POST', body: {} }).then(function () { loadStocktakes(); })
        .catch(function (e) { el('tkMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
    var finish = el('tkFinish');
    if (finish) finish.onclick = function () {
      api('/api/v1/stocktakes/' + active.id + '/finish', { method: 'POST', body: {} }).then(function (r) {
        if (r && r.status === 'pending_approval') {
          el('tkMsg').innerHTML = msgHtml('warn', '差異が ' + (r.differences ? r.differences.length : 0) + ' 件あります。承認待ちになりました。');
          loadStocktakes();
        } else {
          loadStocktakes();
        }
      }).catch(function (e) { el('tkMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
    var approve = el('tkApprove');
    if (approve) approve.onclick = function () {
      if (!window.confirm('差異を在庫へ反映して棚卸しを確定します。よろしいですか?')) return;
      api('/api/v1/stocktakes/' + active.id + '/decide', { method: 'POST', body: { approve: true } })
        .then(function () { loadStocktakes(); })
        .catch(function (e) { el('tkMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
    var reject = el('tkReject');
    if (reject) reject.onclick = function () {
      api('/api/v1/stocktakes/' + active.id + '/decide', { method: 'POST', body: { approve: false } })
        .then(function () { loadStocktakes(); })
        .catch(function (e) { el('tkMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
    if (active) renderStocktakeDetail(active);
  }).catch(function (e) {
    el('view').innerHTML = '<h2>棚卸し</h2>' + msgHtml('error', errMsg(e));
  });
}
function renderStocktakeDetail(t) {
  var box = el('tkDetail');
  if (!box) return;
  api('/api/v1/stocktakes/' + t.id).then(function (d) {
    var manage = can('stocktakes.manage');
    var editable = manage && d.status === 'in_progress';
    var h = '<div class="section-box"><h3>棚卸し #' + d.id + ' の明細 ' + stocktakeStatusBadge(d.status) + '</h3>';
    if (!d.lines || d.lines.length === 0) {
      h += '<p class="muted">対象の在庫がありません。</p>';
    } else {
      h += '<div class="table-wrap"><table><thead><tr><th>商品</th><th>ロット</th><th>保管場所</th><th>帳簿数</th><th>実数</th><th>差異</th><th></th></tr></thead><tbody>';
      d.lines.forEach(function (ln) {
        var diff = ln.difference === null ? '<span class="muted">-</span>'
          : (ln.difference === 0 ? '0' : '<span class="' + (ln.difference < 0 ? 'qty-neg' : 'qty-pos') + '">' + (ln.difference > 0 ? '+' : '') + ln.difference + '</span>');
        var input = editable
          ? '<input type="number" min="0" step="1" id="cnt-' + ln.id + '" value="' + (ln.countedQuantity === null ? '' : ln.countedQuantity) + '" style="width: 6em;">'
          : (ln.countedQuantity === null ? '<span class="muted">未入力</span>' : ln.countedQuantity);
        var btn = editable ? '<button class="btn small" data-count-line="' + ln.id + '">保存</button>' : '';
        h += '<tr><td>' + esc(productLabel(ln.productId)) + '</td><td>' + esc(ln.lotCode) + '</td><td>' + esc(locationLabel(ln.locationId)) +
          '</td><td>' + ln.bookQuantity + '</td><td>' + input + '</td><td>' + diff + '</td><td>' + btn + '</td></tr>';
      });
      h += '</tbody></table></div>';
      h += '<p class="small muted">実数が未入力の行は帳簿どおり (差異なし) として扱われます。</p>';
    }
    h += '</div>';
    box.innerHTML = h;
    var btns = box.querySelectorAll('button[data-count-line]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = function () {
        var lineId = this.getAttribute('data-count-line');
        var v = el('cnt-' + lineId).value;
        if (v === '') { el('tkMsg').innerHTML = msgHtml('error', '実数を入力してください。'); return; }
        api('/api/v1/stocktakes/' + d.id + '/lines/' + lineId, { method: 'PUT', body: { countedQuantity: Number(v) } })
          .then(function () { renderStocktakeDetail(t); })
          .catch(function (e) { el('tkMsg').innerHTML = msgHtml('error', errMsg(e)); });
      };
    }
  }).catch(function (e) {
    box.innerHTML = msgHtml('error', errMsg(e));
  });
}

/* ---------------- alerts ---------------- */
var ALERT_LABELS = { EXPIRED: '期限切れ', EXPIRING: '期限接近', LOW_STOCK: '在庫不足', NEGATIVE_STOCK: 'マイナス在庫' };
function loadAlerts() {
  viewLoading('アラート', 'list');
  ensureMaster().then(function () {
    getJson('/api/v1/alerts').then(function (rows) {
      if (!rows || rows.length === 0) {
        el('view').innerHTML = '<h2>アラート</h2><p class="muted">現在アラートはありません。</p>';
        return;
      }
      var order = ['EXPIRED', 'NEGATIVE_STOCK', 'EXPIRING', 'LOW_STOCK'];
      var h = '<h2>アラート</h2>';
      order.forEach(function (type) {
        var group = rows.filter(function (r) { return r.type === type; });
        if (group.length === 0) return;
        h += '<h3>' + esc(ALERT_LABELS[type] || type) + ' (' + group.length + '件)</h3>';
        h += '<div class="table-wrap"><table><thead><tr><th>商品</th><th>SKU</th><th>数量</th><th>期限</th></tr></thead><tbody>';
        group.forEach(function (r) {
          h += '<tr><td>' + esc(productLabel(r.productId)) + '</td><td>' + esc(r.sku) + '</td><td>' +
            (r.quantity < 0 ? '<span class="qty-neg">' + r.quantity + '</span>' : r.quantity) + '</td><td>' + esc(r.expiryDate || '-') + '</td></tr>';
        });
        h += '</tbody></table></div>';
      });
      el('view').innerHTML = h;
    }).catch(function (e) {
      el('view').innerHTML = '<h2>アラート</h2>' + msgHtml('error', errMsg(e));
    });
  });
}

/* ---------------- purchases ---------------- */
var PO_STATUS_LABELS = { draft: ['下書き', ''], ordered: ['発注済み', 'badge-warn'], received: ['入荷完了', 'badge-ok'], cancelled: ['取消', 'badge-danger'] };
function poStatusBadge(st) {
  var def = PO_STATUS_LABELS[st] || [st, ''];
  return '<span class="badge ' + def[1] + '">' + esc(def[0]) + '</span>';
}
function yen(n) { return '¥' + Number(n).toLocaleString('ja-JP'); }
function loadPurchases() {
  viewLoading('発注', 'list');
  ensureMaster().then(function (m) {
    return Promise.all([
      api('/api/v1/purchase-orders'),
      api('/api/v1/purchase-orders/suggestions').catch(function () { return []; }),
    ]).then(function (r) {
      renderPurchases(m, r[0] || [], r[1] || []);
    });
  }).catch(function (e) {
    el('view').innerHTML = '<h2>発注</h2>' + msgHtml('error', errMsg(e));
  });
}
function appendPoLine(m, productId, quantity, unitCost) {
  var box = el('poLines');
  if (!box) return;
  var row = document.createElement('div');
  row.className = 'toolbar';
  row.innerHTML =
    '<div><label>商品</label><select data-pol-product>' +
    optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, productId || '') + '</select></div>' +
    '<div><label>数量</label><input type="number" min="1" step="1" value="' + (quantity || 1) + '" data-pol-qty></div>' +
    '<div><label>単価 (円、任意)</label><input type="number" min="0" step="1" value="' + (unitCost === null || unitCost === undefined ? '' : unitCost) + '" data-pol-cost></div>' +
    '<div><label>&nbsp;</label><button class="btn small danger" type="button" data-pol-remove>削除</button></div>';
  row.querySelector('[data-pol-remove]').onclick = function () { row.remove(); };
  box.appendChild(row);
}
function renderPurchases(m, orders, suggestions) {
  var writable = can('purchases.write');
  var h = '<h2>発注</h2><div id="poMsg"></div>';
  if (state.flash) { h += msgHtml('success', state.flash); state.flash = ''; }

  h += '<div class="section-box"><h3>発注提案 (安全在庫を下回っている商品)</h3>';
  if (!suggestions.length) {
    h += '<p class="muted">提案はありません。</p>';
  } else {
    h += '<div class="table-wrap"><table><thead><tr><th>商品</th><th>現在庫</th><th>安全在庫</th><th>不足</th><th>提案数量</th>' + (writable ? '<th></th>' : '') + '</tr></thead><tbody>';
    suggestions.forEach(function (s) {
      h += '<tr><td>' + esc(productLabel(s.productId)) + '</td><td>' + s.totalQuantity + '</td><td>' + s.safetyStock + '</td>' +
        '<td><span class="qty-neg">' + s.shortage + '</span></td><td>' + s.suggestedQuantity + '</td>' +
        (writable ? '<td><button class="btn small" data-suggest="' + s.productId + '" data-qty="' + s.suggestedQuantity + '">発注書に追加</button></td>' : '') + '</tr>';
    });
    h += '</tbody></table></div>';
  }
  h += '</div>';

  if (writable) {
    h += '<div class="section-box"><h3>発注書を作成</h3>' +
      '<form class="grid" id="poHeadForm">' +
      '<div><label>仕入先</label><select id="poSupplier" required>' +
      optionsHtml(m.suppliers || [], function (s) { return s.id; }, function (s) { return s.name; }, '') + '</select></div>' +
      '<div><label>入荷予定日 (任意)</label><input id="poExpected" type="date"></div>' +
      '<div><label>メモ (任意)</label><input id="poNote" type="text"></div>' +
      '</form>' +
      '<div id="poLines"></div>' +
      '<p><button class="btn secondary" type="button" id="poAddLine">明細を追加</button> ' +
      '<button class="btn" type="button" id="poSubmit">発注書を作成 (下書き)</button></p></div>';
  }

  h += '<h3>発注書一覧</h3>';
  if (!orders.length) h += '<p class="muted">発注書がありません。</p>';
  orders.forEach(function (po) {
    h += '<div class="section-box"><h3>#' + po.id + ' ' + esc(po.supplierName || ('仕入先#' + po.supplierId)) + ' ' + poStatusBadge(po.status) + '</h3>' +
      '<p class="small muted">作成: ' + fmtDateTime(po.createdAt) + (po.expectedDate ? ' / 入荷予定: ' + esc(po.expectedDate) : '') + (po.note ? ' / メモ: ' + esc(po.note) : '') + '</p>';
    h += '<div class="table-wrap"><table><thead><tr><th>商品</th><th>発注数</th><th>入荷済み</th><th>単価</th></tr></thead><tbody>';
    po.lines.forEach(function (ln) {
      h += '<tr><td>' + esc(productLabel(ln.productId)) + '</td><td>' + ln.quantity + '</td><td>' + ln.receivedQuantity + '</td><td>' +
        (ln.unitCost === null || ln.unitCost === undefined ? '-' : yen(ln.unitCost)) + '</td></tr>';
    });
    h += '</tbody></table></div>';
    if (writable && (po.status === 'draft' || po.status === 'ordered')) {
      h += '<h3>入荷登録</h3><form class="grid" data-receive="' + po.id + '">' +
        '<div><label>入荷先 保管場所</label><select data-rc-loc>' +
        optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '') + '</select></div>';
      po.lines.forEach(function (ln) {
        var remain = ln.quantity - ln.receivedQuantity;
        if (remain <= 0) return;
        h += '<div><label>' + esc(productLabel(ln.productId)) + ' の入荷数 (残 ' + remain + ')</label><input type="number" min="0" step="1" value="' + remain + '" data-rc-qty="' + ln.id + '"></div>' +
          '<div><label>ロット番号</label><input type="text" data-rc-lot="' + ln.id + '" placeholder="例: LOT-2026-001"></div>' +
          '<div><label>有効期限 (任意)</label><input type="date" data-rc-exp="' + ln.id + '"></div>';
      });
      h += '<div><label>&nbsp;</label><button class="btn" type="submit">入荷を登録</button></div></form>';
    }
    h += '</div>';
  });
  el('view').innerHTML = h;

  var sugs = el('view').querySelectorAll('button[data-suggest]');
  for (var si = 0; si < sugs.length; si++) {
    sugs[si].onclick = function () {
      var pid = Number(this.getAttribute('data-suggest'));
      var p = productOf(pid);
      appendPoLine(m, pid, Number(this.getAttribute('data-qty')), p ? p.unitCost : null);
      var form = el('poHeadForm');
      if (form) form.scrollIntoView({ block: 'start' });
    };
  }
  var addBtn = el('poAddLine');
  if (addBtn) addBtn.onclick = function () { appendPoLine(m); };
  if (writable) appendPoLine(m);
  var submitBtn = el('poSubmit');
  if (submitBtn) submitBtn.onclick = function () {
    el('poMsg').innerHTML = '';
    var rows = el('poLines').querySelectorAll('.toolbar');
    var lines = [];
    for (var i = 0; i < rows.length; i++) {
      var line = { productId: Number(rows[i].querySelector('[data-pol-product]').value), quantity: Number(rows[i].querySelector('[data-pol-qty]').value) };
      var cost = rows[i].querySelector('[data-pol-cost]').value;
      if (cost !== '') line.unitCost = Number(cost);
      if (line.quantity > 0) lines.push(line);
    }
    if (!el('poSupplier').value) { el('poMsg').innerHTML = msgHtml('error', '仕入先を選んでください (マスタ管理で登録できます)。'); return; }
    if (lines.length === 0) { el('poMsg').innerHTML = msgHtml('error', '明細を 1 件以上追加してください。'); return; }
    var body = { supplierId: Number(el('poSupplier').value), lines: lines };
    if (el('poExpected').value) body.expectedDate = el('poExpected').value;
    if (el('poNote').value) body.note = el('poNote').value;
    submitBtn.disabled = true;
    api('/api/v1/purchase-orders', { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: body })
      .then(function () {
        state.flash = '発注書を作成しました。';
        loadPurchases();
      })
      .catch(function (e) {
        submitBtn.disabled = false;
        el('poMsg').innerHTML = msgHtml('error', errMsg(e));
      });
  };
  var rcForms = el('view').querySelectorAll('form[data-receive]');
  for (var fi = 0; fi < rcForms.length; fi++) {
    rcForms[fi].onsubmit = function (ev) {
      ev.preventDefault();
      var form = this;
      var poId = form.getAttribute('data-receive');
      el('poMsg').innerHTML = '';
      var qtys = form.querySelectorAll('[data-rc-qty]');
      var lines = [];
      var invalid = '';
      for (var i = 0; i < qtys.length; i++) {
        var qty = Number(qtys[i].value || 0);
        if (qty <= 0) continue;
        var lineId = qtys[i].getAttribute('data-rc-qty');
        var lot = form.querySelector('[data-rc-lot="' + lineId + '"]').value;
        if (!lot) { invalid = 'ロット番号を入力してください。'; break; }
        var line = { lineId: Number(lineId), quantity: qty, lotCode: lot };
        var exp = form.querySelector('[data-rc-exp="' + lineId + '"]').value;
        if (exp) line.expiryDate = exp;
        lines.push(line);
      }
      if (invalid) { el('poMsg').innerHTML = msgHtml('error', invalid); return; }
      if (lines.length === 0) { el('poMsg').innerHTML = msgHtml('error', '入荷数を入力してください。'); return; }
      var body = { locationId: Number(form.querySelector('[data-rc-loc]').value), lines: lines };
      api('/api/v1/purchase-orders/' + poId + '/receive', { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: body })
        .then(function (r) {
          state.flash = r.status === 'received' ? '入荷が完了し、発注書が「入荷完了」になりました。' : '部分入荷を登録しました。';
          loadPurchases();
        })
        .catch(function (e) { el('poMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
  }
}

/* ---------------- analytics ---------------- */
function monthlyChartSvg(monthly) {
  var max = 1;
  monthly.forEach(function (mm) { max = Math.max(max, mm.in, mm.out); });
  var W = 640;
  var H = 196;
  var base = 164;
  var bw = 26;
  var group = (W - 50) / Math.max(monthly.length, 1);
  var s = '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="月別入庫と消費のグラフ">';
  s += '<rect x="20" y="0" width="10" height="10" rx="2" fill="#34c759"></rect><text x="34" y="9" font-size="11" fill="currentColor">入庫</text>';
  s += '<rect x="92" y="0" width="10" height="10" rx="2" fill="#ff9500"></rect><text x="106" y="9" font-size="11" fill="currentColor">消費</text>';
  monthly.forEach(function (mm, i) {
    var gx = 26 + i * group;
    var ih = Math.round((mm.in / max) * 118);
    var oh = Math.round((mm.out / max) * 118);
    s += '<rect x="' + gx + '" y="' + (base - ih) + '" width="' + bw + '" height="' + ih + '" rx="3" fill="#34c759"></rect>';
    s += '<rect x="' + (gx + bw + 4) + '" y="' + (base - oh) + '" width="' + bw + '" height="' + oh + '" rx="3" fill="#ff9500"></rect>';
    s += '<text x="' + (gx + bw + 2) + '" y="' + (base + 17) + '" font-size="11" text-anchor="middle" fill="currentColor">' + esc(String(mm.month).slice(5)) + '月</text>';
    s += '<text x="' + (gx + bw / 2) + '" y="' + (base - ih - 4) + '" font-size="10" text-anchor="middle" fill="currentColor">' + mm.in + '</text>';
    s += '<text x="' + (gx + bw + 4 + bw / 2) + '" y="' + (base - oh - 4) + '" font-size="10" text-anchor="middle" fill="currentColor">' + mm.out + '</text>';
  });
  s += '<line x1="16" y1="' + base + '" x2="' + (W - 8) + '" y2="' + base + '" stroke="currentColor" stroke-opacity="0.25"></line>';
  return s + '</svg>';
}
function loadAnalytics() {
  viewLoading('分析レポート', 'cards');
  ensureMaster().then(function () {
    return api('/api/v1/analytics');
  }).then(function (r) {
    var h = '<h2>分析レポート</h2>';
    h += '<div class="cards">' +
      '<div class="card"><div class="num">' + yen(r.valuation.totalValue) + '</div><div class="lbl">在庫評価額 (単価設定分)</div></div>' +
      '<div class="card"><div class="num">' + Math.round(r.valuation.coverageRate * 100) + '%</div><div class="lbl">単価設定済み (' + r.valuation.pricedProducts + ' / ' + r.valuation.totalProducts + ' 商品)</div></div>' +
      '<div class="card"><div class="num' + (r.deadStock.length > 0 ? ' qty-neg' : '') + '">' + r.deadStock.length + '</div><div class="lbl">滞留在庫 (最終移動から90日超)</div></div>' +
      '</div>';
    h += '<h3>月別の入庫・消費 (直近6ヶ月)</h3><div class="chart-wrap">' + monthlyChartSvg(r.monthly) + '</div>';
    h += '<h3>滞留在庫</h3>';
    if (!r.deadStock.length) {
      h += '<p class="muted">滞留在庫はありません。</p>';
    } else {
      h += '<div class="table-wrap"><table><thead><tr><th>商品</th><th>SKU</th><th>在庫数</th><th>最終移動</th></tr></thead><tbody>';
      r.deadStock.forEach(function (d) {
        h += '<tr><td>' + esc(d.name) + '</td><td>' + esc(d.sku) + '</td><td>' + d.totalQuantity + '</td><td>' +
          (d.lastMovementAt ? fmtDateTime(d.lastMovementAt) : '<span class="muted">移動履歴なし</span>') + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    h += '<h3>消費上位 (直近90日)</h3>';
    if (!r.topConsumed.length) {
      h += '<p class="muted">直近90日の消費がありません。</p>';
    } else {
      h += '<div class="table-wrap"><table><thead><tr><th>商品</th><th>SKU</th><th>消費数量</th></tr></thead><tbody>';
      r.topConsumed.forEach(function (t) {
        h += '<tr><td>' + esc(t.name) + '</td><td>' + esc(t.sku) + '</td><td>' + t.quantity + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    el('view').innerHTML = h;
  }).catch(function (e) {
    el('view').innerHTML = '<h2>分析レポート</h2>' + msgHtml('error', errMsg(e));
  });
}

/* ---------------- audit logs (admin) ---------------- */
var auditState = { limit: 50, offset: 0, total: 0 };
function loadAudit() {
  el('view').innerHTML =
    '<h2>監査ログ</h2>' +
    '<div class="toolbar">' +
    '<div><label>実行者 (ユーザーID)</label><input id="auActor" type="number" min="1"></div>' +
    '<div><label>アクション</label><input id="auAction" type="text" placeholder="例: role_permissions.update"></div>' +
    '<div><label>開始 (日時)</label><input id="auFrom" type="datetime-local"></div>' +
    '<div><label>終了 (日時)</label><input id="auTo" type="datetime-local"></div>' +
    '<div><label>&nbsp;</label><button class="btn" id="auSearch">検索</button></div>' +
    '<div><label>&nbsp;</label><button class="btn secondary" id="auExport">データをエクスポート (JSON)</button></div>' +
    '</div>' +
    '<div id="auMsg"></div><div id="auBody">' + skeletonRows() + '</div>' +
    '<div class="toolbar">' +
    '<div><button class="btn secondary" id="auPrev">前へ</button></div>' +
    '<div><span id="auPage" class="small muted"></span></div>' +
    '<div><button class="btn secondary" id="auNext">次へ</button></div>' +
    '</div>';
  auditState.offset = 0;
  el('auSearch').onclick = function () { auditState.offset = 0; fetchAudit(); };
  el('auExport').onclick = downloadExport;
  el('auPrev').onclick = function () {
    if (auditState.offset > 0) { auditState.offset -= auditState.limit; fetchAudit(); }
  };
  el('auNext').onclick = function () {
    if (auditState.offset + auditState.limit < auditState.total) { auditState.offset += auditState.limit; fetchAudit(); }
  };
  fetchAudit();
}
function fetchAudit() {
  var q = '?limit=' + auditState.limit + '&offset=' + auditState.offset;
  var actor = el('auActor').value;
  if (actor) q += '&actor=' + encodeURIComponent(actor);
  var action = el('auAction').value;
  if (action) q += '&action=' + encodeURIComponent(action);
  var from = el('auFrom').value;
  if (from) q += '&from=' + new Date(from).getTime();
  var to = el('auTo').value;
  if (to) q += '&to=' + new Date(to).getTime();
  getJson('/api/v1/admin/audit-logs' + q).then(function (r) {
    auditState.total = r.total;
    el('auPage').textContent = r.total === 0
      ? '0 件'
      : (r.offset + 1) + ' - ' + Math.min(r.offset + r.items.length, r.total) + ' / ' + r.total + ' 件';
    el('auPrev').disabled = r.offset <= 0;
    el('auNext').disabled = r.offset + r.items.length >= r.total;
    if (!r.items.length) {
      el('auBody').innerHTML = '<p class="muted">該当する監査ログがありません。</p>';
      return;
    }
    var h = '<div class="table-wrap"><table><thead><tr><th>日時</th><th>ID</th><th>実行者</th><th>アクション</th><th>対象</th><th>内容</th></tr></thead><tbody>';
    for (var i = 0; i < r.items.length; i++) {
      var a = r.items[i];
      h += '<tr><td>' + fmtDateTime(a.createdAt) + '</td><td>' + a.id + '</td><td>' +
        (a.actorId === null ? '-' : a.actorId) + '</td><td>' + esc(a.action) + '</td><td>' +
        esc(a.targetType + ' #' + a.targetId) + '</td><td>' +
        esc(a.payload === null ? '' : JSON.stringify(a.payload)) + '</td></tr>';
    }
    h += '</tbody></table></div>';
    el('auBody').innerHTML = h;
  }).catch(function (e) {
    el('auBody').innerHTML = msgHtml('error', errMsg(e));
  });
}
function downloadExport() {
  el('auMsg').innerHTML = '';
  api('/api/v1/admin/export.json').then(function (data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'inventory-export.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    el('auMsg').innerHTML = msgHtml('success', 'エクスポートをダウンロードしました。');
  }).catch(function (e) {
    el('auMsg').innerHTML = msgHtml('error', errMsg(e));
  });
}

/* ---------------- realtime ---------------- */
var wsConn = null;
function setWsStatus(on) {
  var dot = el('wsDot');
  var lbl = el('wsLabel');
  if (dot) dot.className = 'ws-dot' + (on ? ' on' : '');
  if (lbl) lbl.textContent = on ? 'リアルタイム接続中' : 'リアルタイム未接続';
}
function connectWs() {
  try {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsConn = new WebSocket(proto + '//' + location.host + '/api/v1/realtime');
    wsConn.onopen = function () { setWsStatus(true); scheduleRefresh(); };
    wsConn.onmessage = function (ev) {
      try {
        var m = JSON.parse(ev.data);
        if (m && m.type && m.type.indexOf('stock') === 0) { invalidateCache(); scheduleRefresh(); }
      } catch (e) { /* ignore */ }
    };
    wsConn.onclose = function () {
      setWsStatus(false);
      if (state.me) setTimeout(connectWs, 5000);
    };
    wsConn.onerror = function () { try { wsConn.close(); } catch (e) { /* ignore */ } };
  } catch (e) {
    if (state.me) setTimeout(connectWs, 5000);
  }
}

/* ---------------- 店舗の選択・切替 ---------------- */
function selectStore(storeId) {
  api('/api/v1/session/store', { method: 'POST', body: { storeId: storeId } }).then(function () {
    location.reload();
  }).catch(function (e) {
    var m = el('storeMsg');
    if (m && el('storeBox').style.display !== 'none') m.innerHTML = msgHtml('error', errMsg(e));
    else window.alert(errMsg(e));
  });
}
function showStorePicker(me) {
  el('storeBox').style.display = '';
  var stores = me.stores || [];
  var h = '';
  for (var i = 0; i < stores.length; i++) {
    var s = stores[i];
    h += '<button class="group-row" data-store="' + s.id + '"><span class="row-label">' + esc(s.name) + ' <small class="muted">' + esc(s.code) + '</small></span>' +
      (s.status === 'suspended' ? '<span class="badge badge-danger">停止中</span>' : '') +
      '<span class="chev">' + icon('chevR', 18) + '</span></button>';
  }
  if (stores.length === 0) {
    h = '<div class="group-row static"><span class="row-label">入れる店舗がありません。管理者に確認してください。</span></div>';
  }
  el('storeList').innerHTML = h;
  var rows = el('storeList').querySelectorAll('button[data-store]');
  for (var j = 0; j < rows.length; j++) {
    rows[j].onclick = function () { selectStore(Number(this.getAttribute('data-store'))); };
  }
}
function renderStoreSwitch(me) {
  var sel = el('storeSwitch');
  if (!sel) return;
  var stores = me.stores || [];
  if (stores.length < 2 || !me.currentStore) { sel.style.display = 'none'; return; }
  var h = '';
  for (var i = 0; i < stores.length; i++) {
    var s = stores[i];
    h += '<option value="' + s.id + '"' + (s.id === me.currentStore.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
  }
  sel.innerHTML = h;
  sel.style.display = '';
  sel.onchange = function () { selectStore(Number(sel.value)); };
}

/* ---------------- boot ---------------- */
function boot() {
  el('sheetOverlay').addEventListener('click', function (e) { if (e.target === this) closeSheet(); });
  el('sheetCancel').onclick = closeSheet;
  api('/api/v1/me').then(function (me) {
    state.me = me;
    state.features = me.features || {};
    (me.permissions || []).forEach(function (p) { state.perms[p] = true; });
    el('loadingBox').style.display = 'none';
    if ((!me.assignments || me.assignments.length === 0) && !me.isPlatformAdmin) {
      el('noAssignBox').style.display = '';
      return;
    }
    if (!me.currentStore) {
      showStorePicker(me);
      return;
    }
    el('appBox').style.display = '';
    el('userLabel').textContent = me.email + (me.displayName ? ' (' + me.displayName + ')' : '');
    renderStoreSwitch(me);
    buildNav();
    showView('dashboard');
    connectWs();
    /* 先読み: よく使うデータを裏で温めて、タブ切り替えを即時にする */
    ensureMaster();
    if (can('alerts.read') && feat('alerts')) getJson('/api/v1/alerts').catch(function () {});
    if (can('stocks.read')) {
      getJson('/api/v1/stocks?take=200').catch(function () {});
      getJson('/api/v1/movements?take=100').catch(function () {});
    }
    getJson('/api/v1/stocktakes').catch(function () {});
  }).catch(function (err) {
    el('loadingBox').style.display = 'none';
    if (err && err.status === 403) el('noAssignBox').style.display = '';
    else el('loginBox').style.display = '';
  });
}
document.addEventListener('DOMContentLoaded', boot);
`;
