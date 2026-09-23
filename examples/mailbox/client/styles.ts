/** The page's stylesheet, injected once by the client since the bundle is a single script. */
export const styles = `
:root {
  --bg: #fafaf9;
  --panel: #ffffff;
  --ink: #1c1917;
  --muted: #78716c;
  --line: #e7e5e4;
  --accent: #2563eb;
  --accent-ink: #ffffff;
  --selected: #eff6ff;
  --ok: #15803d;
  --error: #b91c1c;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
#app { height: 100dvh; display: flex; flex-direction: column; }

header {
  display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
  padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); background: var(--panel);
}
header h1 { margin: 0; font-size: 1rem; font-weight: 600; }
.address {
  display: inline-flex; align-items: center; gap: 0.5rem;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.9rem;
  background: var(--bg); border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.25rem 0.25rem 0.25rem 0.6rem;
}
.address button { padding: 0.15rem 0.5rem; font-size: 0.8rem; }
header .grow { flex: 1; }

.tabs { display: flex; gap: 0.25rem; padding: 0.5rem 1rem 0; border-bottom: 1px solid var(--line); background: var(--panel); }
.tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--muted); padding: 0.4rem 0.75rem; }
.tabs button.active { color: var(--ink); border-bottom-color: var(--accent); }
.tabs .count { color: var(--muted); font-size: 0.8rem; margin-left: 0.3rem; }

.panes { flex: 1; min-height: 0; display: grid; grid-template-columns: 22rem 1fr; }
.list { overflow-y: auto; border-right: 1px solid var(--line); background: var(--panel); }
.detail { overflow-y: auto; padding: 1.5rem; }

.row {
  display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--line); border-radius: 0;
  background: none; padding: 0.75rem 1rem; cursor: pointer;
}
.row:hover { background: var(--bg); }
.row.selected { background: var(--selected); }
.row .line { display: flex; justify-content: space-between; gap: 0.5rem; }
.row .who { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .when { color: var(--muted); font-size: 0.8rem; white-space: nowrap; }
.row .subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .preview { color: var(--muted); font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.empty { color: var(--muted); padding: 2rem 1rem; text-align: center; }

.message h2 { margin: 0 0 0.75rem; font-size: 1.2rem; }
.meta { color: var(--muted); font-size: 0.85rem; display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.75rem; margin-bottom: 1.25rem; }
.meta dt { margin: 0; }
.meta dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }
.body { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 44rem; }
iframe.body { width: 100%; max-width: none; height: 60vh; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--panel); }
.attachments { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: 0.9rem; }
.attachments a { color: var(--accent); margin-right: 1rem; }
.attachments span { color: var(--muted); }
.back { display: none; margin-bottom: 1rem; }

.compose { max-width: 40rem; display: flex; flex-direction: column; gap: 0.75rem; }
.compose h2 { margin: 0; font-size: 1.2rem; }
.compose input, .compose textarea {
  width: 100%; font: inherit; color: inherit; border: 1px solid var(--line); border-radius: 0.5rem;
  padding: 0.5rem 0.7rem; background: var(--panel);
}
.compose input:focus, .compose textarea:focus { outline: none; border-color: var(--accent); }
.compose textarea { min-height: 12rem; resize: vertical; }
.compose .actions { display: flex; gap: 0.5rem; align-items: center; }
.status { font-size: 0.9rem; }
.status.ok { color: var(--ok); }
.status.error { color: var(--error); }

button {
  font: inherit; cursor: pointer; border: 1px solid var(--line); border-radius: 0.5rem;
  background: var(--panel); color: var(--ink); padding: 0.4rem 0.8rem;
}
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button:disabled { opacity: 0.5; cursor: default; }

@media (max-width: 720px) {
  .panes { grid-template-columns: 1fr; }
  .panes.showing-detail .list { display: none; }
  .panes:not(.showing-detail) .detail { display: none; }
  .detail { padding: 1rem; }
  .back { display: inline-block; }
  header .grow { display: none; }
}
`;
