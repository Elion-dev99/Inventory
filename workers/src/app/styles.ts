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
  --danger: #c81e1e;
  --danger-bg: #fef2f2;
  --warn: #9a6700;
  --warn-bg: #fff8e1;
  --ok: #137333;
  --ok-bg: #e6f4ea;
  --info-bg: #e8effe;
  --info-fg: #123a8f;
  --r-lg: 20px;
  --r-md: 14px;
  --r-sm: 10px;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 10px 30px rgba(0, 0, 0, 0.06);
  --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.16);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000000;
    --surface: #1c1c1e;
    --surface-2: #242426;
    --fg: #f5f5f7;
    --muted: #98989d;
    --line: rgba(255, 255, 255, 0.12);
    --line-strong: rgba(255, 255, 255, 0.24);
    --control: #2c2c2e;
    --header-bg: rgba(22, 22, 24, 0.72);
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

main { padding: 1.25rem 1rem 2rem; padding-bottom: calc(2rem + env(safe-area-inset-bottom)); max-width: 1080px; margin: 0 auto; }

nav.tabs {
  display: flex;
  flex-wrap: nowrap;
  gap: 0.45rem;
  padding: 0.7rem 1rem;
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
  max-width: 1080px;
  margin: 0 auto;
}
nav.tabs::-webkit-scrollbar { display: none; }
@media (min-width: 900px) { nav.tabs { flex-wrap: wrap; overflow-x: visible; } }
nav.tabs button {
  flex: 0 0 auto;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--fg);
  border-radius: 980px;
  padding: 0.42rem 0.95rem;
  cursor: pointer;
  font-size: 0.92rem;
  font-weight: 500;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  transition: background 0.18s ease, color 0.18s ease, transform 0.12s ease;
}
nav.tabs button:active { transform: scale(0.96); }
nav.tabs button.active { background: var(--fg); color: var(--bg); border-color: transparent; }

h2 { font-size: 1.4rem; font-weight: 700; letter-spacing: -0.015em; margin: 0.75rem 0 1rem; }
h3 { font-size: 1.02rem; font-weight: 600; letter-spacing: -0.01em; margin: 1.4rem 0 0.6rem; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(158px, 1fr)); gap: 0.85rem; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 1.05rem 1.1rem; box-shadow: var(--shadow); }
.card .num { font-size: 2.05rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.15; font-variant-numeric: tabular-nums; }
.card .lbl { color: var(--muted); font-size: 0.82rem; font-weight: 500; margin-top: 0.15rem; }

.table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow); -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
th, td { border-bottom: 1px solid var(--line); padding: 0.6rem 0.85rem; text-align: left; white-space: nowrap; }
th { background: var(--surface-2); color: var(--muted); font-size: 0.78rem; font-weight: 600; letter-spacing: 0.04em; }
tbody tr { transition: background 0.12s ease; }
tbody tr:hover { background: var(--surface-2); }
tr:last-child td { border-bottom: none; }

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
.btn.secondary { background: var(--control); color: var(--fg); }
.btn.secondary:hover { background: var(--line-strong); }
.btn.danger { background: #d70015; border-color: transparent; }
.btn.danger:hover { background: #b50011; }
.btn.small { padding: 0.32rem 0.85rem; font-size: 0.85rem; }
.btn:disabled { opacity: 0.45; cursor: default; }

.toolbar { display: flex; flex-wrap: wrap; gap: 0.7rem; align-items: end; margin-bottom: 0.85rem; }
.toolbar label { font-size: 0.82rem; font-weight: 500; color: var(--muted); display: block; }
.toolbar input, .toolbar select { width: auto; margin-top: 0.25rem; }

.msg { border-radius: var(--r-md); padding: 0.8rem 1rem; margin: 0.85rem 0; font-size: 0.92rem; }
.msg.error { background: var(--danger-bg); color: var(--danger); }
.msg.success { background: var(--ok-bg); color: var(--ok); }
.msg.info { background: var(--info-bg); color: var(--info-fg); }
.msg.warn { background: var(--warn-bg); color: var(--warn); }

.center-box { max-width: 430px; margin: 3.5rem auto; background: var(--surface); border: 1px solid var(--line); border-radius: 24px; box-shadow: var(--shadow); padding: 2.4rem 2rem; text-align: center; }
.center-box h2 { margin-top: 1rem; }
.muted { color: var(--muted); }
.small { font-size: 0.85rem; }

.section-box { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow); padding: 1.15rem; margin-bottom: 1rem; }

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
.modal { background: var(--surface); color: var(--fg); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); padding: 1.4rem 1.5rem; width: 100%; max-width: 540px; }
.modal h3 { margin-top: 0; }
.modal form.grid { border: none; padding: 0; background: transparent; box-shadow: none; }
`;
