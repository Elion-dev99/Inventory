import { APP_CSS_URL, APP_JS_URL } from './assets';
import { PWA_HEAD } from '../pwa';

/**
 * /app の SPA シェル。Worker から直接配信する HTML。
 * CSS / JS は内容ハッシュ付きの別アセットとして配信し、ブラウザと
 * Service Worker にキャッシュさせる (毎回の全量ダウンロードを避ける)。
 * 認証は Cookie セッション (HttpOnly) のため、ページ自体は未ログインでも
 * 配信し、初期表示で /api/v1/me を引いてログイン導線に分岐する。
 */
export const APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>在庫管理システム</title>${PWA_HEAD}
<link rel="stylesheet" href="${APP_CSS_URL}">
</head>
<body>
<header class="app-header">
  <img class="app-icon" src="/icons/icon-192.png" alt="">
  <h1>在庫管理システム</h1>
  <span><span class="ws-dot" id="wsDot"></span> <span class="ws-label" id="wsLabel">リアルタイム未接続</span></span>
  <span class="spacer"></span>
  <select id="storeSwitch" style="display:none" aria-label="店舗を切り替える"></select>
  <span class="small" id="userLabel"></span>
</header>

<div id="maintenanceBanner" class="maintenance-banner" style="display:none"></div>

<div id="loadingBox" class="splash"><img class="app-icon-lg" src="/icons/icon-512.png" alt=""><div class="splash-name">在庫管理システム</div></div>

<div id="loginBox" class="center-box" style="display:none">
  <img class="app-icon-lg" src="/icons/icon-512.png" alt="">
  <h2>ログインが必要です</h2>
  <p class="muted">在庫管理システムを利用するにはログインしてください。</p>
  <p><button class="btn" id="passkeyLoginBtn" type="button">Face IDでログイン</button></p>
  <p><a class="btn secondary" href="/auth/login">Google でログイン</a></p>
  <p class="small danger" id="passkeyLoginMsg" style="display:none"></p>
  <p class="small muted" id="passkeyLoginHint" style="display:none">このサイト用のパスキーが未登録の場合は、先に Google でログインして「セキュリティ」から登録してください。</p>
</div>

<div id="errorBox" class="center-box" style="display:none">
  <h2>読み込めませんでした</h2>
  <p class="muted">通信に失敗しました。接続を確認して、もう一度お試しください。</p>
  <p><button class="btn" id="bootRetryBtn">再試行</button></p>
</div>

<div id="noAssignBox" class="center-box" style="display:none">
  <h2>はじめる</h2>
  <div id="pendingArea" style="display:none"></div>
  <p class="muted">ログインはできていますが、このアカウントにはまだ店舗が割り当てられていません。自分の組織と店舗を作成して使い始めるか、管理者にロール付与を依頼してください。</p>
  <form class="grid" id="signupForm" style="text-align:left">
    <label>組織名<input id="signupOrgName" type="text" maxlength="100" placeholder="例: 株式会社サンプル" autocomplete="organization"></label>
    <label>店舗名<input id="signupStoreName" type="text" maxlength="100" placeholder="例: 本店"></label>
    <label>業種テンプレート<select id="signupTemplate"></select></label>
  </form>
  <p class="small muted">テンプレートを選ぶと、カテゴリ・部門・理由コードと最初の保管場所が初期設定されます。プランはフリーで始まります。</p>
  <p><button class="btn" id="signupBtn" type="button">組織と店舗を作成して始める</button></p>
  <p class="small danger" id="signupMsg" style="display:none"></p>
  <p style="margin-top:1.5rem"><button class="btn secondary" id="signupLogoutBtn" type="button">ログアウト</button></p>
  <p class="small muted">別のアカウントでログインし直す場合は、先にログアウトしてください。</p>
</div>

<div id="maintenanceBox" class="center-box" style="display:none">
  <h2>メンテナンス中</h2>
  <p id="mntFullMessage"></p>
  <p class="muted" id="mntFullEnds"></p>
  <p><button class="btn" id="mntReloadBtn">再読み込み</button></p>
</div>

<div id="storeBox" class="center-box" style="display:none">
  <img class="app-icon-lg" src="/icons/icon-512.png" alt="">
  <h2>店舗を選んでください</h2>
  <p class="muted">複数の店舗に所属しています。作業する店舗を選ぶと、その店舗のデータだけが表示されます。</p>
  <div id="storeList" class="group" style="text-align:left"></div>
  <p id="storeMsg"></p>
  <p><button class="btn secondary" id="storeLogoutBtn" type="button">ログアウト</button></p>
</div>

<div id="appBox" style="display:none">
  <div id="offlineBar" class="offline-bar" style="display:none"></div>
  <div id="subbar" class="subbar" style="display:none"></div>
  <main id="view"></main>
  <nav class="tabbar" id="tabbar"></nav>
  <div id="sheetOverlay" class="sheet-overlay" style="display:none">
    <div class="sheet" id="sheetBox"></div>
    <button class="sheet-cancel" id="sheetCancel">キャンセル</button>
  </div>
</div>

<div id="modalOverlay" class="modal-overlay" style="display:none">
  <div class="modal" id="modalBox"></div>
</div>

<div id="scannerOverlay" class="scanner-overlay" style="display:none"></div>

<script src="${APP_JS_URL}" defer></script>
</body>
</html>`;
