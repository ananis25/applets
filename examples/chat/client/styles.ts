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
  --user: #eff6ff;
  --code: #f5f5f4;
  --error: #b91c1c;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
#app { height: 100dvh; display: flex; flex-direction: column; }

header {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); background: var(--panel);
}
header h1 { margin: 0; font-size: 1rem; font-weight: 600; }
header button { font-size: 0.85rem; }

.thread { flex: 1; overflow-y: auto; padding: 1.5rem 1rem; }
.thread-inner { max-width: 44rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1.25rem; }

.empty { text-align: center; color: var(--muted); margin-top: 4rem; }
.empty p { margin: 0 0 1rem; }
.suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem; }
.suggestions button {
  background: var(--panel); border: 1px solid var(--line); border-radius: 999px;
  padding: 0.4rem 0.9rem; color: var(--ink); cursor: pointer; font-size: 0.9rem;
}
.suggestions button:hover { border-color: var(--accent); color: var(--accent); }

.message { display: flex; }
.message.user { justify-content: flex-end; }
.message.user .bubble {
  background: var(--user); border-radius: 1rem 1rem 0.25rem 1rem;
  padding: 0.6rem 0.9rem; max-width: 85%; white-space: pre-wrap; overflow-wrap: anywhere;
}
.message.assistant .bubble { max-width: 100%; min-width: 0; overflow-wrap: anywhere; }
.message.error .bubble { color: var(--error); }

.bubble > :first-child { margin-top: 0; }
.bubble > :last-child { margin-bottom: 0; }
.bubble p, .bubble ul, .bubble ol { margin: 0.5rem 0; }
.bubble pre {
  background: var(--code); border: 1px solid var(--line); border-radius: 0.5rem;
  padding: 0.75rem; overflow-x: auto; font-size: 0.85rem; line-height: 1.5;
}
.bubble code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.9em; }
.bubble :not(pre) > code { background: var(--code); padding: 0.1rem 0.3rem; border-radius: 0.25rem; }
.bubble a { color: var(--accent); }
.bubble table { border-collapse: collapse; }
.bubble td, .bubble th { border: 1px solid var(--line); padding: 0.25rem 0.5rem; }

.cursor {
  display: inline-block; width: 0.5em; height: 1em; margin-left: 0.1em; vertical-align: -0.15em;
  background: var(--ink); animation: blink 1s steps(2) infinite;
}
@keyframes blink { to { visibility: hidden; } }

.typing { display: inline-flex; gap: 0.3rem; padding: 0.5rem 0; }
.typing i {
  width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--muted);
  animation: pulse 1.2s ease-in-out infinite;
}
.typing i:nth-child(2) { animation-delay: 0.2s; }
.typing i:nth-child(3) { animation-delay: 0.4s; }
@keyframes pulse { 0%, 80%, 100% { opacity: 0.25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-0.2rem); } }

.composer { border-top: 1px solid var(--line); background: var(--panel); padding: 0.75rem 1rem; }
.composer form {
  max-width: 44rem; margin: 0 auto; display: flex; gap: 0.5rem; align-items: flex-end;
  background: var(--bg); border: 1px solid var(--line); border-radius: 1rem; padding: 0.5rem 0.5rem 0.5rem 0.9rem;
}
.composer form:focus-within { border-color: var(--accent); }
textarea {
  flex: 1; resize: none; border: 0; background: transparent; font: inherit; color: inherit;
  max-height: 12rem; padding: 0.35rem 0; outline: none;
}
.composer .hint { max-width: 44rem; margin: 0.4rem auto 0; font-size: 0.75rem; color: var(--muted); text-align: center; }

button {
  font: inherit; cursor: pointer; border: 1px solid var(--line); border-radius: 0.6rem;
  background: var(--panel); color: var(--ink); padding: 0.45rem 0.9rem;
}
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button.primary:disabled { opacity: 0.4; cursor: default; }
button.stop { background: var(--ink); border-color: var(--ink); color: var(--panel); }

@media (max-width: 480px) {
  .thread { padding: 1rem 0.75rem; }
  .composer .hint { display: none; }
}
`;
