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
/* ---------------- メンテナンス表示 ---------------- */
var MAINT_FEATURE_LABELS = { inbound: '入庫', outbound: '消費・出庫', transfers: '移動', stocktakes: '棚卸し', purchase_orders: '発注', suppliers: '仕入先', csv_export: 'CSVエクスポート', csv_import: 'CSVインポート', master_products: '商品マスタ', master_locations: '倉庫・保管場所', analytics: '分析', alerts: 'アラート', login: '新規ログイン' };
function maintFeatureText(features) {
  if (!features) return '';
  var keys = Object.keys(features);
  if (keys.length === 0) return '';
  var parts = [];
  keys.forEach(function (k) { parts.push(MAINT_FEATURE_LABELS[k] || k); });
  return parts.join('・');
}
/* 実施中の features 停止で、対象キー群の実効段階を返す ('full' > 'write' > null) */
function maintStageFor(keys) {
  var a = state.maintenance && state.maintenance.active;
  if (!a || a.level !== 'features' || !a.features) return null;
  var stage = null;
  keys.forEach(function (k) {
    var s = a.features[k];
    if (s === 'full') stage = 'full';
    else if (s === 'write' && stage !== 'full') stage = 'write';
  });
  return stage;
}
function maintBadgeHtml(keys) {
  var stage = maintStageFor(keys);
  if (!stage) return '';
  return ' <span class="badge ' + (stage === 'full' ? 'badge-danger' : 'badge-warn') + '">' +
    (stage === 'full' ? '停止中' : '書込停止中') + '</span>';
}
/* 開始 10 分前 (imminent) で対象キーに掛かる予定があれば、その予定を返す */
function maintImminentFor(keys) {
  var u = state.maintenance && state.maintenance.upcoming;
  if (!u || u.phase !== 'imminent' || !u.features) return null;
  var hit = false;
  keys.forEach(function (k) { if (u.features[k]) hit = true; });
  return hit ? u : null;
}
/* フォーム見出しの注記 (停止バッジ / 開始直前の保存促し) と送信ボタンの無効化。
   1 画面に複数フォームがある場合 (マスタ管理) に備えて複数登録できる */
var currentFormNotes = [];
function setMaintFormNote(noteId, keys, submitSelectors) {
  currentFormNotes = currentFormNotes.filter(function (n) { return n.noteId !== noteId; });
  currentFormNotes.push({ noteId: noteId, keys: keys, submits: submitSelectors || [] });
  renderMaintFormNote();
}
function renderMaintFormNote() {
  currentFormNotes.forEach(function (cfg) {
    var note = el(cfg.noteId);
    var stage = maintStageFor(cfg.keys);
    if (note) {
      if (stage) {
        note.innerHTML = maintBadgeHtml(cfg.keys);
        note.style.display = '';
      } else if (maintImminentFor(cfg.keys)) {
        note.innerHTML = msgHtml('warn', 'まもなくメンテナンスが始まります。入力中の内容を保存してください');
        note.style.display = '';
      } else {
        note.innerHTML = '';
        note.style.display = 'none';
      }
    }
    if (stage) {
      cfg.submits.forEach(function (sel) {
        var btns = document.querySelectorAll(sel);
        for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
      });
    }
  });
}
function fmtDayTime(ms) {
  var d = new Date(ms);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function fmtEndText(endsAt) {
  if (!endsAt) return '終了未定';
  var now = new Date();
  var d = new Date(endsAt);
  var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  var sameDay = now.getFullYear() === d.getFullYear() && now.getMonth() === d.getMonth() && now.getDate() === d.getDate();
  var label = sameDay ? hm : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  var mins = Math.max(0, Math.round((endsAt - Date.now()) / 60000));
  return '終了予定 ' + label + '（残り約' + mins + '分）';
}
var maintenanceTimer = null;
function startMaintenanceTimer() {
  if (maintenanceTimer) return;
  maintenanceTimer = setInterval(refreshMaintenance, 60000);
}
function refreshMaintenance() {
  api('/api/v1/me').then(function (me) {
    var wasFull = !!(state.maintenance && state.maintenance.active && state.maintenance.active.level === 'full');
    var isFull = !!(me.maintenance && me.maintenance.active && me.maintenance.active.level === 'full');
    if (wasFull && !isFull) { location.reload(); return; }
    state.me = me;
    applyMaintenance(me.maintenance);
    if (state.me.currentStore) { buildNav(); renderMaintFormNote(); }
  }).catch(function () {});
}
/* /me の maintenance を画面に反映する。全画面表示にした場合は true を返す */
function applyMaintenance(m) {
  state.maintenance = m || { active: null, upcoming: null, lastEnded: null };
  var active = state.maintenance.active;
  var upcoming = state.maintenance.upcoming;
  var lastEnded = state.maintenance.lastEnded;
  var fullBox = el('maintenanceBox');
  if (active && active.level === 'full') {
    el('loadingBox').style.display = 'none';
    el('appBox').style.display = 'none';
    var mb0 = el('maintenanceBanner');
    if (mb0) mb0.style.display = 'none';
    if (fullBox) {
      fullBox.style.display = '';
      el('mntFullMessage').textContent = active.message || 'メンテナンス中です';
      el('mntFullEnds').textContent = fmtEndText(active.endsAt);
      var rb = el('mntReloadBtn');
      if (rb) rb.onclick = function () { location.reload(); };
    }
    startMaintenanceTimer();
    return true;
  }
  if (fullBox) fullBox.style.display = 'none';
  var mb = el('maintenanceBanner');
  if (mb) {
    if (active) {
      var target = active.level === 'read_only' ? '書き込み' : maintFeatureText(active.features);
      var text = 'メンテナンス中: ' + target + 'は停止中 ・ ' + fmtEndText(active.endsAt);
      if (active.message) text += ' ・ ' + active.message;
      mb.textContent = text;
      mb.className = 'maintenance-banner';
      mb.style.display = '';
      el('appBox').style.marginTop = '2.7rem';
    } else if (upcoming) {
      var range = fmtDayTime(upcoming.startsAt) + '〜' + (upcoming.endsAt ? fmtDayTime(upcoming.endsAt) : '');
      var scope = upcoming.level === 'full' ? '全面停止' : upcoming.level === 'read_only' ? '書き込み停止' : maintFeatureText(upcoming.features);
      mb.textContent = range + ' メンテナンス予定（' + scope + '）';
      /* 開始 60 分前からは警告色に格上げする (既定色が警告色、予定は情報色) */
      mb.className = upcoming.phase === 'scheduled' ? 'maintenance-banner upcoming' : 'maintenance-banner';
      mb.style.display = '';
      el('appBox').style.marginTop = '2.7rem';
    } else if (lastEnded && state.maintEndedDismissed !== lastEnded.endsAt) {
      mb.innerHTML = 'メンテナンスは終了しました（' + fmtDayTime(lastEnded.endsAt) + ' 終了）' +
        '<button type="button" class="mnt-close" aria-label="閉じる">×</button>';
      mb.className = 'maintenance-banner ended';
      mb.style.display = '';
      el('appBox').style.marginTop = '2.7rem';
      var closeBtn = mb.querySelector('.mnt-close');
      if (closeBtn) closeBtn.onclick = function () {
        state.maintEndedDismissed = lastEnded.endsAt;
        mb.style.display = 'none';
        el('appBox').style.marginTop = '';
      };
    } else {
      mb.style.display = 'none';
      el('appBox').style.marginTop = '';
    }
  }
  startMaintenanceTimer();
  return false;
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
  return apiOnce(path, opts).catch(function (err) {
    /* 重要操作の再認証要求: シートで再認証できたら元のリクエストを 1 回だけ再試行する */
    if (err && err.code === 'STEP_UP_REQUIRED' && !opts.stepUpRetried) {
      return requestStepUp().then(function () {
        opts.stepUpRetried = true;
        return apiOnce(path, opts);
      });
    }
    throw err;
  });
}
function apiOnce(path, opts) {
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
        err.level = data && data.level ? data.level : '';
        err.endsAt = data && data.endsAt ? data.endsAt : null;
        err.features = data && data.features ? data.features : {};
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

/* ---------------- 画像 (商品画像・検品写真) ---------------- */
/* アップロード前に長辺 1280px・JPEG 品質 0.82 へ圧縮する (サーバー上限は 2MB) */
function compressImageFile(file) {
  return new Promise(function (resolve, reject) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      try {
        var scale = Math.min(1, 1280 / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('画像の変換に失敗しました'));
        }, 'image/jpeg', 0.82);
      } catch (e) { reject(e); }
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}
function postImage(path, method, file) {
  return compressImageFile(file).then(function (blob) {
    return fetch(path, { method: method, headers: { 'Content-Type': 'image/jpeg' }, body: blob, credentials: 'same-origin' })
      .then(function (res) {
        return res.text().then(function (t) {
          var d = null;
          try { d = JSON.parse(t); } catch (e) { /* ignore */ }
          if (!res.ok) {
            var err = new Error(d && d.message ? d.message : 'HTTP ' + res.status);
            err.status = res.status;
            err.code = d && d.error ? d.error : '';
            throw err;
          }
          invalidateCache();
          return d;
        });
      });
  });
}
function uploadProductImage(productId, file) {
  return postImage('/api/v1/products/' + productId + '/image', 'PUT', file);
}
function uploadMovementPhoto(movementId, file) {
  return postImage('/api/v1/movements/' + movementId + '/photos', 'POST', file);
}
/* サムネイルの読み込み失敗 (画像なし・権限なし等) では行レイアウトを壊さず隠す */
function bindThumbFallbacks() {
  var imgs = document.querySelectorAll('img.thumb, img.thumb-lg');
  for (var i = 0; i < imgs.length; i++) {
    imgs[i].onerror = function () { this.style.display = 'none'; };
  }
}

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
  if (e && e.code === 'MAINTENANCE') {
    var mbase = e.message ? e.message : 'メンテナンス中です';
    return e.endsAt ? mbase + '（' + fmtEndText(e.endsAt) + '）' : mbase + '（終了未定）';
  }
  if (e && e.status === 423) return '棚卸し実施中のため、この操作は停止しています (423)。棚卸しが終了するまでお待ちください。';
  if (e && e.code === 'STORE_SUSPENDED') return 'この店舗は現在停止中です。';
  if (e && e.code === 'STORE_NOT_SELECTED') return '店舗が選択されていません。画面を再読み込みして、店舗を選んでください。';
  if (e && e.code === 'PLAN_LIMIT_REACHED') return 'プランの上限に達しています';
  if (e && e.code === 'PLAN_FEATURE_NOT_AVAILABLE') return '現在のプランでは使えません';
  if (e && e.code === 'STEP_UP_REQUIRED') return '再認証が必要です。';
  if (e && e.code === 'STEP_UP_CANCELLED') return '再認証がキャンセルされました。';
  return e && e.message ? e.message : String(e);
}
function msgHtml(kind, text) {
  if (!text) return '';
  return '<div class="msg ' + kind + '">' + esc(text) + '</div>';
}

/* ---------------- state ---------------- */
var state = {
  me: null,
  maintenance: null,
  maintEndedDismissed: null,
  perms: {},
  features: {},
  view: 'dashboard',
  master: null,
  masterExtras: null,
  masterError: '',
  flash: '',
  refreshTimer: null,
  /* お知らせの未読数 (ドックのホームバッジと連動) */
  annUnread: 0,
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
/* 運用マスタ (部門・理由コード・カテゴリ) を一度だけ読み込む (0020) */
function ensureMasterExtras() {
  if (state.masterExtras) return Promise.resolve(state.masterExtras);
  return Promise.all([
    api('/api/v1/master/departments').catch(function () { return []; }),
    api('/api/v1/master/reason-codes?kind=return').catch(function () { return []; }),
    api('/api/v1/master/reason-codes?kind=disposal').catch(function () { return []; }),
    api('/api/v1/master/categories').catch(function () { return []; }),
  ]).then(function (r) {
    state.masterExtras = {
      departments: r[0] || [],
      reasonReturn: r[1] || [],
      reasonDisposal: r[2] || [],
      categories: r[3] || [],
    };
    return state.masterExtras;
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
/* 場所ラベル: 倉庫 / 親 / … / 自身 の階層パス + コード (0015 で階層対応) */
function locationLabel(id) {
  var m = state.master;
  if (m) {
    for (var i = 0; i < m.locations.length; i++) {
      if (m.locations[i].id === id) {
        var loc = m.locations[i];
        var wh = '';
        for (var j = 0; j < m.warehouses.length; j++) {
          if (m.warehouses[j].id === loc.warehouseId) wh = m.warehouses[j].name;
        }
        var names = [loc.name];
        var parentId = loc.parentId;
        var guard = 0;
        while (parentId && guard < 10) {
          var parent = locationOf(parentId);
          if (!parent) break;
          names.unshift(parent.name);
          parentId = parent.parentId;
          guard++;
        }
        return (wh ? wh + ' / ' : '') + names.join(' / ') + ' (' + loc.code + ')';
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
  { id: 'announcements', label: 'お知らせ', visible: function () { return feat('announcements'); } },
  { id: 'announceAdmin', label: 'お知らせ管理', visible: function () { return can('announcements.write') && feat('announcements'); } },
  { id: 'returns', label: '返品', visible: function () { return can('movements.consume'); } },
  { id: 'disposal', label: '廃棄', visible: function () { return can('movements.consume'); } },
  { id: 'reservations', label: '引当', visible: function () { return can('movements.consume'); } },
  { id: 'picking', label: 'ピッキング', visible: function () { return can('movements.consume') || can('movements.transfer'); } },
  { id: 'setup', label: 'はじめに', visible: function () { return (can('admin.users') || can('master.write')) && can('master.read'); } },
  { id: 'security', label: 'セキュリティ', visible: function () { return true; } },
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
  mega: '<path d="M3.8 10.8v2.9a.9.9 0 0 0 .9.9h1.7l5 4.6V5.3l-5 4.6H4.7a.9.9 0 0 0-.9.9z"/><path d="M15.2 9.4a3.9 3.9 0 0 1 0 5.7M18 6.7a7.8 7.8 0 0 1 0 11.1"/>',
  chart: '<path d="M4 20.5h16"/><path d="M7.5 20v-6M12 20V6.5M16.5 20v-9.5"/>',
  sliders: '<line x1="4" y1="7" x2="20" y2="7"/><circle cx="9" cy="7" r="2.2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.2"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="7" cy="17" r="2.2"/>',
  chevL: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  chevR: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
};
function icon(name, size) {
  var s = size || 24;
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON_PATHS[name] || '') + '</svg>';
}

/* ビューの所属グループ: record=記録シート配下 / more=その他リスト配下 */
var RECORD_VIEWS = ['inbound', 'consume', 'transfer', 'returns', 'disposal'];
var MORE_VIEWS = ['master', 'negative', 'stocktakes', 'alerts', 'purchases', 'analytics', 'audit', 'announcements', 'announceAdmin', 'reservations', 'picking', 'setup', 'security', 'storeSettings'];
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
  var homeBadge = feat('announcements') && state.annUnread > 0 ? '<span class="tab-badge">' + state.annUnread + '</span>' : '';
  h += '<button class="tab-item' + (active === 'dashboard' ? ' active' : '') + '" data-tab="dashboard">' + icon('home', 25) + '<span>ホーム</span>' + homeBadge + '</button>';
  if (can('stocks.read')) {
    h += '<button class="tab-item' + (active === 'stocks' ? ' active' : '') + '" data-tab="stocks">' + icon('box', 25) + '<span>在庫</span></button>';
  }
  var anyRecord = RECORD_VIEWS.some(viewVisible) || viewVisible('negative');
  if (anyRecord) {
    /* 記録系の機能がメンテナンス停止中なら、記録ボタンに小ドットを出す */
    var recordDot = maintStageFor(['inbound', 'outbound', 'transfers']) ? '<span class="tab-dot"></span>' : '';
    h += '<button class="tab-plus' + (active === 'record' ? ' active' : '') + '" data-tab="record" aria-label="記録する"><span class="plus-circle">' + icon('plus', 26) + '</span><span>記録</span>' + recordDot + '</button>';
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
  { view: 'inbound', icon: 'in', color: '#34c759', label: '入庫する', maintKeys: ['inbound'] },
  { view: 'consume', icon: 'out', color: '#ff9500', label: '消費する', maintKeys: ['outbound'] },
  { view: 'transfer', icon: 'swap', color: '#0071e3', label: '移動する', maintKeys: ['transfers'] },
  { view: 'returns', icon: 'in', color: '#30b0c7', label: '返品する', maintKeys: ['inbound'] },
  { view: 'disposal', icon: 'out', color: '#ff3b30', label: '廃棄する', maintKeys: ['outbound'] },
  { view: 'negative', icon: 'minus', color: '#af52de', label: 'マイナス在庫 (申請・承認)', maintKeys: ['outbound'] },
];
function openSheet() {
  var h = '<div class="sheet-title">記録する</div>';
  for (var i = 0; i < SHEET_ITEMS.length; i++) {
    var it = SHEET_ITEMS[i];
    if (!viewVisible(it.view)) continue;
    h += '<button class="sheet-row" data-view="' + it.view + '"><span class="row-icon" style="background:' + it.color + '">' + icon(it.icon, 18) + '</span><span class="row-label">' + esc(it.label) + '</span>' + maintBadgeHtml(it.maintKeys) + '<span class="chev">' + icon('chevR', 18) + '</span></button>';
  }
  el('sheetBox').innerHTML = h;
  el('sheetOverlay').style.display = '';
  bindThumbFallbacks();
  var rows = el('sheetBox').querySelectorAll('button[data-view]');
  for (var j = 0; j < rows.length; j++) {
    rows[j].onclick = function () { closeSheet(); showView(this.getAttribute('data-view')); };
  }
}
function closeSheet() {
  el('sheetOverlay').style.display = 'none';
  /* 再認証シートを閉じたら、待ち中のリクエストはキャンセルとして落とす */
  if (typeof stepUpWaiters !== 'undefined' && stepUpWaiters.length) {
    var ws = stepUpWaiters;
    stepUpWaiters = [];
    for (var i = 0; i < ws.length; i++) {
      var ce = new Error('step up cancelled');
      ce.code = 'STEP_UP_CANCELLED';
      ws[i].reject(ce);
    }
  }
}
/* ---------------- お知らせ ---------------- */
function announcePeriodText(a) {
  var s = fmtDateTime(a.startsAt);
  return a.endsAt ? s + ' 〜 ' + fmtDateTime(a.endsAt) : s + ' 〜 (無期限)';
}
function loadAnnouncements() {
  viewLoading('お知らせ');
  getJson('/api/v1/announcements').then(function (data) {
    state.annUnread = data.unreadCount || 0;
    buildNav();
    var h = '<h2>お知らせ</h2>';
    h += '<div id="pushArea"></div>';
    var items = data.items || [];
    if (items.length === 0) {
      h += '<p class="muted">お知らせはありません。</p>';
    } else {
      h += '<div class="group">';
      for (var i = 0; i < items.length; i++) {
        var a = items[i];
        h += '<button class="group-row" data-ann="' + a.id + '">' +
          (a.read ? '' : '<span class="unread-dot"></span>') +
          '<span class="row-label"><span class="announce-title-line">' + esc(a.title) + '</span>' +
          '<span class="announce-meta">' + esc(fmtDateTime(a.startsAt)) +
          (a.storeId === null ? '<span>全店舗</span>' : '') +
          (a.priority === 'important' ? '<span class="badge badge-warn">重要</span>' : '') +
          '</span></span>' +
          '<span class="chev">' + icon('chevR', 18) + '</span></button>';
      }
      h += '</div>';
    }
    el('view').innerHTML = h;
    renderPushArea();
    var rows = el('view').querySelectorAll('button[data-ann]');
    for (var j = 0; j < rows.length; j++) {
      rows[j].onclick = function () { openAnnouncement(Number(this.getAttribute('data-ann'))); };
    }
  }).catch(function (e) {
    el('view').innerHTML = '<h2>お知らせ</h2>' + msgHtml('error', errMsg(e));
  });
}
function openAnnouncement(id) {
  api('/api/v1/announcements/' + id).then(function (a) {
    var h = '<h2>' + esc(a.title) + '</h2>';
    h += '<p class="muted">' + esc(announcePeriodText(a)) + (a.storeId === null ? ' ・ 全店舗' : '') + '</p>';
    if (a.priority === 'important') h += '<p><span class="badge badge-warn">重要</span></p>';
    h += '<div class="card announce-body">' + esc(a.body) + '</div>';
    h += '<p><button class="btn secondary" id="annBack">一覧へ戻る</button></p>';
    el('view').innerHTML = h;
    el('annBack').onclick = function () { showView('announcements'); };
    window.scrollTo(0, 0);
    /* 開いたら既読化し、ドックのバッジを更新する */
    if (!a.read) {
      api('/api/v1/announcements/' + id + '/read', { method: 'POST' }).then(function (r) {
        state.annUnread = r.unreadCount || 0;
        buildNav();
      }).catch(function () {});
    }
  }).catch(function (e) {
    el('view').innerHTML = '<h2>お知らせ</h2>' + msgHtml('error', errMsg(e));
  });
}

/* ---- プッシュ通知の購読 ---- */
function pushSupported() {
  return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
}
function isIosSafariTab() {
  var ua = navigator.userAgent || '';
  if (!/iPhone|iPad|iPod/.test(ua)) return false;
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  return !standalone;
}
function renderPushArea() {
  var box = el('pushArea');
  if (!box) return;
  if (isIosSafariTab()) {
    box.innerHTML = '<div class="card push-note">プッシュ通知は、ホーム画面に追加したアプリから開いたときに受け取れます。</div>';
    return;
  }
  if (!pushSupported()) {
    box.innerHTML = '<div class="card push-note">このブラウザはプッシュ通知に対応していません。</div>';
    return;
  }
  box.innerHTML = '<div class="card push-note"><div>新着のお知らせをプッシュ通知で受け取れます。</div><p><button class="btn" id="pushBtn" type="button">プッシュ通知を受け取る</button></p><div id="pushMsg"></div></div>';
  el('pushBtn').onclick = subscribePush;
  navigator.serviceWorker.ready.then(function (reg) {
    return reg.pushManager.getSubscription();
  }).then(function (sub) {
    var cur = el('pushArea');
    if (!cur || !sub) return;
    cur.innerHTML = '<div class="card push-note"><div>プッシュ通知は有効です。</div><p><button class="btn secondary" id="pushOffBtn" type="button">通知を解除する</button></p><div id="pushMsg"></div></div>';
    el('pushOffBtn').onclick = unsubscribePush;
  }).catch(function () {});
}
function urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var rawData = window.atob(base64);
  var outputArray = new Uint8Array(rawData.length);
  for (var i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
function subscribePush() {
  var msg = el('pushMsg');
  function fail(text) { if (msg) msg.innerHTML = msgHtml('error', text); }
  api('/api/v1/push/public-key').then(function (data) {
    return Notification.requestPermission().then(function (permission) {
      if (permission !== 'granted') {
        fail('通知が許可されませんでした。ブラウザの設定で通知を許可してください。');
        return null;
      }
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(data.publicKey),
        });
      });
    });
  }).then(function (sub) {
    if (!sub) return;
    var json = sub.toJSON();
    return api('/api/v1/push/subscribe', {
      method: 'POST',
      body: { endpoint: json.endpoint, keys: json.keys },
    }).then(function () { renderPushArea(); });
  }).catch(function (e) {
    if (e && e.code === 'PUSH_NOT_CONFIGURED') fail('プッシュ通知は未設定です (サーバー側で鍵が設定されていません)。');
    else fail(errMsg(e));
  });
}
function unsubscribePush() {
  navigator.serviceWorker.ready.then(function (reg) {
    return reg.pushManager.getSubscription();
  }).then(function (sub) {
    if (!sub) { renderPushArea(); return null; }
    var endpoint = sub.endpoint;
    return sub.unsubscribe().then(function () {
      return api('/api/v1/push/subscribe', { method: 'DELETE', body: { endpoint: endpoint } });
    }).then(function () { renderPushArea(); });
  }).catch(function (e) {
    var msg = el('pushMsg');
    if (msg) msg.innerHTML = msgHtml('error', errMsg(e));
  });
}

/* ---------------- お知らせ管理 ---------------- */
var announceAdminItems = [];
var announceEditId = null;
var announceAdminFlash = '';
function announceStateLabel(a) {
  var now = Date.now();
  if (a.startsAt > now) return '<span class="badge">掲載前</span>';
  if (a.endsAt && a.endsAt <= now) return '<span class="badge">終了</span>';
  return '<span class="badge badge-ok">掲載中</span>';
}
function toLocalInputValue(ts) {
  var d = new Date(ts);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function canPostAllStores() {
  if (!state.me) return false;
  if (state.me.isPlatformAdmin) return true;
  var storeId = state.me.currentStore ? state.me.currentStore.id : null;
  var list = state.me.assignments || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].storeId === storeId && list[i].roleCode === 'SYSTEM_ADMIN') return true;
  }
  return false;
}
function loadAnnounceAdmin() {
  viewLoading('お知らせ管理');
  api('/api/v1/admin/announcements').then(function (data) {
    announceAdminItems = data.items || [];
    var editing = null;
    if (announceEditId !== null) {
      for (var ei = 0; ei < announceAdminItems.length; ei++) {
        if (announceAdminItems[ei].id === announceEditId) editing = announceAdminItems[ei];
      }
      if (!editing) announceEditId = null;
    }
    var h = '<h2>お知らせ管理</h2>';
    if (announceAdminFlash) { h += msgHtml('success', announceAdminFlash); announceAdminFlash = ''; }
    h += '<div id="annAdminMsg"></div>';
    h += '<form class="grid" id="annForm">' +
      '<div><label>タイトル</label><input id="annTitle" type="text" required maxlength="200"></div>' +
      '<div><label>本文</label><textarea id="annBody" rows="5" required></textarea></div>' +
      '<div><label>重要度</label><select id="annPriority"><option value="normal">通常</option><option value="important">重要</option></select></div>' +
      '<div><label>対象</label><select id="annStore">' +
      '<option value="store">現在の店舗 (' + esc(state.me && state.me.currentStore ? state.me.currentStore.name : '') + ')</option>' +
      (canPostAllStores() ? '<option value="all">全店舗</option>' : '') +
      '</select></div>' +
      '<div><label>掲載開始</label><input id="annStart" type="datetime-local"></div>' +
      '<div><label>掲載終了 (空欄は無期限)</label><input id="annEnd" type="datetime-local"></div>' +
      '<div><label>プッシュ通知</label><label><input id="annPush" type="checkbox"> 掲載開始時にプッシュ通知を送る</label></div>' +
      '<div class="sticky-actions"><button class="btn" type="submit" id="annSubmit">' + (editing ? '更新する' : '投稿する') + '</button>' +
      (editing ? '<button class="btn secondary" type="button" id="annCancelEdit">編集をやめる</button>' : '') +
      '</div></form>';
    h += '<h3>投稿済み</h3>';
    if (announceAdminItems.length === 0) {
      h += '<p class="muted">まだ投稿がありません。</p>';
    } else {
      h += '<div class="group">';
      for (var i = 0; i < announceAdminItems.length; i++) {
        var a = announceAdminItems[i];
        h += '<div class="group-row static"><span class="row-label">' + esc(a.title) +
          '<span class="small muted" style="display:block">' + announcePeriodText(a) +
          (a.storeId === null ? ' ・ 全店舗' : '') +
          ' ・ 既読 ' + (a.readCount || 0) + '/' + (a.targetUsers || 0) + ' 人' +
          (a.push ? ' ・ プッシュ' + (a.pushSentAt ? '送信済み' : '予定') : '') +
          '</span></span>' + announceStateLabel(a) +
          '<button class="btn small secondary" type="button" data-annedit="' + a.id + '">編集</button>' +
          '<button class="btn small secondary" type="button" data-anndel="' + a.id + '">削除</button></div>';
      }
      h += '</div>';
    }
    el('view').innerHTML = h;
    if (editing) {
      el('annTitle').value = editing.title;
      el('annBody').value = editing.body;
      el('annPriority').value = editing.priority;
      el('annStore').value = editing.storeId === null ? 'all' : 'store';
      el('annStart').value = toLocalInputValue(editing.startsAt);
      el('annEnd').value = editing.endsAt ? toLocalInputValue(editing.endsAt) : '';
      el('annPush').checked = editing.push === true;
    } else {
      el('annStart').value = toLocalInputValue(Date.now());
    }
    var cancelBtn = el('annCancelEdit');
    if (cancelBtn) cancelBtn.onclick = function () { announceEditId = null; loadAnnounceAdmin(); };
    var editBtns = el('view').querySelectorAll('button[data-annedit]');
    for (var j = 0; j < editBtns.length; j++) {
      editBtns[j].onclick = function () {
        announceEditId = Number(this.getAttribute('data-annedit'));
        loadAnnounceAdmin();
        window.scrollTo(0, 0);
      };
    }
    var delBtns = el('view').querySelectorAll('button[data-anndel]');
    for (var k = 0; k < delBtns.length; k++) {
      delBtns[k].onclick = function () {
        var id = Number(this.getAttribute('data-anndel'));
        if (!confirm('このお知らせを削除しますか？')) return;
        api('/api/v1/admin/announcements/' + id, { method: 'DELETE' }).then(function () {
          if (announceEditId === id) announceEditId = null;
          announceAdminFlash = '削除しました。';
          loadAnnounceAdmin();
        }).catch(function (e) {
          el('annAdminMsg').innerHTML = msgHtml('error', errMsg(e));
        });
      };
    }
    el('annForm').onsubmit = function (ev) {
      ev.preventDefault();
      var btn = el('annSubmit');
      btn.disabled = true;
      el('annAdminMsg').innerHTML = '';
      var body = {
        title: el('annTitle').value.trim(),
        body: el('annBody').value,
        priority: el('annPriority').value,
        storeId: el('annStore').value === 'all' ? null : (state.me.currentStore ? state.me.currentStore.id : null),
        startsAt: el('annStart').value ? new Date(el('annStart').value).getTime() : undefined,
        endsAt: el('annEnd').value ? new Date(el('annEnd').value).getTime() : null,
        push: el('annPush').checked,
      };
      var req = announceEditId !== null
        ? api('/api/v1/admin/announcements/' + announceEditId, { method: 'PUT', body: body })
        : api('/api/v1/admin/announcements', { method: 'POST', body: body });
      req.then(function () {
        announceAdminFlash = announceEditId !== null ? '更新しました。' : '投稿しました。';
        announceEditId = null;
        loadAnnounceAdmin();
      }).catch(function (e) {
        btn.disabled = false;
        el('annAdminMsg').innerHTML = msgHtml('error', errMsg(e));
      });
    };
  }).catch(function (e) {
    el('view').innerHTML = '<h2>お知らせ管理</h2>' + msgHtml('error', errMsg(e));
  });
}

/* ---- その他 (iOS 設定風グループリスト) ---- */
var MORE_ITEMS = [
  { view: 'setup', icon: 'clip', color: '#34c759', label: 'はじめに (セットアップ)', maintKeys: [] },
  { view: 'master', icon: 'list', color: '#0071e3', label: 'マスタ管理', maintKeys: ['master_products', 'master_locations', 'suppliers', 'csv_import'] },
  { view: 'purchases', icon: 'cart', color: '#5e5ce6', label: '発注', maintKeys: ['purchase_orders'] },
  { view: 'analytics', icon: 'chart', color: '#0091ff', label: '分析レポート', maintKeys: ['analytics'] },
  { view: 'stocktakes', icon: 'clip', color: '#ff9500', label: '棚卸し', maintKeys: ['stocktakes'] },
  { view: 'alerts', icon: 'bell', color: '#ff3b30', label: 'アラート', maintKeys: ['alerts'] },
  { view: 'negative', icon: 'minus', color: '#af52de', label: 'マイナス在庫', maintKeys: ['outbound'] },
  { view: 'reservations', icon: 'clip', color: '#30b0c7', label: '引当', maintKeys: ['outbound'] },
  { view: 'picking', icon: 'list', color: '#34c759', label: 'ピッキング', maintKeys: ['outbound'] },
  { view: 'announcements', icon: 'mega', color: '#ff9500', label: 'お知らせ', maintKeys: [] },
  { view: 'announceAdmin', icon: 'mega', color: '#64d2ff', label: 'お知らせ管理', maintKeys: [] },
  { view: 'audit', icon: 'doc', color: '#8e8e93', label: '監査ログ', maintKeys: [] },
  { view: 'security', icon: 'shield', color: '#636366', label: 'セキュリティ', maintKeys: [] },
  { view: 'storeSettings', icon: 'sliders', color: '#8e8e93', label: '店舗設定', maintKeys: ['master_products'] },
];
function loadMore() {
  var h = '<h2>その他</h2>';
  h += '<div class="group">';
  for (var i = 0; i < MORE_ITEMS.length; i++) {
    var it = MORE_ITEMS[i];
    if (!viewVisible(it.view)) continue;
    h += '<button class="group-row" data-view="' + it.view + '"><span class="row-icon" style="background:' + it.color + '">' + icon(it.icon, 17) + '</span><span class="row-label">' + esc(it.label) + '</span>' + maintBadgeHtml(it.maintKeys) + '<span class="chev">' + icon('chevR', 18) + '</span></button>';
  }
  if (can('admin.permissions') || can('admin.users')) {
    h += '<a class="group-row" href="/admin/permissions"><span class="row-icon" style="background:#30b0c7">' + icon('shield', 17) + '</span><span class="row-label">権限管理</span><span class="chev">' + icon('chevR', 18) + '</span></a>';
  }
  h += '</div>';
  if (state.me && state.me.plan) {
    var pl = state.me.plan;
    function planCount(used, limit) {
      return Number(used || 0).toLocaleString('ja-JP') + ' / ' + (limit === null || limit === undefined ? '無制限' : Number(limit).toLocaleString('ja-JP'));
    }
    h += '<h3>プラン</h3><div class="group">';
    h += '<div class="group-row static"><span class="row-label">プラン: ' + esc(pl.name) + '</span></div>';
    if (pl.organization) {
      h += '<div class="group-row static"><span class="row-label">組織: ' + esc(pl.organization.name) + '</span></div>';
    }
    if (pl.usage && pl.limits) {
      h += '<div class="group-row static"><span class="row-label">商品数: ' + planCount(pl.usage.skus, pl.limits.skus) + '</span></div>';
      h += '<div class="group-row static"><span class="row-label">ユーザー数: ' + planCount(pl.usage.users, pl.limits.users) + '</span></div>';
      h += '<div class="group-row static"><span class="row-label">店舗数: ' + planCount(pl.usage.stores, pl.limits.stores) + '</span></div>';
    }
    h += '</div>';
  }
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
  currentFormNotes = [];
  buildNav();
  var loaders = {
    dashboard: loadDashboard,
    search: loadSearch,
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
    announcements: loadAnnouncements,
    announceAdmin: loadAnnounceAdmin,
    returns: loadReturns,
    disposal: loadDisposal,
    reservations: loadReservations,
    picking: loadPicking,
    setup: loadSetup,
    security: loadSecurity,
    storeSettings: loadStoreSettings,
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
  jobs.push(feat('announcements')
    ? getJson('/api/v1/announcements').catch(function () { return null; })
    : Promise.resolve(null));
  jobs.push(can('purchases.read') && feat('purchase_orders')
    ? getJson('/api/v1/purchase-orders').catch(function () { return null; })
    : Promise.resolve(null));
  /* セットアップ進捗 (管理者のみ)。未完了の間だけ「はじめに」カードを出す */
  jobs.push(viewVisible('setup')
    ? getJson('/api/v1/setup/status').catch(function () { return null; })
    : Promise.resolve(null));
  Promise.all(jobs).then(function (r) {
    var alerts = r[0];
    var stocks = r[1];
    var stocktakes = r[2] || [];
    var negApprovals = r[3];
    var suggestions = r[4];
    var annData = r[5];
    var orders = r[6];
    var setupData = r[7];
    var h = '<h2>ダッシュボード</h2>';
    if (can('stocks.read')) {
      h += '<button type="button" class="search-entry" id="dashSearch">商品・保管場所・履歴を検索</button>';
    }
    var active = null;
    for (var i = 0; i < stocktakes.length; i++) {
      if (stocktakes[i].status === 'in_progress' || stocktakes[i].status === 'pending_approval') { active = stocktakes[i]; break; }
    }
    if (active && active.status === 'pending_approval') {
      h += msgHtml('warn', '棚卸し #' + active.id + ' が差異承認待ちです。在庫更新は停止しています。');
    } else if (active) {
      var partialNote = active.scopeType === 'locations' ? '対象の保管場所 (' + (active.locationIds ? active.locationIds.length : 0) + '件) のみ在庫更新を停止しています。' : '入庫・消費・移動は停止しています。';
      h += msgHtml('warn', '棚卸し実施中です (開始: ' + fmtDateTime(active.startedAt) + ')。' + partialNote);
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
    /* お知らせカード: 未読件数と最新 1 件。重要は警告色の左帯 (notice-card.important) */
    if (annData) {
      state.annUnread = annData.unreadCount || 0;
      buildNav();
      var annItems = annData.items || [];
      var latest = annItems.length > 0 ? annItems[0] : null;
      h += '<button class="notice-card' + (latest && latest.priority === 'important' ? ' important' : '') + '" id="dashAnnounce">' +
        '<span class="row-icon" style="background:#ff9500">' + icon('mega', 19) + '</span>' +
        '<span class="notice-main"><span class="notice-head">お知らせ' +
        (state.annUnread > 0 ? '<span class="count-badge">' + state.annUnread + '</span>' : '') +
        '</span><span class="notice-latest' + (latest && !latest.read ? ' unread' : '') + '">' +
        (latest ? esc(latest.title) : 'お知らせはありません') +
        '</span></span><span class="chev">' + icon('chevR', 18) + '</span></button>';
    }
    /* セットアップカード: 管理者に未完了の間だけ出す */
    if (setupData && !setupData.complete) {
      h += '<button class="notice-card" id="dashSetup">' +
        '<span class="row-icon" style="background:#34c759">' + icon('clip', 19) + '</span>' +
        '<span class="notice-main"><span class="notice-head">はじめに</span>' +
        '<span class="notice-latest">セットアップ ' + setupData.doneCount + ' / ' + setupData.totalCount + '</span></span>' +
        '<span class="chev">' + icon('chevR', 18) + '</span></button>';
    }
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
      tasks.push({ view: 'purchases', icon: 'cart', color: '#5e5ce6', label: '発注提案 (発注点割れ)', count: suggestions.length, amber: true });
    }
    if (orders) {
      var overdueN = 0;
      for (var oi = 0; oi < orders.length; oi++) { if (orders[oi].overdue) overdueN++; }
      if (overdueN > 0) tasks.push({ view: 'purchases', icon: 'cart', color: '#ff3b30', label: '納期超過の発注', count: overdueN, amber: false });
      var genDrafts = 0;
      for (var gi = 0; gi < orders.length; gi++) {
        if (orders[gi].status === 'draft' && orders[gi].source && orders[gi].source !== 'manual') genDrafts++;
      }
      if (genDrafts > 0) tasks.push({ view: 'purchases', icon: 'cart', color: '#30b0c7', label: 'テンプレート生成の下書き', count: genDrafts, amber: true });
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
    var dsch = el('dashSearch');
    if (dsch) dsch.onclick = function () { showView('search'); };
    var da = el('dashAnnounce');
    if (da) da.onclick = function () { showView('announcements'); };
    var dsu = el('dashSetup');
    if (dsu) dsu.onclick = function () { showView('setup'); };
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

/* ---------------- はじめに (初期セットアップ) ---------------- */
/* 進捗は GET /api/v1/setup/status の実データ判定。そのまま該当画面へ誘導する */
function loadSetup() {
  viewLoading('はじめに', 'rows');
  getJson('/api/v1/setup/status').then(function (d) {
    var defs = [
      { key: 'locations', label: '保管場所を登録', detail: '現在 ' + d.counts.locations + ' 件', view: 'master', btn: 'マスタ管理' },
      { key: 'products', label: '商品を登録', detail: '現在 ' + d.counts.products + ' 件', view: 'master', btn: 'マスタ管理' },
      { key: 'members', label: 'ユーザーを2人以上割り当てる', detail: '現在 ' + d.counts.members + ' 人', href: '/admin/permissions', btn: '権限管理' },
      { key: 'features', label: '機能設定を確認', detail: '使う機能のオン/オフ', href: '/admin/permissions', btn: '権限管理' },
    ];
    var h = '<h2>はじめに</h2>';
    h += '<p class="muted">セットアップ ' + d.doneCount + ' / ' + d.totalCount + (d.complete ? ' — 完了しています' : '') + '</p>';
    h += '<div class="group">';
    defs.forEach(function (def) {
      var done = !!d.items[def.key];
      h += '<div class="group-row static"><span class="row-label">' + esc(def.label) +
        ' <small class="muted">' + esc(def.detail) + '</small></span>' +
        (done ? '<span class="badge badge-ok">完了</span>' : '<span class="badge">未完了</span>');
      if (!done) {
        if (def.view) h += '<button class="btn small secondary" data-setup-view="' + def.view + '">' + esc(def.btn) + '</button>';
        else h += '<a class="btn small secondary" href="' + def.href + '">' + esc(def.btn) + '</a>';
      }
      h += '</div>';
    });
    h += '</div>';
    h += '<h3>CSV テンプレート</h3><div class="group">';
    h += '<a class="group-row" href="/api/v1/setup/template/products.csv"><span class="row-label">商品テンプレート <small class="muted">sku,name,unit,requires_expiry,unit_cost</small></span><span class="chev">' + icon('chevR', 18) + '</span></a>';
    h += '<div class="group-row static"><span class="row-label"><small class="muted">商品はマスタ管理の「商品 CSV インポート」から取り込めます。</small></span></div>';
    h += '<a class="group-row" href="/api/v1/setup/template/locations.csv"><span class="row-label">保管場所テンプレート <small class="muted">warehouse_code,code,name,parent_code</small></span><span class="chev">' + icon('chevR', 18) + '</span></a>';
    h += '<div class="group-row static"><span class="row-label"><small class="muted">保管場所はマスタ管理から登録します (parent_code は階層の親コード)。</small></span></div>';
    h += '</div>';
    el('view').innerHTML = h;
    var btns = el('view').querySelectorAll('button[data-setup-view]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = function () { showView(this.getAttribute('data-setup-view')); };
    }
  }).catch(function (e) {
    el('view').innerHTML = '<h2>はじめに</h2>' + msgHtml('error', errMsg(e));
  });
}

/* ---------------- barcode scan (ZXing WASM エンジン) ---------------- */
/* 旧実装のブラウザ標準デコーダは iOS Safari で使えないため、WASM デコーダ
   (zxing-wasm) を Web Worker で動かす方式に作り替えた。エンジンは外部 CDN
   ではなく Worker 自身が /assets/scan/* で配信する (src/scan-assets.ts)。
   検証ゲート・対象行選択・候補展開の規則は src/lib/scan-core.ts と同じ。 */
var SCAN_SUPPRESS_MS = 900;
var scanVerifyMode = 'accurate';
try { scanVerifyMode = localStorage.getItem('scanVerifyMode') === 'fast' ? 'fast' : 'accurate'; } catch (e) {}
var pendingNewProductBarcode = '';
/* スキャナーの「商品を登録」から商品を作成した後に戻る文脈
   (スキャナー opts.registerReturn が入る: { view: 'inbound'|'consume'|'transfer'|'stocks'|'stocktakes' }) */
var pendingProductReturn = null;

function scanSupported() {
  return feat('barcode_scan') &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
    typeof Worker !== 'undefined';
}

/* UPC-A は ZXing が EAN-13 (先頭 0) として返すため、照合候補を両方向に展開する */
function barcodeCandidateList(code) {
  var s = String(code);
  var out = [s];
  if (/^0[0-9]{12}$/.test(s)) out.push(s.slice(1));
  if (/^[0-9]{12}$/.test(s)) out.push('0' + s);
  return out;
}
function productByBarcode(code) {
  var m = state.master;
  if (!m) return null;
  var cands = barcodeCandidateList(code);
  for (var ci = 0; ci < cands.length; ci++) {
    for (var i = 0; i < m.products.length; i++) {
      if (m.products[i].barcode && String(m.products[i].barcode) === cands[ci]) return m.products[i];
    }
    /* バーコード未登録の商品は SKU でも解決する (SKU の QR ラベル用) */
    for (var j = 0; j < m.products.length; j++) {
      if (String(m.products[j].sku) === cands[ci]) return m.products[j];
    }
  }
  return null;
}

/* 検証ゲート (src/lib/scan-core.ts の createScanGate と同じ規則)。
   accurate: 同じ値が連続 2 回のデコードで一致したら受理。fast: 1 回で受理。
   受理後 900ms は同一コードを抑制する (別コードは対象外)。 */
function scanGateCreate(mode) {
  var pendingCode = null;
  var pendingCount = 0;
  var lastCode = null;
  var lastAt = 0;
  function accept(code, now) {
    lastCode = code;
    lastAt = now;
    pendingCode = null;
    pendingCount = 0;
    return true;
  }
  return {
    consider: function (code, now) {
      if (!code) return false;
      if (code === lastCode && now - lastAt < SCAN_SUPPRESS_MS) return false;
      if (mode === 'fast') return accept(code, now);
      if (code === pendingCode) pendingCount++;
      else { pendingCode = code; pendingCount = 1; }
      if (pendingCount >= 2) return accept(code, now);
      return false;
    },
    setMode: function (next) {
      mode = next;
      pendingCode = null;
      pendingCount = 0;
    }
  };
}

/* 未登録コード通知のラッチ (scan-core.ts の createUnknownLatch と同じ規則)。
   カメラは同じコードをフレームごとに繰り返しデコードするため、通知は
   次の受理 (別コード) かユーザーの操作まで保持し、同じコードの再通知は抑制する。
   notify(code, outcome) -> 'show' | 'suppress' | 'clear' | 'none' */
function scanUnknownLatchCreate() {
  var latched = null;
  return {
    latchedCode: function () { return latched; },
    notify: function (code, outcome) {
      if (outcome === 'unknown') {
        if (latched === code) return 'suppress';
        latched = code;
        return 'show';
      }
      if (latched !== null) {
        latched = null;
        return 'clear';
      }
      return 'none';
    },
    reset: function () { latched = null; }
  };
}

/* 棚卸しスキャンカウントの対象行選択 (scan-core.ts の pickScanCountLine と同じ規則) */
function scanPickLine(lines, productId, locationId) {
  var best = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.productId !== productId || line.locationId !== locationId) continue;
    if (!best) { best = line; continue; }
    var a = line.expiryDate || null;
    var b = best.expiryDate || null;
    if (a && !b) best = line;
    else if (a && b && a < b) best = line;
    else if (a === b && line.id < best.id) best = line;
  }
  return best;
}

/* ---- 読み取りフィードバック (ビープ + バイブ + 枠の色変化のみ、過剰な演出はしない) ---- */
var scanAudioCtx = null;
function scanBeep(freq, durMs) {
  try {
    if (!scanAudioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      scanAudioCtx = new AC();
    }
    if (scanAudioCtx.state === 'suspended') scanAudioCtx.resume();
    var t = scanAudioCtx.currentTime;
    var osc = scanAudioCtx.createOscillator();
    var gain = scanAudioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
    osc.connect(gain);
    gain.connect(scanAudioCtx.destination);
    osc.start(t);
    osc.stop(t + durMs / 1000 + 0.03);
  } catch (e) {}
}
function scanFlashFrame(cls) {
  var f = el('scanFrame');
  if (!f) return;
  f.classList.add(cls);
  setTimeout(function () { var x = el('scanFrame'); if (x) x.classList.remove(cls); }, 180);
}
function scanFeedbackOk() {
  scanBeep(880, 70);
  if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) {} }
  scanFlashFrame('hit');
}
function scanFeedbackNg() {
  scanBeep(220, 100);
  if (navigator.vibrate) { try { navigator.vibrate([20, 30, 20]); } catch (e) {} }
  scanFlashFrame('miss');
}
function scanTimeText(ms) {
  var d = new Date(ms);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/* ---- デコード用 Web Worker (シングルトン。初回オープン時にだけ読み込む) ---- */
var scanWorker = null;
var scanWorkerState = 'idle';
var scanWorkerWaiters = [];
var scanDecodeSeq = 0;
var scanDecodePending = {};
function flushScanWorkerWaiters(ok) {
  var ws = scanWorkerWaiters;
  scanWorkerWaiters = [];
  for (var i = 0; i < ws.length; i++) ws[i](ok);
}
function ensureScanWorker(done) {
  if (scanWorkerState === 'ready') { done(true); return; }
  scanWorkerWaiters.push(done);
  if (scanWorkerState === 'loading') return;
  scanWorkerState = 'loading';
  try {
    scanWorker = new Worker('/assets/scan/worker.js', { type: 'module' });
  } catch (e) {
    scanWorkerState = 'error';
    flushScanWorkerWaiters(false);
    return;
  }
  scanWorker.onmessage = function (ev) {
    var msg = ev.data || {};
    if (msg.type === 'ready') {
      scanWorkerState = 'ready';
      flushScanWorkerWaiters(true);
    } else if (msg.type === 'error') {
      scanWorkerState = 'error';
      flushScanWorkerWaiters(false);
    } else if (msg.type === 'result') {
      var cb = scanDecodePending[msg.id];
      if (cb) {
        delete scanDecodePending[msg.id];
        cb(msg.results || []);
      }
    }
  };
  scanWorker.onerror = function () {
    if (scanWorkerState === 'loading') {
      scanWorkerState = 'error';
      flushScanWorkerWaiters(false);
    }
  };
  scanWorker.postMessage({ type: 'init' });
}
function scanDecodeFrame(buffer, width, height, cb) {
  var id = ++scanDecodeSeq;
  scanDecodePending[id] = cb;
  scanWorker.postMessage({ type: 'decode', id: id, buffer: buffer, width: width, height: height }, [buffer]);
}

/* ---- スキャナー画面 (共通コンポーネント) ----
   opts: {
     title, continuous,
     registerReturn: { view } (「商品を登録」で作成した後に戻る文脈。任意),
     onCode(code, format, api) -> 'ok' | 'unknown' | 'out',
     panelTitle() / syncHtml() / renderPanel(session) (continuous 用),
     onOpen(api), onBeforeClose(api) -> Promise, onClose()
   } */
var scanSession = null;
function scannerHtml(opts, continuous) {
  var h = '<div class="scan-video-wrap">' +
    '<video id="scanVideo" class="scan-video" autoplay playsinline muted></video>' +
    '<div class="scan-top">' +
    '<button type="button" class="scan-round-btn" id="scanCloseBtn" aria-label="閉じる">✕</button>' +
    '<div class="scan-title">' + esc(opts.title || 'バーコードスキャン') + '</div>' +
    '<button type="button" class="scan-pill-btn" id="scanTorchBtn" style="display:none">ライト</button>' +
    '<div class="scan-seg" id="scanModeSeg"><button type="button" data-vmode="accurate">高精度</button><button type="button" data-vmode="fast">高速</button></div>' +
    '</div>' +
    '<div class="scan-frame" id="scanFrame"></div>' +
    '<div class="scan-status" id="scanStatus">準備しています…</div>' +
    '</div>';
  if (continuous) {
    h += '<div class="scan-panel">' +
      '<div class="scan-panel-head"><div class="scan-panel-title" id="scanPanelTitle"></div><span id="scanSync"></span>' +
      '<button type="button" class="scan-undo-btn" id="scanUndoBtn" disabled>最後の1件を取り消し</button></div>' +
      '<div id="scanToast" class="scan-toast"></div>' +
      '<div id="scanUnknownBox" class="scan-unknown"></div>' +
      '<div id="scanPanelBody"></div>' +
      '</div>';
  } else {
    h += '<div id="scanUnknownBox" class="scan-unknown scan-notice"></div>' +
      '<div class="scan-close-bar"><button type="button" class="btn secondary" id="scanCancelBtn">キャンセル</button></div>';
  }
  return h;
}
function openScanner(opts) {
  if (scanSession && !scanSession.closed) teardownScanSession(scanSession);
  var session = {
    opts: opts, closed: false, closing: false, closingPromise: null,
    stream: null, track: null, timer: null, busy: false, canvas: null,
    gate: scanGateCreate(scanVerifyMode), unknownLatch: scanUnknownLatchCreate(),
    undoStack: [], recentLog: [],
    torchOn: false, toastTimer: null,
  };
  scanSession = session;
  var overlay = el('scannerOverlay');
  overlay.innerHTML = scannerHtml(opts, !!opts.continuous);
  overlay.style.display = '';
  bindScannerChrome(session);
  refreshScanPanel(session);
  var status = el('scanStatus');
  if (status) status.textContent = 'スキャンエンジンを準備しています…';
  ensureScanWorker(function (ok) {
    if (session.closed) return;
    var s = el('scanStatus');
    if (!ok) {
      if (s) s.textContent = 'スキャンエンジンを読み込めませんでした。通信環境を確認して開き直してください。';
      return;
    }
    if (s) s.textContent = 'バーコードを枠内に入れてください';
    startScanCamera(session);
  });
  if (opts.onOpen) opts.onOpen(scanSessionApi(session));
  return session;
}
function scanSessionApi(session) {
  return {
    refreshPanel: function () { refreshScanPanel(session); },
    toast: function (text) { showScanToast(session, text); },
    setStatus: function (text) { var s = el('scanStatus'); if (s) s.textContent = text; },
    pushUndo: function (fn) { session.undoStack.push(fn); refreshScanPanel(session); },
    addRecent: function (label, sub) {
      session.recentLog.unshift({ label: label, sub: sub || '', at: Date.now() });
      if (session.recentLog.length > 30) session.recentLog.pop();
      refreshScanPanel(session);
    },
    close: function () { closeScanner(); },
  };
}
function refreshScanPanel(session) {
  if (!session.opts.continuous || session.closed) return;
  var title = el('scanPanelTitle');
  if (title) {
    var t = session.opts.panelTitle;
    title.textContent = typeof t === 'function' ? t() : (t || '読み取り履歴');
  }
  var sync = el('scanSync');
  if (sync && session.opts.syncHtml) sync.innerHTML = session.opts.syncHtml();
  var undo = el('scanUndoBtn');
  if (undo) undo.disabled = session.undoStack.length === 0;
  var body = el('scanPanelBody');
  if (body) body.innerHTML = session.opts.renderPanel ? session.opts.renderPanel(session) : scanDefaultRecentHtml(session);
}
/* パネルの空表示。未登録コードがラッチ中のときは「まだ読み取っていません」と
   矛盾しないよう、読み取った事実と次の操作を示す */
function scanEmptyHtml(session) {
  var latched = session && session.unknownLatch ? session.unknownLatch.latchedCode() : null;
  if (latched) {
    return '<div class="scan-empty">未登録のバーコード ' + esc(latched) + ' を読み取りました。' +
      (can('master.write') ? '上の通知の「商品を登録」から登録できます。' : '登録されている商品のバーコードだけが読み取れます。') + '</div>';
  }
  return '<div class="scan-empty">まだ読み取っていません。バーコードを枠内に入れてください。</div>';
}
function scanDefaultRecentHtml(session) {
  if (session.recentLog.length === 0) {
    return scanEmptyHtml(session);
  }
  var h = '<div class="scan-recent">';
  for (var i = 0; i < Math.min(session.recentLog.length, 8); i++) {
    var r = session.recentLog[i];
    h += '<div class="scan-recent-row"><span class="scan-recent-name">' + esc(r.label) + '</span>' +
      (r.sub ? '<span class="scan-recent-qty">' + esc(r.sub) + '</span>' : '') +
      '<span class="scan-recent-time">' + scanTimeText(r.at) + '</span></div>';
  }
  return h + '</div>';
}
function showScanToast(session, text) {
  var t = el('scanToast');
  if (!t) return;
  t.textContent = text;
  t.style.display = 'block';
  if (session.toastTimer) clearTimeout(session.toastTimer);
  session.toastTimer = setTimeout(function () {
    var x = el('scanToast');
    if (x) x.style.display = 'none';
  }, 2400);
}
function showScanUnknown(session, code) {
  var box = el('scanUnknownBox');
  if (!box) return;
  box.innerHTML = '未登録のバーコードです: <b>' + esc(code) + '</b>' +
    (can('master.write')
      ? '<br><button type="button" class="btn small" id="scanRegisterBtn">商品を登録</button>'
      : '<br><span class="small">商品の登録にはマスタ編集権限が必要です。</span>');
  box.style.display = 'block';
  var btn = el('scanRegisterBtn');
  if (btn) btn.onclick = function () {
    pendingNewProductBarcode = code;
    pendingProductReturn = session.opts.registerReturn || null;
    closeScanner().then(function () { showView('master'); });
  };
}
function hideScanUnknown() {
  var box = el('scanUnknownBox');
  if (box) {
    box.style.display = 'none';
    box.innerHTML = '';
  }
}
function bindScannerChrome(session) {
  el('scanCloseBtn').onclick = function () { closeScanner(); };
  var cancel = el('scanCancelBtn');
  if (cancel) cancel.onclick = function () { closeScanner(); };
  var undo = el('scanUndoBtn');
  if (undo) undo.onclick = function () {
    var fn = session.undoStack.pop();
    if (fn) { try { fn(); } catch (e) {} }
    refreshScanPanel(session);
  };
  var seg = el('scanModeSeg');
  if (seg) {
    var btns = seg.querySelectorAll('button[data-vmode]');
    var syncSeg = function () {
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].getAttribute('data-vmode') === scanVerifyMode) btns[i].classList.add('active');
        else btns[i].classList.remove('active');
      }
    };
    syncSeg();
    for (var i = 0; i < btns.length; i++) {
      btns[i].onclick = function () {
        scanVerifyMode = this.getAttribute('data-vmode');
        try { localStorage.setItem('scanVerifyMode', scanVerifyMode); } catch (e) {}
        session.gate.setMode(scanVerifyMode);
        syncSeg();
      };
    }
  }
  var torch = el('scanTorchBtn');
  if (torch) torch.onclick = function () {
    if (!session.track) return;
    session.torchOn = !session.torchOn;
    try {
      var p = session.track.applyConstraints({ advanced: [{ torch: session.torchOn }] });
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
    torch.classList.toggle('active', session.torchOn);
  };
}
function startScanCamera(session) {
  var video = el('scanVideo');
  if (!video) return;
  navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
  }).then(function (stream) {
    if (session.closed) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      return;
    }
    session.stream = stream;
    video.srcObject = stream;
    var played = video.play();
    if (played && played.catch) played.catch(function () {});
    var track = stream.getVideoTracks()[0] || null;
    session.track = track;
    try {
      var caps = track && track.getCapabilities ? track.getCapabilities() : null;
      if (caps && caps.torch) {
        var tb = el('scanTorchBtn');
        if (tb) tb.style.display = '';
      }
    } catch (e) {}
    session.canvas = document.createElement('canvas');
    scanFrameLoop(session);
  }).catch(function (e) {
    var s = el('scanStatus');
    if (s) s.textContent = 'カメラを利用できませんでした: ' + errMsg(e);
  });
}
/* 中央 ROI を切り出して Worker へ送る。応答が返るまで次フレームは送らない
   (バックプレッシャで実効 10〜15fps 程度に収まる) */
function scanFrameLoop(session) {
  if (session.closed) return;
  session.timer = setTimeout(function () { scanFrameLoop(session); }, 55);
  if (session.busy || scanWorkerState !== 'ready') return;
  var video = el('scanVideo');
  if (!video || !video.videoWidth || video.readyState < 2) return;
  var vw = video.videoWidth;
  var vh = video.videoHeight;
  var sw = Math.round(vw * 0.86);
  var sh = Math.round(vh * 0.62);
  var sx = Math.round((vw - sw) / 2);
  var sy = Math.round((vh - sh) / 2);
  var scale = Math.min(1, 1280 / sw);
  var w = Math.max(2, Math.round(sw * scale));
  var h = Math.max(2, Math.round(sh * scale));
  var canvas = session.canvas;
  if (!canvas) return;
  canvas.width = w;
  canvas.height = h;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  var img;
  try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return; }
  session.busy = true;
  scanDecodeFrame(img.data.buffer, w, h, function (results) {
    session.busy = false;
    if (session.closed || !results || results.length === 0) return;
    scanHandleDecoded(session, results[0].text, results[0].format);
  });
}
/* デコード結果の受理判定とフィードバック (単発モードは受理で自動的に閉じる)。
   未登録の通知はラッチで保持する: フレームごとの再デコードで消したり
   鳴らしたりしない (以前はここで無条件に隠していたため一瞬で消えた)。 */
function scanHandleDecoded(session, code, format) {
  if (!session || session.closed || session.closing) return;
  if (!session.gate.consider(code, Date.now())) return;
  var outcome = 'ok';
  try {
    outcome = session.opts.onCode(code, format, scanSessionApi(session)) || 'ok';
  } catch (e) {
    outcome = 'ok';
  }
  var act = session.unknownLatch.notify(code, outcome);
  if (act === 'show') {
    scanFeedbackNg();
    showScanUnknown(session, code);
    refreshScanPanel(session);
  } else if (act === 'clear') {
    hideScanUnknown();
    if (outcome === 'out') scanFeedbackNg();
    else scanFeedbackOk();
  } else if (act !== 'suppress') {
    if (outcome === 'out') scanFeedbackNg();
    else scanFeedbackOk();
  }
  if (!session.opts.continuous && outcome === 'ok') closeScanner();
}
function stopScanStream(session) {
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  if (session.stream) {
    session.stream.getTracks().forEach(function (t) { t.stop(); });
    session.stream = null;
  }
}
function teardownScanSession(session) {
  session.closed = true;
  stopScanStream(session);
  var overlay = el('scannerOverlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.innerHTML = '';
  }
  if (scanSession === session) scanSession = null;
  if (session.opts.onClose) {
    try { session.opts.onClose(); } catch (e) {}
  }
}
/* 閉じる前に未送信分を flush する (opts.onBeforeClose の Promise を待つ) */
function closeScanner() {
  var session = scanSession;
  if (!session || session.closed) return Promise.resolve();
  if (session.closingPromise) return session.closingPromise;
  session.closing = true;
  var p = Promise.resolve();
  if (session.opts.onBeforeClose) {
    try {
      p = Promise.resolve(session.opts.onBeforeClose(scanSessionApi(session)));
    } catch (e) {
      p = Promise.resolve();
    }
  }
  session.closingPromise = p.then(function () { teardownScanSession(session); });
  return session.closingPromise;
}

/* ---- 記録シート (入庫・消費・移動) 用の連続スキャン ----
   同じ商品の連続スキャンで数量 +1、別の商品を読んだらその商品へ切り替え、
   その商品のセッション数量をフォームへ反映する。 */
function openSheetScanner(productSelId, qtyId, viewName) {
  var counts = {};
  var order = [];
  var current = null;
  var initProduct = el(productSelId).value;
  var initQty = Number(el(qtyId).value);
  if (initProduct && initQty > 0) {
    counts[initProduct] = initQty;
    order.push(initProduct);
    current = initProduct;
  }
  function applyToForm(productId) {
    el(productSelId).value = String(productId);
    el(qtyId).value = counts[productId] || 1;
    var sel = el(productSelId);
    if (sel && sel.onchange) sel.onchange();
  }
  openScanner({
    title: 'バーコードスキャン',
    continuous: true,
    registerReturn: viewName ? { view: viewName } : null,
    panelTitle: '読み取り履歴 (閉じると最後の商品と数量がフォームに残ります)',
    renderPanel: function (sess) {
      if (order.length === 0) {
        return scanEmptyHtml(sess);
      }
      var h = '<div class="scan-recent">';
      for (var i = order.length - 1; i >= 0; i--) {
        var pid = order[i];
        var p = productOf(Number(pid));
        h += '<div class="scan-recent-row"><span class="scan-recent-name">' + esc(p ? p.sku + ' ' + p.name : '商品#' + pid) + '</span>' +
          '<span class="scan-recent-qty">× ' + counts[pid] + '</span></div>';
      }
      return h + '</div>';
    },
    onCode: function (code, format, api) {
      var p = productByBarcode(code);
      if (!p) return 'unknown';
      var key = String(p.id);
      var prevProduct = current;
      var prevCount = prevProduct ? counts[prevProduct] : 0;
      var isNew = counts[key] === undefined;
      counts[key] = (counts[key] || 0) + 1;
      if (isNew) order.push(key);
      current = key;
      applyToForm(key);
      if (prevProduct !== null && prevProduct !== key) {
        api.toast('商品を切り替えました: ' + p.sku + ' ' + p.name);
      }
      api.pushUndo(function () {
        counts[key] -= 1;
        if (counts[key] <= 0) {
          delete counts[key];
          order = order.filter(function (x) { return x !== key; });
        }
        if (prevProduct !== null && counts[prevProduct] !== undefined) {
          current = prevProduct;
          el(productSelId).value = String(prevProduct);
          el(qtyId).value = prevCount;
          var sel2 = el(productSelId);
          if (sel2 && sel2.onchange) sel2.onchange();
        }
        api.refreshPanel();
      });
      api.refreshPanel();
      return 'ok';
    },
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
  var thumb = p && p.imageKey ? '<img class="thumb" src="/api/v1/products/' + p.id + '/image" alt="" loading="lazy">' : '';
  /* フリー在庫は引当がある商品の行だけに併記する (サーバーが freeQuantity を付けた行のみ) */
  var freeNote = (s.freeQuantity !== null && s.freeQuantity !== undefined)
    ? '<div class="free-note">フリー ' + s.freeQuantity + '</div>' : '';
  return '<tr data-stock="' + idx + '"><td>' + thumb + esc(productLabel(s.productId)) + (p && p.isBundle ? ' <span class="badge">セット</span>' : '') + '</td>' +
    '<td>' + esc(s.lotCode) + '</td>' +
    '<td>' + esc(locationLabel(s.locationId)) + '</td>' +
    '<td class="stock-qty' + (low ? ' qty-neg' : '') + '">' + s.quantity + freeNote + '</td>' +
    '<td>' + expiryBadge(s.expiryDate, p ? p.expiryAlertDays : null) + '</td></tr>';
}
/* ケース換算の注記 (入数がある商品のみ)。例: 36個 (3ケース) / 38個 (3ケース＋2個) */
function caseNoteHtml(quantity, p) {
  if (!p || !p.caseSize || p.caseSize <= 1 || quantity <= 0) return '';
  var full = Math.floor(quantity / p.caseSize);
  var rest = quantity % p.caseSize;
  if (full === 0) return '';
  return ' (' + full + 'ケース' + (rest > 0 ? '＋' + rest + esc(p.unit) : '') + ')';
}
/* 在庫行タップ: その在庫を対象に記録画面へ進むアクションシート */
function openStockSheet(s) {
  var p = productOf(s.productId);
  var h = '<div class="sheet-head"><div class="sh-name">' + (p && p.imageKey ? '<img class="thumb" src="/api/v1/products/' + p.id + '/image" alt="" loading="lazy">' : '') + esc(productLabel(s.productId)) + '</div>' +
    '<div class="sh-meta">ロット ' + esc(s.lotCode) + ' ・ ' + esc(locationLabel(s.locationId)) + ' ・ 現在 ' + s.quantity + (p ? ' ' + esc(p.unit) : '') + caseNoteHtml(s.quantity, p) +
    (s.freeQuantity !== null && s.freeQuantity !== undefined ? ' ・ フリー ' + s.freeQuantity : '') + '</div></div>';
  var items = [];
  if (viewVisible('inbound')) items.push({ view: 'inbound', icon: 'in', color: '#34c759', label: '入庫する' });
  if (viewVisible('consume')) items.push({ view: 'consume', icon: 'out', color: '#ff9500', label: '消費する' });
  if (viewVisible('transfer')) items.push({ view: 'transfer', icon: 'swap', color: '#0071e3', label: '移動する' });
  if (viewVisible('returns')) items.push({ view: 'returns', icon: 'in', color: '#30b0c7', label: '返品する' });
  if (viewVisible('disposal')) items.push({ view: 'disposal', icon: 'out', color: '#ff3b30', label: '廃棄する' });
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    h += '<button class="sheet-row" data-view="' + it.view + '"><span class="row-icon" style="background:' + it.color + '">' + icon(it.icon, 18) + '</span><span class="row-label">' + esc(it.label) + '</span><span class="chev">' + icon('chevR', 18) + '</span></button>';
  }
  if (items.length === 0) {
    h += '<div class="sheet-title">この在庫に対して実行できる操作がありません</div>';
  }
  el('sheetBox').innerHTML = h;
  el('sheetOverlay').style.display = '';
  bindThumbFallbacks();
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
/* ---------------- 在庫の保存検索 (端末の localStorage のみ、最大 10 件) ---------------- */
var SAVED_SEARCH_KEY = 'stockSavedSearches.v1';
var SAVED_SEARCH_MAX = 10;
function loadSavedSearches() {
  try {
    var raw = localStorage.getItem(SAVED_SEARCH_KEY);
    var arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function storeSavedSearches(arr) {
  try { localStorage.setItem(SAVED_SEARCH_KEY, JSON.stringify(arr)); } catch (e) {}
}
function renderSavedSearches(applyFn) {
  var box = el('stSaved');
  if (!box) return;
  var arr = loadSavedSearches();
  var h = '';
  for (var i = 0; i < arr.length; i++) {
    h += '<span class="saved-wrap"><button type="button" class="chip" data-saved="' + i + '">' + esc(arr[i].name) + '</button>' +
      '<button type="button" class="saved-del" data-saved-del="' + i + '" aria-label="保存検索を削除">×</button></span>';
  }
  box.innerHTML = h;
  var applyBtns = box.querySelectorAll('button[data-saved]');
  for (var ai = 0; ai < applyBtns.length; ai++) {
    applyBtns[ai].onclick = function () {
      var item = loadSavedSearches()[Number(this.getAttribute('data-saved'))];
      if (item) applyFn(item);
    };
  }
  var delBtns = box.querySelectorAll('button[data-saved-del]');
  for (var di = 0; di < delBtns.length; di++) {
    delBtns[di].onclick = function () {
      var list = loadSavedSearches();
      list.splice(Number(this.getAttribute('data-saved-del')), 1);
      storeSavedSearches(list);
      renderSavedSearches(applyFn);
    };
  }
}
/* セット品の組立可能数 (在庫一覧の下部セクション) */
function renderStockBundles() {
  var box = el('stBundles');
  if (!box) return;
  api('/api/v1/bundles').then(function (rows) {
    if (!rows || rows.length === 0) { box.innerHTML = ''; return; }
    var h = '<h3>セット品</h3><div class="table-wrap"><table><thead><tr><th>商品</th><th>組立可能数</th><th>構成品</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i];
      var comps = (b.components || []).map(function (cm) { return esc(productLabel(cm.productId)) + ' ×' + cm.quantity; }).join('、');
      h += '<tr><td>' + esc(b.sku + ' ' + b.name) + '</td><td class="stock-qty">' + b.assemblable + '</td><td class="small muted">' + comps + '</td></tr>';
    }
    h += '</tbody></table></div>';
    box.innerHTML = h;
  }).catch(function () { box.innerHTML = ''; });
}

/* ---------------- 横断検索 ---------------- */
function loadSearch() {
  el('view').innerHTML =
    '<h2>検索</h2>' +
    '<div class="toolbar"><div style="flex:1 1 11rem"><label>キーワード</label><input id="gq" type="search" placeholder="商品名・SKU・バーコード・場所・理由"></div></div>' +
    '<div id="gsBody"><p class="muted">商品・保管場所・入出庫履歴から探します。</p></div>';
  var timer = null;
  var seq = 0;
  var run = function () {
    var q = el('gq').value.replace(/^ +| +$/g, '');
    if (!q) {
      seq++;
      el('gsBody').innerHTML = '<p class="muted">商品・保管場所・入出庫履歴から探します。</p>';
      return;
    }
    var my = ++seq;
    api('/api/v1/search?q=' + encodeURIComponent(q) + '&take=8').then(function (d) {
      if (my !== seq || !el('gsBody')) return;
      renderSearchResults(d);
    }).catch(function (e) {
      if (my !== seq || !el('gsBody')) return;
      el('gsBody').innerHTML = msgHtml('error', errMsg(e));
    });
  };
  el('gq').oninput = function () {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 250);
  };
  el('gq').focus();
}
function renderSearchResults(d) {
  var h = '';
  var i;
  if (d.products && d.products.length > 0) {
    h += '<h3>商品</h3><div class="group">';
    for (i = 0; i < d.products.length; i++) {
      var p = d.products[i];
      h += '<button type="button" class="group-row" data-gsku="' + esc(p.sku) + '"><span>' + esc(p.name) + '</span><span class="muted">' + esc(p.sku) + ' ・ 在庫 ' + p.totalQuantity + esc(p.unit || '') + '</span></button>';
    }
    h += '</div>';
  }
  if (d.locations && d.locations.length > 0) {
    h += '<h3>保管場所</h3><div class="group">';
    for (i = 0; i < d.locations.length; i++) {
      var l = d.locations[i];
      var path = (l.parentName ? esc(l.parentName) + ' / ' : '') + esc(l.name);
      h += '<button type="button" class="group-row" data-gloc="' + l.id + '"><span>' + path + '</span><span class="muted">' + esc(l.warehouseName || '') + ' ・ 在庫 ' + l.stockCount + ' 件</span></button>';
    }
    h += '</div>';
  }
  if (d.movements && d.movements.length > 0) {
    h += '<h3>入出庫履歴</h3><div class="group">';
    for (i = 0; i < d.movements.length; i++) {
      var m = d.movements[i];
      var tl = MOVEMENT_TYPE_LABELS[m.type] || [m.type, ''];
      var sign = m.quantityChange > 0 ? '+' + m.quantityChange : '' + m.quantityChange;
      h += '<button type="button" class="group-row" data-gmove="1"><span>' + esc(tl[0]) + ' ・ ' + esc(m.productName || '') + '</span><span class="muted">' + sign + ' ・ ' + esc(m.locationName || '') + ' ・ ' + fmtDateTime(m.createdAt) + '</span></button>';
    }
    h += '</div>';
  }
  if (!h) h = '<p class="muted">見つかりませんでした。</p>';
  el('gsBody').innerHTML = h;
  var prods = el('gsBody').querySelectorAll('button[data-gsku]');
  for (i = 0; i < prods.length; i++) {
    prods[i].onclick = function () {
      try { sessionStorage.setItem('pendingStockQuery', this.getAttribute('data-gsku')); } catch (e) {}
      showView('stocks');
    };
  }
  var locs = el('gsBody').querySelectorAll('button[data-gloc]');
  for (i = 0; i < locs.length; i++) {
    locs[i].onclick = function () {
      try { sessionStorage.setItem('pendingStockLocation', this.getAttribute('data-gloc')); } catch (e) {}
      showView('stocks');
    };
  }
  var moves = el('gsBody').querySelectorAll('button[data-gmove]');
  for (i = 0; i < moves.length; i++) {
    moves[i].onclick = function () { showView('history'); };
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
    '<div><label>&nbsp;</label><button class="btn secondary" id="stSaveSearch" type="button">条件を保存</button></div>' +
    (feat('csv') ? '<div><label>&nbsp;</label><a class="btn secondary" href="/api/v1/stocks.csv">CSV ダウンロード</a></div>' : '') +
    '</div>' +
    chipsHtml +
    '<div class="chips" id="stSaved"></div>' +
    '</div>' +
    '<div id="stMsg"></div><div id="stBody">' + skeletonRows() + '</div><div id="stBundles"></div>';
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
  var applySavedSearch = function (item) {
    el('stQ').value = item.q || '';
    stocksChip = item.chip || 'all';
    var all = el('stChips').querySelectorAll('button[data-chip]');
    for (var sk = 0; sk < all.length; sk++) {
      if (all[sk].getAttribute('data-chip') === stocksChip) all[sk].classList.add('active');
      else all[sk].classList.remove('active');
    }
    fetchStocks();
  };
  renderSavedSearches(applySavedSearch);
  var saveSearchBtn = el('stSaveSearch');
  if (saveSearchBtn) saveSearchBtn.onclick = function () {
    var arr = loadSavedSearches();
    if (arr.length >= SAVED_SEARCH_MAX) {
      el('stMsg').innerHTML = msgHtml('error', '保存検索は最大 ' + SAVED_SEARCH_MAX + ' 件です。不要なものを削除してください。');
      return;
    }
    var name = window.prompt('検索条件の名前');
    if (!name) return;
    arr.push({ name: name, q: el('stQ').value || '', chip: stocksChip });
    storeSavedSearches(arr);
    renderSavedSearches(applySavedSearch);
  };
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
      var unknownCode = '';
      openScanner({
        title: 'バーコードスキャン',
        continuous: false,
        registerReturn: { view: 'stocks' },
        onCode: function (code) {
          var p = productByBarcode(code);
          if (!p) {
            unknownCode = code;
            return 'unknown';
          }
          el('stQ').value = p.sku;
          fetchStocks();
          return 'ok';
        },
        onClose: function () {
          if (unknownCode && el('stQ')) {
            el('stQ').value = unknownCode;
            fetchStocks();
            el('stMsg').innerHTML = msgHtml('warn', 'バーコード ' + unknownCode + ' の商品が見つかりませんでした。');
          }
        },
      });
    };
    try {
      var pl = sessionStorage.getItem('pendingStockLocation');
      if (pl) {
        sessionStorage.removeItem('pendingStockLocation');
        var locSel = el('stLoc');
        for (var li2 = 0; li2 < locSel.options.length; li2++) {
          if (String(locSel.options[li2].value) === String(pl)) { locSel.value = pl; break; }
        }
      }
    } catch (e) {}
    fetchStocks();
    renderStockBundles();
    if (state.flash) { el('stMsg').innerHTML = msgHtml('success', state.flash); state.flash = ''; }
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
      bindThumbFallbacks();
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
    var h = '<h2>入庫</h2><div class="mnt-form-note" id="mntNoteInbound" style="display:none"></div><div id="inMsg"></div>' +
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
    if (state.flash) { el('inMsg').innerHTML = msgHtml('success', state.flash); state.flash = ''; }
    setMaintFormNote('mntNoteInbound', ['inbound'], ['#inSubmit']);
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
    if (inScan) inScan.onclick = function () { openSheetScanner('inProduct', 'inQty', 'inbound'); };
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
  Promise.all([ensureMaster(), ensureMasterExtras()]).then(function (rs) {
    var m = rs[0];
    if (state.masterError) {
      el('view').innerHTML = '<h2>消費</h2>' + msgHtml('error', 'マスタの読み込みに失敗しました: ' + state.masterError);
      return;
    }
    var h = '<h2>消費 (FEFO: 期限の早いロットから自動で引きます)</h2><div class="mnt-form-note" id="mntNoteConsume" style="display:none"></div><div id="coMsg"></div>' +
      '<form class="grid" id="coForm">' +
      '<div><label>商品</label><select id="coProduct" required>' +
      optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name + (p.isBundle ? ' (セット)' : ''); }, '') + '</select>' +
      '<div class="small muted" id="coBundleNote"></div>' +
      (scanSupported() ? '<div style="margin-top:0.4rem;"><button class="btn small secondary" type="button" id="coScan">スキャンで商品を選ぶ</button></div>' : '') + '</div>' +
      '<div><label>保管場所 (任意: 指定しない場合は全場所から)</label><select id="coLocation">' +
      optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '', '指定しない') + '</select></div>' +
      '<div><label>数量</label>' + qtyStepperHtml('coQty') + '</div>' +
      '<div><label>部署</label><input id="coDept" type="text" list="coDeptList" required><datalist id="coDeptList">' +
      (state.masterExtras ? state.masterExtras.departments.map(function (d) { return '<option value="' + esc(d.name) + '">'; }).join('') : '') + '</datalist></div>' +
      '<div><label>用途</label><input id="coPurpose" type="text" required></div>' +
      '<div><label>マイナス在庫承認 ID (任意: 承認済みの申請を使う場合)</label><input id="coApproval" type="number" min="1" step="1"></div>' +
      '<div class="sticky-actions"><button class="btn" type="submit" id="coSubmit">消費を登録</button></div>' +
      '</form><div id="coResult"></div>';
    el('view').innerHTML = h;
    bindSteppers();
    if (state.flash) { el('coMsg').innerHTML = msgHtml('success', state.flash); state.flash = ''; }
    setMaintFormNote('mntNoteConsume', ['outbound'], ['#coSubmit']);
    /* 在庫一覧の行タップから来た場合は対象をプリセットする */
    var coPreset = takeFormPreset('consume');
    if (coPreset) {
      if (coPreset.productId) el('coProduct').value = String(coPreset.productId);
      if (coPreset.locationId) el('coLocation').value = String(coPreset.locationId);
    }
    var coScan = el('coScan');
    if (coScan) coScan.onclick = function () { openSheetScanner('coProduct', 'coQty', 'consume'); };
    /* セット品を選んだら組立可能数を出す (消費は構成品へ展開される) */
    var refreshBundleNote = function () {
      var note = el('coBundleNote');
      if (!note) return;
      var p = productOf(Number(el('coProduct').value));
      if (!p || !p.isBundle) { note.textContent = ''; return; }
      note.textContent = 'セット品: 構成品を消費します';
      api('/api/v1/products/' + p.id + '/bundle').then(function (b) {
        if (el('coBundleNote')) el('coBundleNote').textContent = 'セット品: 組立可能数 ' + b.assemblable + ' (構成品を消費します)';
      }).catch(function () {});
    };
    el('coProduct').onchange = refreshBundleNote;
    refreshBundleNote();
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
      var selectedProduct = productOf(body.productId);
      if (selectedProduct && selectedProduct.isBundle) {
        api('/api/v1/movements/bundle-consumption', { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: body })
          .then(function (r) {
            var hh = msgHtml('success', 'セット品の消費を登録しました。') +
              '<div class="table-wrap"><table><thead><tr><th>構成品</th><th>ロット</th><th>保管場所</th><th>数量</th></tr></thead><tbody>';
            for (var bi = 0; bi < r.allocations.length; bi++) {
              var ba = r.allocations[bi];
              hh += '<tr><td>' + esc(productLabel(ba.productId)) + '</td><td>' + esc(lotLabel(ba.lotId)) + '</td><td>' + esc(locationLabel(ba.locationId)) + '</td><td>' + ba.quantity + '</td></tr>';
            }
            hh += '</tbody></table></div>';
            el('coResult').innerHTML = hh;
            btn.disabled = false;
          })
          .catch(function (e) {
            el('coMsg').innerHTML = msgHtml('error', errMsg(e));
            btn.disabled = false;
          });
        return;
      }
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
    var h = '<h2>在庫移動</h2><div class="mnt-form-note" id="mntNoteTransfer" style="display:none"></div><div id="trMsg"></div>' +
      '<form class="grid" id="trForm">' +
      '<div><label>商品</label><select id="trProduct" required>' +
      optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select>' +
      (scanSupported() ? '<div style="margin-top:0.4rem;"><button class="btn small secondary" type="button" id="trScan">スキャンで商品を選ぶ</button></div>' : '') + '</div>' +
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
    if (state.flash) { el('trMsg').innerHTML = msgHtml('success', state.flash); state.flash = ''; }
    setMaintFormNote('mntNoteTransfer', ['transfers'], ['#trSubmit']);
    var fillLots = function () {
      var pid = Number(el('trProduct').value);
      var lots = m.lots.filter(function (l) { return l.productId === pid; });
      el('trLot').innerHTML = optionsHtml(lots, function (l) { return l.id; }, function (l) { return l.lotCode; }, '', 'FEFO (自動)');
    };
    el('trProduct').onchange = fillLots;
    var trScan = el('trScan');
    if (trScan) trScan.onclick = function () { openSheetScanner('trProduct', 'trQty', 'transfer'); };
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

/* ---------------- returns (返品) ---------------- */
var REASON_CODE_OPTIONS = [
  { value: 'damaged', label: '破損' },
  { value: 'expired', label: '期限切れ' },
  { value: 'defective', label: '不良' },
  { value: 'other', label: 'その他' },
];
function reasonCodeSelectHtml(id, kind) {
  var list = [];
  if (state.masterExtras) {
    list = (kind === 'disposal' ? state.masterExtras.reasonDisposal : state.masterExtras.reasonReturn) || [];
  }
  var opts = list.length
    ? list.map(function (r) { return { value: r.code, label: r.label }; })
    : REASON_CODE_OPTIONS;
  return '<select id="' + id + '" required>' +
    optionsHtml(opts, function (o) { return o.value; }, function (o) { return o.label; }, '') + '</select>';
}
function loadReturns() {
  viewLoading('返品', 'form');
  Promise.all([ensureMaster(), ensureMasterExtras()]).then(function (rs) { var m = rs[0];
    if (state.masterError) {
      el('view').innerHTML = '<h2>返品</h2>' + msgHtml('error', 'マスタの読み込みに失敗しました: ' + state.masterError);
      return;
    }
    var products = m.products.filter(function (p) { return !p.isBundle; });
    var h = '<h2>返品 (社内から戻り)</h2><div class="mnt-form-note" id="mntNoteReturn" style="display:none"></div><div id="rtMsg"></div>' +
      '<form class="grid" id="rtForm">' +
      '<div><label>商品</label><select id="rtProduct" required>' +
      optionsHtml(products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select>' +
      (scanSupported() ? '<div style="margin-top:0.4rem;"><button class="btn small secondary" type="button" id="rtScan">スキャンで商品を選ぶ</button></div>' : '') + '</div>' +
      '<div><label>保管場所</label><select id="rtLocation" required>' +
      optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '') + '</select></div>' +
      '<div><label>ロット番号</label><input id="rtLot" type="text" required placeholder="例: LOT-2026-001"></div>' +
      '<div><label>有効期限 (期限管理対象の商品は必須)</label><input id="rtExpiry" type="date"></div>' +
      '<div><label>数量</label>' + qtyStepperHtml('rtQty') + '</div>' +
      '<div><label>理由</label>' + reasonCodeSelectHtml('rtReasonCode', 'return') + '</div>' +
      '<div><label>メモ</label><input id="rtReason" type="text" required></div>' +
      '<div class="sticky-actions"><button class="btn" type="submit" id="rtSubmit">返品を登録</button></div>' +
      '</form>';
    el('view').innerHTML = h;
    bindSteppers();
    if (state.flash) { el('rtMsg').innerHTML = msgHtml('success', state.flash); state.flash = ''; }
    setMaintFormNote('mntNoteReturn', ['inbound'], ['#rtSubmit']);
    var rtPreset = takeFormPreset('returns');
    if (rtPreset) {
      if (rtPreset.productId) el('rtProduct').value = String(rtPreset.productId);
      if (rtPreset.locationId) el('rtLocation').value = String(rtPreset.locationId);
      if (rtPreset.lotId) {
        var rtLot = lotOf(rtPreset.lotId);
        if (rtLot) {
          el('rtLot').value = rtLot.lotCode;
          if (rtLot.expiryDate) el('rtExpiry').value = rtLot.expiryDate;
        }
      }
    }
    var rtScan = el('rtScan');
    if (rtScan) rtScan.onclick = function () { openSheetScanner('rtProduct', 'rtQty', 'returns'); };
    el('rtForm').onsubmit = function (ev) {
      ev.preventDefault();
      var btn = el('rtSubmit');
      btn.disabled = true;
      el('rtMsg').innerHTML = '';
      var body = {
        locationId: Number(el('rtLocation').value),
        productId: Number(el('rtProduct').value),
        lotCode: el('rtLot').value,
        quantity: Number(el('rtQty').value),
        reasonCode: el('rtReasonCode').value,
        reason: el('rtReason').value,
      };
      var exp = el('rtExpiry').value;
      if (exp) body.expiryDate = exp;
      api('/api/v1/movements/return', { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: body })
        .then(function (r) {
          el('rtMsg').innerHTML = msgHtml('success', '返品を登録しました。在庫ID: ' + r.stockId + ' / 現在数量: ' + r.quantity);
          btn.disabled = false;
        })
        .catch(function (e) {
          el('rtMsg').innerHTML = msgHtml('error', errMsg(e));
          btn.disabled = false;
        });
    };
  });
}

/* ---------------- disposal (廃棄) ---------------- */
function loadDisposal() {
  viewLoading('廃棄', 'form');
  Promise.all([ensureMaster(), ensureMasterExtras()]).then(function (rs) { var m = rs[0];
    if (state.masterError) {
      el('view').innerHTML = '<h2>廃棄</h2>' + msgHtml('error', 'マスタの読み込みに失敗しました: ' + state.masterError);
      return;
    }
    var products = m.products.filter(function (p) { return !p.isBundle; });
    var h = '<h2>廃棄</h2><div class="mnt-form-note" id="mntNoteDisposal" style="display:none"></div><div id="dpMsg"></div>' +
      '<form class="grid" id="dpForm">' +
      '<div><label>商品</label><select id="dpProduct" required>' +
      optionsHtml(products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select>' +
      (scanSupported() ? '<div style="margin-top:0.4rem;"><button class="btn small secondary" type="button" id="dpScan">スキャンで商品を選ぶ</button></div>' : '') + '</div>' +
      '<div><label>保管場所 (任意: 指定しない場合は全場所から)</label><select id="dpLocation">' +
      optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '', '指定しない') + '</select></div>' +
      '<div><label>数量</label>' + qtyStepperHtml('dpQty') + '</div>' +
      '<div><label>理由</label>' + reasonCodeSelectHtml('dpReasonCode', 'disposal') + '</div>' +
      '<div><label>メモ</label><input id="dpReason" type="text" required></div>' +
      '<div class="sticky-actions"><button class="btn danger" type="submit" id="dpSubmit">廃棄内容を確認</button></div>' +
      '</form><div id="dpConfirm"></div><div id="dpResult"></div>';
    el('view').innerHTML = h;
    bindSteppers();
    if (state.flash) { el('dpMsg').innerHTML = msgHtml('success', state.flash); state.flash = ''; }
    setMaintFormNote('mntNoteDisposal', ['outbound'], ['#dpSubmit']);
    var dpPreset = takeFormPreset('disposal');
    if (dpPreset) {
      if (dpPreset.productId) el('dpProduct').value = String(dpPreset.productId);
      if (dpPreset.locationId) el('dpLocation').value = String(dpPreset.locationId);
    }
    var dpScan = el('dpScan');
    if (dpScan) dpScan.onclick = function () { openSheetScanner('dpProduct', 'dpQty', 'disposal'); };
    /* 廃棄は確定前に確認ステップを挟む (数量と対象を再表示して実行する) */
    el('dpForm').onsubmit = function (ev) {
      ev.preventDefault();
      el('dpMsg').innerHTML = '';
      el('dpResult').innerHTML = '';
      var body = {
        productId: Number(el('dpProduct').value),
        quantity: Number(el('dpQty').value),
        reasonCode: el('dpReasonCode').value,
        reason: el('dpReason').value,
      };
      var loc = el('dpLocation').value;
      if (loc) body.locationId = Number(loc);
      var p = productOf(body.productId);
      var box = el('dpConfirm');
      box.innerHTML = '<div class="section-box"><h3>廃棄の確認</h3>' +
        '<p>' + esc(p ? p.sku + ' ' + p.name : '商品#' + body.productId) + ' を ' + body.quantity + (p ? ' ' + esc(p.unit) : '') + ' 廃棄します。</p>' +
        '<p class="small muted">理由: ' + esc(reasonCodeLabel(body.reasonCode)) + ' / ' + esc(body.reason) +
        (body.locationId ? ' / 場所: ' + esc(locationLabel(body.locationId)) : ' / 場所: 全場所 (FEFO)') + '</p>' +
        '<p><button class="btn danger" type="button" id="dpExec">廃棄を実行</button> ' +
        '<button class="btn secondary" type="button" id="dpBack">戻る</button></p></div>';
      el('dpBack').onclick = function () { box.innerHTML = ''; };
      el('dpExec').onclick = function () {
        var execBtn = el('dpExec');
        execBtn.disabled = true;
        api('/api/v1/movements/disposal', { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: body })
          .then(function (r) {
            box.innerHTML = '';
            var hh = msgHtml('success', '廃棄を登録しました。') +
              '<div class="table-wrap"><table><thead><tr><th>ロット</th><th>保管場所</th><th>数量</th></tr></thead><tbody>';
            for (var i = 0; i < r.allocations.length; i++) {
              var a = r.allocations[i];
              hh += '<tr><td>' + esc(lotLabel(a.lotId)) + '</td><td>' + esc(locationLabel(a.locationId)) + '</td><td>' + a.quantity + '</td></tr>';
            }
            hh += '</tbody></table></div>';
            el('dpResult').innerHTML = hh;
          })
          .catch(function (e) {
            el('dpMsg').innerHTML = msgHtml('error', errMsg(e));
            execBtn.disabled = false;
          });
      };
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
  RETURN: ['返品', 'badge-ok'],
  DISPOSAL: ['廃棄', 'badge-danger'],
};
var REASON_CODE_LABELS = { damaged: '破損', expired: '期限切れ', defective: '不良', other: 'その他' };
function reasonCodeLabel(code) {
  if (!code) return '';
  if (state.masterExtras) {
    var lists = [state.masterExtras.reasonReturn || [], state.masterExtras.reasonDisposal || []];
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) {
        if (lists[i][j].code === code) return lists[i][j].label;
      }
    }
  }
  return REASON_CODE_LABELS[code] || code;
}
function loadHistory() {
  viewLoading('入出庫履歴', 'list');
  ensureMaster().then(function () {
    getJson('/api/v1/movements?take=100').then(function (rows) {
      if (!rows || rows.length === 0) {
        el('view').innerHTML = '<h2>入出庫履歴</h2><p class="muted">履歴がありません。</p>';
        return;
      }
      var h = '<h2>入出庫履歴</h2><div class="table-wrap"><table><thead><tr>' +
        '<th>日時</th><th>種別</th><th>商品</th><th>ロット</th><th>保管場所</th><th>変化</th><th>数量 (前 → 後)</th><th>部署 / 用途</th><th>写真</th></tr></thead><tbody>';
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
          '<td>' + esc([r.department, r.purpose].filter(Boolean).join(' / ') || [reasonCodeLabel(r.reasonCode), r.reason].filter(Boolean).join(' / ') || '') + (r.groupId ? ' <span class="badge">セット/一括</span>' : '') + '</td>' +
          '<td><button class="btn small secondary" data-mphotos="' + r.id + '">写真' + (r.photoCount ? ' (' + r.photoCount + ')' : '') + '</button></td></tr>';
      }
      h += '</tbody></table></div>';
      el('view').innerHTML = h;
      var pbtns = el('view').querySelectorAll('button[data-mphotos]');
      for (var pi = 0; pi < pbtns.length; pi++) {
        pbtns[pi].onclick = function () { openPhotosModal(Number(this.getAttribute('data-mphotos'))); };
      }
    }).catch(function (e) {
      el('view').innerHTML = '<h2>入出庫履歴</h2>' + msgHtml('error', errMsg(e));
    });
  });
}

/* 検品写真モーダル: 伝票の写真一覧と追加 (追加は movements.inbound のみ) */
function openPhotosModal(movementId) {
  el('modalBox').innerHTML = '<h3>検品写真 (伝票 #' + movementId + ')</h3><div id="phMsg"></div><div id="phList">' + skeletonRows() + '</div>' +
    (can('movements.inbound') ? '<div><label>写真を追加</label><input type="file" id="phFile" accept="image/*" multiple></div>' : '') +
    '<p><button class="btn secondary" type="button" id="phClose">閉じる</button></p>';
  el('modalOverlay').style.display = '';
  el('phClose').onclick = closeModal;
  var renderList = function () {
    api('/api/v1/movements/' + movementId + '/photos').then(function (rows) {
      if (!rows || rows.length === 0) { el('phList').innerHTML = '<p class="muted">写真はありません。</p>'; return; }
      var h = '<div class="photo-grid">';
      rows.forEach(function (ph) {
        h += '<a href="/api/v1/photos/' + ph.id + '" target="_blank" rel="noopener"><img class="thumb-lg" src="/api/v1/photos/' + ph.id + '" alt="検品写真"></a>';
      });
      h += '</div>';
      el('phList').innerHTML = h;
    }).catch(function (e) { el('phList').innerHTML = msgHtml('error', errMsg(e)); });
  };
  renderList();
  var f = el('phFile');
  if (f) f.onchange = function () {
    var files = f.files;
    if (!files || files.length === 0) return;
    el('phMsg').innerHTML = msgHtml('info', 'アップロード中…');
    var chain = Promise.resolve();
    for (var i = 0; i < files.length; i++) {
      (function (file) { chain = chain.then(function () { return uploadMovementPhoto(movementId, file); }); })(files[i]);
    }
    chain.then(function () {
      el('phMsg').innerHTML = msgHtml('success', '写真を追加しました。');
      renderList();
    }).catch(function (e) { el('phMsg').innerHTML = msgHtml('error', errMsg(e)); });
  };
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
/* セット品の構成品エディタ (商品編集モーダル内)。構成品の追加・数量・削除を
   ローカルで編集し、「構成品を保存」で PUT /products/:id/bundle へ送る */
function initBundleEditor(productId) {
  var box = el('edBundleBox');
  if (!box) return;
  var comps = [];
  function render() {
    var candidates = (state.master ? state.master.products : []).filter(function (p) {
      return !p.isBundle && p.id !== productId && !comps.some(function (cm) { return cm.productId === p.id; });
    });
    var h = '';
    if (comps.length === 0) h += '<p class="small muted">構成品がありません。</p>';
    comps.forEach(function (cm) {
      h += '<div class="toolbar"><div><span class="small">' + esc(productLabel(cm.productId)) + '</span></div>' +
        '<div><label>必要数</label><input type="number" min="1" step="1" value="' + cm.quantity + '" data-bcomp-qty="' + cm.productId + '" style="width:6em"></div>' +
        '<div><label>&nbsp;</label><button class="btn small danger" type="button" data-bcomp-del="' + cm.productId + '">削除</button></div></div>';
    });
    h += '<div class="toolbar"><div><label>構成品を追加</label><select id="edBundleAdd">' +
      optionsHtml(candidates, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select></div>' +
      '<div><label>必要数</label><input type="number" min="1" step="1" value="1" id="edBundleAddQty" style="width:6em"></div>' +
      '<div><label>&nbsp;</label><button class="btn small" type="button" id="edBundleAddBtn">追加</button></div></div>' +
      '<p><button class="btn small" type="button" id="edBundleSave">構成品を保存</button> <span class="small" id="edBundleMsg"></span></p>' +
      '<p class="small muted">セット品の中にセット品は入れられません。単価は構成品の合算で計算されます。</p>';
    box.innerHTML = h;
    var delBtns = box.querySelectorAll('button[data-bcomp-del]');
    for (var di = 0; di < delBtns.length; di++) {
      delBtns[di].onclick = function () {
        var pid = Number(this.getAttribute('data-bcomp-del'));
        comps = comps.filter(function (cm) { return cm.productId !== pid; });
        render();
      };
    }
    var addBtn = el('edBundleAddBtn');
    if (addBtn) addBtn.onclick = function () {
      var pid = Number(el('edBundleAdd').value);
      var qty = Number(el('edBundleAddQty').value);
      if (!pid || !(qty >= 1)) return;
      comps.push({ productId: pid, quantity: qty });
      render();
    };
    var saveBtn = el('edBundleSave');
    if (saveBtn) saveBtn.onclick = function () {
      var qtyInputs = box.querySelectorAll('input[data-bcomp-qty]');
      var payload = [];
      for (var qi = 0; qi < qtyInputs.length; qi++) {
        payload.push({ productId: Number(qtyInputs[qi].getAttribute('data-bcomp-qty')), quantity: Number(qtyInputs[qi].value) });
      }
      el('edBundleMsg').textContent = '保存中…';
      api('/api/v1/products/' + productId + '/bundle', { method: 'PUT', body: { components: payload } })
        .then(function (r) {
          comps = (r.components || []).map(function (cm) { return { productId: cm.productId, quantity: cm.quantity }; });
          el('edBundleMsg').textContent = '保存しました。組立可能数: ' + r.assemblable;
          state.master = null;
        })
        .catch(function (e) { el('edBundleMsg').textContent = errMsg(e); });
    };
  }
  api('/api/v1/products/' + productId + '/bundle').then(function (b) {
    comps = (b.components || []).map(function (cm) { return { productId: cm.productId, quantity: cm.quantity }; });
    render();
  }).catch(function (e) {
    box.innerHTML = msgHtml('error', errMsg(e));
  });
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
      fieldHtml('アラート日数 (空欄で解除)', '<input id="edDays" type="number" min="0" step="1" value="' + (p.expiryAlertDays === null || p.expiryAlertDays === undefined ? '' : p.expiryAlertDays) + '">') +
      fieldHtml('1ケースの入数 (空欄で未設定)', '<input id="edCase" type="number" min="2" step="1" value="' + (p.caseSize === null || p.caseSize === undefined ? '' : p.caseSize) + '">') +
      fieldHtml('リードタイム (日、空欄で未設定)', '<input id="edLead" type="number" min="0" step="1" value="' + (p.leadTimeDays === null || p.leadTimeDays === undefined ? '' : p.leadTimeDays) + '">') +
      fieldHtml('セット品', '<select id="edBundle"><option value="">通常商品</option><option value="1"' + (p.isBundle ? ' selected' : '') + '>セット品</option></select>') +
      fieldHtml('カテゴリ', '<select id="edCategory"><option value="">未分類</option>' +
        (state.masterExtras ? state.masterExtras.categories.map(function (ct) { return '<option value="' + ct.id + '"' + (p.categoryId === ct.id ? ' selected' : '') + '>' + esc(ct.name) + '</option>'; }).join('') : '') + '</select>') +
      (p.isBundle ? fieldHtml('構成品 (セット品)', '<div id="edBundleBox"><span class="small muted">読み込み中…</span></div>') : '') +
      fieldHtml('商品画像', '<span id="edImgPrev">' + (p.imageKey ? '<img class="thumb-lg" src="/api/v1/products/' + p.id + '/image" alt="商品画像">' : '<span class="muted">画像なし</span>') + '</span> ' +
        '<input type="file" id="edImgFile" accept="image/*"> ' +
        '<button class="btn small danger" type="button" id="edImgDel"' + (p.imageKey ? '' : ' style="display:none"') + '>画像を削除</button><span id="edImgMsg" class="small"></span>');
    openModal('商品を編集: ' + p.sku, pFields, function () {
      var body = {
        name: el('edName').value,
        unit: el('edUnit').value,
        barcode: el('edBarcode').value === '' ? null : el('edBarcode').value,
        safetyStock: Number(el('edSafety').value || 0),
        requiresExpiry: el('edExpiry').value === '1',
        expiryAlertDays: el('edDays').value === '' ? null : Number(el('edDays').value),
        unitCost: el('edCost').value === '' ? null : Number(el('edCost').value),
        caseSize: el('edCase').value === '' ? null : Number(el('edCase').value),
        leadTimeDays: el('edLead').value === '' ? null : Number(el('edLead').value),
        isBundle: el('edBundle').value === '1',
        categoryId: el('edCategory') && el('edCategory').value !== '' ? Number(el('edCategory').value) : null,
      };
      return api(base, { method: 'PUT', body: body }).then(function () { return '商品を更新しました。'; });
    });
    if (p.isBundle) initBundleEditor(id);
    /* 画像は保存ボタンとは独立に即時アップロード/削除する */
    bindThumbFallbacks();
    var imgFile = el('edImgFile');
    if (imgFile) imgFile.onchange = function () {
      var f = imgFile.files && imgFile.files[0];
      if (!f) return;
      el('edImgMsg').textContent = 'アップロード中…';
      uploadProductImage(id, f).then(function (r) {
        var prod = productOf(id);
        if (prod) prod.imageKey = r.imageKey;
        el('edImgPrev').innerHTML = '<img class="thumb-lg" src="/api/v1/products/' + id + '/image" alt="商品画像">';
        el('edImgDel').style.display = '';
        el('edImgMsg').textContent = '画像を更新しました。';
      }).catch(function (e) { el('edImgMsg').textContent = errMsg(e); });
    };
    var imgDel = el('edImgDel');
    if (imgDel) imgDel.onclick = function () {
      api('/api/v1/products/' + id + '/image', { method: 'DELETE' }).then(function () {
        var prod = productOf(id);
        if (prod) prod.imageKey = null;
        el('edImgPrev').innerHTML = '<span class="muted">画像なし</span>';
        el('edImgDel').style.display = 'none';
        el('edImgMsg').textContent = '画像を削除しました。';
      }).catch(function (e) { el('edImgMsg').textContent = errMsg(e); });
    };
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
      fieldHtml('メモ (任意)', '<input id="edSupNote" value="' + esc(sup.note || '') + '">') +
      fieldHtml('既定リードタイム (日、空欄で未設定)', '<input id="edSupLead" type="number" min="0" step="1" value="' + (sup.leadTimeDays === null || sup.leadTimeDays === undefined ? '' : sup.leadTimeDays) + '">');
    openModal('仕入先を編集', sFields, function () {
      var sBody = {
        name: el('edSupName').value,
        contact: el('edSupContact').value === '' ? null : el('edSupContact').value,
        email: el('edSupEmail').value === '' ? null : el('edSupEmail').value,
        phone: el('edSupPhone').value === '' ? null : el('edSupPhone').value,
        note: el('edSupNote').value === '' ? null : el('edSupNote').value,
        leadTimeDays: el('edSupLead').value === '' ? null : Number(el('edSupLead').value),
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
    if (kind === 'location') {
      var parentCandidates = (state.master ? state.master.locations : []).filter(function (l) {
        return l.warehouseId === row.warehouseId && l.id !== id;
      });
      wFields += fieldHtml('親の場所 (任意)', '<select id="edParent">' +
        optionsHtml(parentCandidates, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, row.parentId || '', 'なし (倉庫直下)') + '</select>');
    }
    openModal((kind === 'warehouse' ? '倉庫' : '保管場所') + 'を編集', wFields, function () {
      var wBody = { code: el('edCode').value, name: el('edWName').value };
      if (kind === 'location') {
        var parentSel = el('edParent');
        wBody.parentId = parentSel && parentSel.value ? Number(parentSel.value) : null;
      }
      return api(base, { method: 'PUT', body: wBody })
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
function masterSection(title, tableHtml, formHtml, noteId) {
  var note = noteId ? '<div class="mnt-form-note" id="' + noteId + '" style="display:none"></div>' : '';
  return '<div class="section-box"><h3>' + esc(title) + '</h3>' + note + tableHtml + formHtml + '</div>';
}
function simpleTable(head, rowsHtml) {
  if (!rowsHtml) return '<p class="muted">データがありません。</p>';
  return '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
}
function loadMasterView() {
  viewLoading('マスタ管理', 'list');
  state.master = null;
  Promise.all([ensureMaster(), ensureMasterExtras()]).then(function (rs) {
    var m = rs[0];
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
      prow += '<tr><td><input type="checkbox" data-label-product="' + p.id + '"></td><td>' + esc(p.sku) + '</td><td>' + esc(p.name) +
        (p.isBundle ? ' <span class="badge">セット</span>' + (p.assemblable !== undefined && p.assemblable !== null ? ' <span class="small muted">組立可能 ' + p.assemblable + '</span>' : '') : '') +
        (p.categoryName ? ' <span class="small muted">' + esc(p.categoryName) + '</span>' : '') + '</td><td>' + esc(p.unit) + '</td><td>' + p.safetyStock + '</td><td>' +
        (p.caseSize ? p.caseSize : '-') + '</td><td>' +
        (p.unitCost === null || p.unitCost === undefined ? '-' : yen(p.unitCost)) + '</td><td>' +
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
        '<div><label>1ケースの入数 (任意)</label><input id="mpCase" type="number" min="2"></div>' +
        '<div><label>リードタイム (日、任意)</label><input id="mpLead" type="number" min="0"></div>' +
        '<div><label>セット品</label><select id="mpBundle"><option value="">通常商品</option><option value="1">セット品 (構成品は編集画面で設定)</option></select></div>' +
        '<div><label>カテゴリ (任意)</label><select id="mpCategory"><option value="">未分類</option>' +
        (state.masterExtras ? state.masterExtras.categories.map(function (ct) { return '<option value="' + ct.id + '">' + esc(ct.name) + '</option>'; }).join('') : '') + '</select></div>' +
        '<div><label>&nbsp;</label><button class="btn" type="submit">商品を追加</button></div></form>';
    }
    var plabel = '<p><button class="btn secondary" type="button" id="maLabelProducts">選択した商品のラベルを印刷</button></p>';
    if (writable) {
      plabel += '<div class="section-box"><h4>選択した商品の一括編集</h4>' +
        '<div class="grid">' +
        '<div><label>安全在庫</label><input id="bkSafety" type="number" min="0" placeholder="変更しない場合は空欄"></div>' +
        '<div><label>単価 (円)</label><input id="bkCost" type="number" min="0" placeholder="変更しない場合は空欄"></div>' +
        '<div><label>入数</label><input id="bkCase" type="number" min="1" placeholder="変更しない場合は空欄"></div>' +
        '<div><label>リードタイム (日)</label><input id="bkLead" type="number" min="0" placeholder="変更しない場合は空欄"></div>' +
        '<div><label>有効/無効</label><select id="bkActive"><option value="">変更しない</option><option value="1">有効化</option><option value="0">無効化</option></select></div>' +
        '<div><label>&nbsp;</label><button class="btn" type="button" id="maBulkApply">一括適用</button></div>' +
        '</div><div id="bkMsg"></div></div>';
    }
    h += masterSection('商品', simpleTable('<th></th><th>SKU</th><th>商品名</th><th>単位</th><th>安全在庫</th><th>入数</th><th>単価</th><th>期限</th><th>アラート</th>' + actHead, prow), plabel + pform, 'mntNoteMasterProducts');

    if (writable && feat('csv')) {
      h += '<div class="section-box"><h3>商品 CSV インポート</h3>' +
        '<div class="mnt-form-note" id="mntNoteCsvImport" style="display:none"></div>' +
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
    h += masterSection('倉庫', simpleTable('<th>コード</th><th>名前</th>' + actHead, wrow), wform, 'mntNoteMasterWarehouses');

    var lrow = '';
    m.locations.forEach(function (l) {
      lrow += '<tr><td><input type="checkbox" data-label-location="' + l.id + '"></td><td>' + esc(locationLabel(l.id)) + '</td><td>' + esc(l.code) + '</td>' + actCell('location', l.id) + '</tr>';
    });
    var lform = '';
    if (writable) {
      lform = '<form class="grid" id="maLocationForm">' +
        '<div><label>倉庫</label><select id="mlWarehouse">' + optionsHtml(m.warehouses, function (w) { return w.id; }, function (w) { return w.name; }, '') + '</select></div>' +
        '<div><label>場所コード</label><input id="mlCode" required></div>' +
        '<div><label>場所名</label><input id="mlName" required></div>' +
        '<div><label>親の場所 (任意)</label><select id="mlParent"></select></div>' +
        '<div><label>&nbsp;</label><button class="btn" type="submit">保管場所を追加</button></div></form>';
    }
    var llabel = '<p><button class="btn secondary" type="button" id="maLabelLocations">選択した保管場所のラベルを印刷</button></p>';
    h += masterSection('保管場所', simpleTable('<th></th><th>場所</th><th>コード</th>' + actHead, lrow), llabel + lform, 'mntNoteMasterLocations');

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
    h += masterSection('ロット', simpleTable('<th>商品</th><th>ロット番号</th><th>期限</th>' + actHead, lotrow), lotform, 'mntNoteMasterLots');

    if (feat('purchase_orders')) {
      var srow = '';
      (m.suppliers || []).forEach(function (s) {
        srow += '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.contact || '-') + '</td><td>' + esc(s.email || '-') + '</td><td>' + esc(s.phone || '-') + '</td><td>' + esc(s.note || '-') + '</td>' +
          '<td>' + (s.leadTimeDays === null || s.leadTimeDays === undefined ? '-' : s.leadTimeDays + '日') + '</td>' +
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
          '<div><label>既定リードタイム (日、任意)</label><input id="msLead" type="number" min="0"></div>' +
          '<div><label>&nbsp;</label><button class="btn" type="submit">仕入先を追加</button></div></form>';
      }
      h += masterSection('仕入先', simpleTable('<th>仕入先名</th><th>担当者</th><th>メール</th><th>電話</th><th>メモ</th><th>リードタイム</th>' + actHead, srow), sform, 'mntNoteMasterSuppliers');
    }

    el('view').innerHTML = h;
    setMaintFormNote('mntNoteMasterProducts', ['master_products'], ['#maProductForm button[type="submit"]', 'button[data-mact="edit-product"]', 'button[data-mact="del-product"]']);
    setMaintFormNote('mntNoteMasterWarehouses', ['master_locations'], ['#maWarehouseForm button[type="submit"]', 'button[data-mact="edit-warehouse"]', 'button[data-mact="del-warehouse"]']);
    setMaintFormNote('mntNoteMasterLocations', ['master_locations'], ['#maLocationForm button[type="submit"]', 'button[data-mact="edit-location"]', 'button[data-mact="del-location"]']);
    setMaintFormNote('mntNoteMasterLots', ['master_locations'], ['#maLotForm button[type="submit"]', 'button[data-mact="edit-lot"]', 'button[data-mact="del-lot"]']);
    setMaintFormNote('mntNoteMasterSuppliers', ['suppliers'], ['#maSupplierForm button[type="submit"]', 'button[data-mact="edit-supplier"]', 'button[data-mact="del-supplier"]']);
    setMaintFormNote('mntNoteCsvImport', ['csv_import'], ['#maCsvBtn']);

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
    /* ラベル印刷: チェックした対象の印刷ページを新しいタブで開く */
    function bindLabelButton(btnId, attr, type) {
      var btn = el(btnId);
      if (!btn) return;
      btn.onclick = function () {
        var boxes = el('view').querySelectorAll('input[' + attr + ']');
        var ids = [];
        for (var i = 0; i < boxes.length; i++) {
          if (boxes[i].checked) ids.push(boxes[i].getAttribute(attr));
        }
        if (ids.length === 0) {
          el('maMsg').innerHTML = msgHtml('error', 'ラベルを印刷する対象を選択してください。');
          return;
        }
        window.open('/labels/print?type=' + type + '&ids=' + ids.join(','), '_blank');
      };
    }
    bindLabelButton('maLabelProducts', 'data-label-product', 'products');
    bindLabelButton('maLabelLocations', 'data-label-location', 'locations');
    /* 商品の一括編集: ラベル印刷と同じチェック選択を対象にする */
    var bulkBtn = el('maBulkApply');
    if (bulkBtn) bulkBtn.onclick = function () {
      var boxes = el('view').querySelectorAll('input[data-label-product]');
      var ids = [];
      for (var bi = 0; bi < boxes.length; bi++) {
        if (boxes[bi].checked) ids.push(Number(boxes[bi].getAttribute('data-label-product')));
      }
      if (ids.length === 0) {
        el('bkMsg').innerHTML = msgHtml('error', '対象の商品を選択してください。');
        return;
      }
      var patch = {};
      if (el('bkSafety').value !== '') patch.safetyStock = Number(el('bkSafety').value);
      if (el('bkCost').value !== '') patch.unitCost = Number(el('bkCost').value);
      if (el('bkCase').value !== '') patch.caseSize = Number(el('bkCase').value);
      if (el('bkLead').value !== '') patch.leadTimeDays = Number(el('bkLead').value);
      if (el('bkActive').value !== '') patch.active = el('bkActive').value === '1';
      if (Object.keys(patch).length === 0) {
        el('bkMsg').innerHTML = msgHtml('error', '変更する項目を 1 つ以上入力してください。');
        return;
      }
      api('/api/v1/admin/products/bulk', { method: 'PUT', body: { ids: ids, patch: patch } })
        .then(function (r) {
          state.flash = ids.length + ' 件の商品を一括編集しました (更新 ' + r.updated + ' 件)。';
          state.master = null;
          loadMasterView();
        })
        .catch(function (e) { el('bkMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
    /* 商品の追加は bindForm と別に扱う: スキャナーの「商品を登録」から来た
       場合は、作成後に元の文脈へ戻す (記録シートは商品をセットして戻る、
       棚卸しは一覧の明細からスキャンを再開できる、在庫検索は SKU で絞り込む)。
       戻り先は下の pending ブロックで productReturn に取り込む */
    var productReturn = null;
    var productFormEl = el('maProductForm');
    if (productFormEl) productFormEl.onsubmit = function (ev) {
      ev.preventDefault();
      var b = { sku: el('mpSku').value, name: el('mpName').value, unit: el('mpUnit').value, safetyStock: Number(el('mpSafety').value || 0), requiresExpiry: el('mpExpiry').value === '1' };
      if (el('mpBundle') && el('mpBundle').value === '1') b.isBundle = true;
      if (el('mpBarcode').value) b.barcode = el('mpBarcode').value;
      if (el('mpAlertDays').value) b.expiryAlertDays = Number(el('mpAlertDays').value);
      if (el('mpCost').value) b.unitCost = Number(el('mpCost').value);
      if (el('mpCase').value) b.caseSize = Number(el('mpCase').value);
      if (el('mpLead').value) b.leadTimeDays = Number(el('mpLead').value);
      if (el('mpCategory') && el('mpCategory').value) b.categoryId = Number(el('mpCategory').value);
      api('/api/v1/master/products', { method: 'POST', body: b }).then(function (res) {
        state.master = null;
        var ret = productReturn;
        productReturn = null;
        if (ret && res && res.id) {
          state.flash = '商品を登録しました: ' + (res.sku || '') + ' ' + (res.name || '');
          if (ret.view === 'stocks') {
            try { sessionStorage.setItem('pendingStockQuery', res.sku || ''); } catch (e) {}
            showView('stocks');
          } else if (ret.view === 'stocktakes') {
            showView('stocktakes');
          } else {
            saveFormPreset(ret.view, { productId: res.id });
            showView(ret.view);
          }
          return;
        }
        state.flash = '商品を追加しました。';
        loadMasterView();
      }).catch(function (e) {
        el('maMsg').innerHTML = msgHtml('error', errMsg(e));
      });
    };
    bindForm('maWarehouseForm', { path: '/api/v1/master/warehouses', body: function () {
      return { code: el('mwCode').value, name: el('mwName').value };
    } }, '倉庫を追加しました。');
    /* 親の場所は選択中の倉庫の場所だけを候補にする */
    var fillLocationParents = function () {
      var sel = el('mlParent');
      var whSel = el('mlWarehouse');
      if (!sel || !whSel) return;
      var wh = Number(whSel.value);
      var locs = m.locations.filter(function (l) { return l.warehouseId === wh; });
      sel.innerHTML = optionsHtml(locs, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '', 'なし (倉庫直下)');
    };
    var mlWhSel = el('mlWarehouse');
    if (mlWhSel) { mlWhSel.onchange = fillLocationParents; fillLocationParents(); }
    bindForm('maLocationForm', { path: '/api/v1/master/locations', body: function () {
      var b = { warehouseId: Number(el('mlWarehouse').value), code: el('mlCode').value, name: el('mlName').value };
      var parent = el('mlParent');
      if (parent && parent.value) b.parentId = Number(parent.value);
      return b;
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
      if (el('msLead').value) b.leadTimeDays = Number(el('msLead').value);
      return b;
    } }, '仕入先を追加しました。');
    /* スキャナーで未登録だったバーコードを引き継いで商品登録へ進める */
    if (pendingNewProductBarcode) {
      var pendingBarcode = pendingNewProductBarcode;
      pendingNewProductBarcode = '';
      productReturn = pendingProductReturn;
      pendingProductReturn = null;
      var bcInput = el('mpBarcode');
      if (bcInput) {
        bcInput.value = pendingBarcode;
        el('maMsg').innerHTML = msgHtml('info', 'バーコード ' + pendingBarcode + ' を入力しました。SKU と商品名を入力して「商品を追加」を押してください。');
        var skuInput = el('mpSku');
        if (skuInput) skuInput.focus();
      }
    }
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
      var h = '<h2>マイナス在庫</h2><div class="mnt-form-note" id="mntNoteNegative" style="display:none"></div><div id="ngMsg"></div>';
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
            statusBadge(a.status) + '</td><td>' + (a.requestedBy === null || a.requestedBy === undefined ? '-' : a.requestedBy) + '</td><td>' + fmtDateTime(a.createdAt) + '</td><td>' + decide + '</td></tr>';
        });
        h += '</tbody></table></div>';
      }
      el('view').innerHTML = h;
      setMaintFormNote('mntNoteNegative', ['outbound'], ['#ngForm button[type="submit"]', 'button[data-decide]']);
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
    var h = '<h2>棚卸し</h2><div class="mnt-form-note" id="mntNoteStocktakes" style="display:none"></div><div id="tkMsg"></div>';
    h += msgHtml('info', '棚卸し実施中・差異承認待ちの間は、対象範囲の在庫更新が停止します (全件: すべて / 場所を指定: 対象の保管場所のみ)。盲検では実数入力の間、帳簿数は表示されません。');
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
      h += '<div class="section-box"><h3>棚卸しを開始</h3>' +
        '<div><label><input type="radio" name="tkScope" value="full" checked> 全件</label> ' +
        '<label><input type="radio" name="tkScope" value="locations"> 場所を指定</label></div>' +
        '<div id="tkLocBox" style="display:none"><p class="small muted">対象の保管場所</p>';
      (state.master ? state.master.locations : []).forEach(function (l) {
        h += '<label style="display:block"><input type="checkbox" data-tk-loc="' + l.id + '"> ' + esc(locationLabel(l.id)) + ' (' + esc(l.code) + ')</label>';
      });
      h += '</div>' +
        '<div><label><input type="checkbox" id="tkBlind"> 盲検 (実数を入力する間、帳簿数を表示しない)</label></div>' +
        '<p><button class="btn" id="tkStart">棚卸しを開始する</button></p></div>';
    }
    h += '<div id="tkDetail"></div>';
    if (!rows || rows.length === 0) h += '<p class="muted">棚卸しの履歴はありません。</p>';
    else {
      h += '<div class="table-wrap"><table><thead><tr><th>ID</th><th>状態</th><th>範囲</th><th>開始者</th><th>開始日時</th><th>確定日時</th></tr></thead><tbody>';
      rows.forEach(function (t) {
        var scopeLabel = t.scopeType === 'locations' ? '場所 ' + (t.locationIds ? t.locationIds.length : 0) + '件' : '全件';
        h += '<tr><td>' + t.id + '</td><td>' + stocktakeStatusBadge(t.status) +
          '</td><td>' + scopeLabel + (t.blind ? ' <span class="badge">盲検</span>' : '') +
          '</td><td>' + (t.startedBy === null || t.startedBy === undefined ? '-' : t.startedBy) + '</td><td>' + fmtDateTime(t.startedAt) + '</td><td>' + fmtDateTime(t.confirmedAt) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    el('view').innerHTML = h;
    if (state.flash) { el('tkMsg').innerHTML = msgHtml('success', state.flash); state.flash = ''; }
    setMaintFormNote('mntNoteStocktakes', ['stocktakes'], ['#tkStart', '#tkFinish', '#tkApprove', '#tkReject', '#tkDetail button']);
    var scopeRadios = el('view').querySelectorAll('input[name="tkScope"]');
    for (var si = 0; si < scopeRadios.length; si++) {
      scopeRadios[si].onchange = function () {
        var box = el('tkLocBox');
        if (box) box.style.display = this.value === 'locations' ? '' : 'none';
      };
    }
    var start = el('tkStart');
    if (start) start.onclick = function () {
      var scope = 'full';
      var radios = el('view').querySelectorAll('input[name="tkScope"]');
      for (var ri = 0; ri < radios.length; ri++) {
        if (radios[ri].checked) scope = radios[ri].value;
      }
      var body = { scopeType: scope, blind: !!(el('tkBlind') && el('tkBlind').checked) };
      if (scope === 'locations') {
        var boxes = el('view').querySelectorAll('input[data-tk-loc]');
        var ids = [];
        for (var bi2 = 0; bi2 < boxes.length; bi2++) {
          if (boxes[bi2].checked) ids.push(Number(boxes[bi2].getAttribute('data-tk-loc')));
        }
        if (ids.length === 0) {
          el('tkMsg').innerHTML = msgHtml('error', '対象の保管場所を選択してください。');
          return;
        }
        body.locationIds = ids;
      }
      api('/api/v1/stocktakes', { method: 'POST', body: body }).then(function () { loadStocktakes(); })
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
    var h = '<div class="section-box"><h3>棚卸し #' + d.id + ' の明細 ' + stocktakeStatusBadge(d.status) + (d.blind ? ' <span class="badge">盲検</span>' : '') + '</h3>';
    if (d.blind && d.status === 'in_progress') {
      h += '<p class="small muted">盲検中のため、帳簿数と差異は表示されません (差異は承認画面でのみ表示されます)。</p>';
    }
    if (editable && scanSupported() && d.lines && d.lines.length > 0) {
      var scanLocIds = [];
      d.lines.forEach(function (ln) {
        if (scanLocIds.indexOf(ln.locationId) === -1) scanLocIds.push(ln.locationId);
      });
      h += '<div class="section-box"><h4>スキャンで数える</h4>' +
        '<p><label>対象の保管場所</label> <select id="tkScanLoc">' +
        optionsHtml(scanLocIds, function (id) { return id; }, function (id) { return locationLabel(id); }, '') +
        '</select> <button class="btn" type="button" id="tkScanStart">スキャンで数える</button></p>' +
        '<p class="small muted">バーコードを連続スキャンすると、選んだ場所の実数が 1 ずつ増えます (複数ロットは期限の早い行へ)。</p></div>';
    }
    if (!d.lines || d.lines.length === 0) {
      h += '<p class="muted">対象の在庫がありません。</p>';
    } else {
      h += '<div class="table-wrap"><table><thead><tr><th>商品</th><th>ロット</th><th>保管場所</th><th>帳簿数</th><th>実数</th><th>差異</th><th></th></tr></thead><tbody>';
      d.lines.forEach(function (ln) {
        var book = ln.bookQuantity === null || ln.bookQuantity === undefined ? '<span class="muted">—</span>' : ln.bookQuantity;
        var diff = ln.difference === null || ln.difference === undefined ? '<span class="muted">—</span>'
          : (ln.difference === 0 ? '0' : '<span class="' + (ln.difference < 0 ? 'qty-neg' : 'qty-pos') + '">' + (ln.difference > 0 ? '+' : '') + ln.difference + '</span>');
        var input = editable
          ? '<input type="number" min="0" step="1" id="cnt-' + ln.id + '" value="' + (ln.countedQuantity === null ? '' : ln.countedQuantity) + '" style="width: 6em;">'
          : (ln.countedQuantity === null ? '<span class="muted">未入力</span>' : ln.countedQuantity);
        var btn = editable ? '<button class="btn small" data-count-line="' + ln.id + '">保存</button>' : '';
        h += '<tr><td>' + esc(productLabel(ln.productId)) + '</td><td>' + esc(ln.lotCode) + '</td><td>' + esc(locationLabel(ln.locationId)) +
          '</td><td>' + book + '</td><td>' + input + '</td><td>' + diff + '</td><td>' + btn + '</td></tr>';
      });
      h += '</tbody></table></div>';
      h += '<p class="small muted">実数が未入力の行は帳簿どおり (差異なし) として扱われます。</p>';
    }
    h += '</div>';
    box.innerHTML = h;
    renderMaintFormNote();
    var tkScanStart = el('tkScanStart');
    if (tkScanStart) tkScanStart.onclick = function () {
      openStocktakeScanner(t, d, Number(el('tkScanLoc').value));
    };
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

/* 棚卸しスキャンカウント: 選んだ保管場所で連続スキャンし、受理のたびに
   その商品 × 場所の明細行 (複数ロットは期限の早い行) の実数を +1 する。
   保存は既存の実数更新 API へ絶対値を直列化して送り、閉じる前に必ず flush する。
   集計の規則は src/lib/scan-core.ts の createScanCounter と同じ。
   盲検でも使える (ここで出すのは数えた数量だけで、帳簿数は一切扱わない)。 */
function openStocktakeScanner(t, detail, locationId) {
  var lines = detail.lines || [];
  var countedVals = {}; /* lineId -> 現在の実数 (絶対値) */
  var savedVals = {}; /* lineId -> サーバーへ保存できた実数 */
  var scheduled = {}; /* lineId -> 保存ランがキュー済みか */
  var baseVals = {}; /* lineId -> 開始時点の countedQuantity (null = 未入力) */
  lines.forEach(function (ln) { baseVals[ln.id] = ln.countedQuantity; });
  var recentByProduct = {}; /* productId -> { name, count, at } */
  var recentOrder = [];
  var saveQueue = Promise.resolve();
  var saving = 0;
  var saveError = '';
  var sessionApi = null;

  function currentCounted(line) {
    if (countedVals[line.id] !== undefined) return countedVals[line.id];
    return line.countedQuantity === null || line.countedQuantity === undefined ? 0 : line.countedQuantity;
  }
  function refreshSync() { if (sessionApi) sessionApi.refreshPanel(); }
  /* 保存は直列化し、実行時点で最新の実数を読む (連続スキャンの PUT を間引く)。
     取り消しで未入力に戻った行や、保存済みと同値の行は送らない。 */
  function enqueueSave(lineId) {
    if (scheduled[lineId]) return;
    scheduled[lineId] = true;
    saving++;
    refreshSync();
    saveQueue = saveQueue.then(function () {
      delete scheduled[lineId];
      var value = countedVals[lineId];
      if (value === undefined || savedVals[lineId] === value ||
          (savedVals[lineId] === undefined && baseVals[lineId] === value)) {
        saving--;
        refreshSync();
        return;
      }
      return api('/api/v1/stocktakes/' + detail.id + '/lines/' + lineId, { method: 'PUT', body: { countedQuantity: value } })
        .then(function () {
          savedVals[lineId] = value;
          saveError = '';
        })
        .catch(function (e) { saveError = errMsg(e); })
        .then(function () {
          saving--;
          refreshSync();
        });
    });
  }
  function sessionTotal() {
    var total = 0;
    for (var pid in recentByProduct) total += recentByProduct[pid].count;
    return total;
  }

  openScanner({
    title: '棚卸しスキャン',
    continuous: true,
    registerReturn: { view: 'stocktakes' },
    onOpen: function (api_) { sessionApi = api_; },
    panelTitle: function () {
      return locationLabel(locationId) + ' — 合計 ' + sessionTotal() + ' 件';
    },
    syncHtml: function () {
      if (saveError) return '<span class="scan-sync error">保存エラー</span>';
      if (saving > 0) return '<span class="scan-sync saving">同期中…</span>';
      return '<span class="scan-sync">保存済み</span>';
    },
    renderPanel: function (sess) {
      if (recentOrder.length === 0) {
        return scanEmptyHtml(sess);
      }
      var h = '<div class="scan-recent">';
      for (var i = recentOrder.length - 1; i >= 0; i--) {
        var r = recentByProduct[recentOrder[i]];
        if (!r || r.count <= 0) continue;
        h += '<div class="scan-recent-row"><span class="scan-recent-name">' + esc(r.name) + '</span>' +
          '<span class="scan-recent-qty">× ' + r.count + '</span>' +
          '<span class="scan-recent-time">' + scanTimeText(r.at) + '</span></div>';
      }
      return h + '</div>';
    },
    onCode: function (code, format, api_) {
      var p = productByBarcode(code);
      if (!p) return 'unknown';
      var line = scanPickLine(lines, p.id, locationId);
      if (!line) {
        api_.setStatus('対象外: ' + p.sku + ' ' + p.name + ' はこの場所の棚卸し対象にありません');
        return 'out';
      }
      countedVals[line.id] = currentCounted(line) + 1;
      enqueueSave(line.id);
      if (!recentByProduct[p.id]) {
        recentByProduct[p.id] = { name: p.sku + ' ' + p.name, count: 0, at: Date.now() };
        recentOrder.push(p.id);
      }
      recentByProduct[p.id].count++;
      recentByProduct[p.id].at = Date.now();
      api_.pushUndo(function () {
        var cur = countedVals[line.id] === undefined ? currentCounted(line) : countedVals[line.id];
        var nv = Math.max(0, cur - 1);
        /* 未入力だった行を未保存のまま 0 へ戻す取り消しは未入力へ戻す。
           一度保存した行は 0 を送って戻す (実数 API は null を受け付けない) */
        if (nv === 0 && baseVals[line.id] === null && savedVals[line.id] === undefined) {
          delete countedVals[line.id];
        } else {
          countedVals[line.id] = nv;
          enqueueSave(line.id);
        }
        if (recentByProduct[p.id]) recentByProduct[p.id].count--;
        api_.refreshPanel();
      });
      api_.refreshPanel();
      return 'ok';
    },
    onBeforeClose: function () { return saveQueue; },
    onClose: function () { renderStocktakeDetail(t); },
  });
}

/* ---------------- reservations (引当) ---------------- */
function loadReservations() {
  viewLoading('引当', 'list');
  ensureMaster().then(function (m) {
    if (state.masterError) {
      el('view').innerHTML = '<h2>引当</h2>' + msgHtml('error', 'マスタの読み込みに失敗しました: ' + state.masterError);
      return;
    }
    var products = m.products.filter(function (p) { return !p.isBundle; });
    var h = '<h2>引当</h2><div id="rsMsg"></div>';
    if (state.flash) { h += msgHtml('success', state.flash); state.flash = ''; }
    h += '<div class="section-box"><h3>引当を作成</h3>' +
      '<form class="grid" id="rsForm">' +
      '<div><label>商品</label><select id="rsProduct" required>' +
      optionsHtml(products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select></div>' +
      '<div><label>保管場所 (任意: 指定しない場合は店舗全体)</label><select id="rsLocation">' +
      optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '', '指定しない') + '</select></div>' +
      '<div><label>数量</label>' + qtyStepperHtml('rsQty') + '</div>' +
      '<div><label>理由</label><input id="rsReason" type="text" required></div>' +
      '<div><label>期限 (任意)</label><input id="rsExpires" type="date"></div>' +
      '<div class="sticky-actions"><button class="btn" type="submit">引当を作成</button></div>' +
      '</form></div>' +
      '<h3>有効な引当</h3><div id="rsList">' + skeletonRows() + '</div>';
    el('view').innerHTML = h;
    bindSteppers();
    el('rsForm').onsubmit = function (ev) {
      ev.preventDefault();
      var body = {
        productId: Number(el('rsProduct').value),
        quantity: Number(el('rsQty').value),
        reason: el('rsReason').value,
      };
      var loc = el('rsLocation').value;
      if (loc) body.locationId = Number(loc);
      var exp = el('rsExpires').value;
      if (exp) body.expiresAt = new Date(exp + 'T23:59:59').getTime();
      api('/api/v1/reservations', { method: 'POST', body: body })
        .then(function () {
          state.flash = '引当を作成しました。';
          loadReservations();
        })
        .catch(function (e) { el('rsMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
    api('/api/v1/reservations').then(function (rows) {
      var box = el('rsList');
      if (!box) return;
      if (!rows || rows.length === 0) {
        box.innerHTML = '<p class="muted">有効な引当はありません。</p>';
        return;
      }
      var hh = '<div class="table-wrap"><table><thead><tr><th>商品</th><th>場所</th><th>数量</th><th>理由</th><th>期限</th><th></th></tr></thead><tbody>';
      rows.forEach(function (r) {
        hh += '<tr><td>' + esc(productLabel(r.productId)) + '</td>' +
          '<td>' + (r.locationId ? esc(locationLabel(r.locationId)) : '店舗全体') + '</td>' +
          '<td>' + r.quantity + '</td><td>' + esc(r.reason) + '</td>' +
          '<td>' + (r.expiresAt ? fmtDateTime(r.expiresAt) : '-') + '</td>' +
          '<td><button class="btn small" data-rs-consume="' + r.id + '">消費する</button> ' +
          '<button class="btn small secondary" data-rs-release="' + r.id + '">解放</button></td></tr>';
      });
      hh += '</tbody></table></div>';
      box.innerHTML = hh;
      var consumeBtns = box.querySelectorAll('button[data-rs-consume]');
      for (var ci = 0; ci < consumeBtns.length; ci++) {
        consumeBtns[ci].onclick = function () {
          var rid = this.getAttribute('data-rs-consume');
          this.disabled = true;
          api('/api/v1/reservations/' + rid + '/consume', { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: {} })
            .then(function () {
              state.flash = '引当を消費しました。';
              loadReservations();
            })
            .catch(function (e) { el('rsMsg').innerHTML = msgHtml('error', errMsg(e)); loadReservations(); });
        };
      }
      var releaseBtns = box.querySelectorAll('button[data-rs-release]');
      for (var ri = 0; ri < releaseBtns.length; ri++) {
        releaseBtns[ri].onclick = function () {
          var rid2 = this.getAttribute('data-rs-release');
          api('/api/v1/reservations/' + rid2 + '/release', { method: 'POST', body: {} })
            .then(function () {
              state.flash = '引当を解放しました。';
              loadReservations();
            })
            .catch(function (e) { el('rsMsg').innerHTML = msgHtml('error', errMsg(e)); });
        };
      }
    }).catch(function (e) {
      var box = el('rsList');
      if (box) box.innerHTML = msgHtml('error', errMsg(e));
    });
  });
}

/* ---------------- picking (ピッキング + スキャン検品) ---------------- */
var pickOpenId = null;
var PICK_STATUS_LABELS = { open: ['検品中', 'badge-warn'], done: ['完了', 'badge-ok'], cancelled: ['取消', 'badge-danger'] };
function pickStatusBadge(st) {
  var def = PICK_STATUS_LABELS[st] || [st, ''];
  return '<span class="badge ' + def[1] + '">' + esc(def[0]) + '</span>';
}
function loadPicking() {
  viewLoading('ピッキング', 'list');
  ensureMaster().then(function (m) {
    if (state.masterError) {
      el('view').innerHTML = '<h2>ピッキング</h2>' + msgHtml('error', 'マスタの読み込みに失敗しました: ' + state.masterError);
      return;
    }
    var canCreate = can('movements.consume');
    var h = '<h2>ピッキング</h2><div id="pkMsg"></div>';
    if (state.flash) { h += msgHtml('success', state.flash); state.flash = ''; }
    if (canCreate) {
      h += '<div class="section-box"><h3>リストを作成</h3>' +
        '<form class="grid" id="pkForm">' +
        '<div><label>種別</label><select id="pkType"><option value="consume">消費</option>' +
        (can('movements.transfer') ? '<option value="transfer">移動</option>' : '') + '</select></div>' +
        '<div id="pkToWrap" style="display:none"><label>移動先 保管場所</label><select id="pkTo">' +
        optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '') + '</select></div>' +
        '</form>' +
        '<div id="pkItems"></div>' +
        '<p><button class="btn secondary" type="button" id="pkAddItem">明細を追加</button> ' +
        '<button class="btn" type="button" id="pkCreate">リストを作成</button></p></div>';
    }
    h += '<h3>リスト一覧</h3><div id="pkList">' + skeletonRows() + '</div><div id="pkDetail"></div>';
    el('view').innerHTML = h;

    function appendPickItemRow() {
      var box = el('pkItems');
      if (!box) return;
      var row = document.createElement('div');
      row.className = 'toolbar';
      row.innerHTML =
        '<div><label>商品</label><select data-pk-product>' +
        optionsHtml(m.products.filter(function (p) { return !p.isBundle; }), function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, '') + '</select></div>' +
        '<div><label>出発場所</label><select data-pk-from>' +
        optionsHtml(m.locations, function (l) { return l.id; }, function (l) { return locationLabel(l.id); }, '') + '</select></div>' +
        '<div><label>数量</label><input type="number" min="1" step="1" value="1" data-pk-qty></div>' +
        '<div><label>&nbsp;</label><button class="btn small danger" type="button" data-pk-remove>削除</button></div>';
      row.querySelector('[data-pk-remove]').onclick = function () { row.remove(); };
      box.appendChild(row);
    }
    var addBtn = el('pkAddItem');
    if (addBtn) { addBtn.onclick = appendPickItemRow; appendPickItemRow(); }
    var typeSel = el('pkType');
    if (typeSel) typeSel.onchange = function () {
      el('pkToWrap').style.display = typeSel.value === 'transfer' ? '' : 'none';
    };
    var createBtn = el('pkCreate');
    if (createBtn) createBtn.onclick = function () {
      var rows = el('pkItems').querySelectorAll('.toolbar');
      var items = [];
      for (var i = 0; i < rows.length; i++) {
        var qty = Number(rows[i].querySelector('[data-pk-qty]').value);
        if (qty > 0) {
          items.push({
            productId: Number(rows[i].querySelector('[data-pk-product]').value),
            fromLocationId: Number(rows[i].querySelector('[data-pk-from]').value),
            plannedQty: qty,
          });
        }
      }
      if (items.length === 0) { el('pkMsg').innerHTML = msgHtml('error', '明細を 1 件以上追加してください。'); return; }
      var body = { type: el('pkType').value, items: items };
      if (body.type === 'transfer') body.toLocationId = Number(el('pkTo').value);
      api('/api/v1/pick-lists', { method: 'POST', body: body })
        .then(function (created) {
          pickOpenId = created.id;
          state.flash = 'ピッキングリスト #' + created.id + ' を作成しました。';
          loadPicking();
        })
        .catch(function (e) { el('pkMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };

    api('/api/v1/pick-lists').then(function (lists) {
      var box = el('pkList');
      if (!box) return;
      if (!lists || lists.length === 0) {
        box.innerHTML = '<p class="muted">ピッキングリストがありません。</p>';
        return;
      }
      var hh = '<div class="table-wrap"><table><thead><tr><th>#</th><th>種別</th><th>状態</th><th>進捗</th><th>作成</th><th></th></tr></thead><tbody>';
      lists.forEach(function (l) {
        var planned = 0;
        var picked = 0;
        (l.items || []).forEach(function (it) { planned += it.plannedQty; picked += it.pickedQty; });
        hh += '<tr><td>#' + l.id + '</td><td>' + (l.type === 'transfer' ? '移動' : '消費') + '</td>' +
          '<td>' + pickStatusBadge(l.status) + '</td><td>' + picked + ' / ' + planned + '</td>' +
          '<td>' + fmtDateTime(l.createdAt) + '</td>' +
          '<td><button class="btn small" data-pk-open="' + l.id + '">' + (l.status === 'open' ? '検品' : '詳細') + '</button></td></tr>';
      });
      hh += '</tbody></table></div>';
      box.innerHTML = hh;
      var openBtns = box.querySelectorAll('button[data-pk-open]');
      for (var oi = 0; oi < openBtns.length; oi++) {
        openBtns[oi].onclick = function () {
          pickOpenId = Number(this.getAttribute('data-pk-open'));
          renderPickDetail();
        };
      }
      if (pickOpenId !== null) renderPickDetail();
    }).catch(function (e) {
      var box = el('pkList');
      if (box) box.innerHTML = msgHtml('error', errMsg(e));
    });

    function renderPickDetail() {
      var box = el('pkDetail');
      if (!box || pickOpenId === null) return;
      api('/api/v1/pick-lists/' + pickOpenId).then(function (l) {
        var isOpen = l.status === 'open';
        var editable = isOpen && can('movements.consume');
        var hh = '<div class="section-box"><h3>リスト #' + l.id + ' ' + (l.type === 'transfer' ? '移動' : '消費') + ' ' + pickStatusBadge(l.status) +
          (l.type === 'transfer' && l.toLocationId ? ' <span class="small muted">移動先: ' + esc(locationLabel(l.toLocationId)) + '</span>' : '') + '</h3>';
        hh += '<div id="pkDetailMsg"></div>';
        if (isOpen && scanSupported()) {
          hh += '<p><button class="btn" type="button" id="pkScan">スキャンで検品</button> ' +
            '<span class="small muted">バーコードを読み取るごとに該当行の実績が 1 増えます</span></p>';
        }
        hh += '<div class="table-wrap"><table><thead><tr><th>商品</th><th>出発場所</th><th>計画</th><th>実績</th><th>状態</th>' + (editable ? '<th></th>' : '') + '</tr></thead><tbody>';
        (l.items || []).forEach(function (it) {
          var done = it.pickedQty >= it.plannedQty;
          hh += '<tr><td>' + esc(productLabel(it.productId)) + '</td><td>' + esc(locationLabel(it.fromLocationId)) + '</td>' +
            '<td>' + (editable ? '<input type="number" min="0" step="1" value="' + it.plannedQty + '" id="pkp-' + it.id + '" style="width:5em">' : it.plannedQty) + '</td>' +
            '<td>' + (editable ? '<input type="number" min="0" step="1" value="' + it.pickedQty + '" id="pkk-' + it.id + '" style="width:5em">' : it.pickedQty) + '</td>' +
            '<td>' + (done ? '<span class="badge badge-ok">完了</span>' : '<span class="badge badge-warn">未達</span>') + '</td>' +
            (editable ? '<td><button class="btn small" data-pk-save="' + it.id + '">保存</button></td>' : '') + '</tr>';
        });
        hh += '</tbody></table></div>';
        if (isOpen && editable) {
          var allDone = (l.items || []).every(function (it) { return it.pickedQty >= it.plannedQty; });
          var anyPicked = (l.items || []).some(function (it) { return it.pickedQty > 0; });
          hh += '<p><button class="btn" type="button" id="pkConfirm"' + (allDone && anyPicked ? '' : ' disabled') + '>確定 (' + (l.type === 'transfer' ? '移動' : '消費') + 'を実行)</button> ' +
            '<button class="btn small danger" type="button" id="pkCancel">リストを取消</button></p>' +
            (allDone ? '' : '<p class="small muted">全行が計画数に達すると確定できます。未達の行は計画数を実績に合わせて保存してください。</p>');
        }
        hh += '</div>';
        box.innerHTML = hh;
        var scanBtn = el('pkScan');
        if (scanBtn) scanBtn.onclick = function () { openPickScanner(l); };
        var saveBtns = box.querySelectorAll('button[data-pk-save]');
        for (var si = 0; si < saveBtns.length; si++) {
          saveBtns[si].onclick = function () {
            var itemId = this.getAttribute('data-pk-save');
            var planned = Number(el('pkp-' + itemId).value);
            var picked = Number(el('pkk-' + itemId).value);
            api('/api/v1/pick-lists/' + l.id + '/items/' + itemId, { method: 'PUT', body: { plannedQty: planned, pickedQty: picked } })
              .then(function () { renderPickDetail(); })
              .catch(function (e) { el('pkDetailMsg').innerHTML = msgHtml('error', errMsg(e)); });
          };
        }
        var confirmBtn = el('pkConfirm');
        if (confirmBtn) confirmBtn.onclick = function () {
          confirmBtn.disabled = true;
          api('/api/v1/pick-lists/' + l.id + '/confirm', { method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: {} })
            .then(function () {
              state.flash = 'ピッキングリスト #' + l.id + ' を確定しました。';
              pickOpenId = null;
              loadPicking();
            })
            .catch(function (e) {
              el('pkDetailMsg').innerHTML = msgHtml('error', errMsg(e));
              confirmBtn.disabled = false;
            });
        };
        var cancelBtn = el('pkCancel');
        if (cancelBtn) cancelBtn.onclick = function () {
          if (!window.confirm('ピッキングリスト #' + l.id + ' を取り消しますか?')) return;
          api('/api/v1/pick-lists/' + l.id + '/cancel', { method: 'POST', body: {} })
            .then(function () {
              state.flash = 'ピッキングリスト #' + l.id + ' を取り消しました。';
              pickOpenId = null;
              loadPicking();
            })
            .catch(function (e) { el('pkDetailMsg').innerHTML = msgHtml('error', errMsg(e)); });
        };
      }).catch(function (e) {
        box.innerHTML = msgHtml('error', errMsg(e));
      });
    }

    /* 検品スキャン: 該当行の実績を +1 し、絶対値を直列化して保存する (棚卸しスキャンと同じ作法) */
    function openPickScanner(list) {
      var items = (list.items || []).map(function (it) {
        return { id: it.id, productId: it.productId, fromLocationId: it.fromLocationId, plannedQty: it.plannedQty, pickedQty: it.pickedQty };
      });
      var saveQueue = Promise.resolve();
      var saving = 0;
      var saveError = '';
      var sessionApi = null;
      function enqueueSave(item) {
        saving++;
        if (sessionApi) sessionApi.refreshPanel();
        var value = item.pickedQty;
        var planned = item.plannedQty;
        saveQueue = saveQueue.then(function () {
          return api('/api/v1/pick-lists/' + list.id + '/items/' + item.id, { method: 'PUT', body: { plannedQty: planned, pickedQty: value } })
            .then(function () { saveError = ''; })
            .catch(function (e) { saveError = errMsg(e); })
            .then(function () {
              saving--;
              if (sessionApi) sessionApi.refreshPanel();
            });
        });
      }
      function pickedTotal() {
        var t = 0;
        items.forEach(function (it) { t += it.pickedQty; });
        return t;
      }
      function plannedTotal() {
        var t = 0;
        items.forEach(function (it) { t += it.plannedQty; });
        return t;
      }
      openScanner({
        title: 'ピッキング検品 #' + list.id,
        continuous: true,
        registerReturn: null,
        onOpen: function (api_) { sessionApi = api_; },
        panelTitle: function () {
          return '検品 ' + pickedTotal() + ' / ' + plannedTotal();
        },
        syncHtml: function () {
          if (saveError) return '<span class="scan-sync error">保存エラー</span>';
          if (saving > 0) return '<span class="scan-sync saving">同期中…</span>';
          return '<span class="scan-sync">保存済み</span>';
        },
        renderPanel: function (sess) {
          var h = '<div class="scan-recent">';
          items.forEach(function (it) {
            var done = it.pickedQty >= it.plannedQty;
            h += '<div class="scan-recent-row"><span class="scan-recent-name">' + esc(productLabel(it.productId)) + ' (' + esc(locationLabel(it.fromLocationId)) + ')</span>' +
              '<span class="scan-recent-qty">' + it.pickedQty + ' / ' + it.plannedQty + (done ? ' 完了' : '') + '</span></div>';
          });
          return h + '</div>';
        },
        onCode: function (code, format, api_) {
          var p = productByBarcode(code);
          if (!p) return 'unknown';
          var target = null;
          var inList = false;
          for (var i = 0; i < items.length; i++) {
            if (items[i].productId !== p.id) continue;
            inList = true;
            if (items[i].pickedQty < items[i].plannedQty && !target) target = items[i];
          }
          if (!inList) {
            api_.setStatus('対象外: ' + p.sku + ' ' + p.name + ' はこのリストにありません');
            return 'out';
          }
          if (!target) {
            api_.setStatus('計画数に達しています: ' + p.sku + ' ' + p.name);
            return 'out';
          }
          target.pickedQty += 1;
          enqueueSave(target);
          var savedItem = target;
          api_.pushUndo(function () {
            savedItem.pickedQty = Math.max(0, savedItem.pickedQty - 1);
            enqueueSave(savedItem);
            api_.refreshPanel();
          });
          api_.refreshPanel();
          return 'ok';
        },
        onBeforeClose: function () { return saveQueue; },
        onClose: function () { renderPickDetail(); },
      });
    }
  });
}

/* ---------------- alerts ---------------- */
var ALERT_LABELS = { EXPIRED: '期限切れ', EXPIRING: '期限接近', LOW_STOCK: '在庫不足', NEGATIVE_STOCK: 'マイナス在庫' };
function loadAlerts() {
  viewLoading('アラート', 'list');
  ensureMaster().then(function () {
    getJson('/api/v1/alerts').then(function (rows) {
      if (!rows || rows.length === 0) {
        el('view').innerHTML = '<h2>アラート</h2><div class="mnt-form-note" id="mntNoteAlerts" style="display:none"></div><p class="muted">現在アラートはありません。</p>';
        setMaintFormNote('mntNoteAlerts', ['alerts'], []);
        return;
      }
      var order = ['EXPIRED', 'NEGATIVE_STOCK', 'EXPIRING', 'LOW_STOCK'];
      var h = '<h2>アラート</h2><div class="mnt-form-note" id="mntNoteAlerts" style="display:none"></div>';
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
      setMaintFormNote('mntNoteAlerts', ['alerts'], []);
    }).catch(function (e) {
      el('view').innerHTML = '<h2>アラート</h2>' + msgHtml('error', errMsg(e));
    });
  });
}

/* ---------------- purchases ---------------- */
var PO_STATUS_LABELS = { draft: ['下書き', ''], ordered: ['発注済み', 'badge-warn'], received: ['入荷完了', 'badge-ok'], cancelled: ['取消', 'badge-danger'], closed: ['残クローズ', 'badge-ok'] };
/* 直近の受入で生成された伝票 (検品写真を付ける導線用。renderPurchases が消費する) */
var lastReceivedMovements = [];
function poStatusBadge(st) {
  var def = PO_STATUS_LABELS[st] || [st, ''];
  return '<span class="badge ' + def[1] + '">' + esc(def[0]) + '</span>';
}
var CURRENCY_SYMBOLS = { JPY: '¥', USD: '$', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'C$', CNY: '¥', KRW: '₩', TWD: 'NT$', HKD: 'HK$', SGD: 'S$' };
function yen(n) {
  var cur = (state.me && state.me.settings && state.me.settings.currency) || 'JPY';
  var sym = CURRENCY_SYMBOLS[cur] || (cur + ' ');
  return sym + Number(n).toLocaleString('ja-JP');
}
function loadPurchases() {
  viewLoading('発注', 'list');
  ensureMaster().then(function (m) {
    return Promise.all([
      api('/api/v1/purchase-orders'),
      api('/api/v1/purchase-orders/suggestions').catch(function () { return []; }),
      api('/api/v1/purchase-order-templates').catch(function () { return []; }),
    ]).then(function (r) {
      renderPurchases(m, r[0] || [], r[1] || [], r[2] || []);
    });
  }).catch(function (e) {
    el('view').innerHTML = '<h2>発注</h2>' + msgHtml('error', errMsg(e));
  });
}
function appendPoLine(m, productId, quantity, unitCost, unitMode) {
  var box = el('poLines');
  if (!box) return;
  var row = document.createElement('div');
  row.className = 'toolbar';
  row.innerHTML =
    '<div><label>商品</label><select data-pol-product>' +
    optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, productId || '') + '</select></div>' +
    '<div><label>数量</label><input type="number" min="1" step="1" value="' + (quantity || 1) + '" data-pol-qty></div>' +
    '<div><label>単位</label><select data-pol-unit></select></div>' +
    '<div><label>単価 (円、任意)</label><input type="number" min="0" step="1" value="' + (unitCost === null || unitCost === undefined ? '' : unitCost) + '" data-pol-cost></div>' +
    '<div><label>&nbsp;</label><button class="btn small danger" type="button" data-pol-remove>削除</button></div>';
  row.querySelector('[data-pol-remove]').onclick = function () { row.remove(); };
  /* 入数がある商品は「個 / ケース」を選べる。ケースはサーバーで基本単位へ換算される */
  var prodSel = row.querySelector('[data-pol-product]');
  var unitSel = row.querySelector('[data-pol-unit]');
  var refreshUnit = function () {
    var p = productOf(Number(prodSel.value));
    var opts = '<option value="base">' + (p ? esc(p.unit) : '個') + '</option>';
    if (p && p.caseSize && p.caseSize > 1) opts += '<option value="case">ケース (×' + p.caseSize + ')</option>';
    unitSel.innerHTML = opts;
    if (unitMode === 'case' && p && p.caseSize && p.caseSize > 1) unitSel.value = 'case';
  };
  prodSel.onchange = refreshUnit;
  refreshUnit();
  box.appendChild(row);
}
function appendTplLine(m, productId, quantity) {
  var box = el('tplLines');
  if (!box) return;
  var row = document.createElement('div');
  row.className = 'toolbar';
  row.innerHTML =
    '<div><label>商品</label><select data-tpl-product>' +
    optionsHtml(m.products, function (p) { return p.id; }, function (p) { return p.sku + ' ' + p.name; }, productId || '') + '</select></div>' +
    '<div><label>数量</label><input type="number" min="1" step="1" value="' + (quantity || 1) + '" data-tpl-qty></div>' +
    '<div><label>&nbsp;</label><button class="btn small danger" type="button" data-tpl-remove>削除</button></div>';
  row.querySelector('[data-tpl-remove]').onclick = function () { row.remove(); };
  box.appendChild(row);
}
function renderPurchases(m, orders, suggestions, templates) {
  var writable = can('purchases.write');
  var h = '<h2>発注</h2><div class="mnt-form-note" id="mntNotePurchases" style="display:none"></div><div id="poMsg"></div>';
  if (state.flash) { h += msgHtml('success', state.flash); state.flash = ''; }

  if (lastReceivedMovements.length && can('movements.inbound')) {
    h += '<div class="section-box"><h3>入荷の検品写真</h3><div id="rcPhotoMsg"></div>';
    lastReceivedMovements.forEach(function (mv) {
      h += '<div class="toolbar"><div><span class="small">伝票 #' + mv.movementId + '</span></div>' +
        '<div><input type="file" accept="image/*" multiple data-rc-photo="' + mv.movementId + '"></div>' +
        '<div><button class="btn small" type="button" data-rc-photo-add="' + mv.movementId + '">写真を追加</button></div></div>';
    });
    h += '</div>';
  }
  lastReceivedMovements = [];

  h += '<div class="section-box"><h3>発注提案 (発注点を下回っている商品)</h3>';
  if (!suggestions.length) {
    h += '<p class="muted">提案はありません。</p>';
  } else {
    h += '<div class="table-wrap"><table><thead><tr><th>商品</th><th>実在庫</th><th>発注残</th><th>発注点</th><th>提案数量</th><th>内訳</th>' + (writable ? '<th></th>' : '') + '</tr></thead><tbody>';
    suggestions.forEach(function (s) {
      var prop = s.suggestedQuantity + (s.caseSize && s.suggestedCases ? ' (' + s.suggestedCases + 'ケース ×' + s.caseSize + ')' : '');
      h += '<tr><td>' + esc(productLabel(s.productId)) + '</td><td>' + s.onHand + '</td><td>' + s.onOrder + '</td>' +
        '<td>' + s.reorderPoint + '</td><td>' + prop + '</td>' +
        '<td class="small muted">平均日次 ' + s.avgDailyConsumption + ' / リードタイム ' + s.leadTimeDays + '日 / 安全在庫 ' + s.safetyStock + '</td>' +
        (writable ? '<td><button class="btn small" data-suggest="' + s.productId + '" data-qty="' + s.suggestedQuantity + '"' + (s.suggestedCases ? ' data-cases="' + s.suggestedCases + '"' : '') + '>発注書に追加</button></td>' : '') + '</tr>';
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

  /* 発注テンプレートと定期発注 (下書き生成のみ、自動発注はしない) */
  h += '<div class="section-box"><h3>発注テンプレート</h3><div id="tplMsg"></div>';
  if (!templates || templates.length === 0) {
    h += '<p class="muted">テンプレートがありません。</p>';
  }
  (templates || []).forEach(function (t) {
    var lineText = (t.lines || []).map(function (ln) { return esc(productLabel(ln.productId)) + ' ×' + (ln.quantity || ln.inputQuantity || 0); }).join('、');
    h += '<div class="section-box"><h4>' + esc(t.name) + ' <span class="small muted">' + esc(supplierOf(t.supplierId) ? supplierOf(t.supplierId).name : '仕入先#' + t.supplierId) + '</span></h4>' +
      '<p class="small muted">' + lineText + '</p>';
    if (t.schedule) {
      h += '<p class="small">定期: ' + t.schedule.intervalDays + ' 日ごと / ' + (t.schedule.enabled ? '有効' : '無効') +
        ' / 次回: ' + fmtDateTime(t.schedule.nextRunAt) + (t.schedule.lastRunAt ? ' / 前回: ' + fmtDateTime(t.schedule.lastRunAt) : '') + '</p>';
    } else {
      h += '<p class="small muted">定期: 未設定</p>';
    }
    if (writable) {
      h += '<p><button class="btn small" type="button" data-tpl-gen="' + t.id + '">下書きを生成</button> ' +
        '<button class="btn small danger" type="button" data-tpl-del="' + t.id + '">テンプレートを削除</button></p>' +
        '<div class="grid"><div><label>定期の間隔 (日)</label><input type="number" min="1" max="365" step="1" value="' + (t.schedule ? t.schedule.intervalDays : 7) + '" id="tplInt-' + t.id + '"></div>' +
        '<div><label>定期生成</label><select id="tplEn-' + t.id + '"><option value="1"' + (t.schedule && t.schedule.enabled ? ' selected' : '') + '>有効</option><option value="0"' + (t.schedule && !t.schedule.enabled ? ' selected' : '') + '>無効</option></select></div>' +
        '<div><label>&nbsp;</label><button class="btn small secondary" type="button" data-tpl-sched="' + t.id + '">定期設定を保存</button></div></div>';
    }
    h += '</div>';
  });
  if (writable) {
    h += '<h4>テンプレートを作成</h4>' +
      '<form class="grid" id="tplHeadForm">' +
      '<div><label>テンプレート名</label><input id="tplName" type="text" required></div>' +
      '<div><label>仕入先</label><select id="tplSupplier" required>' +
      optionsHtml(m.suppliers || [], function (s) { return s.id; }, function (s) { return s.name; }, '') + '</select></div>' +
      '</form>' +
      '<div id="tplLines"></div>' +
      '<p><button class="btn secondary" type="button" id="tplAddLine">明細を追加</button> ' +
      '<button class="btn" type="button" id="tplCreate">テンプレートを作成</button></p>';
  }
  h += '</div>';

  h += '<h3>発注書一覧</h3>';
  if (!orders.length) h += '<p class="muted">発注書がありません。</p>';
  orders.forEach(function (po) {
    var partial = po.status === 'ordered' && po.lines.some(function (ln) { return ln.receivedQuantity > 0; });
    var sourceBadge = po.source === 'schedule' ? ' <span class="badge">定期生成</span>' : (po.source === 'template' ? ' <span class="badge">テンプレート</span>' : '');
    h += '<div class="section-box"><h3>#' + po.id + ' ' + esc(po.supplierName || ('仕入先#' + po.supplierId)) + ' ' + poStatusBadge(po.status) + sourceBadge +
      (partial ? ' <span class="badge badge-warn">一部入荷</span>' : '') + (po.overdue ? ' <span class="badge badge-danger">納期超過</span>' : '') + '</h3>' +
      '<p class="small muted">作成: ' + fmtDateTime(po.createdAt) + (po.expectedDate ? ' / 納期: ' + esc(po.expectedDate) : '') + (po.note ? ' / メモ: ' + esc(po.note) : '') + '</p>';
    h += '<div class="table-wrap"><table><thead><tr><th>商品</th><th>発注数</th><th>入荷済み</th><th>残</th><th>入力</th><th>単価</th></tr></thead><tbody>';
    po.lines.forEach(function (ln) {
      var inputNote = ln.inputUnit === 'case' && ln.inputQuantity ? ln.inputQuantity + 'ケース (×' + Math.round(ln.quantity / ln.inputQuantity) + ')' : '-';
      h += '<tr><td>' + esc(productLabel(ln.productId)) + '</td><td>' + ln.quantity + '</td><td>' + ln.receivedQuantity + '</td><td>' + ln.remainingQuantity + '</td><td>' + inputNote + '</td><td>' +
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
    if (writable && (po.status === 'draft' || po.status === 'ordered') && po.lines.some(function (ln) { return ln.remainingQuantity > 0; })) {
      h += '<p><button class="btn small danger" type="button" data-close-po="' + po.id + '">残をクローズ</button> <span class="small muted">未入荷の残数量を打ち切って完了にします</span></p>';
    }
    h += '</div>';
  });
  el('view').innerHTML = h;
  setMaintFormNote('mntNotePurchases', ['purchase_orders'], ['#poSubmit', 'form[data-receive] button[type="submit"]', 'button[data-suggest]', '#tplCreate', 'button[data-tpl-gen]']);

  var tplAddBtn = el('tplAddLine');
  if (tplAddBtn) { tplAddBtn.onclick = function () { appendTplLine(m); }; appendTplLine(m); }
  var tplCreateBtn = el('tplCreate');
  if (tplCreateBtn) tplCreateBtn.onclick = function () {
    var rows = el('tplLines').querySelectorAll('.toolbar');
    var lines = [];
    for (var ti = 0; ti < rows.length; ti++) {
      var qty = Number(rows[ti].querySelector('[data-tpl-qty]').value);
      if (qty > 0) lines.push({ productId: Number(rows[ti].querySelector('[data-tpl-product]').value), quantity: qty });
    }
    if (!el('tplName').value) { el('tplMsg').innerHTML = msgHtml('error', 'テンプレート名を入力してください。'); return; }
    if (!el('tplSupplier').value) { el('tplMsg').innerHTML = msgHtml('error', '仕入先を選んでください。'); return; }
    if (lines.length === 0) { el('tplMsg').innerHTML = msgHtml('error', '明細を 1 件以上追加してください。'); return; }
    api('/api/v1/purchase-order-templates', { method: 'POST', body: { name: el('tplName').value, supplierId: Number(el('tplSupplier').value), lines: lines } })
      .then(function () {
        state.flash = 'テンプレートを作成しました。';
        loadPurchases();
      })
      .catch(function (e) { el('tplMsg').innerHTML = msgHtml('error', errMsg(e)); });
  };
  var tplGenBtns = el('view').querySelectorAll('button[data-tpl-gen]');
  for (var tg = 0; tg < tplGenBtns.length; tg++) {
    tplGenBtns[tg].onclick = function () {
      var tid = this.getAttribute('data-tpl-gen');
      api('/api/v1/purchase-order-templates/' + tid + '/generate', { method: 'POST', body: {} })
        .then(function (po) {
          state.flash = '下書きの発注書 #' + po.id + ' を生成しました。';
          loadPurchases();
        })
        .catch(function (e) { el('tplMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
  }
  var tplDelBtns = el('view').querySelectorAll('button[data-tpl-del]');
  for (var td = 0; td < tplDelBtns.length; td++) {
    tplDelBtns[td].onclick = function () {
      var tid2 = this.getAttribute('data-tpl-del');
      if (!window.confirm('テンプレートを削除しますか? (定期設定も削除されます)')) return;
      api('/api/v1/purchase-order-templates/' + tid2, { method: 'DELETE' })
        .then(function () {
          state.flash = 'テンプレートを削除しました。';
          loadPurchases();
        })
        .catch(function (e) { el('tplMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
  }
  var tplSchedBtns = el('view').querySelectorAll('button[data-tpl-sched]');
  for (var ts = 0; ts < tplSchedBtns.length; ts++) {
    tplSchedBtns[ts].onclick = function () {
      var tid3 = this.getAttribute('data-tpl-sched');
      var body = {
        intervalDays: Number(el('tplInt-' + tid3).value),
        enabled: el('tplEn-' + tid3).value === '1',
      };
      api('/api/v1/purchase-order-templates/' + tid3 + '/schedule', { method: 'PUT', body: body })
        .then(function () {
          state.flash = '定期設定を保存しました。';
          loadPurchases();
        })
        .catch(function (e) { el('tplMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
  }

  var sugs = el('view').querySelectorAll('button[data-suggest]');
  for (var si = 0; si < sugs.length; si++) {
    sugs[si].onclick = function () {
      var pid = Number(this.getAttribute('data-suggest'));
      var p = productOf(pid);
      var cases = this.getAttribute('data-cases');
      if (cases) appendPoLine(m, pid, Number(cases), p ? p.unitCost : null, 'case');
      else appendPoLine(m, pid, Number(this.getAttribute('data-qty')), p ? p.unitCost : null);
      var form = el('poHeadForm');
      if (form) form.scrollIntoView({ block: 'start' });
    };
  }
  var closeBtns = el('view').querySelectorAll('button[data-close-po]');
  for (var ci2 = 0; ci2 < closeBtns.length; ci2++) {
    closeBtns[ci2].onclick = function () {
      var poId = this.getAttribute('data-close-po');
      if (!window.confirm('残数量を打ち切って発注 #' + poId + ' を完了 (残クローズ) にします。よろしいですか?')) return;
      api('/api/v1/purchase-orders/' + poId + '/close-residual', { method: 'POST', body: {} })
        .then(function () {
          state.flash = '発注 #' + poId + ' の残をクローズしました。';
          loadPurchases();
        })
        .catch(function (e) { el('poMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
  }
  var photoBtns = el('view').querySelectorAll('button[data-rc-photo-add]');
  for (var pi = 0; pi < photoBtns.length; pi++) {
    photoBtns[pi].onclick = function () {
      var mid = Number(this.getAttribute('data-rc-photo-add'));
      var input = el('view').querySelector('input[data-rc-photo="' + mid + '"]');
      var files = input && input.files;
      if (!files || files.length === 0) {
        el('rcPhotoMsg').innerHTML = msgHtml('error', '写真ファイルを選んでください。');
        return;
      }
      el('rcPhotoMsg').innerHTML = msgHtml('info', 'アップロード中…');
      var chain = Promise.resolve();
      for (var fi2 = 0; fi2 < files.length; fi2++) {
        (function (file) { chain = chain.then(function () { return uploadMovementPhoto(mid, file); }); })(files[fi2]);
      }
      var btn = this;
      chain.then(function () {
        btn.disabled = true;
        el('rcPhotoMsg').innerHTML = msgHtml('success', '写真を追加しました (履歴の写真ボタンから確認できます)。');
      }).catch(function (e) { el('rcPhotoMsg').innerHTML = msgHtml('error', errMsg(e)); });
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
      var qtyVal = Number(rows[i].querySelector('[data-pol-qty]').value);
      var unitSel = rows[i].querySelector('[data-pol-unit]');
      var line;
      if (unitSel && unitSel.value === 'case') {
        line = { productId: Number(rows[i].querySelector('[data-pol-product]').value), inputQuantity: qtyVal, inputUnit: 'case' };
      } else {
        line = { productId: Number(rows[i].querySelector('[data-pol-product]').value), quantity: qtyVal };
      }
      var cost = rows[i].querySelector('[data-pol-cost]').value;
      if (cost !== '') line.unitCost = Number(cost);
      if (qtyVal > 0) lines.push(line);
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
          lastReceivedMovements = r.receivedMovements || [];
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
    var h = '<h2>分析レポート</h2><div class="mnt-form-note" id="mntNoteAnalytics" style="display:none"></div>';
    h += '<div class="cards">' +
      '<div class="card"><div class="num">' + yen(r.valuation.totalValue) + '</div><div class="lbl">在庫評価額 (単価設定分)</div></div>' +
      '<div class="card"><div class="num">' + Math.round(r.valuation.coverageRate * 100) + '%</div><div class="lbl">単価設定済み (' + r.valuation.pricedProducts + ' / ' + r.valuation.totalProducts + ' 商品)</div></div>' +
      '<div class="card"><div class="num' + (r.deadStock.length > 0 ? ' qty-neg' : '') + '">' + r.deadStock.length + '</div><div class="lbl">滞留在庫 (最終移動から90日超)</div></div>' +
      (r.disposal ? '<div class="card"><div class="num">' + r.disposal.quantity + '</div><div class="lbl">廃棄数量 (直近6ヶ月、評価額 ' + yen(r.disposal.value) + ')</div></div>' : '') +
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
    setMaintFormNote('mntNoteAnalytics', ['analytics'], []);
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
        (a.actorId === null || a.actorId === undefined ? '-' : a.actorId) + '</td><td>' + esc(a.action) + '</td><td>' +
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
/* ---------------- パスキー (WebAuthn / Face ID) と再認証 ---------------- */
function b64urlToBuf(s) {
  var b = String(s).split('-').join('+').split('_').join('/');
  while (b.length % 4) b += '=';
  var bin = atob(b);
  var u = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
function bufToB64url(buf) {
  var u = new Uint8Array(buf);
  var s = '';
  for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  s = btoa(s).split('+').join('-').split('/').join('_');
  while (s.charAt(s.length - 1) === '=') s = s.slice(0, -1);
  return s;
}
function passkeySupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.get && navigator.credentials.create);
}
function uaShortLabel(ua) {
  var s = String(ua || '');
  var os = '端末';
  if (s.indexOf('iPhone') >= 0) os = 'iPhone';
  else if (s.indexOf('iPad') >= 0) os = 'iPad';
  else if (s.indexOf('Android') >= 0) os = 'Android';
  else if (s.indexOf('Macintosh') >= 0 || s.indexOf('Mac OS') >= 0) os = 'Mac';
  else if (s.indexOf('Windows') >= 0) os = 'Windows';
  else if (s.indexOf('Linux') >= 0) os = 'Linux';
  var br = '';
  if (s.indexOf('Edg') >= 0) br = 'Edge';
  else if (s.indexOf('Chrome') >= 0 || s.indexOf('CriOS') >= 0) br = 'Chrome';
  else if (s.indexOf('Firefox') >= 0 || s.indexOf('FxiOS') >= 0) br = 'Firefox';
  else if (s.indexOf('Safari') >= 0) br = 'Safari';
  return br ? os + ' ' + br : os;
}
function assertionBody(cred) {
  var r = cred.response;
  return {
    credentialId: cred.id,
    authenticatorData: bufToB64url(r.authenticatorData),
    clientDataJSON: bufToB64url(r.clientDataJSON),
    signature: bufToB64url(r.signature),
  };
}
function getPasskeyAssertion(opts) {
  return navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBuf(opts.challenge),
      rpId: opts.rpId,
      userVerification: opts.userVerification || 'required',
      timeout: opts.timeout,
    },
  });
}
/* ログインページの「Face IDでログイン」 */
function passkeyLogin() {
  var msg = el('passkeyLoginMsg');
  var hint = el('passkeyLoginHint');
  function fail(text) {
    if (msg) { msg.textContent = text; msg.style.display = ''; }
    if (hint) hint.style.display = '';
  }
  if (!passkeySupported()) { fail('この端末ではパスキーを使えません'); return; }
  if (msg) msg.style.display = 'none';
  if (hint) hint.style.display = 'none';
  apiOnce('/api/v1/auth/passkey/login/options', { method: 'POST', body: {} }).then(function (opts) {
    return getPasskeyAssertion(opts);
  }).then(function (cred) {
    if (!cred) { fail('キャンセルされました'); return null; }
    return apiOnce('/api/v1/auth/passkey/login/verify', { method: 'POST', body: assertionBody(cred) });
  }).then(function (res) {
    if (res) location.reload();
  }).catch(function (e) {
    if (e && e.name === 'NotAllowedError') { fail('キャンセルされました'); return; }
    if (e && e.status === 503 && e.code === 'MAINTENANCE') { if (msg) { msg.textContent = e.message; msg.style.display = ''; } return; }
    fail('ログインできませんでした');
  });
}
/* パスキー登録 (セキュリティ画面) */
function doPasskeyRegister() {
  var msg = el('passkeyMsg');
  function fail(t) { if (msg) msg.innerHTML = msgHtml('error', t); }
  if (!passkeySupported()) { fail('この端末ではパスキーを使えません'); return; }
  if (msg) msg.innerHTML = '';
  api('/api/v1/auth/passkey/register/options', { method: 'POST', body: {} }).then(function (opts) {
    return navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBuf(opts.challenge),
        rp: opts.rp,
        user: { id: b64urlToBuf(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
        pubKeyCredParams: opts.pubKeyCredParams,
        timeout: opts.timeout,
        attestation: opts.attestation,
        authenticatorSelection: opts.authenticatorSelection,
        excludeCredentials: (opts.excludeCredentials || []).map(function (x) {
          return { type: x.type, id: b64urlToBuf(x.id), transports: x.transports };
        }),
      },
    });
  }).then(function (cred) {
    if (!cred) { fail('キャンセルされました'); return null; }
    var r = cred.response;
    return api('/api/v1/auth/passkey/register/verify', {
      method: 'POST',
      body: {
        credentialId: cred.id,
        attestationObject: bufToB64url(r.attestationObject),
        clientDataJSON: bufToB64url(r.clientDataJSON),
        transports: r.getTransports ? r.getTransports() : [],
      },
    });
  }).then(function (res) {
    if (res) loadSecurity();
  }).catch(function (e) {
    if (e && e.name === 'NotAllowedError') { fail('キャンセルされました'); return; }
    fail('登録できませんでした');
  });
}
/* ---- 再認証 (ステップアップ) ---- */
var stepUpWaiters = [];
function requestStepUp() {
  return new Promise(function (resolve, reject) {
    stepUpWaiters.push({ resolve: resolve, reject: reject });
    renderStepUpSheet();
  });
}
function settleStepUp(ok) {
  var ws = stepUpWaiters;
  stepUpWaiters = [];
  closeSheet();
  for (var i = 0; i < ws.length; i++) {
    if (ok) ws[i].resolve();
    else {
      var ce = new Error('step up cancelled');
      ce.code = 'STEP_UP_CANCELLED';
      ws[i].reject(ce);
    }
  }
}
function renderStepUpSheet() {
  var h = '<div class="sheet-title">本人確認</div>';
  h += '<p class="muted" style="padding:0 4px">この操作には再認証が必要です。</p>';
  if (passkeySupported()) {
    h += '<button class="sheet-row" id="stepUpPasskeyBtn"><span class="row-icon" style="background:#636366">' + icon('shield', 18) + '</span><span class="row-label">Face IDで認証</span></button>';
  }
  h += '<a class="sheet-row" href="/auth/login?stepup=1"><span class="row-icon" style="background:#0071e3">' + icon('shield', 18) + '</span><span class="row-label">Google で再ログイン</span></a>';
  h += '<p class="small danger" id="stepUpMsg" style="display:none"></p>';
  el('sheetBox').innerHTML = h;
  el('sheetOverlay').style.display = '';
  var b = el('stepUpPasskeyBtn');
  if (b) b.onclick = doPasskeyStepUp;
}
function doPasskeyStepUp() {
  var msg = el('stepUpMsg');
  function fail() { if (msg) { msg.textContent = '認証できませんでした'; msg.style.display = ''; } }
  apiOnce('/api/v1/auth/passkey/step-up/options', { method: 'POST', body: {} }).then(function (opts) {
    return getPasskeyAssertion(opts);
  }).then(function (cred) {
    if (!cred) { fail(); return null; }
    return apiOnce('/api/v1/auth/step-up/passkey', { method: 'POST', body: assertionBody(cred) });
  }).then(function (res) {
    if (res) settleStepUp(true);
  }).catch(function (e) {
    if (e && e.name === 'NotAllowedError') return;
    fail();
  });
}
/* ---- セキュリティ画面 (その他タブ) ---- */
/* ---------------- 店舗設定 (0020) ---------------- */
var STORE_CURRENCIES = ['JPY', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CNY', 'KRW', 'TWD', 'HKD', 'SGD'];
var STORE_TIMEZONES = ['Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Taipei', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Kolkata', 'UTC', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Australia/Sydney', 'Pacific/Auckland'];
function ssFail(e) { el('ssMsg').innerHTML = msgHtml('error', errMsg(e)); }
function namedMasterSectionHtml(title, kind, rows, canEdit, hasActive) {
  var h = '<div class="section-box"><h3>' + title + '</h3>';
  if (!rows.length) h += '<p class="muted">未登録です。</p>';
  rows.forEach(function (row) {
    h += '<div class="group-row" style="display:block"><div><span class="row-label">' + esc(row.name) +
      (row.productCount !== undefined && row.productCount !== null ? ' <span class="small muted">' + row.productCount + ' 商品</span>' : '') +
      (hasActive && !row.isActive ? ' <span class="badge">無効</span>' : '') + '</span></div>';
    if (canEdit) {
      h += '<div style="margin-top:0.45rem">' +
        '<button class="btn small secondary" type="button" data-ss-edit="' + kind + '" data-ss-id="' + row.id + '" data-ss-name="' + esc(row.name) + '">名前を変更</button> ' +
        (hasActive ? '<button class="btn small secondary" type="button" data-ss-toggle="' + kind + '" data-ss-id="' + row.id + '" data-ss-active="' + (row.isActive ? '1' : '0') + '">' + (row.isActive ? '無効にする' : '有効にする') + '</button> ' : '') +
        '<button class="btn small danger" type="button" data-ss-del="' + kind + '" data-ss-id="' + row.id + '">削除</button></div>';
    }
    h += '</div>';
  });
  if (canEdit) {
    h += '<form class="grid" data-ss-add="' + kind + '"><div><label>名前</label><input data-ss-name-input required maxlength="100"></div>' +
      '<div><label>&nbsp;</label><button class="btn" type="submit">追加</button></div></form>';
  }
  return h + '</div>';
}
function reasonSectionHtml(title, kind, rows, canEdit) {
  var h = '<div class="section-box"><h3>' + title + '</h3>';
  if (!rows.length) h += '<p class="muted">未登録です。</p>';
  rows.forEach(function (row) {
    h += '<div class="group-row" style="display:block"><div><span class="row-label">' + esc(row.label) +
      ' <span class="small muted">' + esc(row.code) + '</span>' +
      (!row.isActive ? ' <span class="badge">無効</span>' : '') + '</span></div>';
    if (canEdit) {
      h += '<div style="margin-top:0.45rem">' +
        '<button class="btn small secondary" type="button" data-ss-redit="' + kind + '" data-ss-id="' + row.id + '" data-ss-name="' + esc(row.label) + '">表示名を変更</button> ' +
        '<button class="btn small secondary" type="button" data-ss-rtoggle="' + kind + '" data-ss-id="' + row.id + '" data-ss-active="' + (row.isActive ? '1' : '0') + '">' + (row.isActive ? '無効にする' : '有効にする') + '</button> ' +
        '<button class="btn small danger" type="button" data-ss-rdel="' + kind + '" data-ss-id="' + row.id + '">削除</button></div>';
    }
    h += '</div>';
  });
  if (canEdit) {
    h += '<form class="grid" data-ss-radd="' + kind + '"><div><label>コード (英小文字・数字・_・-)</label><input data-ss-code-input required maxlength="64"></div>' +
      '<div><label>表示名</label><input data-ss-label-input required maxlength="50"></div>' +
      '<div><label>&nbsp;</label><button class="btn" type="submit">追加</button></div></form>';
  }
  return h + '</div>';
}
function loadStoreSettings() {
  viewLoading('店舗設定');
  var canEdit = can('master.write');
  Promise.all([
    api('/api/v1/settings'),
    api('/api/v1/master/reason-codes?kind=return&all=1').catch(function () { return []; }),
    api('/api/v1/master/reason-codes?kind=disposal&all=1').catch(function () { return []; }),
    api('/api/v1/master/departments?all=1').catch(function () { return []; }),
    api('/api/v1/master/categories').catch(function () { return []; }),
  ]).then(function (r) {
    var settings = r[0];
    var h = '<h2>店舗設定</h2><div id="ssMsg"></div>';
    if (state.flash) { h += msgHtml('success', state.flash); state.flash = ''; }
    h += '<div class="section-box"><h3>基本設定</h3><form class="grid" id="ssBasicForm">' +
      '<div><label>通貨</label><select id="ssCurrency"' + (canEdit ? '' : ' disabled') + '>' +
      STORE_CURRENCIES.map(function (cur) { return '<option value="' + cur + '"' + (settings.currency === cur ? ' selected' : '') + '>' + cur + '</option>'; }).join('') + '</select></div>' +
      '<div><label>タイムゾーン</label><select id="ssTimezone"' + (canEdit ? '' : ' disabled') + '>' +
      STORE_TIMEZONES.map(function (tz) { return '<option value="' + tz + '"' + (settings.timezone === tz ? ' selected' : '') + '>' + tz + '</option>'; }).join('') +
      (STORE_TIMEZONES.indexOf(settings.timezone) < 0 ? '<option value="' + esc(settings.timezone) + '" selected>' + esc(settings.timezone) + '</option>' : '') + '</select></div>' +
      (canEdit ? '<div><label>&nbsp;</label><button class="btn" type="submit">保存</button></div>' : '') +
      '</form>' + (canEdit ? '' : '<p class="small muted">編集にはマスタ編集の権限が必要です。</p>') + '</div>';
    h += namedMasterSectionHtml('商品カテゴリ', 'categories', r[4], canEdit, false);
    h += namedMasterSectionHtml('部門 (消費の部署)', 'departments', r[3], canEdit, true);
    h += reasonSectionHtml('返品の理由', 'return', r[1], canEdit);
    h += reasonSectionHtml('廃棄の理由', 'disposal', r[2], canEdit);
    el('view').innerHTML = h;

    var basic = el('ssBasicForm');
    if (basic && canEdit) {
      basic.onsubmit = function (ev) {
        ev.preventDefault();
        api('/api/v1/settings', { method: 'PUT', body: { currency: el('ssCurrency').value, timezone: el('ssTimezone').value } })
          .then(function (s) {
            if (state.me) state.me.settings = s;
            state.flash = '店舗設定を保存しました。';
            loadStoreSettings();
          })
          .catch(ssFail);
      };
    }
    function afterMaster(kind) {
      state.masterExtras = null;
      if (kind === 'categories') state.master = null;
      state.flash = '保存しました。';
      loadStoreSettings();
    }
    function bindAll(selector, handler) {
      var nodes = el('view').querySelectorAll(selector);
      for (var i = 0; i < nodes.length; i++) handler(nodes[i]);
    }
    var NAMED_PATH = { categories: '/api/v1/master/categories', departments: '/api/v1/master/departments' };
    bindAll('form[data-ss-add]', function (f) {
      f.onsubmit = function (ev) {
        ev.preventDefault();
        var kind = f.getAttribute('data-ss-add');
        var input = f.querySelector('[data-ss-name-input]');
        api(NAMED_PATH[kind], { method: 'POST', body: { name: input.value } })
          .then(function () { afterMaster(kind); })
          .catch(ssFail);
      };
    });
    bindAll('button[data-ss-edit]', function (b) {
      b.onclick = function () {
        var kind = b.getAttribute('data-ss-edit');
        var name = window.prompt('新しい名前', b.getAttribute('data-ss-name') || '');
        if (!name) return;
        api(NAMED_PATH[kind] + '/' + b.getAttribute('data-ss-id'), { method: 'PUT', body: { name: name } })
          .then(function () { afterMaster(kind); })
          .catch(ssFail);
      };
    });
    bindAll('button[data-ss-toggle]', function (b) {
      b.onclick = function () {
        var kind = b.getAttribute('data-ss-toggle');
        api(NAMED_PATH[kind] + '/' + b.getAttribute('data-ss-id'), { method: 'PUT', body: { isActive: b.getAttribute('data-ss-active') !== '1' } })
          .then(function () { afterMaster(kind); })
          .catch(ssFail);
      };
    });
    bindAll('button[data-ss-del]', function (b) {
      b.onclick = function () {
        if (!window.confirm('削除しますか?')) return;
        var kind = b.getAttribute('data-ss-del');
        api(NAMED_PATH[kind] + '/' + b.getAttribute('data-ss-id'), { method: 'DELETE' })
          .then(function () { afterMaster(kind); })
          .catch(ssFail);
      };
    });
    bindAll('form[data-ss-radd]', function (f) {
      f.onsubmit = function (ev) {
        ev.preventDefault();
        var kind = f.getAttribute('data-ss-radd');
        api('/api/v1/master/reason-codes', {
          method: 'POST',
          body: { kind: kind, code: f.querySelector('[data-ss-code-input]').value, label: f.querySelector('[data-ss-label-input]').value },
        })
          .then(function () { afterMaster('reason'); })
          .catch(ssFail);
      };
    });
    bindAll('button[data-ss-redit]', function (b) {
      b.onclick = function () {
        var label = window.prompt('新しい表示名', b.getAttribute('data-ss-name') || '');
        if (!label) return;
        api('/api/v1/master/reason-codes/' + b.getAttribute('data-ss-id'), { method: 'PUT', body: { label: label } })
          .then(function () { afterMaster('reason'); })
          .catch(ssFail);
      };
    });
    bindAll('button[data-ss-rtoggle]', function (b) {
      b.onclick = function () {
        api('/api/v1/master/reason-codes/' + b.getAttribute('data-ss-id'), { method: 'PUT', body: { isActive: b.getAttribute('data-ss-active') !== '1' } })
          .then(function () { afterMaster('reason'); })
          .catch(ssFail);
      };
    });
    bindAll('button[data-ss-rdel]', function (b) {
      b.onclick = function () {
        if (!window.confirm('削除しますか? (過去の履歴の表示には影響しません)')) return;
        api('/api/v1/master/reason-codes/' + b.getAttribute('data-ss-id'), { method: 'DELETE' })
          .then(function () { afterMaster('reason'); })
          .catch(ssFail);
      };
    });
  }).catch(function (e) {
    el('view').innerHTML = '<h2>店舗設定</h2>' + msgHtml('error', errMsg(e));
  });
}

function loadSecurity() {
  viewLoading('セキュリティ');
  Promise.all([
    api('/api/v1/auth/passkey/credentials').catch(function () { return null; }),
    api('/api/v1/auth/sessions').catch(function () { return null; }),
    api('/api/v1/auth/login-events').catch(function () { return null; }),
  ]).then(function (r) {
    renderSecurity(r[0], r[1], r[2]);
  });
}
function renderSecurity(creds, sessions, events) {
  var h = '<h2>セキュリティ</h2>';
  /* パスキー */
  h += '<h3>パスキー</h3>';
  h += '<p class="small muted">' + (passkeySupported() ? 'この端末で使えます' : 'この端末では使えません') + '</p>';
  h += '<div id="passkeyMsg"></div>';
  h += '<div class="group">';
  var list = creds || [];
  if (!creds) {
    h += '<div class="group-row static"><span class="row-label muted">読み込めませんでした</span></div>';
  } else if (list.length === 0) {
    h += '<div class="group-row static"><span class="row-label muted">登録済みのパスキーはありません</span></div>';
  } else {
    for (var i = 0; i < list.length; i++) {
      var pk = list[i];
      h += '<div class="group-row static"><span class="row-label">' + esc(pk.label || 'パスキー') +
        '<br><span class="small muted">登録: ' + fmtDateTime(pk.createdAt) + ' / 最終利用: ' + (pk.lastUsedAt ? fmtDateTime(pk.lastUsedAt) : '未使用') + '</span></span>' +
        '<button class="btn small danger" data-del-passkey="' + pk.id + '">削除</button></div>';
    }
  }
  h += '</div>';
  h += '<p><button class="btn" id="passkeyRegisterBtn"' + (passkeySupported() ? '' : ' disabled') + '>パスキーを登録</button></p>';
  /* セッション */
  h += '<h3>セッション</h3><div class="group">';
  var ss = sessions || [];
  if (!sessions) {
    h += '<div class="group-row static"><span class="row-label muted">読み込めませんでした</span></div>';
  } else if (ss.length === 0) {
    h += '<div class="group-row static"><span class="row-label muted">セッションはありません</span></div>';
  } else {
    for (var j = 0; j < ss.length; j++) {
      var s = ss[j];
      h += '<div class="group-row static"><span class="row-label">' + esc(uaShortLabel(s.userAgent)) +
        (s.current ? ' <span class="badge">現在のセッション</span>' : '') +
        '<br><span class="small muted">作成: ' + fmtDateTime(s.createdAt) + ' / 最終利用: ' + fmtDateTime(s.lastSeenAt || s.createdAt) + (s.ip ? ' / IP: ' + esc(s.ip) : '') + '</span></span>' +
        (s.current ? '' : '<button class="btn small secondary" data-revoke-session="' + s.id + '">失効</button>') + '</div>';
    }
  }
  h += '</div>';
  /* ログイン履歴 */
  h += '<h3>ログイン履歴</h3><div class="group">';
  var evs = events || [];
  if (!events) {
    h += '<div class="group-row static"><span class="row-label muted">読み込めませんでした</span></div>';
  } else if (evs.length === 0) {
    h += '<div class="group-row static"><span class="row-label muted">履歴はありません</span></div>';
  } else {
    for (var k = 0; k < evs.length; k++) {
      var ev = evs[k];
      h += '<div class="group-row static"><span class="row-label">' + (ev.method === 'passkey' ? 'パスキー' : 'Google') + ' / ' + esc(ev.deviceLabel || uaShortLabel(ev.userAgent)) +
        '<br><span class="small muted">' + fmtDateTime(ev.createdAt) + (ev.ip ? ' / IP: ' + esc(ev.ip) : '') + '</span></span></div>';
    }
  }
  h += '</div>';
  el('view').innerHTML = h;
  var reg = el('passkeyRegisterBtn');
  if (reg) reg.onclick = doPasskeyRegister;
  var dels = el('view').querySelectorAll('button[data-del-passkey]');
  for (var d = 0; d < dels.length; d++) {
    dels[d].onclick = function () {
      var id = this.getAttribute('data-del-passkey');
      api('/api/v1/auth/passkey/credentials/' + id, { method: 'DELETE' }).then(function () { loadSecurity(); })
        .catch(function (e) { el('passkeyMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
  }
  var revs = el('view').querySelectorAll('button[data-revoke-session]');
  for (var v = 0; v < revs.length; v++) {
    revs[v].onclick = function () {
      var id = this.getAttribute('data-revoke-session');
      api('/api/v1/auth/sessions/' + id, { method: 'DELETE' }).then(function () { loadSecurity(); })
        .catch(function (e) { el('passkeyMsg').innerHTML = msgHtml('error', errMsg(e)); });
    };
  }
}

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
    if (applyMaintenance(me.maintenance)) return;
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
    /* Web Push 用 Service Worker を登録する (未対応ブラウザでは何もしない) */
    if ('serviceWorker' in navigator) {
      try { navigator.serviceWorker.register('/sw.js').catch(function () {}); } catch (e) {}
    }
    /* お知らせの未読数を先読みしてドックのバッジに反映する */
    if (feat('announcements')) {
      getJson('/api/v1/announcements').then(function (d) {
        state.annUnread = d.unreadCount || 0;
        buildNav();
      }).catch(function () {});
    }
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
    el('loginBox').style.display = 'none';
    el('noAssignBox').style.display = 'none';
    el('errorBox').style.display = 'none';
    if (err && err.status === 401) el('loginBox').style.display = '';
    else if (err && err.status === 403) el('noAssignBox').style.display = '';
    else el('errorBox').style.display = '';
  });
  var retryBtn = el('bootRetryBtn');
  if (retryBtn) {
    retryBtn.onclick = function () {
      el('errorBox').style.display = 'none';
      el('loadingBox').style.display = '';
      boot();
    };
  }
  var pkLoginBtn = el('passkeyLoginBtn');
  if (pkLoginBtn) {
    /* パスキー非対応の端末ではボタンを出さない (Google ログインのみ) */
    if (!passkeySupported()) pkLoginBtn.style.display = 'none';
    pkLoginBtn.onclick = passkeyLogin;
  }
}
document.addEventListener('DOMContentLoaded', boot);
`;
