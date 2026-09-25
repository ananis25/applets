# Agent instructions

`README.md` is the intent. `docs/development.md` is the commands and local setup, `docs/architecture.md` is the design, `docs/applets.md` and `docs/platform.md` are what an applet and a deployment can do. Read what fits the task.

- Never commit. The owner does.
- Use `vp` directly: `vp install`, `vp run check --fix`, `vp run test`. Never `npx vp`, `npm` or `npx`.
- Keep private choices out of the repo: no real domain, email, account ids or paths from a local machine. Use `example.com` and `.localhost` placeholders.
- Something deployed misbehaves: run `vp run tail` in the background, reproduce, read the `!` lines. Then reproduce on `vp run dev` before reading code. Do this before probing the platform by hand.
- Never back up state by copying or renaming files or folders (`.wrangler.before-ids/`, `foo.old.ts`). Git is the backup. Delete what is in the way.

## This is a playground

This is a personal project, optimized for simplicity. It is not a product: one deployment serves its admin and a few people they know, and nobody else runs it.

That changes what good engineering looks like here:

- throw code away. A rewrite that leaves the code smaller beats a patch that keeps the old shape around
- bias against handling obscure edge cases or backwards compatibility chunks without checking with the user first.
- build on what exists: Workers, shadcn, Better Auth, Cloudflare Email Service. Use a lightweight library when it replaces custom code without adding more complexity than it removes
- write tests when they help iterate, not for their own sake
- keep notes on what was learned; the README and `docs/` are the specification of what exists, not a history
