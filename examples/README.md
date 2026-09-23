# Examples

One working applet per shape, to deploy after a platform change and to copy from. They are not packages in the workspace, so `vp run check` does not typecheck them: `npm:` imports and `@std` only resolve inside the bundler script.

| Example | Shape | Shows |
| --- | --- | --- |
| `counter` | JSON API | `sql`, `kv` and `log`: the smallest applet that touches storage, plus a `scheduled` export to set a schedule against |
| `mailbox` | web app with mail | an `inbox` export, `email.send`, and a Preact client over `/api` routes; turn email on in its settings after the push |
| `chat` | web app with AI | `ai.stream` piped to the browser as a streamed response, an `npm:` dependency on both sides, and a `shared/` module |

Deploy one with `vp run push --visibility public examples/counter`, or all of them with `vp run push --examples`, which opens every one except `chat`: it spends the OpenRouter key, so it stays private. `vp run remove <name>` deletes one from the platform.
