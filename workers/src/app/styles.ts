/**
 * /app と /admin の共通スタイル。
 * デザイン言語: Apple のミニマリズム (余白・タイポグラフィ・半透明ヘッダー) と
 * Dribbble 系プロダクト UI (大きな角丸・柔らかい影・ピル型ナビ) の融合。
 * 色は CSS 変数に集約し、ダークモードは変数の差し替えだけで追随する。
 */
export const APP_CSS = `
:root {
  --bg: #f5f5f7;
  --surface: #ffffff;
  --surface-2: #f5f5f7;
  --fg: #1d1d1f;
  --muted: #86868b;
  --line: rgba(0, 0, 0, 0.08);
  --line-strong: rgba(0, 0, 0, 0.16);
  --accent: #0071e3;
  --accent-press: #0060c9;
  --control: #e8e8ed;
  --header-bg: rgba(251, 251, 253, 0.78);
  --glass: rgba(255, 255, 255, 0.66);
  --glass-border: rgba(255, 255, 255, 0.65);
  --dock-shadow: 0 12px 32px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.08);
  --danger: #c81e1e;
  --danger-bg: #fef2f2;
  --warn: #9a6700;
  --warn-bg: #fff8e1;
  --ok: #137333;
  --ok-bg: #e6f4ea;
  --info-bg: #e8effe;
  --info-fg: #123a8f;
  --r-lg: 24px;
  --r-md: 14px;
  --r-sm: 10px;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 10px 30px rgba(0, 0, 0, 0.06);
  --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.16);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #060608;
    --surface: #1c1c1e;
    --surface-2: #242426;
    --fg: #f5f5f7;
    --muted: #98989d;
    --line: rgba(255, 255, 255, 0.12);
    --line-strong: rgba(255, 255, 255, 0.24);
    --control: #2c2c2e;
    --header-bg: rgba(22, 22, 24, 0.72);
    --glass: rgba(30, 30, 34, 0.62);
    --glass-border: rgba(255, 255, 255, 0.14);
    --dock-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35);
    --danger: #ff6961;
    --danger-bg: #3a2222;
    --warn: #f5c66b;
    --warn-bg: #33290e;
    --ok: #63da6e;
    --ok-bg: #12351a;
    --info-bg: #0f2a52;
    --info-fg: #7db4ff;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 10px 30px rgba(0, 0, 0, 0.35);
    --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.55);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
  margin: 0;
  color: var(--fg);
  line-height: 1.6;
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
::selection { background: rgba(0, 113, 227, 0.22); }
a { color: var(--accent); }
input[type="checkbox"], input[type="radio"] { accent-color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

header.app-header {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0.6rem;
  padding: calc(0.55rem + env(safe-area-inset-top)) 1rem 0.55rem;
  background: var(--header-bg);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--line);
}
header.app-header h1 { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.01em; margin: 0; white-space: nowrap; }
header.app-header .spacer { flex: 1; }
header.app-header a { text-decoration: none; font-weight: 500; }
.app-icon { width: 32px; height: 32px; border-radius: 8px; flex: none; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18); }
.app-icon-lg { width: 72px; height: 72px; border-radius: 18px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18); }
.ws-dot { display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; background: #bbb; vertical-align: middle; }
.ws-dot.on { background: #30d158; }
.ws-label { font-size: 0.78rem; color: var(--muted); white-space: nowrap; }
@media (max-width: 720px) {
  #userLabel { display: none; }
  .ws-label { display: none; }
}

main { padding: 1rem 1rem 2rem; padding-bottom: calc(7.6rem + env(safe-area-inset-bottom)); max-width: 1080px; margin: 0 auto; }

/* 画面遷移: 中身がふわりと浮かび上がる */
#view > * { animation: view-rise 0.38s cubic-bezier(0.22, 0.9, 0.3, 1) both; }
#view > *:nth-child(2) { animation-delay: 0.04s; }
#view > *:nth-child(3) { animation-delay: 0.08s; }
#view > *:nth-child(4) { animation-delay: 0.12s; }
#view > *:nth-child(5) { animation-delay: 0.16s; }
#view > *:nth-child(n+6) { animation-delay: 0.2s; }
@keyframes view-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { #view > * { animation: none; } }

/* ---- 浮遊ドック型タブバー (visionOS 風) ---- */
.tabbar {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(0.65rem + env(safe-area-inset-bottom));
  z-index: 45;
  width: min(450px, calc(100% - 1.4rem));
  display: flex;
  align-items: flex-start;
  justify-content: space-around;
  padding: 0.5rem 0.55rem 0.42rem;
  background: var(--glass);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  backdrop-filter: blur(24px) saturate(180%);
  border: 1px solid var(--glass-border);
  border-radius: 30px;
  box-shadow: var(--dock-shadow);
}
.tab-item, .tab-plus {
  flex: 1;
  max-width: 110px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  background: none;
  border: none;
  padding: 0.2rem 0;
  cursor: pointer;
  color: var(--muted);
  font-size: 0.64rem;
  font-weight: 500;
  font-family: inherit;
  transition: color 0.15s ease, transform 0.12s ease;
}
.tab-item:active, .tab-plus:active { transform: scale(0.94); }
.tab-item.active { color: var(--accent); }
.tab-item { border-radius: 18px; padding: 0.28rem 0.1rem 0.18rem; }
.tab-item.active { background: rgba(0, 113, 227, 0.13); }
.tab-plus .plus-circle {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin-top: -22px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
  border: none;
}
.tab-plus.active { color: var(--accent); }

/* ---- サブ画面の戻るバー ---- */
.subbar { max-width: 1080px; margin: 0 auto; padding: 0.55rem 1rem 0; }
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.1rem;
  background: none;
  border: none;
  padding: 0.25rem 0;
  color: var(--accent);
  font-size: 1rem;
  font-family: inherit;
  cursor: pointer;
}

/* ---- アクションシート ---- */
.sheet-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.4);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.75rem;
  padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));
}
.sheet { background: var(--glass); -webkit-backdrop-filter: blur(24px) saturate(180%); backdrop-filter: blur(24px) saturate(180%); border: 1px solid var(--glass-border); border-radius: 26px; overflow: hidden; box-shadow: var(--shadow-lg); animation: sheet-up 0.34s cubic-bezier(0.22, 0.9, 0.3, 1) both; }
@keyframes sheet-up { from { opacity: 0; transform: translateY(26px); } to { opacity: 1; transform: translateY(0); } }
.sheet-title { text-align: center; color: var(--muted); font-size: 0.85rem; font-weight: 600; padding: 0.8rem 1rem 0.4rem; }
.sheet-cancel {
  background: var(--surface);
  color: var(--accent);
  border: none;
  border-radius: var(--r-lg);
  padding: 0.95rem;
  font-size: 1.05rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  box-shadow: var(--shadow-lg);
}

/* ---- iOS 設定風グループリスト ---- */
.group { background: var(--surface); border: 1px solid var(--glass-border); border-radius: var(--r-lg); box-shadow: var(--shadow); overflow: hidden; margin-bottom: 1rem; }
.group-row, .sheet-row {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  width: 100%;
  min-height: 54px;
  padding: 0.7rem 1rem;
  background: none;
  border: none;
  border-bottom: 1px solid var(--line);
  color: var(--fg);
  font-size: 1rem;
  font-family: inherit;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}
.group-row:last-child, .sheet-row:last-child { border-bottom: none; }
.group-row:active, .sheet-row:active { background: var(--surface-2); }
.group-row.static { cursor: default; }
.search-entry { display: block; width: 100%; text-align: left; background: var(--surface-2); border: 1px solid var(--glass-border); border-radius: 999px; padding: 0.65rem 1rem; color: var(--muted); font-size: 0.95rem; font-family: inherit; margin-bottom: 1rem; cursor: pointer; }
.search-entry:active { background: var(--surface); }
.group-row.danger { color: #d70015; justify-content: center; font-weight: 600; }
@media (prefers-color-scheme: dark) { .group-row.danger { color: #ff6961; } }
.row-icon { flex: none; display: grid; place-items: center; width: 31px; height: 31px; border-radius: 8px; color: #fff; }
.row-label { flex: 1; }
.chev { color: var(--muted); display: grid; place-items: center; }

/* ---- ダッシュボードのクイックアクション ---- */
.quick-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.85rem; margin-top: 0.85rem; }
.quick-btn {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.95rem 1.05rem;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow);
  color: var(--fg);
  font-size: 1rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: transform 0.12s ease;
}
.quick-btn:active { transform: scale(0.97); }
.quick-btn .row-icon { width: 36px; height: 36px; border-radius: 10px; }

/* ---- ダッシュボードの状態ヒーローとクイック検索 ---- */
.hero {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  border-radius: 26px;
  padding: 1.15rem 1.25rem;
  margin-bottom: 0.85rem;
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow);
  background: var(--surface);
}
.hero-dot { flex: none; width: 11px; height: 11px; border-radius: 50%; background: var(--accent); }
.hero.ok .hero-dot { background: #30d158; }
.hero.warn .hero-dot { background: #ff9f0a; }
.hero.danger .hero-dot { background: #ff453a; }
.hero { border-left: 4px solid var(--accent); }
.hero.ok { border-left-color: #30d158; }
.hero.warn { border-left-color: #ff9f0a; }
.hero.danger { border-left-color: #ff453a; }
.hero-title { font-size: 1.45rem; font-weight: 800; letter-spacing: -0.02em; line-height: 1.25; }
.hero-sub { color: var(--muted); font-size: 0.88rem; font-weight: 500; }
.search-hero {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  background: var(--glass);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  border: 1px solid var(--glass-border);
  border-radius: 18px;
  padding: 0.15rem 0.95rem;
  margin-bottom: 0.95rem;
  box-shadow: var(--shadow);
}
.search-hero .search-ic { color: var(--muted); display: grid; place-items: center; }
.search-hero input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--fg);
  font-size: 1rem;
  padding: 0.7rem 0;
  font-family: inherit;
}
.search-hero input:focus { outline: none; }
.search-hero:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px rgba(0, 113, 227, 0.16), var(--shadow); }

h2 { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.02em; margin: 0.35rem 0 1.1rem; }
h3 { font-size: 1.02rem; font-weight: 600; letter-spacing: -0.01em; margin: 1.4rem 0 0.6rem; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 0.85rem; }
.card { background: var(--surface); border: 1px solid var(--glass-border); border-radius: var(--r-lg); padding: 1.05rem 1.1rem; box-shadow: var(--shadow); transition: transform 0.18s ease, box-shadow 0.18s ease; }
@media (hover: hover) { .card:hover, .quick-btn:hover { transform: translateY(-2px); } }
.card .num { font-size: 2.05rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; font-variant-numeric: tabular-nums; }
.card .lbl { color: var(--muted); font-size: 0.82rem; font-weight: 500; margin-top: 0.15rem; }

.table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--glass-border); border-radius: var(--r-lg); box-shadow: var(--shadow); -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
th, td { border-bottom: 1px solid var(--line); padding: 0.6rem 0.85rem; text-align: left; white-space: nowrap; }
th { background: var(--surface-2); color: var(--muted); font-size: 0.78rem; font-weight: 600; letter-spacing: 0.04em; }
tbody tr { transition: background 0.12s ease; }
tbody tr:hover { background: var(--surface-2); }
tr:last-child td { border-bottom: none; }

.thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 8px; vertical-align: middle; margin-right: 0.5rem; background: var(--control); }
.thumb-lg { width: 76px; height: 76px; object-fit: cover; border-radius: 10px; background: var(--control); }
.photo-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.5rem 0; }
.badge { display: inline-block; padding: 0.12rem 0.6rem; border-radius: 980px; font-size: 0.78rem; font-weight: 600; background: var(--control); color: var(--fg); }
.badge-danger { background: var(--danger-bg); color: var(--danger); }
.badge-warn { background: var(--warn-bg); color: var(--warn); }
.badge-ok { background: var(--ok-bg); color: var(--ok); }
.qty-neg { color: var(--danger); font-weight: 700; }
.qty-pos { color: var(--ok); font-weight: 700; }

form.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.85rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 1.15rem; box-shadow: var(--shadow); }
form.grid label { display: block; font-size: 0.82rem; font-weight: 500; color: var(--muted); }
form.grid input, form.grid select, form.grid textarea,
.toolbar input, .toolbar select {
  width: 100%;
  padding: 0.58rem 0.8rem;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  font-size: 1rem;
  margin-top: 0.25rem;
  background: var(--surface);
  color: var(--fg);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
form.grid input:focus, form.grid select:focus, form.grid textarea:focus,
.toolbar input:focus, .toolbar select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 4px rgba(0, 113, 227, 0.16);
}

.btn {
  display: inline-block;
  border: 1px solid transparent;
  background: var(--accent);
  color: #fff;
  border-radius: 980px;
  padding: 0.55rem 1.25rem;
  cursor: pointer;
  font-size: 0.95rem;
  font-weight: 500;
  text-decoration: none;
  transition: background 0.18s ease, transform 0.12s ease, opacity 0.18s ease;
}
.btn:hover { background: var(--accent-press); }
.btn:active { transform: scale(0.97); }
.btn.secondary { background: var(--control); color: var(--fg); box-shadow: none; }
.btn.secondary:hover { background: var(--line-strong); }
.btn.danger { background: #d70015; border-color: transparent; }
.btn.danger:hover { background: #b50011; }
.btn.small { padding: 0.32rem 0.85rem; font-size: 0.85rem; }
.btn:disabled { opacity: 0.45; cursor: default; }

.toolbar { display: flex; flex-wrap: wrap; gap: 0.7rem; align-items: end; margin-bottom: 0.85rem; }
.toolbar label { font-size: 0.82rem; font-weight: 500; color: var(--muted); display: block; }
.toolbar input, .toolbar select { width: auto; margin-top: 0.25rem; }

.msg { border-radius: var(--r-md); padding: 0.8rem 1rem; margin: 0.85rem 0; font-size: 0.92rem; }

/* メンテナンス告知バナー (全体管理がメンテナンスモードを ON にしたとき画面上部に固定表示) */
.maintenance-banner {
  position: fixed;
  top: calc(3.4rem + env(safe-area-inset-top));
  left: 0;
  right: 0;
  z-index: 39;
  background: var(--warn-bg);
  color: var(--warn);
  border-bottom: 1px solid var(--line);
  padding: 0.55rem 1rem;
  text-align: center;
  font-weight: 600;
  font-size: 0.9rem;
}
/* オフライン/未送信バー: アプリ内の先頭に置く事実表示 (情報色、要確認がある時だけ警告色) */
.offline-bar {
  background: var(--info-bg);
  color: var(--info-fg);
  border-bottom: 1px solid var(--line);
  padding: 0.5rem 1rem;
  text-align: center;
  font-weight: 600;
  font-size: 0.85rem;
}
.offline-bar.alert {
  background: var(--warn-bg);
  color: var(--warn);
}
/* メンテナンス予定の事前告知は情報色で控えめに出す */
.maintenance-banner.upcoming {
  background: var(--info-bg);
  color: var(--info-fg);
}
/* 終了通知も情報色で控えめに出し、閉じるボタンを持つ */
.maintenance-banner.ended {
  background: var(--info-bg);
  color: var(--info-fg);
}
.maintenance-banner .mnt-close {
  float: right;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  font-size: 1.05rem;
  line-height: 1;
  padding: 0 0.15rem;
  cursor: pointer;
}
/* フォーム見出し下のメンテナンス注記 (停止バッジ・開始直前の帯) */
.mnt-form-note { margin-bottom: 0.4rem; }
.mnt-form-note .msg { margin: 0.4rem 0; }
/* 記録ボタン上の小ドット (記録系機能の停止中を示す) */
.tab-plus { position: relative; }
.tab-dot {
  position: absolute;
  top: 0.1rem;
  right: calc(50% - 2.1rem);
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #ff9500;
}

/* ---- お知らせ ---- */
/* ホームタブの未読バッジ */
.tab-item { position: relative; }
.tab-badge {
  position: absolute;
  top: 0.05rem;
  right: calc(50% - 1.6rem);
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 980px;
  background: #ff3b30;
  color: #fff;
  font-size: 0.66rem;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
}
/* ホームのお知らせカード (左帯はヒーローと同じ作法。重要は警告色) */
.notice-card {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  width: 100%;
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--line);
  border-left: 4px solid var(--accent);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow);
  padding: 0.95rem 1.05rem;
  margin-bottom: 1rem;
  cursor: pointer;
  font-family: inherit;
  color: var(--fg);
}
.notice-card.important { border-left-color: var(--warn); }
.notice-card:active { background: var(--surface-2); }
.notice-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.notice-head { display: flex; align-items: center; gap: 0.5rem; font-weight: 700; font-size: 0.95rem; }
.notice-latest { display: block; color: var(--muted); font-size: 0.88rem; margin-top: 0.15rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.notice-latest.unread { color: var(--fg); font-weight: 600; }
/* 一覧の未読ドット・メタ行、詳細の本文、購読エリア */
.unread-dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
.announce-title-line { display: block; }
.announce-meta { display: flex; align-items: center; gap: 0.45rem; color: var(--muted); font-size: 0.8rem; margin-top: 0.2rem; }
.announce-body { white-space: pre-wrap; line-height: 1.7; }
.push-note { margin-bottom: 1rem; }
.push-note p { margin: 0.6rem 0 0; }
.msg.error { background: var(--danger-bg); color: var(--danger); }
.msg.success { background: var(--ok-bg); color: var(--ok); }
.msg.info { background: var(--info-bg); color: var(--info-fg); }
.msg.warn { background: var(--warn-bg); color: var(--warn); }

.center-box { max-width: 430px; margin: 3.5rem auto; background: var(--surface); border: 1px solid var(--line); border-radius: 24px; box-shadow: var(--shadow); padding: 2.4rem 2rem; text-align: center; }
.center-box h2 { margin-top: 1rem; }
.muted { color: var(--muted); }
.fc-input { width: 5.2rem; text-align: right; flex: none; }
.small { font-size: 0.85rem; }

.section-box { background: var(--surface); border: 1px solid var(--glass-border); border-radius: var(--r-lg); box-shadow: var(--shadow); padding: 1.15rem; margin-bottom: 1rem; }

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 2.5rem 1rem;
  z-index: 60;
  overflow-y: auto;
}
/* ---- スケルトン (読み込み中テキストの代替) と起動スプラッシュ ---- */
.skl {
  border-radius: 10px;
  background: linear-gradient(100deg, var(--surface-2) 40%, var(--control) 50%, var(--surface-2) 60%);
  background-size: 200% 100%;
  animation: skl-shimmer 1.15s linear infinite;
}
@keyframes skl-shimmer { from { background-position: 180% 0; } to { background-position: -20% 0; } }
.skl-card { height: 104px; border-radius: var(--r-lg); }
.skl-line { height: 14px; margin: 12px 0; }
.skl-row { height: 26px; margin: 14px 16px; }
.skl-form { height: 190px; border-radius: var(--r-lg); margin-bottom: 12px; }
.splash { display: flex; flex-direction: column; align-items: center; gap: 1rem; margin: 22vh auto 0; text-align: center; }
.splash img { animation: splash-pulse 1.6s ease-in-out infinite; }
.splash-name { font-size: 1.15rem; font-weight: 700; letter-spacing: -0.01em; color: var(--muted); }
@keyframes splash-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.94); opacity: 0.75; } }

.modal { background: var(--surface); color: var(--fg); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); padding: 1.4rem 1.5rem; width: 100%; max-width: 540px; }
.modal h3 { margin-top: 0; }
.modal form.grid { border: none; padding: 0; background: transparent; box-shadow: none; }

/* ---- iOS 風トグルスイッチ (機能フラグのオン/オフ) ---- */
.switch { position: relative; display: inline-block; flex: none; width: 51px; height: 31px; cursor: pointer; }
.switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.switch .track {
  position: absolute;
  inset: 0;
  border-radius: 980px;
  background: var(--control);
  transition: background 0.2s ease;
  pointer-events: none;
}
.switch .track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 27px;
  height: 27px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
  transition: transform 0.2s ease;
}
.switch input:checked + .track { background: #34c759; }
.switch input:checked + .track::after { transform: translateX(20px); }
.switch input:disabled + .track { opacity: 0.5; }
.switch input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ---- 分析レポートの SVG 棒グラフ ---- */
.chart-wrap { background: var(--surface); border: 1px solid var(--glass-border); border-radius: var(--r-lg); box-shadow: var(--shadow); padding: 1.15rem; margin-bottom: 1rem; overflow-x: auto; }
.chart-legend { display: flex; gap: 1.25rem; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.5rem; }
.chart-legend .sw { display: inline-block; width: 0.8rem; height: 0.8rem; border-radius: 3px; margin-right: 0.35rem; vertical-align: -0.08rem; }

/* ---- 在庫一覧: 上部固定ツールバーと絞り込みチップ ---- */
.sticky-bar {
  position: sticky;
  top: calc(3.1rem + env(safe-area-inset-top));
  z-index: 30;
  background: var(--glass);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow);
  padding: 0.6rem 0.7rem;
  margin-bottom: 0.85rem;
}
.sticky-bar .toolbar { margin-bottom: 0.55rem; }
.sticky-bar .toolbar:last-child { margin-bottom: 0; }
.chips { display: flex; gap: 0.45rem; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
.chips::-webkit-scrollbar { display: none; }
.chip {
  flex: none;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--fg);
  border-radius: 980px;
  padding: 0.42rem 0.95rem;
  font-size: 0.88rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}
.chip:active { transform: scale(0.96); }
.chip.active { background: var(--accent); border-color: transparent; color: #fff; }

/* ---- 保存検索チップ (在庫一覧) とフリー在庫の併記 ---- */
.saved-wrap { display: inline-flex; align-items: center; gap: 0.15rem; }
.saved-del {
  border: none; background: transparent; color: var(--muted); cursor: pointer;
  font-size: 1rem; line-height: 1; padding: 0.3rem 0.35rem;
}
.free-note { font-size: 0.78rem; font-weight: 600; color: var(--accent); margin-top: 0.1rem; }

/* ---- 在庫一覧: 行タップと数量の強調 ---- */
.stocks-table tbody tr { cursor: pointer; }
.stocks-table td { padding-top: 0.85rem; padding-bottom: 0.85rem; }
.stock-qty { font-size: 1.15rem; font-weight: 700; text-align: right; font-variant-numeric: tabular-nums; }
th.stock-qty-head { text-align: right; }

/* ---- シート先頭の対象サマリ (在庫行タップ時) ---- */
.sheet-head { padding: 0.95rem 1rem 0.55rem; border-bottom: 1px solid var(--line); }
.sheet-head .sh-name { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.01em; }
.sheet-head .sh-meta { color: var(--muted); font-size: 0.85rem; font-weight: 500; margin-top: 0.1rem; }

/* ---- ダッシュボード「やること」タスクカード ---- */
.task-list { display: grid; gap: 0.6rem; margin-bottom: 0.4rem; }
.task-card {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  padding: 0.9rem 1.05rem;
  background: var(--surface);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow);
  color: var(--fg);
  font-size: 1rem;
  font-weight: 600;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: transform 0.12s ease;
}
.task-card:active { transform: scale(0.98); }
.task-card .row-icon { width: 36px; height: 36px; border-radius: 10px; }
.count-badge {
  flex: none;
  min-width: 1.75rem;
  height: 1.75rem;
  padding: 0 0.5rem;
  border-radius: 980px;
  background: #d70015;
  color: #fff;
  font-size: 0.95rem;
  font-weight: 700;
  display: inline-grid;
  place-items: center;
  font-variant-numeric: tabular-nums;
}
.count-badge.amber { background: #d97a06; }

/* ---- 数量ステッパー (大きな − / ＋ と中央の数字) ---- */
.stepper { display: flex; align-items: stretch; gap: 0.5rem; margin-top: 0.25rem; }
.stepper-btn {
  flex: none;
  width: 52px;
  min-height: 52px;
  border-radius: 14px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--accent);
  font-size: 1.55rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  display: grid;
  place-items: center;
  transition: background 0.12s ease, transform 0.1s ease;
}
.stepper-btn:active { background: var(--control); transform: scale(0.95); }
form.grid .stepper input { margin-top: 0; flex: 1; min-width: 0; text-align: center; font-size: 1.35rem; font-weight: 700; font-variant-numeric: tabular-nums; }

/* ---- フォームの確定ボタン固定バー (ドックの上) ---- */
.sticky-actions {
  grid-column: 1 / -1;
  position: sticky;
  bottom: calc(5rem + env(safe-area-inset-bottom));
  z-index: 20;
  display: flex;
  gap: 0.6rem;
  align-items: center;
  padding: 0.6rem;
  background: var(--glass);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid var(--glass-border);
  border-top: 1px solid var(--line-strong);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-lg);
}
.sticky-actions .btn { flex: 1; padding: 0.8rem 1.25rem; font-size: 1.02rem; font-weight: 600; text-align: center; }

/* ---- バーコードスキャナー (全画面。カメラ映像の上に重ねるため常時ダーク) ---- */
.scanner-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: #000;
  color: #fff;
  display: flex;
  flex-direction: column;
}
.scan-video-wrap { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; background: #000; }
.scan-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.scan-frame {
  position: absolute;
  left: 50%;
  top: 46%;
  width: min(80vw, 430px);
  aspect-ratio: 1.55;
  transform: translate(-50%, -50%);
  border: 2px solid rgba(255, 255, 255, 0.92);
  border-radius: 14px;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.42);
  pointer-events: none;
  transition: border-color 0.12s ease;
}
.scan-frame.hit { border-color: #34c759; }
.scan-frame.miss { border-color: #ff453a; }
.scan-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: calc(0.7rem + env(safe-area-inset-top)) 0.9rem 0.7rem;
}
.scan-title { font-size: 1rem; font-weight: 700; flex: 1; text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6); }
.scan-round-btn {
  flex: none;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(28, 28, 30, 0.72);
  color: #fff;
  font-size: 1.15rem;
  font-family: inherit;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.scan-round-btn.active { background: #f5c518; color: #000; border-color: transparent; }
.scan-round-btn:disabled { opacity: 0.35; }
.scan-seg {
  flex: none;
  display: flex;
  background: rgba(28, 28, 30, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 980px;
  padding: 2px;
  gap: 2px;
}
.scan-seg button {
  border: none;
  background: transparent;
  color: #d1d1d6;
  font-size: 0.82rem;
  font-weight: 600;
  font-family: inherit;
  padding: 0.38rem 0.7rem;
  border-radius: 980px;
  cursor: pointer;
}
.scan-seg button.active { background: #fff; color: #000; }
.scan-status {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0.8rem;
  z-index: 2;
  text-align: center;
  font-size: 0.9rem;
  color: #e5e5ea;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.7);
  padding: 0 1rem;
}
.scan-panel {
  flex: none;
  background: #111113;
  border-top: 1px solid rgba(255, 255, 255, 0.14);
  padding: 0.7rem 0.9rem calc(0.7rem + env(safe-area-inset-bottom));
  max-height: 40vh;
  overflow-y: auto;
}
.scan-panel-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.45rem; }
.scan-panel-title { flex: 1; font-size: 0.92rem; font-weight: 700; }
.scan-sync { font-size: 0.8rem; color: #aeaeb2; }
.scan-sync.saving { color: #ffd60a; }
.scan-sync.error { color: #ff6961; }
.scan-undo-btn {
  flex: none;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: transparent;
  color: #fff;
  border-radius: 980px;
  padding: 0.4rem 0.8rem;
  font-size: 0.85rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.scan-undo-btn:disabled { opacity: 0.35; }
.scan-recent { display: flex; flex-direction: column; }
.scan-recent-row {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  padding: 0.42rem 0.1rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
  font-size: 0.92rem;
}
.scan-recent-row:last-child { border-bottom: none; }
.scan-recent-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scan-recent-qty { font-weight: 700; font-variant-numeric: tabular-nums; }
.scan-recent-time { color: #8e8e93; font-size: 0.78rem; font-variant-numeric: tabular-nums; }
.scan-empty { color: #8e8e93; font-size: 0.88rem; padding: 0.3rem 0.1rem; }
.scan-toast {
  margin-bottom: 0.55rem;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 0.5rem 0.7rem;
  font-size: 0.88rem;
  display: none;
}
.scan-unknown {
  margin-bottom: 0.55rem;
  background: rgba(255, 69, 58, 0.16);
  border: 1px solid rgba(255, 69, 58, 0.45);
  border-radius: 10px;
  padding: 0.55rem 0.7rem;
  font-size: 0.88rem;
  display: none;
}
.scan-unknown .btn { margin-top: 0.45rem; }
.scan-close-bar { flex: none; padding: 0.6rem 0.9rem calc(0.6rem + env(safe-area-inset-bottom)); background: #111113; border-top: 1px solid rgba(255, 255, 255, 0.14); }
.scan-close-bar .btn { width: 100%; }
.scan-pill-btn {
  flex: none;
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(28, 28, 30, 0.72);
  color: #fff;
  border-radius: 980px;
  padding: 0.55rem 0.85rem;
  font-size: 0.85rem;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
}
.scan-pill-btn.active { background: #f5c518; color: #000; border-color: transparent; }
.scan-notice { position: absolute; left: 0.9rem; right: 0.9rem; bottom: 5.2rem; z-index: 3; margin-bottom: 0; background: rgba(66, 18, 15, 0.94); }
`;
