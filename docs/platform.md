# The platform

## Agents and scripts

The admin API is an OpenAPI document at `https://admin<suffix>/openapi.json`, with a reference page at `https://admin<suffix>/docs`. A script calls it with an API key from the editor's Settings page as the bearer token, and `vp run push` is one such script.

The MCP server at `https://mcp<suffix>/` exposes the same verbs as tools: `list_applets`, `get_applet`, `read_files`, `deploy_applet`, `update_applet`, `fork_applet`, `remove_applet`, `run_applet`, `get_logs`, `get_requests`, `query_sqlite`, `list_kv`, `put_blob`, `list_secrets`, `set_secret`, `remove_secret`, `whoami` and `read_docs`. Its instructions are a few lines that send the agent to `read_docs`, which returns these docs. It needs no key: the router is an OAuth authorization server, so a client registers itself, opens the sign-in page in a browser, and asks for consent once. In Claude Code:

```
claude mcp add --transport http applets https://mcp<suffix>/
```

An agent acts as the person who signed in, with their applets and nobody else's. A person signs in once: the agent's token renews itself, and asks for a sign-in again only after a year without use. The editor's Settings page has an Agents section with the same instructions.

## Access

One deployment is one group of people: an admin, and the family and friends the admin lets in. A person has a role, an applet has an owner and a visibility, and one pure function, `can(subject, action, applet)` in `packages/router/src/policy.ts`, turns the pair into yes or no. Nothing else in the router decides access. Nobody keeps a list of people on one applet, so there is no "share with this email".

Roles:

- `admin`: the address in `OWNER_EMAIL`. One person, set at deploy, not stored
- `user`: an email in the `users` table

An unauthenticated request has no role. The code represents it as `null`.

Each applet has one owner, the user whose deploy created it, and one visibility the owner sets on the editor's Settings page. A new applet is `private`.

| | `private` | `family` | `public` |
| --- | --- | --- | --- |
| `use`, as the owner | yes | yes | yes |
| `use`, as another user or the admin | no | yes | yes |
| `use`, as a stranger | no | no | yes |
| `edit` | the owner only | the owner only | the owner only |
| `remove` | the owner and the admin | the owner and the admin | the owner and the admin |

`use` is reaching the applet over HTTP. `edit` is everything about its code and data: source, drafts, deploy, rollback, logs, requests, emails, the storage pages, secrets, settings and run now. Logs are in that set because a log line can carry a secret. The admin never reads another user's code or logs through the product. This is a boundary in the API and the editor, not in cryptography, since the admin holds the Cloudflare account.

What the admin has on top of being a user:

- `GET /applets` lists every applet with its owner, visibility and triggers; a user gets their own. Each row carries `failures`, the failed runs of the last 24 hours, counted on the caller's own applets only
- remove any applet
- the users routes and `GET /emails/unclaimed`

Applet names are hostnames, so every user shares one namespace, first come first served. A deploy to a name someone else owns answers 403, and so does a rename or a fork onto a name anyone holds.

Identity comes from [Better Auth](https://www.better-auth.com), running inside the router on the registry database, with a magic link as the only way in: the sign-in page takes an email, the router sends a one-time link through its email binding, valid for an hour, and pressing the button on the page it opens sets the session cookie. The link lands on a page rather than the verify route because mail scanners such as Outlook's Safe Links open every link they see, and the token is spent on first use.

There are no invites. The admin adds an email to `users` on the editor's Settings page, and from then on that address can ask for a link. An address outside the table gets no email and no Better Auth row, and the page says the same thing either way. The first sign-in of an allowed address creates its Better Auth row; one-time setup for a new person would go in `databaseHooks.user.create.after`, and nothing needs it today. Removing a user deletes their row, their sessions and their API keys, so they are out at once. Their applets stay and keep running until the admin removes them.

A session lasts 30 days and slides: any request after a day of use pushes the expiry out another 30 days, so one link a month is the ceiling for a daily user. A signed cookie caches the Better Auth session for 5 minutes. The router still checks `users` on every authenticated request, so the cache does not delay removal. Cookies are set for the host suffix, so one sign-in covers every applet subdomain. That needs a real suffix: `*.localhost` cannot share a cookie, so sign-in is only exercised on the public host.

### API keys

A user makes a key on the editor's Settings page and sees it once. The registry keeps its SHA-256 hash, the creator's email, a name, and when it was made and last used. A request with `Authorization: Bearer <key>` is its creator, except on a public applet, where all callers stay anonymous:

- on `admin.<suffix>` a key does what its creator could do in the editor, which is what a script or an MCP server uses
- on an applet's hostname a key lets a script reach its creator's `private` applets and everyone's `family` ones

`subject(headers)` in `auth.ts` is the one place a request becomes a subject: a bearer credential first, which is an OAuth access token when it has a JWT's three parts and an API key otherwise, else the session, else `null`. `ADMIN_TOKEN` from `secrets.env` is the bootstrap key and acts as the admin. Public applets skip identity lookup and receive no `x-applet-user`, even when the caller is signed in or uses a key.

## Secrets

An applet's own secrets are its owner's: a provider key, a webhook token. The owner sets them on the Secrets page, and the code reads one with `secret("NAME")` from `@std`, which throws when it is not set. They are rows in the registry's `secrets` table, in plain text: the Cloudflare account holder can read D1 either way, and a key held in a router secret would not change that. The API takes a value and never returns one. The supervisor reads them inside the loader callback and places them in the loaded `env` as `SECRETS`. `env` is fixed at load, so every change bumps `applets.secrets_rev`, which is part of the target, the loader key and the facet key: the next request loads the worker again with the new set and the facet restarts, keeping its storage.

## The editor

An open applet is one screen with a left rail of pages: Code, Logs, Requests, Emails, SQLite, KV, Blobs, Secrets, Versions and Settings. The top bar is a breadcrumb, the state pill, and Save and Deploy. Code is the file tree, tabs and the editor pane, with the live applet in an optional preview beside it and the bundler's errors and warnings from the last deploy under it. Logs and Requests follow the two registry tables, filtered to the current version by default with a switch to all versions. Logs follows both, to put each run's lines under its request row. Requests has a small bar chart above the list, the last 24 hours or 7 days across every version, failures in red. Emails lists the applet's mail in and out. SQLite lists the applet's tables with row counts, runs any statement against the live database, and downloads a dump as SQL, which the page builds from queries; the runtime's own `_cf_` tables, `kv` among them, and SQLite's own `sqlite_` objects are left out. KV lists keys by prefix with values as JSON, Blobs lists the bucket under the applet's prefix and uploads a file under it, and both delete. Secrets sets and deletes the applet's secrets and shows names only. Versions is the list with the files each one changed, and view and rollback per row. Settings shows the registry row, renames the applet, sets the description, visibility, egress, schedule and email switch, fires the schedule now, forks the live version into a new applet, lists the live version's dependencies with 're-resolve', downloads the live source as a zip the page builds itself, and discards the draft. Its danger zone removes the applet once its name is typed.

Home shows the user's six most recently changed applets as cards: name, description, visibility and trigger badges, when it last changed, and a red dot when the last 24 hours had failed runs. The Applets page lists them all with search; the admin's also lists everyone else's applets with their owner, which do not open and can be removed. New applet is a button on both: it names the applet and deploys the template as v1, or the files of a zip picked from disk, which is how a downloaded source comes back; the page reads the zip itself. The platform Logs page lists runs across the user's own applets, newest first, with filters for applet, status and trigger kept in the query string; a row opens to the lines that run wrote. For the admin it has a second view, platform, which is `platform_logs` newest first with a level filter, each line linking to its applet. The platform Settings page has one section per URL under `/settings/`. For every user: profile, browser sessions with revoke, and API keys. For the admin: users, the schedules of every applet, unclaimed mail, and read-only platform info, which is the host suffix, the admin, the mail sender, the default model and how long logs and emails are kept. The editor's own events, saved, deployed, rolled back, go to the status line and never into the log stream.

A draft is stored source and nothing else. The editor has no preview environment: Deploy makes a real version current, so the live applet swaps to it and keeps its storage. A save is live at once and the database is one per applet, shared by every version of it.
