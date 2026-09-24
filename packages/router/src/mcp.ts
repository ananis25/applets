/**
 * The MCP server on `MCP_URL`: the admin API's verbs as tools, so an agent in
 * Claude Code or any MCP client can list, read, deploy and inspect applets as
 * the person who authorized it. Tools are named object_verb, `applet_deploy`,
 * `blobs_put`, so they group by what they act on. Ingress has already turned
 * the access token into the `Caller`; the server is built for that one
 * request, which is why only the stateless protocol revision is offered:
 * nothing outlives a request on Workers, so a session id would have nowhere
 * to live.
 */
import {
  Applet,
  AppletFailed,
  AppletPatch,
  AppletSummary,
  BadRequest,
  BlobEntry,
  BuildFailed,
  Deployed,
  Edit,
  EmailEntry,
  Files,
  Forbidden,
  KvEntry,
  KvList,
  listTemplates,
  LogEntry,
  NotFound,
  RequestEntry,
  SecretEntry,
  SqlResult,
  TemplateEntry,
  templates,
  Version,
} from "@applets/api";
import { Context, Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";

import { create, deploy, edit, emails, fork, patch, remove, source } from "./admin.ts";
import { Bucket, Bundler, Supervisors, Vars } from "./bindings.ts";
import { blobDownloadUrl } from "./blobDownload.ts";
import { Caller, owned } from "./caller.ts";
import { index, topics } from "./docs.ts";
import { log } from "./platformLog.ts";
import { Registry } from "./registry.ts";
import {
  getBlob,
  getKv,
  listBlobs,
  listKv,
  putBlob,
  putKv,
  removeBlob,
  removeKv,
  runSql,
  runSqlBatch,
} from "./storage.ts";
import { isSecretName, targetOf } from "./types.ts";

/** Ingress's applet host as the caller, so `applet_fetch` is recorded like any request. Ingress provides it, since it owns that path. */
export class AppletFetch extends Context.Service<
  AppletFetch,
  (name: string, request: Request) => Effect.Effect<Response, NotFound | Forbidden | AppletFailed>
>()("applets/AppletFetch") {}

const { name: _renamed, ...settings } = AppletPatch.fields;

const ok = { ok: true } as const;

const Ok = Schema.Struct({ ok: Schema.Literal(true) });

const Text = Schema.Struct({ text: Schema.String });

const Refused = Schema.Union([NotFound, Forbidden, BadRequest, BuildFailed, AppletFailed]);

const name = { name: Schema.String.annotate({ description: "the applet's name" }) };

const key = { key: Schema.String };

const templateNames = Object.keys(templates).join(", ");

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
  read(
    "help",
    `Without a topic: who you act as, where applets answer, the workflow and the topics. With one, that part of the docs. Read \`applets\` once before writing an applet: the build refuses code that breaks its rules.`,
    {
      topic: Schema.optional(
        Schema.String.annotate({ description: `one of ${Object.keys(topics).join(", ")}` }),
      ),
    },
    Text,
  ),
  read(
    "applet_list",
    "Every applet the caller may edit, with owner, visibility, triggers and the failed runs of the last day. The admin sees everyone's.",
    {},
    Schema.Struct({ applets: Schema.Array(AppletSummary) }),
  ),
  read(
    "applet_get",
    "One applet's settings and its versions, newest first.",
    name,
    Schema.Struct({ applet: Applet, versions: Schema.Array(Version) }),
  ),
  write(
    "applet_create",
    `A new applet from a template, live at once at https://<name><host_suffix>. \`files\` lay over the template's. Refuses a name that exists: applet_deploy and files_edit change an applet. Templates: ${templateNames}; templates_list describes them.`,
    { ...name, template: Schema.String, files: Schema.optional(Files) },
    Deployed,
  ),
  write(
    "applet_deploy",
    "A new live version from the complete set of source files by path, `main.ts` among them; a new name creates the applet. A file left out is not in the new version. `fresh` reinstalls npm packages instead of reusing the cached install.",
    { ...name, files: Files, fresh: Schema.optional(Schema.Boolean) },
    Deployed,
  ),
  write(
    "applet_configure",
    "Changes settings, never code: `description`; `visibility` (`private`, `family`, `public`); `egress` (`open`, `none`); `schedule` (five-field cron in UTC calling `scheduled`, null to stop); `email` (whether mail to the applet's address calls `inbox`); `current_version` to roll back; `new_name` to rename, moving the hostname and address. Only the fields given change.",
    { ...name, ...settings, new_name: Schema.optional(Schema.String) },
    Schema.Struct({ applet: Applet }),
  ),
  write(
    "applet_fork",
    "A new applet of the caller's, `new_name`, from the current version's files and dependencies. Storage, secrets, logs and triggers are not copied.",
    { ...name, new_name: Schema.String },
    Schema.Struct({ applet: Applet }),
  ),
  write("applet_run", "Calls the applet's `scheduled` export once now, as a manual run.", name, Ok),
  write(
    "applet_fetch",
    "An HTTP request to the applet as the caller, recorded like any other: the way to try a private applet. Returns the status, headers and body as text.",
    {
      ...name,
      path: Schema.String.annotate({ description: "path and query, like /api/items?limit=5" }),
      method: Schema.optional(Schema.String),
      headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      body: Schema.optional(Schema.String),
    },
    Schema.Struct({
      status: Schema.Number,
      headers: Schema.Record(Schema.String, Schema.String),
      body: Schema.String,
    }),
  ),
  write(
    "applet_remove",
    "Deletes an applet with every version, its storage and its blobs. There is no undo.",
    name,
    Ok,
    true,
  ),
  read(
    "templates_list",
    "The templates applet_create starts from: name, what each shows, and its files.",
    {},
    Schema.Struct({ templates: Schema.Array(TemplateEntry) }),
  ),
  read(
    "files_read",
    "The source files of the current version, or of `version`; `paths` picks some.",
    {
      ...name,
      version: Schema.optional(Schema.Number),
      paths: Schema.optional(Schema.Array(Schema.String)),
    },
    Schema.Struct({ version: Schema.Number, files: Files }),
  ),
  write(
    "files_edit",
    "Replaces text in the current files and deploys the result as a new live version: cheaper than applet_deploy for small changes. Each edit's `old` must occur exactly once in its file.",
    {
      ...name,
      edits: Schema.Array(Edit).annotate({
        description: "each `old` occurs exactly once in its file, or is empty to create the file",
      }),
    },
    Deployed,
  ),
  read(
    "sql_read",
    "One SELECT against the applet's own SQLite database. A statement that writes is rolled back and refused.",
    { ...name, sql: Schema.String },
    SqlResult,
  ),
  write(
    "sql_write",
    "Runs statements against the applet's own SQLite database in one transaction; the first failure rolls back all of them.",
    { ...name, statements: Schema.Array(Schema.String) },
    Schema.Struct({ results: Schema.Array(SqlResult) }),
  ),
  read(
    "kv_list",
    "The applet's key-value entries, values as JSON text, optionally under a prefix.",
    { ...name, prefix: Schema.optional(Schema.String) },
    KvList,
  ),
  read("kv_get", "One key-value entry, its value as JSON text.", { ...name, ...key }, KvEntry),
  write(
    "kv_put",
    "Sets one key-value entry the applet reads with `kv.get(key)`. `value` is JSON text.",
    { ...name, ...key, value: Schema.String },
    Ok,
  ),
  write("kv_remove", "Removes one key-value entry.", { ...name, ...key }, Ok, true),
  read(
    "blobs_list",
    "The applet's blobs under a prefix, 200 a page; pass `cursor` back for the next page.",
    { ...name, prefix: Schema.optional(Schema.String), cursor: Schema.optional(Schema.String) },
    Schema.Struct({ blobs: Schema.Array(BlobEntry), cursor: Schema.NullOr(Schema.String) }),
  ),
  read(
    "blobs_get",
    "One blob: its size and type, text when readable, and a download URL valid for five minutes. The URL returns the original bytes.",
    { ...name, ...key },
    Schema.Struct({
      key: Schema.String,
      size: Schema.Number,
      content_type: Schema.String,
      text: Schema.NullOr(Schema.String),
      download_url: Schema.String,
    }),
  ),
  write(
    "blobs_put",
    "Stores one blob the applet reads with `blob.get(key)`: text as `text`, or bytes such as an image as `base64`, one of the two. Replaces any value at the key.",
    {
      ...name,
      ...key,
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
  write("blobs_remove", "Removes one blob.", { ...name, ...key }, Ok, true),
  read(
    "secrets_list",
    "The names of the applet's secrets. Values are never returned.",
    name,
    Schema.Struct({ secrets: Schema.Array(SecretEntry) }),
  ),
  write(
    "secrets_set",
    'Sets one secret the applet reads with `secret("NAME")`. The name is capitals, digits and underscores.',
    { ...name, secret: Schema.String, value: Schema.String },
    Ok,
  ),
  write("secrets_remove", "Removes one secret.", { ...name, secret: Schema.String }, Ok, true),
  read(
    "logs_list",
    "Lines the applet logged, newest first.",
    { ...name, ...Window, level: Schema.optional(Schema.String) },
    Schema.Struct({ logs: Schema.Array(LogEntry) }),
  ),
  read(
    "requests_list",
    "The applet's runs, newest first: every HTTP request, schedule tick, manual run and email, with status, error and duration.",
    { ...name, ...Window },
    Schema.Struct({ requests: Schema.Array(RequestEntry) }),
  ),
  read(
    "emails_list",
    "Mail sent and received by an applet, with sender, recipient, subject, status and time; bodies are not stored.",
    { ...name, after: Window.after, limit: Window.limit },
    Schema.Struct({ emails: Schema.Array(EmailEntry) }),
  ),
);

const isText = (contentType: string) => /^text\/|json|xml|javascript/.test(contentType);

/** Every tool over the services of the request that built it: the caller and the router's own. */
const handlers = toolkit.toLayer(
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Caller | Registry | Supervisors | Bundler | Bucket | Vars | AppletFetch
    >();

    const caller = yield* Caller;
    const registry = yield* Registry;
    const supervisors = yield* Supervisors;
    const vars = yield* Vars;
    const fetchApplet = yield* AppletFetch;

    const provided = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        Caller | Registry | Supervisors | Bundler | Bucket | Vars | AppletFetch
      >,
    ) => Effect.provide(effect, context);

    // A refused build is one line per problem, joined so the text of the result carries them all.
    const refusedBuild = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.mapError(effect, (failed) =>
        failed instanceof BuildFailed
          ? new BadRequest({ message: failed.errors.join("\n") })
          : failed,
      );

    return {
      help: ({ topic }) => {
        if (topic === undefined)
          return Effect.succeed({
            text: [
              `You act as ${caller.email} (${caller.role}). An applet named x answers at https://x${vars.HOST_SUFFIX}.`,
              "",
              "Workflow: templates_list and applet_create to start; files_read, then files_edit or applet_deploy to change; applet_fetch or applet_run to exercise; requests_list and logs_list to see what happened. Settings, schedule and rollback are applet_configure.",
              "",
              "Topics, for help(topic):",
              index,
            ].join("\n"),
          });

        const found = topics[topic];

        return found === undefined
          ? Effect.fail(
              new BadRequest({
                message: `no topic ${topic}; one of ${Object.keys(topics).join(", ")}`,
              }),
            )
          : Effect.succeed({ text: found.text });
      },
      applet_list: () =>
        registry
          .listApplets(caller.email, caller.role === "admin")
          .pipe(Effect.map((applets) => ({ applets }))),
      applet_get: ({ name }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);

            return { applet, versions: yield* registry.listVersions(applet.id) };
          }),
        ),
      applet_create: ({ name, template, files }) =>
        provided(refusedBuild(create(name, template, files))),
      applet_deploy: ({ name, files, fresh }) =>
        provided(refusedBuild(deploy(name, files, fresh ?? false))),
      applet_configure: ({ name, new_name, ...change }) =>
        provided(patch(name, new_name === undefined ? change : { ...change, name: new_name })),
      applet_fork: ({ name, new_name }) => provided(fork(name, new_name)),
      applet_run: ({ name }) =>
        provided(
          Effect.gen(function* () {
            const target = targetOf(yield* owned(name));

            if (target === undefined)
              return yield* new NotFound({ message: "applet has no version" });

            yield* supervisors.run(target, "manual");

            return ok;
          }),
        ),
      applet_fetch: ({ name, path, method, headers, body }) =>
        Effect.gen(function* () {
          const url = `https://${name}${vars.HOST_SUFFIX}${path.startsWith("/") ? path : `/${path}`}`;

          const request = yield* Effect.try({
            try: () => new Request(url, { method: method ?? "GET", headers, body }),
            catch: (cause) => new BadRequest({ message: String(cause) }),
          });

          const response = yield* fetchApplet(name, request);

          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: yield* Effect.promise(() => response.text()),
          };
        }),
      applet_remove: ({ name }) => provided(remove(name)),
      templates_list: () => Effect.succeed({ templates: listTemplates() }),
      files_read: ({ name, version, paths }) =>
        provided(
          Effect.gen(function* () {
            const current = yield* source(name, version);

            if (paths === undefined) return current;

            const missing = paths.filter((path) => !(path in current.files));

            if (missing.length > 0)
              return yield* new NotFound({ message: `no file ${missing.join(", ")}` });

            return {
              version: current.version,
              files: Object.fromEntries(paths.map((path) => [path, current.files[path] ?? ""])),
            };
          }),
        ),
      files_edit: ({ name, edits }) => provided(refusedBuild(edit(name, edits))),
      sql_read: ({ name, sql }) => provided(runSql(name, sql, true)),
      sql_write: ({ name, statements }) => provided(runSqlBatch(name, statements)),
      kv_list: ({ name, prefix }) => provided(listKv(name, prefix ?? "")),
      kv_get: ({ name, key }) => provided(getKv(name, key)),
      kv_put: ({ name, key, value }) => provided(putKv(name, key, value)),
      kv_remove: ({ name, key }) => provided(removeKv(name, key)),
      blobs_list: ({ name, prefix, cursor }) => provided(listBlobs(name, prefix ?? "", cursor)),
      blobs_get: ({ name, key }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);
            const object = yield* getBlob(name, key);

            if (object === null) return yield* new NotFound({ message: `no blob ${key}` });

            const content_type = object.httpMetadata?.contentType ?? "application/octet-stream";
            const text = isText(content_type) ? yield* Effect.promise(() => object.text()) : null;

            const download_url = yield* Effect.promise(() =>
              blobDownloadUrl(vars.MCP_URL, vars.BETTER_AUTH_SECRET, applet.id, key),
            );

            return { key, size: object.size, content_type, text, download_url };
          }),
        ),
      blobs_put: ({ name, key, text, base64, content_type }) =>
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
      blobs_remove: ({ name, key }) => provided(removeBlob(name, key).pipe(Effect.as(ok))),
      secrets_list: ({ name }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);

            return { secrets: yield* registry.listSecrets(applet.id) };
          }),
        ),
      secrets_set: ({ name, secret, value }) =>
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
      secrets_remove: ({ name, secret }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);
            yield* registry.putSecret(applet.id, secret, null);
            yield* log.info("secret removed", { applet: name, name: secret });

            return ok;
          }),
        ),
      logs_list: ({ name, ...query }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);

            return { logs: yield* registry.listLogs(applet.id, query) };
          }),
        ),
      requests_list: ({ name, ...query }) =>
        provided(
          Effect.gen(function* () {
            const applet = yield* owned(name);

            return { requests: yield* registry.listRequests(applet.id, query) };
          }),
        ),
      emails_list: ({ name, ...query }) => provided(emails(name, query)),
    };
  }),
);

/** What every client is told on connect: enough to orient, and where the rest is. */
const instructions = `Applets is a personal platform for small programs on Cloudflare Workers. An applet is a directory whose entry is main.ts, exporting fetch(request) and optionally scheduled(event) and inbox(message). @std gives it SQLite, key-value storage, blobs, email, AI and logs with no setup. Tools are named object_verb: applet_*, templates_*, files_*, sql_*, kv_*, blobs_*, secrets_*, logs_*, requests_*, emails_*.

Start with help(): who you act as, where applets answer, and the topics. Before writing an applet, help("applets") once: it is the full guide, and the build refuses code that breaks its rules. Then templates_list and applet_create to start, files_read and files_edit or applet_deploy to change, applet_fetch or applet_run to exercise it, and requests_list and logs_list to see what happened. A change is not done until they show it working.`;

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
