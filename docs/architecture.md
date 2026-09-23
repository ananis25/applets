# Architecture

How the platform is built and why. Commands and local development are in [development.md](development.md), writing an applet in [applets.md](applets.md), and using a deployment in [platform.md](platform.md).

## Why this design

The Workers programming model is what makes single-file applets pleasant, and it has every primitive a platform like this needs: Durable Objects with SQLite, KV, D1, R2, cron and dynamic workers.

Applets are loaded code, not scripts of their own. A loaded worker's `env` may carry service bindings and plain values, and `globalOutbound` may be a Fetcher or `null`, so the platform hands each applet exactly the capabilities it should have:

- a facet is a Durable Object class from loaded code, with its own SQLite, run inside a supervisor Durable Object we control
- one Durable Object binding covers every applet, present and future, because instances are addressed by the applet's id at runtime
- egress policy is a per-applet choice at load time
- a new version is a new load; the old isolate goes away when nothing references it
- writes are fast: inside a facet an insert is a synchronous local call, where a shared store would cost an RPC per write

The cost: one facet instance per applet, so one applet's storage-only work is serialised. Fine for a handful of people.

## The shape of a deployment

```
the zone, one wildcard route, *<suffix>/*
  applets-router    every request on the suffix enters here
  applets-bundler   reached only over the router's BUNDLER service binding
  applets-editor    reached only over the router's EDITOR service binding

loaded code, no wrangler config, one module per version in a registry row
  applet       run as a facet inside the applet's supervisor Durable Object
```

Terms used throughout:

- a facet is a Durable Object running inside another one, with its own SQLite, from a class the parent loaded
- a script, or worker, is one Wrangler project, deployed with `wrangler deploy`

The router is the whole front door. One route, `*<suffix>/*`, sends every hostname one level under the suffix to it, and it routes by hostname from there. The apex is not matched. Every host under the suffix is public and the router gates what needs gating: a user for `private` and `family` applets and for the editor on `app.<suffix>`, a bearer key on `admin.<suffix>`, an OAuth access token on `mcp.<suffix>`. The bundler and the editor have no route; they exist only because the router's `services` name them, which is why the router deploys last.

The suffix is host-specific and never committed. It lives in `secrets.env`, and `vp run deploy` derives the route and the zone name from it.

The editor script has a `main` that forwards to its assets binding, because an asset-only script cannot answer a service binding call.

## The shape of a deployment, in detail

### The scripts and what they export

The router, `packages/router`. Bindings: `LOADER` the Worker Loader, `REGISTRY` D1, `APPLET_BLOBS` R2, `SUPERVISOR` a Durable Object, `BUNDLER` and `EDITOR` service bindings, and a cron every 10 minutes. It exports:

- the default handler: ingress by hostname, Better Auth's routes, the admin API and its OpenAPI document, the MCP server, the `email` handler for received mail, and the cron that vacuums logs, requests, emails and attachments
- `Supervisor`, the one Durable Object class declared anywhere, one instance per applet, addressed by applet id
- five `WorkerEntrypoint` classes that are capabilities, not routes: `Logs`, `Blobs`, `Email`, `AI` and `Egress`. The loader stamps each with the applet's name and version and puts it in the loaded applet's `env`

The bundler, `packages/bundler`. One binding, `DEPS`, the R2 cache of installed `node_modules` trees. It exports the `Bundler` entrypoint the router calls as `env.BUNDLER.build(files)`. It has no routes.

The editor, `packages/editor`. Static assets plus a `worker.ts` that forwards to `ASSETS`. Two pages: the editor at `/`, and the sign-in page at `/auth`, which the router serves on `auth.<suffix>` as `/`, `/confirm` and the OAuth `/consent`. The sign-in page is a top-level `auth.html`, not a nested `auth/index.html`: the assets binding would redirect `/auth` to `/auth/`, the router rewrites every sign-in path back to `/auth`, and the two would loop. The router sends `app.<suffix>` to it and answers `/api/` itself. It has no bindings.

### Durable Objects

- `Supervisor(name)` holds the version it last ran, the cron expression and the alarm. On a request it compares the stamped version, aborts the facet on a change, gets or loads the facet, and forwards
- the applet facet is `App` from the generated entry: a Durable Object class from loaded code, inside the supervisor, with its own SQLite file. `sql` and `kv` live here. Only its supervisor can reach it
- the D1 registry and the two R2 buckets are reached through bindings

### Where state lives

| State | Where |
| --- | --- |
| applet rows, versions, drafts, users, API keys, sessions, OAuth clients and tokens, logs, requests, emails, the platform's own log | D1 `applets-registry` on the router |
| an applet's `sql` and `kv` | the facet's SQLite, inside its supervisor |
| an applet's `blob` | R2 `applets-blobs`, keys prefixed with the applet's id |
| a schedule and its next fire | the supervisor's storage and alarm |
| installed dependency trees | R2 `applets-deps` |

### The request paths

1. `<applet>.<suffix>`: router ingress, registry lookup by hostname and policy check, `SUPERVISOR.getByName(id)`, facet, the applet's `fetch`. An outbound `fetch()` from the applet comes back through the router's `Egress` entrypoint, or is refused when egress is `none`. A `fetch()` to another applet's hostname is dispatched inside the router, see "Applets calling applets".
2. `app.<suffix>`: the router needs a signed-in user, then `/api/` is answered by the admin API as that user and everything else is forwarded to the editor's assets.
3. `admin.<suffix>`: router, bearer key, admin API as the key's creator. `vp run push` and the Vite page use this with `ADMIN_TOKEN`.
4. `PUT /applets/:name/versions`: router, `BUNDLER.build`, a new version row, a poke to the supervisor.
5. `auth.<suffix>`: router, Better Auth, which is also the OAuth authorization server under `/api/auth/oauth2/` and `/.well-known/`.
6. `mcp.<suffix>`: router, OAuth access token, the MCP server's tools over the admin services as the token's user. `GET /.well-known/oauth-protected-resource` says where the token comes from.
7. Mail to `<applet>@<domain>`: Email Routing, the router's `email` handler, registry lookup by the local part, `SUPERVISOR.getByName(id)`, the applet's `inbox` export.

## Infrastructure inventory

Everything a working deployment needs on the Cloudflare account, one line each. Today `vp run deploy` creates or updates the rows marked deploy, and a person sets up the rows marked by hand once, in the dashboard.

Account and zone:

- Workers Paid plan, by hand: outbound email to unverified addresses and the bundler's 60-second CPU limit need it
- a zone on Cloudflare DNS for the host suffix, by hand
- a proxied wildcard `AAAA` record, name `*`, value `100::`, by hand: the wildcard route needs a record to attach to
- `wrangler login` on the host, by hand: every deploy step runs through wrangler with that login

Compute:

- worker `applets-bundler`, deploy: no route, `cpu_ms` limit 60000, `nodejs_compat`
- worker `applets-editor`, deploy: no route, static assets from the Vite build in `packages/editor/dist`, so the build runs first
- worker `applets-router`, deploy: last of the three, because its service bindings to the other two resolve at deploy
- route `*<suffix>/*` on the zone to `applets-router`, deploy: written into the git-ignored `wrangler.local.jsonc`, since the suffix is never committed
- cron trigger `*/10 * * * *` on the router, deploy
- Durable Object namespace `Supervisor` on the router, SQLite-backed, migration tag `v1`, deploy: deleting the router deletes every applet's storage with it
- worker loader binding `LOADER` on the router, deploy: loads applet code from registry rows, no resource behind it
- service bindings on the router, deploy: `BUNDLER` to `applets-bundler` entrypoint `Bundler`, `EDITOR` to `applets-editor`
- Workers Logs on the router, deploy: `observability.logs.enabled`

Storage:

- D1 database `applets-registry`, binding `REGISTRY`, deploy: created when missing, and its id spliced into `wrangler.local.jsonc`; the schema is created by the router on first use, no migrations
- R2 bucket `applets-blobs`, binding `APPLET_BLOBS` on the router, deploy: applet blobs and received attachments
- R2 bucket `applets-deps`, binding `DEPS` on the bundler, deploy: the npm package cache

Email:

- `send_email` binding `MAILER` on the router, deploy
- the zone onboarded in Email Service for sending, by hand: adds MX, SPF and DKIM on `cf-bounce.<domain>` and a DMARC record
- Email Routing enabled on the zone, by hand: adds the apex MX, SPF and DKIM records, so the apex can take mail nowhere else
- catch-all routing rule with the action send to worker `applets-router`, deploy: set and turned on after every router deploy through the Cloudflare API, because Cloudflare turns it off when the router is deleted. No other rule or destination address is touched
- the owner's address as a verified destination address, by hand and optional: mail to it is then free

Secrets, all on the router, deploy, from the host-only `secrets.env` through `wrangler secret bulk`:

- from the file: `BETTER_AUTH_SECRET`, `EMAIL_FROM`, `OWNER_EMAIL`, `OPENROUTER_API_KEY`
- derived: `ADMIN_TOKEN_HASH` from `ADMIN_TOKEN`, `HOST_SUFFIX` and `AUTH_URL` from `APPLET_HOST_SUFFIX`

After the platform, `vp run push --examples` pushes the example applets through the admin API as the check that the platform answers. `vp run destroy --yes` deletes every deploy row under Compute and Storage, the router first, and leaves the zone's rows alone.

## The build

A deploy is a `PUT` of the applet's files to `/applets/<name>/versions` on the admin API. The editor's Deploy button sends it, and `vp run push <path>` sends the same thing for a directory, named after the directory. The router calls `env.BUNDLER.build(files)`, which does, in order:

1. Scan `main.ts` for its exports, every file for `npm:` specifiers, and check the `client/` rules.
2. Rewrite `npm:zod@3` to `zod` and `@std` to the bundled copy of the library.
3. Add `@std`'s source and the generated entry to the file map, write a `package.json` from the dependency map, install from the cache or the registry.
4. Bundle the client for the browser when `client/main.tsx` exists, then bundle the entry for the loader with the client inlined.
5. Return the module, the export list and the installed versions. Errors come back as data; the editor lists them and `push` prints them.

The router stores the result as the applet's next version, numbered from 1, makes it current, and pokes the supervisor so the next request swaps. A failed build returns the errors and changes nothing: the version that was live stays live. D1 caps a row at 2 MB, so a source file is one `file_contents` row and the bundle is split into `bundle_parts` rows of at most 1.9 MB, each under the SHA-256 of its text; the version row lists the hashes, and it and any new text are written in one transaction. A source file past 1,900,000 bytes fails the same way, with a message that gives the size. A bundle costs 20 to 500 ms plus a one-time 200 ms wasm start per isolate.

[Cloudflare allows](https://developers.cloudflare.com/workers/platform/limits/#worker-size) a platform Worker bundle up to 64 MiB uncompressed on both Free and Paid plans, with no compressed-size limit. This applies to the platform workers, not the 1,900,000-byte applet version-row check above.

The generated entry wraps `main.ts` in the Durable Object class the supervisor runs:

```ts
import { DurableObject } from "cloudflare:workers";
import { bind, handle, inspect } from "./applet-std.ts";
import client from "applet:client";
import * as applet from "./main.ts";

export class App extends DurableObject {
  constructor(ctx, env) { super(ctx, env); bind(ctx); }
  async fetch(request) {
    if (new URL(request.url).pathname === "/main.js") return new Response(client, { headers: { "content-type": "text/javascript" } });
    return handle(request, applet.fetch);
  }
  inspect(call) { return inspect(call); }
}
```

The `/main.js` branch is only generated when the applet has a `client/` directory. `handle` runs the handler with the run's id in an `AsyncLocalStorage`, which is how `log` knows the request it is writing for; see "Logs". `inspect` is an RPC method only the supervisor can reach, since nothing else holds the facet's stub. It is how the editor's SQLite and KV pages read the applet's storage: `@std` runs one statement, or lists or deletes `kv` keys, and a statement SQLite refuses comes back as `{ error }` rather than a throw. A version bundled before `inspect` existed has no such method, and the router answers 409 asking for a deploy.

## The router

`packages/router/wrangler.jsonc` is static and committed: the loader binding, the registry D1 with no id, the `Supervisor` Durable Object, the service bindings to the bundler and the editor, and a cron every 10 minutes that vacuums old rows. It has no route, because with one `wrangler dev` rewrites the request host and the router routes by host. `vp run deploy` writes a copy beside it as `wrangler.local.jsonc`, git-ignored, with the wildcard route and the registry's database id spliced in, and deploys that. The deploy looks the `applets-registry` database up by name and creates it when the account has none, so no resource id is committed anywhere. It names the id itself because wrangler would otherwise inherit it from the deployed router's settings, which fails once that database has been deleted. Wrangler creates the two R2 buckets on the first deploy and finds them by name after that.

Request flow for `<applet>.<suffix>/path`:

1. Ingress reads the applet name from the hostname.
2. A request for `/favicon.ico` is answered with the platform's icon and goes no further, so a browser's automatic request never reaches a handler or the `requests` table. An applet that wants its own icon links one at another path.
3. Ingress reads the applet row from the registry and asks `can(subject, "use", applet)`, see "Access" in [platform.md](platform.md#access). A `public` applet forwards without looking for a subject. For the rest, a stranger gets a redirect to sign-in for a navigation and 401 otherwise, and a user the policy refuses gets 403. A user's request is forwarded with `x-applet-user` set. The applet never sees the platform's session or key: ingress drops `cookie`, `authorization` and a caller's own `x-applet-user`.
4. Ingress stamps the applet's id and name, the version and the egress mode in headers and calls `env.SUPERVISOR.getByName(id).fetch(request)`. When the response comes back it records one `requests` row with the method, path, status and duration, off the request's critical path.
5. The supervisor compares the stamped version with the one it last ran. On a change it aborts the facet.
6. The supervisor gets the facet, loading the worker from the version row if needed, and forwards the request.
7. The facet runs the generated entry, which calls the applet's `fetch`.

The loaded worker's `env` holds `APPLET_NAME`, `APPLET_VERSION` and the `LOGS`, `BLOBS`, `EMAIL` and `AI` capabilities stamped with both, so a log line or an email is attributed to the version that wrote it. `globalOutbound` is `null` when the applet's egress is `none`, else the router's `Egress` entrypoint, so every outbound `fetch()` passes through the router. The load also sets `limits`, 10 seconds of CPU and 100 subrequests per request, so a loop or a fan-out in an applet ends early.

Every hostname is public on the internet and gated by the router:

- an applet answers a stranger only when its visibility is `public`; every other applet, the editor and its `/api/` routes need a user, from a session or a bearer key
- `admin.<suffix>` takes a bearer key and never a cookie, so a page on a sibling host cannot call it as its visitor
- the API under `app.<suffix>/api/` refuses a request whose `Origin` is another host, for the same reason: the session cookie covers every applet host, so an applet's page could otherwise call it as whoever is visiting
- a private or family applet refuses cross-origin writes that carry the shared session cookie. Its own page and scripts using a bearer key can still write to it. Applets should keep GET and HEAD free of side effects
- `auth.<suffix>` is open, because it is how a session starts, and rate-limited by Better Auth
- received mail has no hostname: Email Routing calls the router's `email` handler directly

Hostnames:

| Hostname | Serves |
| --- | --- |
| `<applet>.<suffix>` | the applet's current version |
| `admin.<suffix>` | the admin API, bearer key only |
| `auth.<suffix>` | the sign-in pages from the editor script, and Better Auth's own routes under `/api/auth/` |
| `app.<suffix>` | the editor page, with the admin API under `/api/`, behind a session |

### Applets calling applets

On Cloudflare a worker's `fetch()` to a host on its own zone skips Workers and goes to the origin, which here is a placeholder. Every outbound `fetch()` from an applet already passes through the router's `Egress` entrypoint, so `Egress` handles it, in `packages/router/src/egress.ts`:

- a request whose hostname ends with the suffix goes to the router's own ingress as a function call. The policy check, the version stamp and the `requests` row happen as they do for a request from outside
- any other host goes to `fetch(request)`
- the internal request has its `cookie` and `authorization` headers stripped. It carries no session and no key, so the caller is a stranger: only `public` applets answer, and any other target answers 401
- the reserved hosts `admin`, `app` and `auth` answer 403
- at most 16 internal calls may be in flight per router isolate; the next one answers 508. A loop nests, so it reaches the cap in 16 hops and fails. The cap is a counter, not a queue: calls under it run concurrently
- an `x-applet-depth` header counts hops for applets that forward incoming headers, and the fifth hop answers 508. Ingress deletes the header on requests from outside

An applet with egress `none` cannot `fetch()` anything, another applet included. That is all `none` blocks: the applet still has its `email`, `blob` and `log` capabilities, and `email.send` reaches an outside recipient, so `none` is a guard against stray requests, not a sandbox. An applet that calls another builds the target host from its own request URL, so no suffix is written into the applet.

## The registry

One D1 database on the router:

| Table | Holds |
| --- | --- |
| `applets` | id, a UUID v7 minted on the first deploy so ids sort by creation; name, unique, the hostname, changeable; owner (the email of the user who created it); a one-line description, visibility (`private`, `family` or `public`), egress (`open` or `none`), the schedule and email switch, its two triggers, current version id, `secrets_rev` which counts changes to its secrets |
| `secrets` | per applet by id, a name and a value in plain text. The API takes values and returns names only |
| `drafts` | the editor's saved, undeployed source per applet, one row, never run: a map of path to `file_contents` hash, so a save writes only content that is new. Every applet has a version before it has a draft |
| `versions` | applet, version number, a map of source path to `file_contents` hash, the ordered hashes of its `bundle_parts`, exports, installed packages, which files changed from the version before, created at |
| `file_contents` | source text per applet under its SHA-256, named by versions and drafts. A file that does not change between versions, or between a draft and its version, is stored once |
| `bundle_parts` | a bundled module's text in parts of at most 1.9 MB, per applet under their SHA-256. The supervisor joins a version's parts when the loader asks for the code. The cron drops rows of either table that nothing names |
| `users` | emails that may sign in. The admin is not a row: `OWNER_EMAIL` names them |
| `api_keys` | the SHA-256 hash of a key, its creator's email, a name, created at, last used at |
| Better Auth's | `user`, `session`, `account`, `verification`, `jwks`, and the OAuth provider's `oauthClient`, `oauthResource`, `oauthClientResource`, `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, `oauthClientAssertion`, generated by Better Auth's migration compiler |
| `logs` | applet, version, level, message, the id of the run that wrote it, timestamp |
| `requests` | the run's id, applet, version, trigger kind, method, path, status, error, duration, timestamp. A handler that throws is a row with status 500 and the error text; the visitor gets a plain 500 carrying the run's id, never the error |
| `emails` | direction, applet or null when unclaimed, message id, sender, recipient, subject, status, detail, timestamp; no bodies |
| `platform_logs` | the router's own lines: level, message, data as JSON, the applet it is about or null, trace id, timestamp |

To reset the registry after a schema change: locally, stop `vp run dev` and delete `packages/router/.wrangler/`; on the account, run `vp run destroy --yes`, then `vp run ship`, which creates an empty database, deploys against it and pushes the examples. The registry and the applets' storage go together, since a registry row without its facet is no use. A reset drops every applet, user, key and session, so it costs one new magic link.

Every per-applet table keys on `applet_id`, never on the name; a row returned by the API carries the name as `applet`, joined at read time. The id addresses the applet's Supervisor, prefixes its blobs and its received attachments, and keys the loader. So the name is a setting: a `PATCH` with `name` renames the applet in one row update, the hostname and the email address move, and the storage, versions, secrets and logs stay where they are. The loaded worker's `env` carries the name, so the facet key includes it and the next request reloads the worker, as a secrets change does; storage is kept. Nothing answers at the old name after that, and an applet that called the old hostname breaks; the old name is free for anyone.

`POST /applets/:name/fork` makes a new applet of the caller's from the current version: a fresh id, the version's file and bundle hashes and the contents they name copied into the new applet's rows, the same exports and dependencies as its version 1, with every file marked added. No storage, secrets, drafts, logs or triggers come along, and the fork is `private`. `platform_logs.applet` is the one column that holds a name, since it labels a log line rather than keying a row.

Versions are numbered from 1 per applet. A rollback makes an older version current; the applet's settings, its schedule and email switch among them, stay as they are. An applet name is lowercase letters and digits joined by single dashes, never a platform host; the admin API refuses anything else, on a deploy, a rename and a fork alike. `vp run push` and the Vite page reach the registry only through the admin API with the host-only `ADMIN_TOKEN`; the router stores its SHA-256 hash, and the token acts as the admin.

The routes are the `HttpApi` in `packages/api`: every path, parameter, body, answer and error as a Schema, one group per area (`applets`, `versions`, `storage`, `secrets`, `runs`, `keys`, `users`, `sessions`, `platform`). The router implements it with `HttpApiBuilder`, the editor and `vp run push` call it through the client `HttpApiClient` derives, and a refusal is a tagged error with its own status: `BadRequest` 400, `Unauthorized` 401, `Forbidden` 403, `NotFound` 404, `BuildFailed` 422 with one line per problem, `AppletFailed` 502. Who may call which is under "Access" in [platform.md](platform.md#access). On the editor host only, the `sessions` group lists and revokes the caller's own browser sessions through Better Auth, so a session token never leaves the router; a revoked browser is signed out once its five-minute cookie cache runs out.

The same `HttpApi` is the OpenAPI document Effect generates from it, served on `admin.<suffix>` as `/openapi.json` with a Scalar page at `/docs`, both without a key. The document is the contract as the router runs it, so there is nothing to keep in sync.

### The MCP server

`packages/router/src/mcp.ts` is an Effect `Toolkit` of tools over the same services the admin API's handlers use, `deploy` and `patch` among them, served by Effect's `McpServer` on `MCP_URL`, which is `https://mcp<suffix>/`. The tools are `list_applets`, `deploy_applet`, `get_logs` and so on, The server's instructions are a short orientation that sends the agent to `read_docs`, which returns `applets.md` or `platform.md` as they are, imported as text by `packages/router/src/docs.ts`. So an agent reads what a person reads, and there is no second copy to go stale. Ingress turns the bearer token into the `Caller` and builds the server for that one request; a tool's refusal is the same tagged error the API answers with, shown to the agent as the result's text. Only the stateless protocol revision, `2026-07-28`, is offered: nothing outlives a request on Workers, so a session id would have nowhere to live, and the `subscriptions/listen` stream is refused with method-not-found, which a client takes as no notifications.

## OAuth for MCP clients

An MCP client has no place to paste a key, so the router is an OAuth 2.1 authorization server as well: Better Auth's `mcp` plugin, which is its OAuth provider configured for one protected resource, `MCP_URL`, plus the `jwt` plugin that signs the tokens with keys kept in the `jwks` table. The flow, all on `auth.<suffix>`:

1. the client reads `/.well-known/oauth-protected-resource` on the MCP host, which names the issuer, `https://auth<suffix>/api/auth`, then the issuer's metadata at `/.well-known/oauth-authorization-server/api/auth`, which the MCP host repeats at its own `/.well-known/oauth-authorization-server` for clients that look there
2. it registers itself at `/api/auth/oauth2/register`, open to anyone, and is recorded as a native client, since MCP clients on a laptop redirect to `http://localhost` and rarely say so
3. it opens `/api/auth/oauth2/authorize` in the browser. Without a session, Better Auth sends the person to the sign-in page with the signed authorization query, and the magic link's callback returns them to the authorize route; with one, to `/consent`, where one button posts the grant and the browser lands on the client's redirect URI with the code
4. the client exchanges the code with PKCE at `/api/auth/oauth2/token` for an access token bound to `MCP_URL`, a JWT whose subject is the Better Auth user id, valid for an hour, and a refresh token valid for a year that is rotated at each use with a fresh year, so a person signs in again only after a year away. The scopes are `applets` and `offline_access`; the resource metadata on the MCP host is written by ingress rather than the provider, because the provider leaves `offline_access` out of it and a client asks only for what is advertised, and the registration hook grants the refresh token grant to a client that does not ask for it

The router checks a presented token in-process, `verifyJWT` against the keys in the registry with the issuer and the audience the `jwt` plugin was given, since a worker's `fetch()` to its own zone never reaches the router. The token's subject becomes an email through the `user` table, and from there the same `memberFor` as a session, so removing a user revokes their agents at once. A token is accepted on the MCP host and on `admin.<suffix>` alike.

## Email

Every applet has an address, `<applet>@<domain>`, where the domain is the host suffix without its dot. The domain is onboarded in [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) for sending, and Email Routing's catch-all rule sends everything it receives to the router. Only the router holds the `send_email` binding; the magic link uses it too.

Out: `email.send` goes through the router's `Email` capability, which sets the sender to the applet's address, sends through the binding and records an `emails` row as `sent`, or `failed` with Cloudflare's error. Applets never choose a `from`.

In: Email Routing calls the router's `email` handler with the raw message. The router parses it with [postal-mime](https://github.com/postalsys/postal-mime) and reads the applet name from the local part of the envelope recipient. When that applet exists and its email setting is on, the router stores the attachments and hands the message to the applet's `inbox` export through its supervisor; a return records `delivered`, a throw, or no `inbox` export, records `failed` with the error. Delivery is at most once: nothing retries a failed handler, and the sender gets no bounce. Mail for an address with no such applet is recorded as `unclaimed` and shown to the admin on the editor's front page.

The `emails` table holds no bodies, only the row above, and nothing else keeps them: an applet that wants a message later stores it itself. Rows and attachments older than a week are deleted by the router's vacuum, on its 10-minute cron. The editor's Emails page shows an applet's rows, and the admin's front page the unclaimed ones.

## Logs

`@std`'s `log` writes each line twice, to the console and to the router, both tagged with the applet's name and version. Ingress writes one `requests` row per forwarded HTTP request. The supervisor also writes a row when a scheduled, manual or inbox run finishes: 200 when the handler returned, 500 with the error when it threw. These rows show whether a silent handler ran. Whoever writes the row also mints the run's id, a UUID, and sends it to the applet in `x-applet-request`. The generated entry puts it in an `AsyncLocalStorage` around the handler, because the facet serves requests concurrently, and `log` stamps it on each line. So a line joins its `requests` row on `request_id`; a line written outside any handler, or by a version bundled before this existed, has none. Both tables in D1 are a window: a router cron deletes rows older than 7 days. The console line goes to Workers Logs, which the router's config turns on; `vp run tail` follows it live and the Cloudflare dashboard keeps the history.

A `requests` row is written when the response has ended, not when its headers went out: an applet that streams has sent its 200 long before its handler can fail, so ingress forwards the body chunk by chunk and records the status, the full duration and, when the body ended early, the reason.

The platform keeps a log of its own, `platform_logs`, in the same window. Every `Effect.log` line at info or above in the router is queued by a logger and written in one batch after the response, under `waitUntil`; a line's annotations are its data, `applet` is a column of its own, and a failed cause is added as text. What is written: a deploy with its duration, package count and whether the dependency set was cached, a failed build with its errors, a rollback, a settings or secret change, an applet removed, a sign-in link sent or refused, users and keys added or removed, a worker loaded and a facet restarted with the load time, a schedule run that failed, mail unclaimed, delivery and send failures, an editor asset the editor script had no file for, an admin API call that answered 5xx and an ingress crash. Every line from an admin API call carries `by`, the caller. The admin reads it on the Logs page's platform view; `GET /platform/logs` is the endpoint. The console line still goes to Workers Logs.

There is no separate development log. Every deploy is a real version on the live applet, so "the logs from what I just deployed" is the version filter, which is the editor's default view.

## Secrets

Platform secrets are Worker secrets on the router. `vp run deploy` reads them from the host-only `secrets.env` and, after the router deploys, pipes them as JSON to `wrangler secret bulk`, so they never touch a file. The set is `ADMIN_TOKEN`, stored as its hash only, `BETTER_AUTH_SECRET`, `EMAIL_FROM`, `OWNER_EMAIL`, `OPENROUTER_API_KEY`, and the two derived values `HOST_SUFFIX` and `AUTH_URL`. Secrets and vars look the same to the worker, and the committed `wrangler.jsonc` carries neither.

`secrets.env.example` lists what the file holds. One entry is host-specific, not secret:

- `APPLET_HOST_SUFFIX`: with it set the scripts talk to `https://admin<suffix>` and the router's `AUTH_URL` becomes `https://auth<suffix>`; without it everything is `.localhost` on port 8787. A platform deploy refuses the `.localhost` suffix

`wrangler` takes the account from its own login, so no account id is stored. The few Cloudflare API calls the scripts make themselves, in `packages/cli/src/cloudflare.ts`, run with the token `wrangler auth token` prints. That login has no DNS scope, so the one thing a deploy cannot create is the wildcard DNS record the route attaches to: a proxied `AAAA` record, name `*`, value `100::`, added once in the Cloudflare dashboard.

For the local platform, `vp run dev` writes the same set to `packages/router/.dev.vars`, git-ignored, always with the `.localhost` suffix whatever `secrets.env` names.

Applets never receive a platform secret; the OpenRouter key is used on their behalf by the `AI` capability.

## The editor

`packages/editor` is the third platform script: a Vite React page on the design system, served on `app.<suffix>`. The router forwards that host to the editor script over a service binding and answers `/api/` on it with the admin API, so the page never holds a token and never crosses an origin. What it does: show the user's recently changed applets on Home, list and search applets, open one from `GET /applets/:name/source`, edit and add files, save unsaved work as a draft on the router, deploy, browse the version history with the files each one changed, view or roll back to an older version after a confirmation, create a new applet, which deploys a one-function template as its version 1, remove one, manage the user's API keys and, for the admin, manage who may sign in.

The URL picks the page, through [wouter](https://github.com/molefrog/wouter): `/`, `/applets`, `/logs` and `/settings` sit in a shell with a global rail, and `/applets/:name/:view` is an open applet, so every page has a link and the back button works. The editor script answers a path that is no file with `index.html`, except under `/assets/`, which is a 404: a deploy replaces every chunk, and a page open across one would otherwise get the page as JavaScript and go blank. The page listens for Vite's `preloadError` and reloads for the current build instead, and the router logs the miss. The store follows the URL and keeps the open applet loaded while the user visits other pages, so unsaved edits survive until another applet is opened or the tab closes, and both of those ask first.

The editor pane is [CodeMirror 6](https://codemirror.net) with its basic setup and a language pack per kind of applet file, and the file tree is [Pierre's](https://github.com/pierrecomputer/pierre) `@pierre/trees`, with keyboard navigation and a context menu. There is no language service, so type errors show up after Deploy in the Problems panel, not while typing. The editor has undo, multiple cursors, search and replace, bracket matching, auto-indent and auto-closing brackets.

One zustand store holds every piece of state and every action; components read slices and call actions. File text lives in the store as strings, the editor pane reports each edit back, and a file is dirty when its text differs from the saved copy. `vp run deploy` runs `vp build` here and deploys `dist/`. The editor host needs a user, so a browser without a session is redirected to sign-in and a script without a session or a key gets 401.

## The design system

`packages/ui` is the one place components and theme live. It is a stock shadcn workspace on Base UI, not Radix, with the `base-vega` style: the theme is shadcn's standard CSS variables in `src/globals.css`, exported from a [tweakcn](https://tweakcn.com) theme, and every component is a file under `src/components/ui/`, copied in by the shadcn CLI and owned by us. A new theme is a new `:root` and `.dark` block in that file; the components stay.

A page that uses it needs three things and no shadcn setup of its own:

- `"@applets/ui": "*"` in its dependencies
- `plugins: ui()` from `@applets/ui/vite` in its Vite config, which brings React and Tailwind
- `@import "@applets/ui/globals.css";` in its stylesheet

Components import as `@applets/ui/components/ui/button`. To add one, run from `packages/ui`:

```
vpx shadcn@latest add <name>
```

Generated component files are excluded from lint and format, since they are not our code. Base UI popups need `isolate` on the app root and `relative` on `body`, which the page's `index.html` sets.

## To do

`vp run push --examples` is the check after a platform change, and `vp run push:local --examples` is the same against the local platform. Still open:

- the installer on a package that ships CommonJS, imports a `node:` builtin, or needs a peer dependency
- streaming blobs over RPC
- folding the editor into the router's static assets, which removes one worker and one service binding
- a skill per `@std` module, for agents that write applets outside the MCP server's instructions
- an RPC seam between an applet's page and its worker over [Cap'n Web](https://github.com/cloudflare/capnweb): an applet exports a class, the page calls its methods through `@std`, with no hand-written routes. The win is that an agent can call the same methods, which is how [Cloudflare OS](https://blog.cloudflare.com/cloudflare-os/) makes its gadgets usable by people and agents alike. Inside the platform, Workers RPC already gives the capabilities this shape

## Out of scope

- execution of untrusted code. Applets come from the admin and from family and friends the admin lets in, which sits between our own code and a stranger's. The platform isolates them from each other: each runs in its own loaded worker with its own storage, blob prefix and secrets, under CPU and subrequest limits, and none sees a platform secret or another user's code and logs. It does not defend the platform against them: any applet can spend the shared AI key and mail quota and fetch anything when egress is open, with no per-user quota or abuse handling. So the allow list is the boundary, and nobody the admin does not know gets on it
- a full browser IDE. The editor edits stored applet source and nothing more: no language server, no terminal
- applets that hold WebSockets
- social and product features: likes, remixes, public profiles, branches and pull requests, billing, custom domains, OAuth clients, a built-in AI agent. Versions are the unit, and there is no applet overview page: an applet opens on Code
- an applet choosing its own sender address, or a catch-all applet for unclaimed mail

## Decisions at a glance

| Decision | Why |
| --- | --- |
| Cloudflare Workers Paid | the Workers model has every primitive an applet needs, and the Worker Loader and facets need the paid plan |
| one wildcard route, routing by hostname in the router | one deploy covers every applet, present and future, and the domain stays out of the repo |
| applet-to-applet calls dispatched inside `Egress` | a worker's `fetch()` to its own zone skips Workers, and every applet `fetch()` already passes through `Egress` |
| applets as loaded code run as facets | no deploy per applet, storage isolation from the runtime, sync SQL, egress per applet |
| three scripts, router, bundler and editor | the router's upload stays small, and a bundler or editor change never touches ingress |
| the editor as a platform script, not an applet | applets are our own code plus its npm dependencies, trusted less than the platform; the editor needs the admin API, and it ships with the platform |
| CodeMirror for the editor pane, Pierre's trees for the file tree | CodeMirror is modular, so the page carries only the languages an applet holds, and it measures text from the DOM; Pierre's edit mode placed the caret from canvas widths and drifted under the page's letter-spacing, and Monaco was 13 MB and could not take the page's theme |
| shadcn on Base UI for the two pages we maintain | components are files we own, one theme in `packages/ui`, and every agent knows the API |
| bundles in D1 as content-addressed parts, not R2 | one transactional store for a version with nothing to orphan, and no R2 read on a cold load; a probe loaded a 16 MB module from R2 in 0.3 to 1.4 s |
| the bundler inside a worker | deploying an applet needs no toolchain on the host, and the editor calls the same API |
| a supervisor Durable Object per applet | one binding covers every applet, and the supervisor swaps versions and owns the alarm |
| no preview environment | storage is the facet's own, so two versions cannot share it without the RPC hop the facets removed; iterate on the live applet and roll back |
| visibility and egress as registry columns | a change takes effect without a deploy and survives a redeploy |
| an applet is a UUID v7 id, and the name a column | a rename is one row update that keeps storage, versions and logs; the Durable Object, the blob prefix and every table key on the id, and the name is only ever looked up at ingress |
| Effect in the router and the repo's scripts, not in applets or `@std` | services with explicit dependencies, one `HttpApi` contract in `packages/api` shared by the router, the editor and `push`, and spans on every step; applet code stays a script |
| Preact for applet client code | applets have no tsconfig, so JSX is one platform-wide choice, and Preact is small |
| the bundler reads export names, never the code | a small source scan finds the declarations, and esbuild fails on anything it cannot resolve |
| `push` talks to the router over HTTP | one owner of the registry, and the same admin API the editor uses |
| two member roles, anonymous access, three fixed visibilities, one `can` function | family use needs no custom roles or per-applet lists of people, and one table is small enough to test cell by cell |
| code, logs and secrets belong to the owner alone | the product never shows one person's code to another, the admin included |
| an API key is its creator | one way to get a subject covers scripts and machine callers of private applets |
| the router is the OAuth authorization server for MCP clients | an MCP client has no place for a key, Better Auth already holds the users, and one URL is the whole setup |
| the MCP server inside the router, stateless | the tools share the admin API's services, and nothing outlives a request on Workers |
| the OpenAPI document generated from the `HttpApi` | the contract the router runs is the one documented |
| Better Auth inside the router | the platform must deploy on its own, and Better Auth runs on D1 |
| magic link by email, no OAuth | one binding instead of a Google project, the `users` table is the whole identity policy, and the same binding sends applets' mail |
| one named export per trigger, settings in the registry | `fetch`, `scheduled` and `inbox` are the Workers module shape, each with the argument it really gets; whether anything calls the last two is a setting beside visibility, so the bundler never reads declarations out of source and a missing handler is a failed run, not a build rule |
| inbound through the `email` handler, no retries of our own | Email Routing hands the router the raw message, so there is no webhook, signature or provider API to call; the `emails` row says what happened |
| platform secrets as Worker secrets on the router | they never touch a file, and applets never see them |
| logs through an RPC call to the router | the editor reads logs per applet and version from the registry, and a capability in the loaded env crosses the isolate |
