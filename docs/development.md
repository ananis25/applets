# Development

How to develop and deploy the platform. The design is in [architecture.md](architecture.md).

## One-time setup

Local development needs the first two steps. Deploying needs all of them, once per host and account. After that every command below runs without a person.

**The toolchain is [Vite+](https://vite.plus). Use `vp` for every install, check, build and script, and `vpx` in place of `npx`. Never call `npm` or `npx` directly.**

1. `vp install`.
2. Copy `secrets.env.example` to `secrets.env` and fill it in. It is never committed.
3. `vpx wrangler login`. Every deploy step, and the few Cloudflare API calls the scripts make themselves, run with that login.
4. In the Cloudflare dashboard, on the zone of the host suffix, add one DNS record: type `AAAA`, name `*`, value `100::`, proxied. The wildcard route needs a record to attach to, and wrangler's login has no DNS permission, so no script can add it.
5. For email, in the same dashboard: onboard the zone in Email Service for sending, enable Email Routing, and optionally verify the owner's address as a destination, so mail to it is free. The deploy sets the catch-all rule itself.

The account needs the Workers Paid plan. [docs/architecture.md](docs/architecture.md) lists every resource under "Infrastructure inventory".

## Everyday commands

All from this directory, all scripts in `package.json`, run with `vp run`.

| Command | Does |
| --- | --- |
| `vp install` | install the workspace |
| `vp run check` | typecheck, lint and format every package; `vp check --fix` writes the fixes |
| `vp run test` | the test suites |
| `vp run dev` | the local platform and the editor page against it, see "Local development" |
| `vp run dev:remote` | the editor page on localhost against the deployed platform, see "Local development" |
| `vp run push <path>` | upload one applet directory to the deployed platform; `push:local` for the local one. A new applet is `private`, and `--visibility family` or `--visibility public` opens this one; without the flag a push leaves the setting alone |
| `vp run push --examples` | push every example applet as public, except `chat`, which spends the OpenRouter key, and `GET` each public one, which must answer 2xx: the check after a platform change; `vp run push:local --examples` for the local platform |
| `vp run remove <name>` | delete one applet from the deployed platform with its versions, storage and blobs; `remove:local` for the local one |
| `vp run deploy` | build the editor, `wrangler deploy` the bundler, the editor and the router, upload the router's secrets, and point the mail catch-all rule at the router. The platform deploys when the platform changes, not when an applet does |
| `vp run deploy <worker>...` | the same for only the workers named, any of `bundler`, `editor` and `router`, always in that order |
| `vp run ship` | `deploy`, then `push --examples` |
| `vp run destroy` | list what the platform holds on the account; `vp run destroy --yes` deletes it: the three workers with every applet's storage, the registry and both buckets. The zone's DNS record, Email Routing and destination addresses stay |
| `vp run tail` | follow the deployed router's console output |

Secrets and the host suffix live in `secrets.env`, copied from `secrets.env.example`, never committed.

## Workflows

What to run for each kind of change, once "One-time setup" is done.

| You changed | Run |
| --- | --- |
| the editor page, and want to see it while you work | `vp run dev:remote` for the page against the deployed platform, or `vp run dev` against the local one |
| the router, the bundler or `@std`, and want to try it | `vp run dev`, then `vp run push:local --examples` to fill the local registry |
| the editor page, and want it live | `vp run deploy editor` |
| the router, the bundler or `@std` | `vp run deploy router bundler`. `@std` is bundled into the bundler, so it counts as a bundler change |
| the page and the backend, or you are not sure | `vp run ship`, which deploys all three and pushes the examples as the check |
| the registry schema, a Durable Object class, a resource name, or anything else the deployed state would fight | `vp run destroy --yes`, then `vp run ship`. It costs one new magic link |

`vp run destroy` without `--yes` is always safe: it prints what exists and deletes nothing.

## Local development

There are two ways to run the platform on your machine. Both open the same editor page on Vite, with hot reload, at `http://localhost:5173`. They differ in which platform the page talks to.

| | `vp run dev` | `vp run dev:remote` |
| --- | --- | --- |
| Use it for | work on the router, the bundler or `@std`, with or without the page | work on the editor page with real data |
| Router and bundler | local, one `wrangler dev` on port 8787 | the deployed ones |
| Registry, blobs, applet storage | local files under `.wrangler/` | the real D1 database, R2 buckets and Durable Objects |
| Touches the Cloudflare account | never | every read and write, including Deploy and Remove |
| A backend change shows up | on save, `wrangler dev` reloads | after `vp run deploy` |
| Needs | `secrets.env` | `secrets.env` with the public suffix, and a deployed platform |

### Everything local, `vp run dev`

`vp run dev` starts two processes and stops both when either exits:

- `wrangler dev` with the router and the bundler on port 8787. D1, R2 and Durable Object state are local files under `.wrangler/`. Nothing reaches the account
- the editor page on Vite, which proxies `/api/` to `http://admin.localhost:8787` with the admin token

`<applet>.localhost` resolves to loopback in every browser, so the router routes by hostname with no DNS. Before it starts, the script writes `packages/router/.dev.vars` from `secrets.env`, always with the `.localhost` suffix whatever the file names.

The local registry starts empty. `vp run push:local --examples` fills it, and `vp run push:local <path>` uploads one directory.

Received mail can be simulated locally: wrangler's `POST http://localhost:8787/cdn-cgi/handler/email?from=<sender>&to=<applet>@localhost` with an RFC 822 message as the body reaches the router's `email` handler and the applet named by the local part. Sent mail is accepted locally and goes nowhere.

Nothing local asks for sign-in. The script writes the owner's email to `.dev.vars` as `DEV_USER`, and the local router treats every request without a bearer key as that user, who is the admin. So a private applet answers `curl http://<applet>.localhost:8787/` and opens in a browser. The router only reads `DEV_USER` when its suffix is `.localhost`, and a deploy never uploads it.

To reset the local state, stop `vp run dev` and delete `packages/router/.wrangler/`.

The editor tests stub `fetch` with rows in the contract's shape. The client decodes every answer against `packages/api`, so a stub missing one field is a refused response and the page shows the decode error; when a fixture breaks, every test waits out its matcher timeout, which looks like a stall. Run one test with `-t` first.

The sign-in flow itself does not work locally, because `*.localhost` cannot share a cookie across subdomains. So the magic link, the 401 and the redirect for a missing session, and the `users` table are only checked on the deployed platform. The local `wrangler dev` also leaves the editor worker out: the Vite page is the local editor.

### The page against the deployed platform, `vp run dev:remote`

`vp run dev:remote` starts only the editor page on Vite. It proxies `/api/` to `https://admin<suffix>` with the admin token from `secrets.env`, so the page needs no session. It shows the real applets, logs and versions, and every action in it is real: Deploy makes a live version, Remove deletes the applet and its storage.

The router and the bundler do not run locally in this mode. A backend change needs `vp run deploy` before the page sees it. The live preview points at the real applet hosts, so a private applet shows the sign-in page there until the browser has a session for the suffix.

There is no mode that runs a local router against the real database. Wrangler's remote bindings do not cover Durable Objects or the Worker Loader, and the router is mostly those two.

## Repo layout

```
applets/
  README.md            what this is and why
  docs/                applets.md, platform.md, development.md and architecture.md
  package.json         the Vite+ workspace and its everyday scripts
  packages/
    router/            the first script, the only one with a route
    bundler/           the second script, esbuild-wasm plus an npm installer
    std/               the library applets import
    cli/               the repo's scripts: push, deploy, dev
    editor/            the third script, a Vite React page over the admin API
    ui/                the design system both pages build on: shadcn components on Base UI, one theme
  examples/            one working applet per shape, deployed after every platform change
  tools/               the vendored anti-slop lint plugin
```

## References

- [Cloudflare dynamic workers and facets](https://developers.cloudflare.com/dynamic-workers/)
- [@cloudflare/worker-bundler](https://github.com/cloudflare/agents/tree/main/packages/worker-bundler)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Better Auth](https://www.better-auth.com/docs)
