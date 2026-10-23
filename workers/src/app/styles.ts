/** /app のスタイル。ビルド基盤を増やさないため TS 文字列として配信する */
export const APP_CSS = `
:root {
  --fg: #1a1a1a;
  --muted: #666;
  --line: #ddd;
  --accent: #1a56db;
  --danger: #b00020;
  --danger-bg: #fdecea;
  --warn: #8a6d00;
  --warn-bg: #fff6d6;
  --ok: #27632a;
  --ok-bg: #e7f5e8;
}
* { box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, "Hiragino Sans", sans-serif;
  margin: 0;
  color: var(--fg);
  line-height: 1.6;
  background: #fafafa;
}
header.app-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: #fff;
  border-bottom: 1px solid var(--line);
}
header.app-header h1 { font-size: 1.1rem; margin: 0; }
header.app-header .spacer { flex: 1; }
.ws-dot { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%; background: #bbb; vertical-align: middle; }
.ws-dot.on { background: #2e9e4f; }
.ws-label { font-size: 0.8rem; color: var(--muted); }
main { padding: 1rem; max-width: 1100px; margin: 0 auto; }
nav.tabs { display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0.6rem 1rem; background: #fff; border-bottom: 1px solid var(--line); }
nav.tabs button {
  border: 1px solid var(--line);
  background: #fff;
  border-radius: 999px;
  padding: 0.35rem 0.9rem;
  cursor: pointer;
  font-size: 0.95rem;
}
nav.tabs button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
h2 { font-size: 1.15rem; margin: 0.5rem 0 0.75rem; }
h3 { font-size: 1rem; margin: 1.25rem 0 0.5rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; }
.card { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 0.9rem; }
.card .num { font-size: 1.6rem; font-weight: 700; }
.card .lbl { color: var(--muted); font-size: 0.85rem; }
.table-wrap { overflow-x: auto; background: #fff; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
th, td { border-bottom: 1px solid var(--line); padding: 0.45rem 0.6rem; text-align: left; white-space: nowrap; }
th { background: #f5f5f5; }
tr:last-child td { border-bottom: none; }
.badge { display: inline-block; padding: 0.05rem 0.5rem; border-radius: 999px; font-size: 0.8rem; background: #eee; }
.badge-danger { background: var(--danger-bg); color: var(--danger); }
.badge-warn { background: var(--warn-bg); color: var(--warn); }
.badge-ok { background: var(--ok-bg); color: var(--ok); }
.qty-neg { color: var(--danger); font-weight: 700; }
.qty-pos { color: var(--ok); font-weight: 700; }
form.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 1rem; }
form.grid label { display: block; font-size: 0.85rem; color: var(--muted); }
form.grid input, form.grid select, form.grid textarea {
  width: 100%;
  padding: 0.45rem;
  border: 1px solid #bbb;
  border-radius: 6px;
  font-size: 1rem;
  margin-top: 0.2rem;
  background: #fff;
  color: var(--fg);
}
.btn {
  display: inline-block;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  border-radius: 6px;
  padding: 0.5rem 1.1rem;
  cursor: pointer;
  font-size: 0.95rem;
  text-decoration: none;
}
.btn.secondary { background: #fff; color: var(--accent); }
.btn.danger { background: var(--danger); border-color: var(--danger); }
.btn.small { padding: 0.25rem 0.7rem; font-size: 0.85rem; }
.btn:disabled { opacity: 0.5; cursor: default; }
.toolbar { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: end; margin-bottom: 0.75rem; }
.toolbar label { font-size: 0.85rem; color: var(--muted); display: block; }
.toolbar input, .toolbar select { padding: 0.45rem; border: 1px solid #bbb; border-radius: 6px; font-size: 1rem; background: #fff; }
.msg { border-radius: 8px; padding: 0.75rem 1rem; margin: 0.75rem 0; }
.msg.error { background: var(--danger-bg); color: var(--danger); }
.msg.success { background: var(--ok-bg); color: var(--ok); }
.msg.info { background: #e8effe; color: #123a8f; }
.msg.warn { background: var(--warn-bg); color: var(--warn); }
.center-box { max-width: 480px; margin: 3rem auto; background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 1.5rem; text-align: center; }
.muted { color: var(--muted); }
.small { font-size: 0.85rem; }
.section-box { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 2.5rem 1rem;
  z-index: 50;
  overflow-y: auto;
}
.modal { background: #fff; border-radius: 8px; padding: 1rem 1.25rem; width: 100%; max-width: 520px; }
.modal h3 { margin-top: 0; }
.modal form.grid { border: none; padding: 0; background: transparent; }
`;
