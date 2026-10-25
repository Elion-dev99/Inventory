import { APP_CSS } from '../../workers/src/app/styles';

/**
 * 全体管理コンソール画面 (GET /)。
 * 左サイドバー + 6 セクション (概要 / 店舗 / ユーザー / 監査 / お知らせ / システム) の
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
.console-main input, .console-main select, .console-main textarea { max-width: 100%; }
.feed-row { padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
.feed-row:last-child { border-bottom: 0; }
.detail-box { margin-top: 1.5rem; }
.user-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.6rem; }
/* メンテナンスの対象機能は 1機能=1行 + セグメントコントロールで選ぶ
   (チップ+select は狭幅で重なるため廃止。色は単色のみ、発光・グラデーションなし) */
.mnt-feat-block { padding: 0.35rem 1rem; border-bottom: 1px solid var(--line); }
.mnt-feat-row { padding: 0.55rem 0; border-bottom: 1px solid var(--line); }
.mnt-feat-row:last-child { border-bottom: 0; }
.mnt-feat-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 0.45rem; }
.mnt-feat-name { font-weight: 600; }
.mnt-feat-state { font-size: 0.82rem; color: var(--muted); white-space: nowrap; }
.mnt-feat-state.stage-write { color: var(--warn); }
.mnt-feat-state.stage-full { color: var(--danger); }
.mnt-seg { display: flex; gap: 2px; padding: 2px; background: var(--control); border-radius: var(--r-sm); }
.mnt-seg button { flex: 1 1 0; min-width: 0; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 0.9rem; font-weight: 600; padding: 0.45rem 0.2rem; border-radius: 8px; cursor: pointer; white-space: nowrap; }
.mnt-seg button.sel { background: var(--surface); color: var(--fg); box-shadow: var(--shadow); }
.mnt-seg button.sel.stage-write { background: var(--warn-bg); color: var(--warn); }
.mnt-seg button.sel.stage-full { background: var(--danger-bg); color: var(--danger); }
/* プリセットはピル状チップのまま (中身はボタンだけなので重ならない) */
.mnt-preset-row { flex-wrap: wrap; }
.mnt-preset-chip { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.42rem 0.75rem; border: 1px solid var(--line-strong); border-radius: 980px; background: var(--surface-2); color: var(--fg); font-size: 0.92rem; white-space: nowrap; }
.mnt-preset-del { border: 0; background: transparent; color: var(--danger); cursor: pointer; font: inherit; padding: 0 0.1rem; }
/* 利用量の容量バー (単色のみ) */
.usage-bar { height: 8px; background: var(--control); border-radius: 4px; overflow: hidden; margin: 0.4rem 0; }
.usage-bar > div { height: 100%; background: var(--accent); }
/* 再認証 (ステップアップ) のオーバーレイ。色は単色のみ */
.stepup-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 60; }
.stepup-box { max-width: 24rem; margin: 14vh auto 0; background: var(--surface); border-radius: var(--r-md); box-shadow: var(--shadow); padding: 1.2rem 1.4rem; }
.stepup-box h3 { margin-top: 0; }
/* 中幅以下ではフォーム行を 1 カラムに積み、コントロールを全幅にする
   (.group-row は折り返しなしの flex のため、狭幅ではラベルが潰れ入力欄がはみ出す) */
@media (max-width: 900px) {
  .console-main .group-row.static { flex-direction: column; align-items: stretch; gap: 0.6rem; }
  .console-main .group-row.static > label { display: block; }
  .console-main .group-row.static > label > input,
  .console-main .group-row.static > label > select { display: block; width: 100%; margin-top: 0.3rem; }
  .console-main .group-row.static > input,
  .console-main .group-row.static > select,
  .console-main .group-row.static > textarea { width: 100% !important; flex: none !important; }
  .console-main .group-row.static > .btn { align-self: flex-start; }
}
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
    <button class="side-btn" data-sec="orgs">組織・プラン</button>
    <button class="side-btn" data-sec="users">ユーザー</button>
    <button class="side-btn" data-sec="audit">監査</button>
    <button class="side-btn" data-sec="announce">お知らせ</button>
    <button class="side-btn" data-sec="system">システム</button>
  </aside>
  <main class="console-main">
<p id="status" style="color: var(--ok);"></p>
<p id="error" style="color: var(--danger); white-space: pre-wrap;"></p>
<div id="loginGuide" class="section-box" style="display:none;">
  <p>ログインが必要です（セッションの有効期限は2時間です）。全体管理者だけがログインできます。</p>
  <p><a class="btn" href="/auth/login">Google でログインする</a>
  <button class="btn secondary" id="passkeyLoginBtn" style="display:none;">Face IDでログイン</button></p>
  <p class="small" id="passkeyLoginMsg" style="display:none; color: var(--danger);"></p>
  <p class="small muted" id="passkeyLoginHint" style="display:none;">このサイト用のパスキーが未登録の場合は、先に Google でログインして「システム」のセキュリティから登録してください。</p>
  <p class="small muted">パスキーはホストごとに登録が必要です。店舗アプリで登録したパスキーはこのコンソールでは使えません。このコンソール用のパスキーは、Google でログインした後に「システム」画面で登録してください。</p>
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
    <label>組織 <select id="newStoreOrg"></select></label>
    <button class="btn" id="createStore">作成</button>
  </div></div>
  <div id="storeDetail" class="detail-box"></div>
</section>

<section id="sec-orgs" class="console-sec" style="display:none;">
  <h2>組織・プラン</h2>
  <p class="small muted">プランは組織単位で付与します。プラン変更は即時反映され、監査ログに記録されます。</p>
  <div id="orgs"><div class="skl skl-row"></div><div class="skl skl-row"></div></div>
  <h3>組織を作成</h3>
  <div class="group"><div class="group-row static">
    <input id="newOrgName" type="text" placeholder="組織名" style="width: 14em;">
    <label>プラン <select id="newOrgPlan"></select></label>
    <button class="btn" id="createOrg">作成</button>
  </div></div>
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
    <span class="row-label">整合性チェック <small class="muted">ハッシュチェーンで改ざんを検知します</small></span>
    <button class="btn small secondary" id="auditIntegrityBtn">チェックする</button>
    <span class="small" id="auditIntegrityResult"></span>
  </div></div>
  <div class="group"><div class="group-row static">
    <label>店舗 <select id="auditStore"></select></label>
    <label>ユーザー <select id="auditUser"></select></label>
    <input id="auditQ" type="search" placeholder="キーワード (操作・詳細)">
    <button class="btn small" id="auditSearchBtn">検索</button>
  </div></div>
  <p class="small muted" id="auditTotal"></p>
  <div id="auditList"><div class="skl skl-row"></div></div>
</section>

<section id="sec-announce" class="console-sec" style="display:none;">
  <h2>お知らせ</h2>
  <p class="small muted">全店舗または店舗を指定して投稿できます。掲載期間を過ぎたお知らせは店舗アプリに表示されません。プッシュ通知は購読登録したユーザーへ届きます (掲載開始が未来のものは、店舗アプリ側の定期実行で送信されます)。</p>
  <h3>投稿</h3>
  <div class="group">
    <div class="group-row static">
      <input id="annTitle" type="text" placeholder="タイトル" style="flex:1;" maxlength="200">
    </div>
    <div class="group-row static">
      <textarea id="annBody" rows="4" placeholder="本文" style="flex:1;"></textarea>
    </div>
    <div class="group-row static">
      <label>重要度 <select id="annPriority">
        <option value="normal">通常</option>
        <option value="important">重要</option>
      </select></label>
      <label>対象 <select id="annStore"></select></label>
      <label><input type="checkbox" id="annPush"> プッシュ通知を送る</label>
    </div>
    <div class="group-row static">
      <label>掲載開始 <input id="annStart" type="datetime-local"></label>
      <label>掲載終了 <input id="annEnd" type="datetime-local"></label>
      <span class="small muted">終了を空にすると無期限</span>
      <button class="btn small" id="annCreateBtn">投稿</button>
    </div>
  </div>
  <h3>一覧</h3>
  <div id="annList"><div class="skl skl-row"></div></div>
</section>

<section id="sec-system" class="console-sec" style="display:none;">
  <h2>システム</h2>
  <h3>メンテナンス</h3>
  <p class="small muted">実施中・予定は店舗アプリへ自動で反映されます (最大30秒)。全体管理者はメンテナンス中も店舗アプリを操作できます。</p>
  <div id="mntNow"><div class="skl skl-row"></div></div>
  <h4>プリセット</h4>
  <div class="group">
    <div class="group-row static mnt-preset-row" id="mntPresets"></div>
    <div class="group-row static">
      <input id="mntPresetName" type="text" placeholder="プリセット名" style="flex:1;">
      <button class="btn small secondary" id="mntPresetSaveBtn">現在の入力をプリセットとして保存</button>
    </div>
    <p class="small muted">チップを選ぶと「予定を追加」の入力に反映されます。保存は「予定を追加」側の現在の入力 (止め方・対象機能・対象店舗・告知文) を使います。</p>
  </div>
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
    <div class="mnt-feat-block" id="mntStartFeatures" style="display:none;"></div>
    <div class="group-row static">
      <label><input type="checkbox" id="mntStartEmergency"> 緊急</label>
      <label id="mntStartDurationWrap" style="display:none;">終了 <select id="mntStartDuration">
        <option value="60">1時間後</option>
        <option value="120">2時間後</option>
        <option value="240">4時間後</option>
      </select></label>
      <input id="mntStartReason" type="text" placeholder="緊急の理由 (緊急時は必須)" style="flex:1; display:none;">
    </div>
    <p class="small muted" id="mntStartPreview"></p>
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
      <span class="small muted">終了を空にすると終了未定 (緊急時は終了必須)</span>
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
    <div class="mnt-feat-block" id="mntFeatures" style="display:none;"></div>
    <div class="group-row static">
      <label><input type="checkbox" id="mntEmergency"> 緊急</label>
      <input id="mntReason" type="text" placeholder="緊急の理由 (緊急時は必須)" style="flex:1; display:none;">
    </div>
    <p class="small muted" id="mntEmergencyNote" style="display:none;">緊急は単発のみ・終了必須・最長4時間です。理由は監査に残ります。</p>
    <div class="group-row static">
      <input id="mntMessage" type="text" placeholder="告知文 (任意)" style="flex:1;">
      <button class="btn small" id="mntAddBtn">予定を追加</button>
    </div>
    <p class="small muted" id="mntPreview"></p>
  </div>
  <h4>実施中・予定</h4>
  <div id="mntList"><div class="skl skl-row"></div></div>
  <h4>履歴</h4>
  <div id="mntRecent"></div>
  <h3>データベース</h3>
  <div id="sysTables"><div class="skl skl-row"></div></div>
  <p class="small muted" id="sysSessions"></p>
  <h3>利用量</h3>
  <div id="sysUsage"><div class="skl skl-row"></div></div>
  <h3>バックアップ</h3>
  <p class="small muted">業務データ一式のスナップショットです。自動分は1日1回作成されます。復元は業務データだけが対象で、ユーザー・割当・セッションは戻りません。復元前に現在の状態が自動で保存されます。</p>
  <div class="group">
    <div class="group-row"><span class="row-label">手動バックアップ</span><button class="btn small" id="backupCreateBtn">今すぐ作成</button></div>
  </div>
  <p class="small" id="backupMsg"></p>
  <div id="backupList"><div class="skl skl-row"></div></div>
  <h3>操作</h3>
  <div class="group">
    <div class="group-row"><span class="row-label">全データエクスポート (全店舗)</span><a class="btn small" href="/api/platform/export.json">ダウンロード</a></div>
    <div class="group-row"><span class="row-label">全セッション失効 <small class="muted">自分のセッションは残ります</small></span><button class="btn small danger" id="revokeAllBtn">失効させる</button></div>
  </div>
  <h3>セキュリティ</h3>
  <h4>パスキー (このコンソール用)</h4>
  <p class="small muted">パスキーはホストごとに登録が必要です。店舗アプリで登録したパスキーはこのコンソールでは使えません。</p>
  <div class="group"><div class="group-row static">
    <button class="btn small" id="passkeyRegisterBtn">このコンソール用にパスキーを登録</button>
    <span class="small" id="passkeyMsg"></span>
  </div></div>
  <h4>自分のセッション</h4>
  <p class="small muted">このコンソール (全体管理) のセッションだけを表示します。店舗アプリのセッションは店舗アプリのセキュリティ画面で管理してください。</p>
  <div id="mySessions"><div class="skl skl-row"></div></div>
</section>
  </main>
</div>

<div id="stepUpOverlay" class="stepup-overlay" style="display:none;">
  <div class="stepup-box">
    <h3>本人確認</h3>
    <p class="small muted">この操作には再認証が必要です。</p>
    <p><button class="btn" id="stepUpPasskeyBtn" style="display:none;">Face IDで認証</button>
    <a class="btn secondary" href="/auth/login?stepup=1">Google で再ログイン</a></p>
    <p class="small" id="stepUpMsg" style="display:none; color: var(--danger);"></p>
    <p><button class="btn small secondary" id="stepUpCancelBtn">キャンセル</button></p>
  </div>
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
  const src = opts || {};
  const headers = { 'Content-Type': 'application/json', ...(src.headers || {}) };
  const fetchOpts = { credentials: 'same-origin', method: src.method, body: src.body, headers };
  const res = await fetch(path, fetchOpts);
  const text = await res.text();
  if (res.status === 401) {
    el('loginGuide').style.display = '';
    throw new Error('未ログインです。下のボタンからログインしてください。');
  }
  if (res.status === 403 && !src.stepUpRetried) {
    let code = '';
    try { code = (JSON.parse(text) || {}).error || ''; } catch (e) { code = ''; }
    if (code === 'STEP_UP_REQUIRED') {
      // 重要操作の再認証: ダイアログで認証できたら元のリクエストを 1 回だけ再試行する
      await requestStepUp();
      return api(path, { ...src, stepUpRetried: true });
    }
  }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + text);
  return text ? JSON.parse(text) : null;
}

/* ---------------- パスキー / 再認証 (WebAuthn) ---------------- */
function b64urlToBuf(text) {
  const b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
function bufToB64url(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  s = btoa(s).split('+').join('-').split('/').join('_');
  while (s.charAt(s.length - 1) === '=') s = s.slice(0, -1);
  return s;
}
function passkeySupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.get && navigator.credentials.create);
}
function assertionBody(cred) {
  const r = cred.response;
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
async function passkeyLogin() {
  const msg = el('passkeyLoginMsg');
  const hint = el('passkeyLoginHint');
  function fail(text) {
    if (msg) { msg.textContent = text; msg.style.display = ''; }
    if (hint) hint.style.display = '';
  }
  if (!passkeySupported()) { fail('この端末ではパスキーを使えません'); return; }
  if (msg) msg.style.display = 'none';
  if (hint) hint.style.display = 'none';
  try {
    const opts = await api('/api/platform/auth/passkey/login/options', { method: 'POST', body: '{}' });
    const cred = await getPasskeyAssertion(opts);
    if (!cred) { fail('キャンセルされました'); return; }
    await api('/api/platform/auth/passkey/login/verify', { method: 'POST', body: JSON.stringify(assertionBody(cred)) });
    location.reload();
  } catch (e) {
    if (e && e.name === 'NotAllowedError') { fail('キャンセルされました'); return; }
    if (String(e && e.message ? e.message : e).indexOf('PLATFORM_ADMIN_REQUIRED') >= 0) {
      fail('全体管理者の権限がありません');
      return;
    }
    fail('ログインできませんでした');
  }
}
/* システム画面の「このコンソール用にパスキーを登録」 */
async function doPasskeyRegister() {
  const msg = el('passkeyMsg');
  function fail(t) { if (msg) msg.textContent = t; }
  if (!passkeySupported()) { fail('この端末ではパスキーを使えません'); return; }
  if (msg) msg.textContent = '';
  try {
    const opts = await api('/api/platform/auth/passkey/register/options', { method: 'POST', body: '{}' });
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBuf(opts.challenge),
        rp: opts.rp,
        user: { id: b64urlToBuf(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
        pubKeyCredParams: opts.pubKeyCredParams,
        timeout: opts.timeout,
        attestation: opts.attestation,
        authenticatorSelection: opts.authenticatorSelection,
        excludeCredentials: (opts.excludeCredentials || []).map((x) => ({ type: x.type, id: b64urlToBuf(x.id), transports: x.transports })),
      },
    });
    if (!cred) { fail('キャンセルされました'); return; }
    const r = cred.response;
    await api('/api/platform/auth/passkey/register/verify', {
      method: 'POST',
      body: JSON.stringify({
        credentialId: cred.id,
        attestationObject: bufToB64url(r.attestationObject),
        clientDataJSON: bufToB64url(r.clientDataJSON),
        transports: r.getTransports ? r.getTransports() : [],
      }),
    });
    fail('登録しました');
  } catch (e) {
    if (e && e.name === 'NotAllowedError') { fail('キャンセルされました'); return; }
    fail('登録できませんでした');
  }
}
/* ---- 再認証 (ステップアップ) ダイアログ ---- */
let stepUpWaiters = [];
function requestStepUp() {
  return new Promise((resolve, reject) => {
    stepUpWaiters.push({ resolve, reject });
    el('stepUpMsg').style.display = 'none';
    el('stepUpPasskeyBtn').style.display = passkeySupported() ? '' : 'none';
    el('stepUpOverlay').style.display = '';
  });
}
function settleStepUp(ok) {
  const ws = stepUpWaiters;
  stepUpWaiters = [];
  el('stepUpOverlay').style.display = 'none';
  for (const w of ws) {
    if (ok) w.resolve();
    else w.reject(new Error('再認証をキャンセルしました'));
  }
}
async function doPasskeyStepUp() {
  const msg = el('stepUpMsg');
  function fail() { if (msg) { msg.textContent = '認証できませんでした'; msg.style.display = ''; } }
  try {
    const opts = await api('/api/platform/auth/passkey/step-up/options', { method: 'POST', body: '{}' });
    const cred = await getPasskeyAssertion(opts);
    if (!cred) { fail(); return; }
    await api('/api/platform/auth/step-up/passkey', { method: 'POST', body: JSON.stringify(assertionBody(cred)) });
    settleStepUp(true);
  } catch (e) {
    if (e && e.name === 'NotAllowedError') return;
    fail();
  }
}

let myId = null;
let storeList = [];
let roleList = [];
let userList = [];
let orgList = [];
let planCatalog = [];
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
  if (name === 'orgs') loadOrganizations();
  if (name === 'users') loadUsers();
  if (name === 'audit') loadAudit();
  if (name === 'announce') loadAnnouncements();
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
  let html = '<div class="table-wrap"><table><thead><tr><th>ID</th><th>コード</th><th>店舗名</th><th>状態</th><th>組織 / プラン</th><th>統計 (ユーザー/商品/在庫/30日移動)</th><th>操作</th></tr></thead><tbody>';
  for (const s of storeList) {
    const orgCell = s.organization
      ? esc(s.organization.name || '') + ' / ' + esc(planNameOf(s.organization.planKey))
      : '<span class="muted">組織なし</span>';
    html += '<tr><td>' + s.id + '</td><td><code>' + esc(s.code) + '</code></td><td>' + esc(s.name) + '</td>' +
      '<td>' + (s.status === 'suspended' ? '<span class="badge badge-danger">停止中</span>' : '<span class="badge">稼働中</span>') + '</td>' +
      '<td>' + orgCell + '</td>' +
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
  const orgSel = el('newStoreOrg');
  const body = { code, name };
  if (orgSel && orgSel.value) body.organizationId = Number(orgSel.value);
  setError(''); setStatus('作成中…');
  try {
    await api('/api/platform/stores', { method: 'POST', body: JSON.stringify(body) });
    el('newStoreCode').value = '';
    el('newStoreName').value = '';
    await reloadStores();
    setStatus('店舗「' + name + '」を作成しました。');
  } catch (e) {
    setStatus('');
    setError(errText(e));
  }
}

/* ---------------- 組織・プラン ---------------- */
function planNameOf(key) {
  const p = planCatalog.find((x) => x.key === key);
  return p ? p.name : (key || '');
}
function limitText(used, limit) {
  return (used || 0) + ' / ' + (limit === null || limit === undefined ? '無制限' : limit);
}
function fillOrgSelects() {
  const planOpts = planCatalog.map((p) =>
    '<option value="' + esc(p.key) + '">' + esc(p.name) + (p.price === null ? ' (個別見積)' : ' (¥' + Number(p.price || 0).toLocaleString('ja-JP') + '/月)') + '</option>'
  ).join('');
  const orgPlanSel = el('newOrgPlan');
  if (orgPlanSel) orgPlanSel.innerHTML = planOpts;
  const storeOrgSel = el('newStoreOrg');
  if (storeOrgSel) {
    storeOrgSel.innerHTML = orgList.map((o) =>
      '<option value="' + o.id + '">' + esc(o.name) + ' (' + esc(planNameOf(o.planKey)) + ')</option>'
    ).join('');
  }
}
async function refreshOrgData() {
  const data = await api('/api/platform/organizations');
  orgList = data.organizations || [];
  planCatalog = data.plans || [];
  fillOrgSelects();
}
async function loadOrganizations() {
  try {
    await refreshOrgData();
    renderOrganizations();
  } catch (e) {
    setError(errText(e));
  }
}
function renderOrganizations() {
  const box = el('orgs');
  if (orgList.length === 0) { box.textContent = '組織がありません。'; return; }
  let html = '<div class="table-wrap"><table><thead><tr><th>ID</th><th>組織名</th><th>プラン</th><th>利用状況 (店舗 / ユーザー / 商品)</th><th>操作</th></tr></thead><tbody>';
  for (const o of orgList) {
    const planOpts = planCatalog.map((p) =>
      '<option value="' + esc(p.key) + '"' + (p.key === o.planKey ? ' selected' : '') + '>' + esc(p.name) + '</option>'
    ).join('');
    const lim = (o.plan && o.plan.limits) || {};
    const u = o.usage || {};
    html += '<tr><td>' + o.id + '</td>' +
      '<td><input id="orgName-' + o.id + '" type="text" value="' + esc(o.name) + '" style="width: 12em;"></td>' +
      '<td><select data-org-plan="' + o.id + '">' + planOpts + '</select></td>' +
      '<td>' + limitText(u.stores, lim.stores) + ' ・ ' + limitText(u.users, lim.users) + ' ・ ' + limitText(u.skus, lim.skus) + '</td>' +
      '<td><button data-org-rename="' + o.id + '">名前を保存</button></td></tr>';
  }
  box.innerHTML = html + '</tbody></table></div>';
  box.querySelectorAll('select[data-org-plan]').forEach((sel) => {
    sel.onchange = () => changeOrgPlan(Number(sel.dataset.orgPlan), sel.value);
  });
  box.querySelectorAll('button[data-org-rename]').forEach((btn) => {
    btn.onclick = () => renameOrg(Number(btn.dataset.orgRename));
  });
}
async function changeOrgPlan(id, planKey) {
  setError(''); setStatus('プランを変更中…');
  try {
    await api('/api/platform/organizations/' + id + '/plan', { method: 'PUT', body: JSON.stringify({ planKey }) });
    await refreshOrgData();
    renderOrganizations();
    storeList = await api('/api/platform/stores');
    await renderStores();
    setStatus('組織 #' + id + ' のプランを「' + planNameOf(planKey) + '」に変更しました。');
  } catch (e) {
    setStatus('');
    setError(errText(e));
    await loadOrganizations();
  }
}
async function renameOrg(id) {
  const name = el('orgName-' + id).value.trim();
  if (!name) { setError('組織名を入力してください。'); return; }
  setError(''); setStatus('保存中…');
  try {
    await api('/api/platform/organizations/' + id, { method: 'PUT', body: JSON.stringify({ name }) });
    await refreshOrgData();
    renderOrganizations();
    storeList = await api('/api/platform/stores');
    await renderStores();
    setStatus('組織 #' + id + ' の名前を変更しました。');
  } catch (e) {
    setStatus('');
    setError(errText(e));
  }
}
async function createOrganization() {
  const name = el('newOrgName').value.trim();
  const planKey = el('newOrgPlan').value;
  if (!name || !planKey) { setError('組織名とプランを入力してください。'); return; }
  setError(''); setStatus('作成中…');
  try {
    await api('/api/platform/organizations', { method: 'POST', body: JSON.stringify({ name, planKey }) });
    el('newOrgName').value = '';
    await refreshOrgData();
    renderOrganizations();
    setStatus('組織「' + name + '」を作成しました。');
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
    let html = '<div class="section-box"><div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap;">' +
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
  loadUsage();
  loadBackups();
  loadMySessions();
}

/* ---------------- 自分のセッション (platform スコープ) ---------------- */
function uaShortLabel(ua) {
  const s = String(ua || '');
  let os = '端末';
  if (s.indexOf('iPhone') >= 0) os = 'iPhone';
  else if (s.indexOf('iPad') >= 0) os = 'iPad';
  else if (s.indexOf('Android') >= 0) os = 'Android';
  else if (s.indexOf('Macintosh') >= 0 || s.indexOf('Mac OS') >= 0) os = 'Mac';
  else if (s.indexOf('Windows') >= 0) os = 'Windows';
  else if (s.indexOf('Linux') >= 0) os = 'Linux';
  let br = '';
  if (s.indexOf('Edg') >= 0) br = 'Edge';
  else if (s.indexOf('Chrome') >= 0 || s.indexOf('CriOS') >= 0) br = 'Chrome';
  else if (s.indexOf('Firefox') >= 0 || s.indexOf('FxiOS') >= 0) br = 'Firefox';
  else if (s.indexOf('Safari') >= 0) br = 'Safari';
  return br ? os + ' ' + br : os;
}
async function loadMySessions() {
  const box = el('mySessions');
  if (!box) return;
  try {
    const list = await api('/api/platform/auth/sessions');
    if (!Array.isArray(list) || list.length === 0) {
      box.innerHTML = '<p class="small muted">有効なセッションがありません。</p>';
      return;
    }
    let html = '<div class="table-wrap"><table><thead><tr><th>作成</th><th>最終利用</th><th>端末</th><th>IP</th><th></th></tr></thead><tbody>';
    for (const s of list) {
      html += '<tr><td>' + fmtDate(s.createdAt) + '</td><td>' + fmtDate(s.lastSeenAt) + '</td>' +
        '<td>' + esc(uaShortLabel(s.userAgent)) + '</td><td>' + esc(s.ip || '') + '</td><td style="white-space:nowrap;">' +
        (s.current
          ? '<span class="small muted">現在のセッション</span>'
          : '<button class="btn small danger" data-revoke-session="' + s.id + '">失効</button>') +
        '</td></tr>';
    }
    box.innerHTML = html + '</tbody></table></div>';
    box.querySelectorAll('button[data-revoke-session]').forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api('/api/platform/auth/sessions/' + btn.dataset.revokeSession, { method: 'DELETE' });
          loadMySessions();
        } catch (e) {
          setError(errText(e));
          btn.disabled = false;
        }
      };
    });
  } catch (e) {
    box.innerHTML = '<p class="small muted">セッション一覧を取得できませんでした: ' + esc(errText(e)) + '</p>';
  }
}

/* ---------------- 監査の整合性チェック ---------------- */
async function checkAuditIntegrity() {
  const out = el('auditIntegrityResult');
  out.textContent = '確認中…';
  try {
    const res = await api('/api/platform/audit-integrity');
    if (res.ok) {
      out.textContent = '整合性 OK (検証 ' + res.checked + ' 件)';
      out.style.color = 'var(--ok)';
    } else {
      out.textContent = '不整合を検出しました (行 ID ' + res.brokenAtId + ' 以降が改ざんされている可能性があります)';
      out.style.color = 'var(--danger)';
    }
  } catch (e) {
    out.textContent = 'チェックできませんでした: ' + errText(e);
    out.style.color = 'var(--danger)';
  }
}

/* ---------------- 利用量 ---------------- */
function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
async function loadUsage() {
  try {
    const data = await api('/api/platform/usage');
    const db = data.database || {};
    let html = '';
    const dbSize = (db.sizeBytes !== null && db.sizeBytes !== undefined) ? db.sizeBytes : db.sizeEstimateBytes;
    if (dbSize) {
      const FREE_LIMIT = 5 * 1024 * 1024 * 1024;
      const pct = Math.min(100, Math.round((dbSize / FREE_LIMIT) * 1000) / 10);
      const estimated = db.sizeBytes === null || db.sizeBytes === undefined;
      html += '<div class="group"><div class="group-row static"><span class="row-label">DB 容量 ' +
        (estimated ? '約 ' : '') + fmtBytes(dbSize) + ' / 5 GB (無料枠)</span><span>' + pct + '%</span></div>' +
        '<div style="padding:0 1rem 0.6rem;"><div class="usage-bar"><div style="width:' + pct + '%"></div></div></div></div>';
    }
    html += '<p class="small muted">全テーブル行数: ' + (db.totalRows || 0) + ' 行 / 有効なセッション: ' +
      data.activeSessions + ' 件 / バックアップ: ' + data.backups.count + ' 件 (' + fmtBytes(data.backups.totalBytes) + ')</p>';
    html += '<div class="table-wrap"><table><thead><tr><th>店舗</th><th>商品</th><th>在庫レコード</th><th>移動 (当月)</th><th>ユーザー</th></tr></thead><tbody>';
    for (const s of data.stores || []) {
      html += '<tr><td>' + esc(s.name) + ' <small class="muted">' + esc(s.code) + '</small></td>' +
        '<td>' + s.products + '</td><td>' + s.stockRows + '</td><td>' + s.movementsThisMonth + '</td><td>' + s.users + '</td></tr>';
    }
    el('sysUsage').innerHTML = html + '</tbody></table></div>';
  } catch (e) {
    el('sysUsage').innerHTML = '<p class="small muted">利用量を取得できませんでした: ' + esc(errText(e)) + '</p>';
  }
}

/* ---------------- バックアップ ---------------- */
let restoreConfirmId = null;
async function loadBackups() {
  try {
    const data = await api('/api/platform/backups');
    const items = data.items || [];
    if (items.length === 0) {
      el('backupList').innerHTML = '<p class="small muted">バックアップはまだありません。</p>';
      return;
    }
    let html = '<div class="table-wrap"><table><thead><tr><th>日時</th><th>種別</th><th>サイズ</th><th>メモ</th><th></th></tr></thead><tbody>';
    for (const b of items) {
      const kindLabel = b.note === 'pre-restore' ? '復元前' : (b.kind === 'auto' ? '自動' : '手動');
      html += '<tr><td>' + fmtDate(b.createdAt) + '</td><td>' + kindLabel + '</td><td>' + fmtBytes(b.sizeBytes) + '</td>' +
        '<td>' + esc(b.note || '') + '</td><td style="white-space:nowrap;">' +
        '<a class="btn small secondary" href="/api/platform/backups/' + b.id + '/download">ダウンロード</a> ';
      if (restoreConfirmId === b.id) {
        html += '<span class="small">この内容で復元しますか？ <button class="btn small danger" data-restore-yes="' + b.id + '">復元する</button> ' +
          '<button class="btn small secondary" data-restore-no="1">やめる</button></span>';
      } else {
        html += '<button class="btn small danger" data-restore="' + b.id + '">復元</button>';
      }
      html += '</td></tr>';
    }
    el('backupList').innerHTML = html + '</tbody></table></div>';
    el('backupList').querySelectorAll('button[data-restore]').forEach((btn) => {
      btn.onclick = () => { restoreConfirmId = Number(btn.dataset.restore); loadBackups(); };
    });
    el('backupList').querySelectorAll('button[data-restore-no]').forEach((btn) => {
      btn.onclick = () => { restoreConfirmId = null; loadBackups(); };
    });
    el('backupList').querySelectorAll('button[data-restore-yes]').forEach((btn) => {
      btn.onclick = () => restoreBackupById(Number(btn.dataset.restoreYes));
    });
  } catch (e) {
    el('backupList').innerHTML = '<p class="small muted">バックアップ一覧を取得できませんでした: ' + esc(errText(e)) + '</p>';
  }
}
async function createBackupNow() {
  const btn = el('backupCreateBtn');
  btn.disabled = true;
  el('backupMsg').textContent = '';
  try {
    const created = await api('/api/platform/backups', { method: 'POST', body: {} });
    el('backupMsg').textContent = 'バックアップを作成しました (' + fmtDate(created.createdAt) + ' / ' + fmtBytes(created.sizeBytes) + ')。';
    loadBackups();
    loadUsage();
  } catch (e) {
    el('backupMsg').textContent = '作成に失敗しました: ' + errText(e);
  } finally {
    btn.disabled = false;
  }
}
async function restoreBackupById(id) {
  restoreConfirmId = null;
  el('backupMsg').textContent = '復元しています…';
  try {
    const res = await api('/api/platform/backups/' + id + '/restore', { method: 'POST', body: {} });
    el('backupMsg').textContent = '復元しました。復元前の状態はバックアップ #' + res.preRestoreBackupId + ' に保存されています。';
    loadBackups();
    loadUsage();
    loadSystemTablesOnly();
  } catch (e) {
    el('backupMsg').textContent = '復元に失敗しました: ' + errText(e);
    loadBackups();
  }
}
/* 復元後にデータベース行数だけを更新する (loadSystem 全体はメンテナンス欄も触るため分ける) */
async function loadSystemTablesOnly() {
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
  } catch (e) { /* 次回表示時に再取得する */ }
}

/* ---------------- メンテナンス ---------------- */
/* [キー, 表示名, 'write' (書込のみ停止) を選べるか] */
const MNT_FEATURE_OPTS = [
  ['inbound', '入庫', true], ['outbound', '消費・出庫', true], ['transfers', '移動', true],
  ['stocktakes', '棚卸し', true], ['purchase_orders', '発注', true], ['suppliers', '仕入先', true],
  ['csv_export', 'CSVエクスポート', false], ['csv_import', 'CSVインポート', false],
  ['master_products', '商品マスタ', true], ['master_locations', '倉庫・保管場所', true],
  ['analytics', '分析', false], ['alerts', 'アラート', false], ['login', '新規ログイン', false],
];
const MNT_LEVEL_LABELS = { read_only: '読み取り専用', features: '機能別停止', full: '全面停止' };
const MNT_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const MNT_STATE_LABELS = { active: '実施中', scheduled: '予定', finished: '終了', cancelled: '取消' };
let mntFormsFilled = false;
let mntPresets = [];

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
function featuresText(features) {
  const keys = Object.keys(features || {});
  if (keys.length === 0) return '';
  return keys.map((k) => mntFeatureLabel(k) + (features[k] === 'write' ? ' (書込のみ)' : '')).join('・');
}
function windowDesc(w) {
  let s = MNT_STATE_LABELS[w.state] + ': ' + (w.emergency ? '緊急 ' : '') + MNT_LEVEL_LABELS[w.level];
  if (w.level === 'features') {
    s += ' (' + featuresText(w.features) + ')';
  }
  s += ' / ' + (w.storeId === null ? '全店舗' : storeName(w.storeId));
  s += ' / ' + windowPeriod(w);
  if (w.kind === 'weekly' && (w.state === 'active' || w.state === 'scheduled')) {
    s += ' (今回: ' + fmtDate(w.occurrenceStartsAt) + '〜' + (w.occurrenceEndsAt ? fmtDate(w.occurrenceEndsAt) : '終了未定') + ')';
  }
  if (w.message) s += ' / ' + w.message;
  if (w.emergency && w.reason) s += ' / 理由: ' + w.reason;
  return s;
}
function reportText(w) {
  const r = w.report;
  if (!r) return '';
  const parts = [];
  if (r.plannedMinutes !== null && r.plannedMinutes !== undefined) parts.push('予定 ' + r.plannedMinutes + '分');
  if (r.actualMinutes !== null && r.actualMinutes !== undefined) parts.push('実績 ' + r.actualMinutes + '分');
  if (r.extendCount) parts.push('延長 ' + r.extendCount + '回');
  parts.push('拒否 ' + (r.rejections || 0) + '件');
  return ' [' + parts.join(' / ') + ']';
}
/* 機能ごとに「対象外 / 書込停止 / 全停止」を 1行 + セグメントで選ぶ (write 不可は2択) */
const MNT_STAGE_LABELS = { '': '対象外', write: '書込停止', full: '全停止' };
function fillFeatureChecks(boxId) {
  el(boxId).innerHTML = MNT_FEATURE_OPTS.map((o) => {
    const stages = o[2] ? ['', 'write', 'full'] : ['', 'full'];
    const btns = stages.map((st) =>
      '<button type="button" data-mnt-stage="' + st + '"' + (st === '' ? ' class="sel"' : '') + '>' +
      MNT_STAGE_LABELS[st] + '</button>'
    ).join('');
    return '<div class="mnt-feat-row" data-mnt-feature="' + o[0] + '">' +
      '<div class="mnt-feat-head"><span class="mnt-feat-name">' + o[1] + '</span>' +
      '<span class="mnt-feat-state">対象外</span></div>' +
      '<div class="mnt-seg">' + btns + '</div></div>';
  }).join('');
  el(boxId).querySelectorAll('.mnt-feat-row').forEach((row) => {
    row.querySelectorAll('button[data-mnt-stage]').forEach((btn) => {
      btn.onclick = () => {
        setFeatureRow(row, btn.dataset.mntStage);
        schedulePreview(boxId === 'mntStartFeatures' ? 'start' : 'add');
      };
    });
  });
}
/* 1行分の選択状態を反映する (選択ボタンの色と右上の状態ラベル) */
function setFeatureRow(row, stage) {
  row.querySelectorAll('button[data-mnt-stage]').forEach((b) => {
    b.className = b.dataset.mntStage === stage ? 'sel' + (stage ? ' stage-' + stage : '') : '';
  });
  const label = row.querySelector('.mnt-feat-state');
  label.textContent = MNT_STAGE_LABELS[stage];
  label.className = 'mnt-feat-state' + (stage ? ' stage-' + stage : '');
}
/* 選択された機能を { key: stage } マップで返す (対象外は含めない) */
function checkedFeatures(boxId) {
  const map = {};
  el(boxId).querySelectorAll('.mnt-feat-row').forEach((row) => {
    const sel = row.querySelector('button.sel');
    const stage = sel ? sel.dataset.mntStage : '';
    if (stage) map[row.dataset.mntFeature] = stage;
  });
  return map;
}
function setFeatureSelectors(boxId, features) {
  el(boxId).querySelectorAll('.mnt-feat-row').forEach((row) => {
    const v = features && features[row.dataset.mntFeature] ? features[row.dataset.mntFeature] : '';
    setFeatureRow(row, v);
  });
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
  const startEmergency = el('mntStartEmergency').checked;
  el('mntStartReason').style.display = startEmergency ? '' : 'none';
  el('mntStartDurationWrap').style.display = startEmergency ? '' : 'none';
  const emergency = el('mntEmergency').checked;
  el('mntReason').style.display = emergency ? '' : 'none';
  el('mntEmergencyNote').style.display = emergency ? '' : 'none';
}
function fillMaintenanceForms() {
  if (mntFormsFilled) return;
  mntFormsFilled = true;
  fillFeatureChecks('mntStartFeatures');
  fillFeatureChecks('mntFeatures');
  fillStoreSelect('mntStartStore');
  fillStoreSelect('mntStore');
  el('mntStartLevel').onchange = () => { syncMaintenanceFormVisibility(); schedulePreview('start'); };
  el('mntLevel').onchange = () => { syncMaintenanceFormVisibility(); schedulePreview('add'); };
  el('mntKind').onchange = () => { syncMaintenanceFormVisibility(); schedulePreview('add'); };
  el('mntStartStore').onchange = () => schedulePreview('start');
  el('mntStore').onchange = () => schedulePreview('add');
  el('mntStartEmergency').onchange = () => { syncMaintenanceFormVisibility(); schedulePreview('start'); };
  el('mntEmergency').onchange = () => { syncMaintenanceFormVisibility(); schedulePreview('add'); };
  el('mntOnceStart').onchange = () => schedulePreview('add');
  el('mntOnceEnd').onchange = () => schedulePreview('add');
  el('mntPresetSaveBtn').onclick = savePreset;
  syncMaintenanceFormVisibility();
  loadPresets();
}

/* ---------------- プリセット ---------------- */
async function loadPresets() {
  try {
    const data = await api('/api/platform/maintenance/presets');
    mntPresets = data.presets || [];
    renderPresets();
  } catch (e) { /* プリセットが読めなくてもフォームは使える */ }
}
function renderPresets() {
  const box = el('mntPresets');
  if (mntPresets.length === 0) { box.innerHTML = '<span class="small muted">プリセットはありません。</span>'; return; }
  box.innerHTML = mntPresets.map((p, i) =>
    '<span class="mnt-preset-chip"><button type="button" data-preset="' + i + '" style="border:0;background:transparent;font:inherit;cursor:pointer;padding:0;">' +
    esc(p.name) + '</button><button type="button" class="mnt-preset-del" data-preset-del="' + p.id + '" aria-label="削除">×</button></span>'
  ).join('');
  box.querySelectorAll('button[data-preset]').forEach((b) => {
    b.onclick = () => applyPreset(mntPresets[Number(b.dataset.preset)]);
  });
  box.querySelectorAll('button[data-preset-del]').forEach((b) => {
    b.onclick = () => deletePreset(b.dataset.presetDel);
  });
}
function applyPreset(p) {
  if (!p) return;
  el('mntLevel').value = p.level;
  el('mntStore').value = p.storeId === null || p.storeId === undefined ? '' : String(p.storeId);
  el('mntMessage').value = p.message || '';
  setFeatureSelectors('mntFeatures', p.features);
  syncMaintenanceFormVisibility();
  schedulePreview('add');
  setStatus('プリセット「' + p.name + '」を反映しました。');
}
async function savePreset() {
  const name = el('mntPresetName').value.trim();
  if (!name) { setError('プリセット名を入力してください。'); return; }
  setError(''); setStatus('保存中…');
  try {
    const level = el('mntLevel').value;
    const body = {
      name: name, level: level,
      storeId: storeSelectValue('mntStore'),
      message: el('mntMessage').value || null,
    };
    if (level === 'features') body.features = checkedFeatures('mntFeatures');
    const data = await api('/api/platform/maintenance/presets', { method: 'POST', body: JSON.stringify(body) });
    mntPresets = data.presets || [];
    renderPresets();
    el('mntPresetName').value = '';
    setStatus('プリセット「' + name + '」を保存しました。');
  } catch (e) {
    setStatus('');
    setError(errText(e));
  }
}
async function deletePreset(id) {
  if (!confirm('このプリセットを削除しますか？')) return;
  setError(''); setStatus('');
  try {
    const data = await api('/api/platform/maintenance/presets/' + encodeURIComponent(id), { method: 'DELETE' });
    mntPresets = data.presets || [];
    renderPresets();
    setStatus('プリセットを削除しました。');
  } catch (e) {
    setError(errText(e));
  }
}

/* ---------------- 影響プレビュー ---------------- */
let mntPreviewTimer = null;
function schedulePreview(which) {
  if (mntPreviewTimer) clearTimeout(mntPreviewTimer);
  mntPreviewTimer = setTimeout(() => refreshPreview(which), 350);
}
async function refreshPreview(which) {
  const target = which === 'start' ? el('mntStartPreview') : el('mntPreview');
  if (!target) return;
  const body = {};
  if (which === 'start') {
    body.level = el('mntStartLevel').value;
    body.storeId = storeSelectValue('mntStartStore');
    if (body.level === 'features') body.features = checkedFeatures('mntStartFeatures');
    body.startsAt = Date.now();
    body.endsAt = el('mntStartEmergency').checked
      ? Date.now() + Number(el('mntStartDuration').value) * 60000
      : null;
  } else {
    body.level = el('mntLevel').value;
    body.storeId = storeSelectValue('mntStore');
    if (body.level === 'features') body.features = checkedFeatures('mntFeatures');
    if (el('mntKind').value === 'once') {
      const s = el('mntOnceStart').value;
      const e = el('mntOnceEnd').value;
      if (s) body.startsAt = new Date(s).getTime();
      body.endsAt = e ? new Date(e).getTime() : null;
    }
  }
  try {
    const data = await api('/api/platform/maintenance/preview', { method: 'POST', body: JSON.stringify(body) });
    const ops = Object.keys(data.recentOps || {})
      .filter((k) => data.recentOps[k] > 0)
      .map((k) => mntFeatureLabel(k) + ' ' + data.recentOps[k] + '件')
      .join(' / ');
    let text = '影響: 対象ユーザー ' + data.affectedUsers + '人 / 有効セッション ' + data.activeSessions + '件';
    if (ops) text += ' / 直近7日の操作: ' + ops;
    const overlaps = data.overlaps || [];
    if (overlaps.length > 0) {
      text += ' / 重なる予定 ' + overlaps.length + '件: ' + overlaps.map(windowDesc).join('、');
    }
    target.textContent = text;
  } catch (e) {
    target.textContent = '';
  }
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
      '<div class="feed-row"><small class="muted">' + fmtDate(w.cancelledAt || w.endsAt || w.createdAt) + '</small> ' +
      esc(windowDesc(w)) + '<small class="muted">' + esc(reportText(w)) + '</small></div>'
    ).join('');
  } catch (e) {
    setError(errText(e));
  }
}

async function startMaintenanceNow() {
  setError(''); setStatus('開始中…');
  try {
    const level = el('mntStartLevel').value;
    const emergency = el('mntStartEmergency').checked;
    const body = {
      kind: 'once', startsAt: Date.now(), endsAt: null, level: level,
      storeId: storeSelectValue('mntStartStore'),
      message: el('mntStartMessage').value || null,
    };
    if (level === 'features') body.features = checkedFeatures('mntStartFeatures');
    if (emergency) {
      const reason = el('mntStartReason').value.trim();
      if (!reason) { setStatus(''); setError('緊急の理由を入力してください (緊急時は必須)。'); return; }
      body.emergency = true;
      body.reason = reason;
      body.endsAt = Date.now() + Number(el('mntStartDuration').value) * 60000;
    }
    await api('/api/platform/maintenance/windows', { method: 'POST', body: JSON.stringify(body) });
    el('mntStartMessage').value = '';
    el('mntStartReason').value = '';
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
    if (el('mntEmergency').checked) {
      const reason = el('mntReason').value.trim();
      if (!reason) { setStatus(''); setError('緊急の理由を入力してください (緊急時は必須)。'); return; }
      body.emergency = true;
      body.reason = reason;
    }
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
    el('mntReason').value = '';
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

/* ---------------- お知らせ ---------------- */
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fillAnnounceStores() {
  const sel = el('annStore');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全店舗';
  sel.appendChild(all);
  for (const s of storeList) {
    const opt = document.createElement('option');
    opt.value = String(s.id);
    opt.textContent = s.name + ' (' + s.code + ')';
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}
function announceStateOf(a) {
  const now = Date.now();
  if (a.startsAt > now) return '<span class="badge">掲載前</span>';
  if (a.endsAt && a.endsAt <= now) return '<span class="badge">終了</span>';
  return '<span class="badge badge-ok">掲載中</span>';
}
async function loadAnnouncements() {
  fillAnnounceStores();
  if (!el('annStart').value) {
    const d = new Date();
    d.setSeconds(0, 0);
    el('annStart').value = toLocalInput(d);
  }
  try {
    const data = await api('/api/platform/announcements');
    const items = data.items || [];
    const box = el('annList');
    if (items.length === 0) {
      box.innerHTML = '<p class="muted">お知らせはまだありません。</p>';
      return;
    }
    let html = '<div class="group">';
    for (const a of items) {
      html += '<div class="group-row static"><span class="row-label">' + esc(a.title) +
        '<span class="small muted" style="display:block">' +
        esc(storeName(a.storeId)) + ' ・ ' + fmtDate(a.startsAt) + ' 〜 ' + (a.endsAt ? fmtDate(a.endsAt) : '無期限') +
        ' ・ 既読 ' + (a.readCount || 0) + '/' + (a.targetUsers || 0) + ' 人' +
        (a.priority === 'important' ? ' ・ 重要' : '') +
        (a.push ? ' ・ プッシュ' + (a.pushSentAt ? '送信済み' : '予定') : '') +
        '</span></span>' + announceStateOf(a) +
        '<button class="btn small secondary" data-ann-del="' + a.id + '">削除</button></div>';
    }
    box.innerHTML = html + '</div>';
    box.querySelectorAll('button[data-ann-del]').forEach((btn) => {
      btn.onclick = () => deleteAnnouncement(Number(btn.dataset.annDel));
    });
  } catch (e) {
    setError(errText(e));
  }
}
async function createAnnouncement() {
  setError(''); setStatus('');
  const title = el('annTitle').value.trim();
  const body = el('annBody').value;
  if (!title || !body) { setError('タイトルと本文を入力してください。'); return; }
  const storeVal = el('annStore').value;
  const payload = {
    title: title,
    body: body,
    priority: el('annPriority').value,
    storeId: storeVal === '' ? null : Number(storeVal),
    startsAt: el('annStart').value ? new Date(el('annStart').value).getTime() : undefined,
    endsAt: el('annEnd').value ? new Date(el('annEnd').value).getTime() : null,
    push: el('annPush').checked,
  };
  try {
    await api('/api/platform/announcements', { method: 'POST', body: JSON.stringify(payload) });
    setStatus('お知らせを投稿しました。');
    el('annTitle').value = '';
    el('annBody').value = '';
    el('annEnd').value = '';
    el('annPush').checked = false;
    loadAnnouncements();
  } catch (e) {
    setError(errText(e));
  }
}
async function deleteAnnouncement(id) {
  if (!confirm('このお知らせを削除しますか？')) return;
  setError(''); setStatus('');
  try {
    await api('/api/platform/announcements/' + id, { method: 'DELETE' });
    setStatus('お知らせ #' + id + ' を削除しました。');
    loadAnnouncements();
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
    await refreshOrgData();
  } catch (e) { /* 組織 API が無い環境では店舗作成の組織セレクトは空のまま */ }
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
el('createOrg').onclick = createOrganization;
el('userSearchBtn').onclick = loadUsers;
el('auditSearchBtn').onclick = loadAudit;
el('mntStartBtn').onclick = startMaintenanceNow;
el('mntAddBtn').onclick = addWindow;
el('revokeAllBtn').onclick = revokeAllSessions;
el('backupCreateBtn').onclick = createBackupNow;
el('annCreateBtn').onclick = createAnnouncement;
el('auditIntegrityBtn').onclick = checkAuditIntegrity;
el('passkeyRegisterBtn').onclick = doPasskeyRegister;
el('stepUpPasskeyBtn').onclick = doPasskeyStepUp;
el('stepUpCancelBtn').onclick = () => settleStepUp(false);
el('passkeyLoginBtn').onclick = passkeyLogin;
if (passkeySupported()) el('passkeyLoginBtn').style.display = '';
loadAll();
</script>
</body>
</html>`;
