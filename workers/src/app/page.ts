import { APP_CSS } from './styles';
import { APP_JS } from './client';

/**
 * /app の SPA シェル。Worker から直接配信する単一 HTML。
 * 認証は Cookie セッション (HttpOnly) のため、ページ自体は未ログインでも
 * 配信し、初期表示で /api/v1/me を引いてログイン導線に分岐する。
 */
export const APP_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>在庫管理システム</title>
<style>${APP_CSS}</style>
</head>
<body>
<header class="app-header">
  <h1>在庫管理システム</h1>
  <span><span class="ws-dot" id="wsDot"></span> <span class="ws-label" id="wsLabel">リアルタイム未接続</span></span>
  <span class="spacer"></span>
  <span class="small" id="userLabel"></span>
  <a class="small" id="permLink" href="/admin/permissions">権限管理</a>
  <button class="btn secondary small" id="logoutBtn">ログアウト</button>
</header>

<div id="loadingBox" class="center-box"><p>読み込み中…</p></div>

<div id="loginBox" class="center-box" style="display:none">
  <h2>ログインが必要です</h2>
  <p class="muted">在庫管理システムを利用するには Google アカウントでログインしてください。</p>
  <p><a class="btn" href="/auth/login">Google でログイン</a></p>
</div>

<div id="noAssignBox" class="center-box" style="display:none">
  <h2>権限が付与されていません</h2>
  <p class="muted">ログインはできていますが、このアカウントにはまだロールが割り当てられていません。管理者にロール付与を依頼してください。</p>
</div>

<div id="appBox" style="display:none">
  <nav class="tabs" id="tabs"></nav>
  <main id="view"></main>
</div>

<div id="modalOverlay" class="modal-overlay" style="display:none">
  <div class="modal" id="modalBox"></div>
</div>

<script>${APP_JS}</script>
</body>
</html>`;
