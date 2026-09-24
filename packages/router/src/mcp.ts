/**
 * The MCP server on `MCP_URL`: the admin API's verbs as tools, so an agent in
 * Claude Code or any MCP client can list, read, deploy and inspect applets as
 * the person who authorized it. Ingress has already turned the access token
 * into the `Caller`; the server is built for that one request, which is why
 * only the stateless protocol revision is offered: nothing outlives a request
 * on Workers, so a session id would have nowhere to live.
 */
import {
  Applet,
  AppletFailed,
  AppletPatch,
  AppletSummary,
  BadRequest,
  BuildFailed,
  Deployed,
  Files,
  Forbidden,
  KvList,
  LogEntry,
  NotFound,
  RequestEntry,
  SecretEntry,
  SqlResult,
  Version,
} from "@applets/api";
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";

import { deploy, fork, patch, remove } from "./admin.ts";
import { Bucket, Bundler, Supervisors, Vars } from "./bindings.ts";
import { Caller, owned } from "./caller.ts";
import { docs } from "./docs.ts";
import { log } from "./platformLog.ts";
import { Registry } from "./registry.ts";
import { inspect, putBlob } from "./storage.ts";
import { isSecretName, targetOf } from "./types.ts";

const { name: _renamed, ...settings } = AppletPatch.fields;

const ok = { ok: true } as const;

const Ok = Schema.Struct({ ok: Schema.Literal(true) });

const Refused = Schema.Union([NotFound, Forbidden, BadRequest, BuildFailed, AppletFailed]);

const name = { name: Schema.String.annotate({ description: "the applet's name" }) };

const Window = {
  version: Schema.optional(Schema.Number),
  after: Schema.optional(Schema.Number.annotate({ description: "only ids above this one" })),
  limit: Schema.optional(Schema.Number),
};

const read = <const Name extends string, P extends Schema.Struct.Fields, S extends Schema.Top>(
  tool: Name,
  description: string,
  parameters: P,
  success: S,
) =>
  Tool.make(tool, { description, parameters: Schema.Struct(parameters), success, failure: Refused })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false);

const write = <const Name extends string, P extends Schema.Struct.Fields, S extends Schema.Top>(
  tool: Name,
  description: string,
  parameters: P,
  success: S,
  destructive = false,
) =>
  Tool.make(tool, {
    description,
    parameters: Schema.Struct(parameters),
    success,
    failure: Refused,
  }).annotate(Tool.Destructive, destructive);

export const toolkit = Toolkit.make(
  Tool.make("whoami", {
    description:
      "Who the agent acts as, and the host suffix: an applet named `x` answers at `https://x<host_suffix>`.",
    success: Schema.Struct({
      email: Schema.String,
      role: Schema.Literals(["admin", "user"]),
      host_suffix: Schema.String,
    }),
  }).annotate(Tool.Readonly, true),
  Tool.make("read_docs", {
    description:
      "One of the platform's docs as markdown. `applets` is how to write an applet: the handler, `@std`, npm imports and the rules the build enforces. `platform` is visibility, access, secrets, API keys and the editor. A link to `applets.md` or `platform.md` in one names another doc.",
    parameters: Schema.Struct({ doc: Schema.Literals(["applets", "platform"]) }),
    success: Schema.Struct({ text: Schema.String }),
  }).annotate(Tool.Readonly, true),
  Tool.make("list_applets", {
    description: "Every applet the caller may edit: their own, and all of them for the admin.",
    success: Schema.Struct({ applets: Schema.Array(AppletSummary) }),
    failure: Refused,
  }).annotate(Tool.Readonly, true),
  read(
    "get_applet",
    "One applet's settings and its versions, newest first.",
    name,
    Schema.Struct({ applet: Applet, versions: Schema.Array(Version) }),
  ),
  read(
    "read_files",
    "The source files of an applet's current version, or of the version given.",
    { ...name, version: Schema.optional(Schema.Number) },
    Schema.Struct({ version: Schema.Number, files: Files }),
  ),
  write(
    "deploy_applet",
    "Creates an applet, or makes a new version of one, from the complete set of source files by path, `main.ts` among them, and makes it live. Read the current files first when changing an existing applet: files left out are gone. `fresh` reinstalls npm packages instead of reusing the cached install. Third-party imports carry the npm: prefix, `npm:zod@3`.",
    { ...name, files: Files, fresh: Schema.optional(Schema.Boolean) },
    Deployed,
  ),
  write(
    "update_applet",
    "Changes an applet's settings: description, visibility (`private`, `family` or `public`), egress (`open` or `none`), `schedule` (a five-field cron expression in UTC that calls the applet's `scheduled` export, or null to stop it), `email` (whether mail to the applet's address calls its `inbox` export), a rollback to an earlier `current_version`, or a rename to `new_name`: the hostname and email address move, storage, versions and logs stay. Every field is optional; only the given ones change.",
    {
      ...name,
      ...settings,
      new_name: Schema.optional(Schema.String),
    },
    Schema.Struct({ applet: Applet }),
  ),
  write(
    "fork_applet",
    "A new applet of the caller's, named `new_name`, from the current version's source of `name`: files and dependencies. Its storage, secrets, logs and triggers are not copied.",
    { ...name, new_name: Schema.String },
    Schema.Struct({ applet: Applet }),
  ),
  write(
    "remove_applet",
    "Deletes an applet with every version, its storage and its blobs. There is no undo.",
    name,
    Ok,
    true,
  ),
  write("run_applet", "Calls the applet's `scheduled` export once now, as a manual run.", name, Ok),
  read(
    "get_logs",
    "Lines the applet logged, newest first.",
    { ...name, ...Window, level: Schema.optional(Schema.String) },
    Schema.Struct({ logs: Schema.Array(LogEntry) }),
  ),
  read(
    "get_requests",
    "The applet's runs, newest first: every HTTP request, schedule tick, manual run and email, with status, error and duration.",
    { ...name, ...Window },
    Schema.Struct({ requests: Schema.Array(RequestEntry) }),
  ),
  write(
    "query_sqlite",
    "Runs one SQL statement against the applet's own SQLite database, reads and writes alike.",
    { ...name, sql: Schema.String },
    SqlResult,
  ),
  read(
    "list_kv",
    "The applet's key-value entries, values as JSON text, optionally under a prefix.",
    { ...name, prefix: Schema.optional(Schema.String) },
    KvList,
  ),
  write(
    "put_blob",
    "Stores one blob the applet reads with `blob.get(key)`: text as `text`, or bytes such as an image as `base64`, one of the two. Replaces any value at the key.",
    {
      ...name,
      key: Schema.String,
      text: Schema.optional(Schema.String),
      base64: Schema.optional(Schema.String),
      content_type: Schema.optional(
        Schema.String.annotate({
          description: "text/plain when text is given, else application/octet-stream",
        }),
      ),
    },
    Ok,
  ),
  read(
    "list_secrets",
    "The names of the applet's secrets. Values are never returned.",
    name,
    Schema.Struct({ secrets: Schema.Array(SecretEntry) }),
  ),
  write(
    "set_secret",
    'Sets one secret the applet reads with `secret("NAME")`. The name is capitals, digits and underscores.',
    { ...name, secret: Schema.String, value: Schema.String },
    Ok,
  ),
  write(
    "remove_secret",
    "Removes one of the applet's secrets.",
    { ...name, secret: Schema.String },
    Ok,
    true,
  ),
);

/** Every tool over the services of the request that built it: the caller and the router's own. */
const handlers = toolkit.toLayer(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Caller | Registry | Supervisors | Bundler | Bucket | Vars
    >();

    const caller = yield* Caller;
    const registry = yield* Registry;
    const supervisors = yield* Supervisors;
    const vars = yield* Vars;

    const provided = <A, E>(
      effect: Effect.Effect<A, E, Caller | Registry | Supervisors | Bundler | Bucket | Vars>,
    ) => Effect.provide(effect, context);

    return {
      whoami: () =>
        Effect.succeed({ email: caller.email, role: caller.role, host_suffix: vars.HOST_SUFFIX }),
      read_docs: ({ doc }) => Effect.succeed({ text: docs[doc] }),
      list_applets: () =>
        registry
          .listApplets(caller.email, caller.role === "admin")
          .pipe(Effect.map((applets) => ({ applets }))),
      get_applet: ({ name }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);

            return { applet, versions: yield* registry.listVersions(applet.id) };
          }),
        ),
      read_files: ({ name, version }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);
            const id = version ?? applet.current_version;

            if (id === null) return yield* new NotFound({ message: "applet has no version" });

            const files = yield* registry.getFiles(applet.id, id);

            return { version: id, files };
          }),
        ),
      deploy_applet: ({ name, files, fresh }) =>
        provided(deploy(name, files, fresh ?? false)).pipe(
          // A refused build is one line per problem, joined so the text of the result carries them all.
          Effect.mapError((failed) =>
            failed instanceof BuildFailed
              ? new BadRequest({ message: failed.errors.join("\n") })
              : failed,
          ),
        ),
      update_applet: ({ name, new_name, ...change }) =>
        provided(patch(name, new_name === undefined ? change : { ...change, name: new_name })),
      fork_applet: ({ name, new_name }) => provided(fork(name, new_name)),
      remove_applet: ({ name }) => provided(remove(name)),
      run_applet: ({ name }) =>
        provided(
          Effect.gen(function* () {
            const target = targetOf(yield* owned(name));

            if (target === undefined)
              return yield* new NotFound({ message: "applet has no version" });

            yield* supervisors.run(target, "manual");

            return ok;
          }),
        ),
      get_logs: ({ name, ...query }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);

            return { logs: yield* registry.listLogs(applet.id, query) };
          }),
        ),
      get_requests: ({ name, ...query }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);

            return { requests: yield* registry.listRequests(applet.id, query) };
          }),
        ),
      query_sqlite: ({ name, sql }) =>
        provided(
          inspect(name, { kind: "sql", sql }).pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(SqlResult)(result).pipe(Effect.orDie),
            ),
          ),
        ),
      list_kv: ({ name, prefix }) =>
        provided(
          inspect(name, { kind: "kv", prefix: prefix ?? "", limit: 500 }).pipe(
            Effect.flatMap((result) =>
              Schema.decodeUnknownEffect(KvList)(result).pipe(Effect.orDie),
            ),
          ),
        ),
      put_blob: ({ name, key, text, base64, content_type }) =>
        provided(
          Effect.gen(function* () {
            if ((text === undefined) === (base64 === undefined))
              return yield* new BadRequest({ message: "give exactly one of text and base64" });

            const body =
              text !== undefined
                ? new TextEncoder().encode(text)
                : Uint8Array.from(atob(base64 ?? ""), (char) => char.charCodeAt(0));

            yield* putBlob(
              name,
              key,
              body,
              content_type ?? (text !== undefined ? "text/plain" : undefined),
            );

            return ok;
          }),
        ),
      list_secrets: ({ name }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);

            return { secrets: yield* registry.listSecrets(applet.id) };
          }),
        ),
      set_secret: ({ name, secret, value }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);

            if (!isSecretName(secret))
              return yield* new BadRequest({
                message: "a secret name is capitals, digits and underscores, like API_KEY",
              });

            yield* registry.putSecret(applet.id, secret, value);
            yield* log.info("secret set", { applet: name, name: secret });

            return ok;
          }),
        ),
      remove_secret: ({ name, secret }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);
            yield* registry.putSecret(applet.id, secret, null);
            yield* log.info("secret removed", { applet: name, name: secret });

            return ok;
          }),
        ),
    };
  }),
);

/** What every client is told on connect: enough to orient, and where the rest is. */
const instructions = `Applets is a personal platform for small programs on Cloudflare Workers. An applet is a directory whose entry is main.ts, exporting fetch(request) and optionally scheduled(event) and inbox(message); a schedule and the email switch are settings set with update_applet. @std gives it SQLite, key-value storage, blobs, email, AI and logs with no setup. deploy_applet makes it live at https://<name><host_suffix>, and whoami gives the suffix.

Before writing or changing an applet, call read_docs with "applets": it is the full guide, and the build refuses code that breaks its rules. read_docs "platform" covers visibility, access and secrets. After a deploy, check it works: call run_applet, or fetch the URL of a public applet, then read get_requests and get_logs. A change is not done until they show it working.`;

const server = Layer.merge(
  McpServer.layerHttp({
    name: "applets",
    version: "1.0.0",
    instructions,
    path: "/",
    protocols: [McpProtocol.v2026_07_28],
  }),
  McpServer.toolkit(toolkit).pipe(Layer.provide(handlers)),
);

/** The MCP endpoint for the request in context, as the `Caller` in context. The server's fibers live in the request's scope. */
export const serve = Effect.flatMap(HttpRouter.toHttpEffect(server), (handle) => handle);
