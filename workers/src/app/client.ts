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
      return data;
    });
  });
}
function errMsg(e) {
  if (e && e.status === 423) return '棚卸し実施中のため、この操作は停止しています (423)。棚卸しが終了するまでお待ちください。';
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
  view: 'dashboard',
  master: null,
  masterError: '',
  flash: '',
  refreshTimer: null,
};
function can(p) { return state.perms[p] === true; }

/* マスタ (商品・倉庫・場所・ロット) を一度だけ読み込む */
function ensureMaster() {
  if (state.master) return Promise.resolve(state.master);
  if (!can('master.read')) {
    state.master = { products: [], warehouses: [], locations: [], lots: [] };
    return Promise.resolve(state.master);
  }
  return Promise.all([
    api('/api/v1/master/products?take=200'),
    api('/api/v1/master/warehouses'),
    api('/api/v1/master/locations'),
    api('/api/v1/master/lots'),
  ]).then(function (r) {
    state.master = { products: r[0] || [], warehouses: r[1] || [], locations: r[2] || [], lots: r[3] || [] };
    return state.master;
  }).catch(function (e) {
    state.masterError = errMsg(e);
    state.master = { products: [], warehouses: [], locations: [], lots: [] };
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
/* 期限バッジ: 期限切れ=赤、接近 (商品のアラート日数、既定30日) =黄 */
function expiryBadge(dateStr, alertDays) {
  if (!dateStr) return '<span class="muted">-</span>';
  var parts = dateStr.split('-');
  var exp = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var nowD = new Date();
  var today = Date.UTC(nowD.getFullYear(), nowD.getMonth(), nowD.getDate());
  var days = Math.round((exp - today) / 86400000);
  if (days < 0) return '<span class="badge badge-danger">' + esc(dateStr) + ' 期限切れ</span>';
  var limit = alertDays === null || alertDays === undefined ? 30 : alertDays;
  if (days <= limit) return '<span class="badge badge-warn">' + esc(dateStr) + ' あと' + days + '日</span>';
  return '<span>' + esc(dateStr) + '</span>';
}

/* ---------------- navigation ---------------- */
var VIEWS = [
  { id: 'dashboard', label: 'ダッシュボード', visible: function () { return true; } },
  { id: 'stocks', label: '在庫一覧', visible: function () { return can('stocks.read'); } },
  { id: 'inbound', label: '入庫', visible: function () { return can('movements.inbound'); } },
  { id: 'consume', label: '消費', visible: function () { return can('movements.consume'); } },
  { id: 'history', label: '履歴', visible: function () { return can('stocks.read'); } },
  { id: 'master', label: 'マスタ管理', visible: function () { return can('master.read'); } },
  { id: 'negative', label: 'マイナス在庫', visible: function () { return can('negative.request') || can('negative.decide'); } },
  { id: 'stocktakes', label: '棚卸し', visible: function () { return true; } },
  { id: 'alerts', label: 'アラート', visible: function () { return can('alerts.read'); } },
];
function buildNav() {
  var h = '';
  for (var i = 0; i < VIEWS.length; i++) {
    var v = VIEWS[i];
    if (!v.visible()) continue;
    h += '<button data-view="' + v.id + '"' + (state.view === v.id ? ' class="active"' : '') + '>' + esc(v.label) + '</button>';
  }
  el('tabs').innerHTML = h;
  var btns = el('tabs').querySelectorAll('button[data-view]');
  for (var j = 0; j < btns.length; j++) {
    btns[j].onclick = function () { showView(this.getAttribute('data-view')); };
  }
}
function showView(id) {
  state.view = id;
  buildNav();
  var loaders = {
    dashboard: loadDashboard,
    stocks: loadStocks,
    inbound: loadInbound,
    consume: loadConsume,
    history: loadHistory,
    master: loadMasterView,
    negative: loadNegative,
    stocktakes: loadStocktakes,
    alerts: loadAlerts,
  };
  var fn = loaders[id];
  if (fn) fn();
}
function refreshCurrent() { showView(state.view); }
function scheduleRefresh() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(function () {
    state.refreshTimer = null;
    if (state.me) refreshCurrent();
  }, 400);
}

/* ---------------- dashboard ---------------- */
function loadDashboard() {
  el('view').innerHTML = '<h2>ダッシュボード</h2><p class="muted">読み込み中…</p>';
  var jobs = [];
  jobs.push(can('alerts.read') ? api('/api/v1/alerts') : Promise.resolve(null));
  jobs.push(can('stocks.read') ? api('/api/v1/stocks?take=200') : Promise.resolve(null));
  jobs.push(api('/api/v1/stocktakes'));
  Promise.all(jobs).then(function (r) {
    var alerts = r[0];
    var stocks = r[1];
    var stocktakes = r[2] || [];
    var h = '<h2>ダッシュボード</h2>';
    var active = null;
    for (var i = 0; i < stocktakes.length; i++) { if (stocktakes[i].status === 'in_progress') { active = stocktakes[i]; break; } }
    if (active) h += msgHtml('warn', '棚卸し実施中です (開始: ' + fmtDateTime(active.startedAt) + ')。入庫・消費は停止しています。');
    h += '<div class="cards">';
    if (alerts) {
      var counts = { EXPIRED: 0, EXPIRING: 0, LOW_STOCK: 0, NEGATIVE_STOCK: 0 };
      for (var a = 0; a < alerts.length; a++) { if (counts[alerts[a].type] !== undefined) counts[alerts[a].type]++; }
      h += '<div class="card"><div class="num">' + alerts.length + '</div><div class="lbl">アラート総数</div></div>';
      h += '<div class="card"><div class="num">' + counts.EXPIRED + '</div><div class="lbl">期限切れ</div></div>';
      h += '<div class="card"><div class="num">' + counts.EXPIRING + '</div><div class="lbl">期限接近</div></div>';
      h += '<div class="card"><div class="num">' + counts.LOW_STOCK + '</div><div class="lbl">在庫不足</div></div>';
      h += '<div class="card"><div class="num">' + counts.NEGATIVE_STOCK + '</div><div class="lbl">マイナス在庫</div></div>';
    }
    if (stocks) {
      var total = 0;
      for (var s = 0; s < stocks.length; s++) total += stocks[s].quantity;
      h += '<div class="card"><div class="num">' + stocks.length + '</div><div class="lbl">在庫レコード数</div></div>';
      h += '<div class="card"><div class="num">' + total + '</div><div class="lbl">総数量 (表示分)</div></div>';
    }
    h += '</div>';
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
  }).catch(function (e) {
    el('view').innerHTML = '<h2>ダッシュボード</h2>' + msgHtml('error', errMsg(e));
  });
}

/* ---------------- stocks ---------------- */
function stockRowHtml(s) {
  var p = productOf(s.productId);
  return '<tr><td>' + esc(productLabel(s.productId)) + '</td>' +
    '<td>' + esc(s.lotCode) + '</td>' +
    '<td>' + esc(locationLabel(s.locationId)) + '</td>' +
    '<td>' + (s.quantity < 0 ? '<span class="qty-neg">' + s.quantity + '</span>' : s.quantity) + '</td>' +
    '<td>' + expiryBadge(s.expiryDate, p ? p.expiryAlertDays : null) + '</td></tr>';
}
function loadStocks() {
  el('view').innerHTML =
    '<h2>在庫一覧</h2>' +
    '<div class="toolbar">' +
    '<div><label>キーワード (SKU / 商品名 / ロット)</label><input id="stQ" type="search" placeholder="検索"></div>' +
    '<div><label>倉庫</label><select id="stWh"><option value="">すべて</option></select></div>' +
    '<div><label>保管場所</label><select id="stLoc"><option value="">すべて</option></select></div>' +
    '<div><button class="btn" id="stReload">再読み込み</button></div>' +
    '</div>' +
    '<div id="stMsg"></div><div id="stBody"><p class="muted">読み込み中…</p></div>';
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
    fetchStocks();
  });
  function fetchStocks() {
    var loc = el('stLoc') ? el('stLoc').value : '';
    var path = '/api/v1/stocks?take=200' + (loc ? '&locationId=' + encodeURIComponent(loc) : '');
    el('stMsg').innerHTML = '';
    api(path).then(function (rows) {
      var q = (el('stQ').value || '').toLowerCase();
      var wh = el('stWh').value;
      var filtered = rows.filter(function (s) {
        if (wh && String(s.warehouseId) !== String(wh)) return false;
        if (!q) return true;
        var text = (s.sku + ' ' + s.lotCode + ' ' + productLabel(s.productId)).toLowerCase();
        return text.indexOf(q) >= 0;
      });
      if (filtered.length === 0) {
        el('stBody').innerHTML = '<p class="muted">在庫がありません。</p>';
        return;
      }
      var h = '<div class="table-wrap"><table><thead><tr><th>商品</th><th>ロット</th><th>保管場所</th><th>数量</th><th>期限</th></tr></thead><tbody>';
      for (var i = 0; i < filtered.length; i++) h += stockRowHtml(filtered[i]);
      h += '</tbody></table></div><p class="small muted">' + filtered.length + ' 件</p>';
      el('stBody').innerHTML = h;
    }).catch(function (e) {
      el('stBody').innerHTML = msgHtml('error', errMsg(e));
    });
  }
}

/* ---------------- inbound ---------------- */
function loadInbound() {
  el('view').innerHTML = '<h2>入庫</h2><p class="muted">読み込み中…</p>';
  ensureMaster().then(function (m) {
    if (state.masterError) {
      el('view').innerHTML = '<h2>入庫</h2>' + msgHtml('error', 'マスタの読み込みに失敗しました: ' + state.masterError);
      return;
    }
    var h = '<h2>入庫</h2><div id="inMsg"></div>' +
      '<form class="grid" id="inForm">' +
      '<div><label>商品</label><select id="inProduct" required>' +
      optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select>' +
      '<span class="small muted" id="inProdHint"></span></div>' +
      '<div><label>保管場所</label><select id="inLocation" required>' +
      optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '') + '</select></div>' +
      '<div><label>ロット番号</label><input id="inLot" type="text" required placeholder="例: LOT-2026-001"></div>' +
      '<div><label>有効期限 (期限管理対象の商品は必須)</label><input id="inExpiry" type="date"></div>' +
      '<div><label>数量</label><input id="inQty" type="number" min="1" step="1" required value="1"></div>' +
      '<div><label>&nbsp;</label><button class="btn" type="submit" id="inSubmit">入庫を登録</button></div>' +
      '</form>';
    el('view').innerHTML = h;
    var updateHint = function () {
      var p = productOf(Number(el('inProduct').value));
      el('inProdHint').textContent = p && p.requiresExpiry ? 'この商品は有効期限が必須です' : '';
    };
    el('inProduct').onchange = updateHint;
    updateHint();
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
  el('view').innerHTML = '<h2>消費</h2><p class="muted">読み込み中…</p>';
  ensureMaster().then(function (m) {
    if (state.masterError) {
      el('view').innerHTML = '<h2>消費</h2>' + msgHtml('error', 'マスタの読み込みに失敗しました: ' + state.masterError);
      return;
    }
    var h = '<h2>消費 (FEFO: 期限の早いロットから自動で引きます)</h2><div id="coMsg"></div>' +
      '<form class="grid" id="coForm">' +
      '<div><label>商品</label><select id="coProduct" required>' +
      optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select></div>' +
      '<div><label>保管場所 (任意: 指定しない場合は全場所から)</label><select id="coLocation">' +
      optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '', '指定しない') + '</select></div>' +
      '<div><label>数量</label><input id="coQty" type="number" min="1" step="1" required value="1"></div>' +
      '<div><label>部署</label><input id="coDept" type="text" required></div>' +
      '<div><label>用途</label><input id="coPurpose" type="text" required></div>' +
      '<div><label>マイナス在庫承認 ID (任意: 承認済みの申請を使う場合)</label><input id="coApproval" type="number" min="1" step="1"></div>' +
      '<div><label>&nbsp;</label><button class="btn" type="submit" id="coSubmit">消費を登録</button></div>' +
      '</form><div id="coResult"></div>';
    el('view').innerHTML = h;
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

/* ---------------- history ---------------- */
function loadHistory() {
  el('view').innerHTML = '<h2>入出庫履歴</h2><p class="muted">読み込み中…</p>';
  ensureMaster().then(function () {
    api('/api/v1/movements?take=100').then(function (rows) {
      if (!rows || rows.length === 0) {
        el('view').innerHTML = '<h2>入出庫履歴</h2><p class="muted">履歴がありません。</p>';
        return;
      }
      var h = '<h2>入出庫履歴</h2><div class="table-wrap"><table><thead><tr>' +
        '<th>日時</th><th>種別</th><th>商品</th><th>ロット</th><th>保管場所</th><th>変化</th><th>数量 (前 → 後)</th><th>部署 / 用途</th></tr></thead><tbody>';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var isIn = r.type === 'IN' || r.type === 'TRANSFER_IN';
        h += '<tr><td>' + fmtDateTime(r.createdAt) + '</td>' +
          '<td>' + (isIn ? '<span class="badge badge-ok">入庫</span>' : '<span class="badge">消費</span>') + '</td>' +
          '<td>' + esc(productLabel(r.productId)) + '</td>' +
          '<td>' + esc(r.lotCode || '') + '</td>' +
          '<td>' + esc(locationLabel(r.locationId)) + '</td>' +
          '<td>' + (r.quantityChange > 0 ? '<span class="qty-pos">+' + r.quantityChange + '</span>' : '<span class="qty-neg">' + r.quantityChange + '</span>') + '</td>' +
          '<td>' + r.quantityBefore + ' → ' + r.quantityAfter + '</td>' +
          '<td>' + esc([r.department, r.purpose].filter(Boolean).join(' / ')) + '</td></tr>';
      }
      h += '</tbody></table></div>';
      el('view').innerHTML = h;
    }).catch(function (e) {
      el('view').innerHTML = '<h2>入出庫履歴</h2>' + msgHtml('error', errMsg(e));
    });
  });
}

/* ---------------- master ---------------- */
function masterSection(title, tableHtml, formHtml) {
  return '<div class="section-box"><h3>' + esc(title) + '</h3>' + tableHtml + formHtml + '</div>';
}
function simpleTable(head, rowsHtml) {
  if (!rowsHtml) return '<p class="muted">データがありません。</p>';
  return '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}
function loadMasterView() {
  el('view').innerHTML = '<h2>マスタ管理</h2><p class="muted">読み込み中…</p>';
  state.master = null;
  ensureMaster().then(function (m) {
    var writable = can('master.write');
    var h = '<h2>マスタ管理</h2><div id="maMsg"></div>';
    if (state.flash) { h += msgHtml('success', state.flash); state.flash = ''; }
    if (state.masterError) h += msgHtml('error', state.masterError);

    var prow = '';
    m.products.forEach(function (p) {
      prow += '<tr><td>' + esc(p.sku) + '</td><td>' + esc(p.name) + '</td><td>' + esc(p.unit) + '</td><td>' + p.safetyStock + '</td><td>' +
        (p.requiresExpiry ? '必須' : '-') + '</td><td>' + (p.expiryAlertDays === null || p.expiryAlertDays === undefined ? '-' : p.expiryAlertDays + '日前') + '</td></tr>';
    });
    var pform = '';
    if (writable) {
      pform = '<form class="grid" id="maProductForm">' +
        '<div><label>SKU</label><input id="mpSku" required></div>' +
        '<div><label>商品名</label><input id="mpName" required></div>' +
        '<div><label>単位</label><input id="mpUnit" required value="個"></div>' +
        '<div><label>バーコード (任意)</label><input id="mpBarcode"></div>' +
        '<div><label>安全在庫</label><input id="mpSafety" type="number" min="0" value="0"></div>' +
        '<div><label>アラート日数 (任意)</label><input id="mpAlertDays" type="number" min="0"></div>' +
        '<div><label>有効期限</label><select id="mpExpiry"><option value="">不要</option><option value="1">必須</option></select></div>' +
        '<div><label>&nbsp;</label><button class="btn" type="submit">商品を追加</button></div></form>';
    }
    h += masterSection('商品', simpleTable('<th>SKU</th><th>商品名</th><th>単位</th><th>安全在庫</th><th>期限</th><th>アラート</th>', prow), pform);

    var wrow = '';
    m.warehouses.forEach(function (w) { wrow += '<tr><td>' + esc(w.code) + '</td><td>' + esc(w.name) + '</td></tr>'; });
    var wform = '';
    if (writable) {
      wform = '<form class="grid" id="maWarehouseForm">' +
        '<div><label>倉庫コード</label><input id="mwCode" required></div>' +
        '<div><label>倉庫名</label><input id="mwName" required></div>' +
        '<div><label>&nbsp;</label><button class="btn" type="submit">倉庫を追加</button></div></form>';
    }
    h += masterSection('倉庫', simpleTable('<th>コード</th><th>名前</th>', wrow), wform);

    var lrow = '';
    m.locations.forEach(function (l) { lrow += '<tr><td>' + esc(locationLabel(l.id)) + '</td><td>' + esc(l.code) + '</td></tr>'; });
    var lform = '';
    if (writable) {
      lform = '<form class="grid" id="maLocationForm">' +
        '<div><label>倉庫</label><select id="mlWarehouse">' + optionsHtml(m.warehouses, function (w) { return w.id; }, function (w) { return w.name; }, '') + '</select></div>' +
        '<div><label>場所コード</label><input id="mlCode" required></div>' +
        '<div><label>場所名</label><input id="mlName" required></div>' +
        '<div><label>&nbsp;</label><button class="btn" type="submit">保管場所を追加</button></div></form>';
    }
    h += masterSection('保管場所', simpleTable('<th>場所</th><th>コード</th>', lrow), lform);

    var lotrow = '';
    m.lots.forEach(function (l) {
      lotrow += '<tr><td>' + esc(productLabel(l.productId)) + '</td><td>' + esc(l.lotCode) + '</td><td>' + esc(l.expiryDate || '-') + '</td></tr>';
    });
    var lotform = '';
    if (writable) {
      lotform = '<form class="grid" id="maLotForm">' +
        '<div><label>商品</label><select id="mlotProduct">' + optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select></div>' +
        '<div><label>ロット番号</label><input id="mlotCode" required></div>' +
        '<div><label>有効期限 (任意)</label><input id="mlotExpiry" type="date"></div>' +
        '<div><label>&nbsp;</label><button class="btn" type="submit">ロットを追加</button></div></form>';
    }
    h += masterSection('ロット', simpleTable('<th>商品</th><th>ロット番号</th><th>期限</th>', lotrow), lotform);

    el('view').innerHTML = h;

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
  });
}

/* ---------------- negative stock ---------------- */
function statusBadge(st) {
  if (st === 'approved') return '<span class="badge badge-ok">承認済み</span>';
  if (st === 'rejected') return '<span class="badge badge-danger">却下</span>';
  return '<span class="badge badge-warn">承認待ち</span>';
}
function loadNegative() {
  el('view').innerHTML = '<h2>マイナス在庫</h2><p class="muted">読み込み中…</p>';
  ensureMaster().then(function () {
    var jobs = [api('/api/v1/negative-approvals')];
    if (can('stocks.read')) jobs.push(api('/api/v1/stocks?take=200'));
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
function loadStocktakes() {
  el('view').innerHTML = '<h2>棚卸し</h2><p class="muted">読み込み中…</p>';
  api('/api/v1/stocktakes').then(function (rows) {
    var active = null;
    rows.forEach(function (t) { if (t.status === 'in_progress') active = t; });
    var h = '<h2>棚卸し</h2><div id="tkMsg"></div>';
    h += msgHtml('info', '棚卸し実施中は、入庫・消費などの在庫更新がすべて停止します (API は 423 を返します)。');
    if (active) {
      h += msgHtml('warn', '棚卸し #' + active.id + ' が実施中です (開始: ' + fmtDateTime(active.startedAt) + ')。');
      if (can('stocktakes.manage')) {
        h += '<p><button class="btn" id="tkFinish">棚卸しを終了する</button></p>';
      }
    } else if (can('stocktakes.manage')) {
      h += '<p><button class="btn" id="tkStart">棚卸しを開始する</button></p>';
    }
    if (!rows || rows.length === 0) h += '<p class="muted">棚卸しの履歴はありません。</p>';
    else {
      h += '<div class="table-wrap"><table><thead><tr><th>ID</th><th>状態</th><th>開始者</th><th>開始日時</th><th>確定日時</th></tr></thead><tbody>';
      rows.forEach(function (t) {
        h += '<tr><td>' + t.id + '</td><td>' +
          (t.status === 'in_progress' ? '<span class="badge badge-warn">実施中</span>' : '<span class="badge badge-ok">確定済み</span>') +
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
      api('/api/v1/stocktakes/' + active.id + '/finish', { method: 'POST', body: {} }).then(function () { loadStocktakes(); })
        .catch(function (e) { el('tkMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
  }).catch(function (e) {
    el('view').innerHTML = '<h2>棚卸し</h2>' + msgHtml('error', errMsg(e));
  });
}

/* ---------------- alerts ---------------- */
var ALERT_LABELS = { EXPIRED: '期限切れ', EXPIRING: '期限接近', LOW_STOCK: '在庫不足', NEGATIVE_STOCK: 'マイナス在庫' };
function loadAlerts() {
  el('view').innerHTML = '<h2>アラート</h2><p class="muted">読み込み中…</p>';
  ensureMaster().then(function () {
    api('/api/v1/alerts').then(function (rows) {
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
        if (m && m.type && m.type.indexOf('stock') === 0) scheduleRefresh();
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

/* ---------------- boot ---------------- */
function boot() {
  el('logoutBtn').onclick = function () {
    api('/api/v1/auth/logout', { method: 'POST' }).then(function () { location.href = '/'; })
      .catch(function () { location.href = '/'; });
  };
  api('/api/v1/me').then(function (me) {
    state.me = me;
    (me.permissions || []).forEach(function (p) { state.perms[p] = true; });
    el('loadingBox').style.display = 'none';
    if (!me.assignments || me.assignments.length === 0) {
      el('noAssignBox').style.display = '';
      return;
    }
    el('appBox').style.display = '';
    el('userLabel').textContent = me.email + (me.displayName ? ' (' + me.displayName + ')' : '');
    var permLink = el('permLink');
    if (permLink && !can('admin.permissions') && !can('admin.users')) permLink.style.display = 'none';
    buildNav();
    showView('dashboard');
    connectWs();
  }).catch(function (err) {
    el('loadingBox').style.display = 'none';
    if (err && err.status === 403) el('noAssignBox').style.display = '';
    else el('loginBox').style.display = '';
  });
}
document.addEventListener('DOMContentLoaded', boot);
`;
