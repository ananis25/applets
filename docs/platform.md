# The platform

## Agents and scripts

Use when connecting an agent or a script to the platform.

The admin API is an OpenAPI document at `https://admin<suffix>/openapi.json`, with a reference page at `https://admin<suffix>/docs`. A script calls it with an API key from the editor's Settings page as the bearer token, and `vp run push` is one such script.

The MCP server at `https://mcp<suffix>/` exposes applet creation, code, settings, storage, and activity operations as tools named by what they act on. Platform administration and editor drafts stay on the API:

| Object | Tools |
| --- | --- |
| `help` | `help(topic?)`: without a topic, who the agent acts as, the host suffix, the default model and the list of topics; with one, that section of these docs |
| `applet` | `applet_list`, `applet_get`, `applet_create` (from a template), `applet_deploy` (the complete set of files), `applet_configure` (settings, schedule, rollback, rename), `applet_fork`, `applet_run`, `applet_fetch` (an HTTP request as the caller), `applet_remove` |
| `templates` | `templates_list` |
| `files` | `files_read`, `files_edit` (text replacements, deployed as a new version) |
| `sql` | `sql_read`, `sql_write` (several statements in one transaction) |
| `kv` | `kv_list`, `kv_get`, `kv_put`, `kv_remove` |
| `blobs` | `blobs_list`, `blobs_get`, `blobs_put`, `blobs_remove` |
| `secrets` | `secrets_list`, `secrets_set`, `secrets_remove` |
| `logs`, `requests`, `emails` | `logs_list`, `requests_list`, `emails_list` (mail metadata; bodies are not stored) |

The server's instructions are a few lines that send the agent to `help`, which serves these docs a section at a time. It needs no key: the server is an OAuth authorization server, so a client registers itself, opens the sign-in page in a browser, and asks for consent once. In Claude Code:

```
claude mcp add --transport http applets https://mcp<suffix>/
```

An agent acts as the person who signed in, with their applets and nobody else's. A person signs in once: the agent's token renews itself, and asks for a sign-in again only after a year without use. The editor's Settings page has an Agents section with the same instructions.

## Access

Use when deciding who can reach an applet, or how a caller is identified.

One deployment is one group of people: an admin, and the family and friends the admin lets in. A person has a role, an applet has an owner and a visibility, and the pair decides every request. Nobody keeps a list of people on one applet, so there is no "share with this email".

Roles:

- `admin`: one person, fixed at deploy
- `user`: an email the admin has added on the Settings page

An unauthenticated request has no role.

Each applet has one owner, the user whose deploy created it, and one visibility the owner sets with `applet_configure` or on the Settings page. A new applet is `private`.

| | `private` | `family` | `public` |
| --- | --- | --- | --- |
| `use`, as the owner | yes | yes | yes |
| `use`, as another user or the admin | no | yes | yes |
| `use`, as a stranger | no | no | yes |
| `edit` | the owner only | the owner only | the owner only |
| `remove` | the owner and the admin | the owner and the admin | the owner and the admin |

`use` is reaching the applet over HTTP. `edit` is everything about its code and data: source, deploy, rollback, logs, requests, emails, storage, secrets, settings and run now. Logs are in that set because a log line can carry a secret. The admin never reads another user's code or logs through the product.

What the admin has on top of being a user: `applet_list` shows every applet with its owner, any applet can be removed, and the users and unclaimed mail pages are theirs.

Applet names are hostnames, so every user shares one namespace, first come first served. A deploy to a name someone else owns answers 403, and so does a rename or a fork onto a name anyone holds.

Identity is a magic link: the sign-in page takes an email, an allowed address gets a one-time link, and the page it opens sets a session that lasts 30 days and slides with use. One sign-in covers every applet subdomain. There are no invites and no passwords. Removing a user signs them out at once, revokes their keys and agents, and leaves their applets running until the admin removes them.

### API keys

A user makes a key on the editor's Settings page and sees it once. A request with `Authorization: Bearer <key>` acts as its creator:

- on `admin<suffix>` a key does what its creator could do in the editor, which is what a script uses
- on an applet's hostname a key lets a script reach its creator's `private` applets and everyone's `family` ones
- on a `public` applet every caller is anonymous, key or not: the applet gets no identity header

An MCP access token is accepted in the same places as a key.

## Secrets

Use when an applet needs a key or a token.

An applet's own secrets are its owner's: a provider key, a webhook token. `secrets_set` or the Secrets page sets one, the code reads it with `secret("NAME")` from `@std`, which throws when it is not set, and `secrets_list` shows names only. A value is never returned once set. Setting or removing a secret restarts the applet's worker with the new set on its next request, storage kept, so no deploy is needed.
