/**
 * The admin API contract. The router implements it with `HttpApiBuilder`; the
 * editor and `vp run push` call it through the client `HttpApiClient` derives.
 * Every registry row that crosses the wire is a Schema here, so the router
 * decodes rows and encodes responses with the shapes the clients decode, and
 * the errors are the tagged errors a handler fails with, each with its status.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";

export const visibilities = ["private", "family", "public"] as const;

export type Visibility = (typeof visibilities)[number];

export const egressModes = ["open", "none"] as const;

export type EgressMode = (typeof egressModes)[number];

export const logLevels = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof logLevels)[number];

export const requestKinds = ["http", "schedule", "manual", "email"] as const;

export type RequestKind = (typeof requestKinds)[number];

export const emailStatuses = ["sent", "delivered", "failed", "unclaimed"] as const;

export type EmailStatus = (typeof emailStatuses)[number];

/**
 * An `applets` row. `id` is the applet for good: a UUID v7, so ids sort by creation; `name` is
 * its hostname and may change. `schedule` and `email` are the applet's triggers, settings like
 * `visibility`; `email` is SQLite's boolean. `secrets_rev` bumps on every secret change so the
 * supervisor reloads them.
 */
export const Applet = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  owner: Schema.String,
  description: Schema.String,
  visibility: Schema.Literals(visibilities),
  egress: Schema.Literals(egressModes),
  schedule: Schema.NullOr(Schema.String),
  email: Schema.Literals([0, 1]),
  current_version: Schema.NullOr(Schema.Number),
  secrets_rev: Schema.Number,
  created_at: Schema.String,
  updated_at: Schema.String,
});

export type Applet = typeof Applet.Type;

/** A row on the applets list. `failures` counts the viewer's own failed runs in the last day, and is 0 on anyone else's applet. */
export const AppletSummary = Schema.Struct({ ...Applet.fields, failures: Schema.Number });

export type AppletSummary = typeof AppletSummary.Type;

/** Source files by path, as the editor and `vp run push` send them. */
export const Files = Schema.Record(Schema.String, Schema.String);

export type Files = typeof Files.Type;

export const FileChange = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(["added", "changed", "deleted"]),
});

export type FileChange = typeof FileChange.Type;

const JsonList = Schema.fromJsonString(Schema.Array(Schema.String));

/** A `versions` row. Ids count from 1 per applet; the list columns are JSON text in the row and on the wire. `applet` is the applet's name, here and on every row below. */
export const Version = Schema.Struct({
  id: Schema.Number,
  applet: Schema.String,
  exports: JsonList,
  installed: JsonList,
  changed: Schema.fromJsonString(Schema.Array(FileChange)),
  created_at: Schema.String,
});

export type Version = typeof Version.Type;

export const LogEntry = Schema.Struct({
  id: Schema.Number,
  applet: Schema.String,
  version: Schema.Number,
  level: Schema.Literals(logLevels),
  message: Schema.String,
  data: Schema.NullOr(Schema.String),
  request_id: Schema.NullOr(Schema.String),
  at: Schema.String,
});

export type LogEntry = typeof LogEntry.Type;

/** One line the platform wrote about itself. `applet` is set when the line is about one applet. */
export const PlatformLogEntry = Schema.Struct({
  id: Schema.Number,
  level: Schema.Literals(logLevels),
  message: Schema.String,
  data: Schema.NullOr(Schema.String),
  applet: Schema.NullOr(Schema.String),
  trace_id: Schema.NullOr(Schema.String),
  at: Schema.String,
});

export type PlatformLogEntry = typeof PlatformLogEntry.Type;

/** One run of an applet: an HTTP request, a schedule, a manual run or an email. */
export const RequestEntry = Schema.Struct({
  id: Schema.Number,
  request_id: Schema.String,
  applet: Schema.String,
  version: Schema.Number,
  kind: Schema.Literals(requestKinds),
  method: Schema.String,
  path: Schema.String,
  status: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  duration_ms: Schema.Number,
  at: Schema.String,
});

export type RequestEntry = typeof RequestEntry.Type;

/** One email in or out. No bodies: `message_id` is Cloudflare's id for mail out, and ours for mail in. */
export const EmailEntry = Schema.Struct({
  id: Schema.Number,
  direction: Schema.Literals(["in", "out"]),
  applet: Schema.NullOr(Schema.String),
  message_id: Schema.NullOr(Schema.String),
  sender: Schema.String,
  recipient: Schema.String,
  subject: Schema.String,
  status: Schema.Literals(emailStatuses),
  detail: Schema.NullOr(Schema.String),
  at: Schema.String,
});

export type EmailEntry = typeof EmailEntry.Type;

/** One hour of requests. `hour` is the ISO start of the hour, in UTC. */
export const TrafficHour = Schema.Struct({
  hour: Schema.String,
  total: Schema.Number,
  failed: Schema.Number,
});

export type TrafficHour = typeof TrafficHour.Type;

/** One secret of an applet. The router takes values and never returns them. */
export const SecretEntry = Schema.Struct({ name: Schema.String, updated_at: Schema.String });

export type SecretEntry = typeof SecretEntry.Type;

/** An email that may sign in. The admin is not a row: the platform's owner names them. */
export const User = Schema.Struct({ email: Schema.String, added_at: Schema.String });

export type User = typeof User.Type;

/** An API key as its creator sees it after the first time. The key itself is stored as a hash only. */
export const ApiKey = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  created_at: Schema.String,
  last_used_at: Schema.NullOr(Schema.String),
});

export type ApiKey = typeof ApiKey.Type;

export const Session = Schema.Struct({
  id: Schema.String,
  created_at: Schema.String,
  expires_at: Schema.String,
  user_agent: Schema.NullOr(Schema.String),
  ip: Schema.NullOr(Schema.String),
  current: Schema.Boolean,
});

export type Session = typeof Session.Type;

export const Me = Schema.Struct({ email: Schema.String, role: Schema.Literals(["admin", "user"]) });

export type Me = typeof Me.Type;

export const Platform = Schema.Struct({
  host_suffix: Schema.String,
  owner: Schema.String,
  email_from: Schema.String,
  default_model: Schema.String,
  log_retention_days: Schema.Number,
  email_retention_days: Schema.Number,
});

export type Platform = typeof Platform.Type;

/** A SQLite value as JSON carries it: a BLOB travels as hex. */
export const Cell = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Null,
  Schema.Struct({ blob: Schema.String }),
]);

export type Cell = typeof Cell.Type;

export const SqlResult = Schema.Struct({
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Cell)),
  rowsWritten: Schema.Number,
});

export type SqlResult = typeof SqlResult.Type;

/** One key of the applet's `kv`, with its value as JSON text. */
export const KvEntry = Schema.Struct({ key: Schema.String, value: Schema.String });

export type KvEntry = typeof KvEntry.Type;

export const KvList = Schema.Struct({ entries: Schema.Array(KvEntry) });

export const BlobEntry = Schema.Struct({
  key: Schema.String,
  size: Schema.Number,
  content_type: Schema.NullOr(Schema.String),
  uploaded_at: Schema.String,
});

export type BlobEntry = typeof BlobEntry.Type;

/** The answer to a deploy: the new version, what the bundle exports and installed, and the bundler's warnings. */
export const Deployed = Schema.Struct({
  version: Schema.Number,
  exports: Schema.Array(Schema.String),
  installed: Schema.Array(Schema.String),
  warnings: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type Deployed = typeof Deployed.Type;

/**
 * The settings a PATCH changes. `name` renames the applet: its hostname and email address move,
 * everything else stays. `schedule` is a five-field cron expression, or null to stop the timer;
 * `email` says whether mail to `<applet>@<domain>` reaches the applet.
 */
export const AppletPatch = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  visibility: Schema.optionalKey(Schema.Literals(visibilities)),
  egress: Schema.optionalKey(Schema.Literals(egressModes)),
  schedule: Schema.optionalKey(Schema.NullOr(Schema.String)),
  email: Schema.optionalKey(Schema.Boolean),
  current_version: Schema.optional(Schema.Number),
});

export type AppletPatch = typeof AppletPatch.Type;

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

/** A deploy the bundler refused: one line per problem, each naming the file. */
export class BuildFailed extends Schema.TaggedError<BuildFailed>()(
  "BuildFailed",
  { errors: Schema.Array(Schema.String) },
  { httpApiStatus: 422 },
) {}

/** The applet's own code threw or did not answer. */
export class AppletFailed extends Schema.TaggedError<AppletFailed>()(
  "AppletFailed",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

const Ok = Schema.Struct({ ok: Schema.Literal(true) });

const name = { name: Schema.String };

/** The `version`, `after` and `limit` filters of a per-applet stream. */
const Window = {
  version: Schema.optional(Schema.Number),
  after: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
};

const owned = [NotFound, Forbidden] as const;

const applets = HttpApiGroup.make("applets").add(
  HttpApiEndpoint.get("list", "/applets", {
    success: Schema.Struct({ applets: Schema.Array(AppletSummary) }),
  }),
  HttpApiEndpoint.get("get", "/applets/:name", {
    params: name,
    success: Schema.Struct({ applet: Applet, versions: Schema.Array(Version) }),
    error: owned,
  }),
  HttpApiEndpoint.patch("patch", "/applets/:name", {
    params: name,
    payload: AppletPatch,
    success: Schema.Struct({ applet: Applet }),
    error: [NotFound, Forbidden, BadRequest],
  }),
  HttpApiEndpoint.delete("remove", "/applets/:name", { params: name, success: Ok, error: owned }),
  HttpApiEndpoint.post("fork", "/applets/:name/fork", {
    params: name,
    payload: Schema.Struct({ name: Schema.String }),
    success: Schema.Struct({ applet: Applet }),
    error: [NotFound, Forbidden, BadRequest],
  }),
  HttpApiEndpoint.post("run", "/applets/:name/run", {
    params: name,
    success: Ok,
    error: [NotFound, Forbidden, AppletFailed],
  }),
  HttpApiEndpoint.get("draft", "/applets/:name/draft", {
    params: name,
    success: Schema.Struct({
      files: Schema.NullOr(Files),
      updated_at: Schema.NullOr(Schema.String),
    }),
    error: owned,
  }),
  HttpApiEndpoint.put("saveDraft", "/applets/:name/draft", {
    params: name,
    payload: Schema.Struct({ files: Files }),
    success: Schema.Struct({ updated_at: Schema.String }),
    error: [NotFound, Forbidden, BuildFailed],
  }),
  HttpApiEndpoint.delete("discardDraft", "/applets/:name/draft", {
    params: name,
    success: Ok,
    error: owned,
  }),
  HttpApiEndpoint.get("logs", "/applets/:name/logs", {
    params: name,
    query: { ...Window, level: Schema.optional(Schema.Literals(logLevels)) },
    success: Schema.Struct({ logs: Schema.Array(LogEntry) }),
    error: owned,
  }),
  HttpApiEndpoint.get("requests", "/applets/:name/requests", {
    params: name,
    query: Window,
    success: Schema.Struct({ requests: Schema.Array(RequestEntry) }),
    error: owned,
  }),
  HttpApiEndpoint.get("traffic", "/applets/:name/traffic", {
    params: name,
    success: Schema.Struct({ hours: Schema.Array(TrafficHour) }),
    error: owned,
  }),
  HttpApiEndpoint.get("emails", "/applets/:name/emails", {
    params: name,
    query: Window,
    success: Schema.Struct({ emails: Schema.Array(EmailEntry) }),
    error: owned,
  }),
);

const versions = HttpApiGroup.make("versions").add(
  HttpApiEndpoint.put("deploy", "/applets/:name/versions", {
    params: name,
    query: { fresh: Schema.optional(Schema.Boolean) },
    payload: Schema.Struct({ files: Files }),
    success: Deployed,
    error: [Forbidden, BuildFailed],
  }),
  HttpApiEndpoint.get("source", "/applets/:name/source", {
    params: name,
    query: { version: Schema.optional(Schema.Number) },
    success: Schema.Struct({ version: Schema.Number, files: Files }),
    error: owned,
  }),
);

/** The owner's view into the applet's own storage. SQL and KV are answered inside the applet's facet, blobs from the bucket. */
const storage = HttpApiGroup.make("storage").add(
  HttpApiEndpoint.post("sql", "/applets/:name/sql", {
    params: name,
    payload: Schema.Struct({ sql: Schema.String }),
    success: SqlResult,
    error: [NotFound, Forbidden, BadRequest, AppletFailed],
  }),
  HttpApiEndpoint.get("kv", "/applets/:name/kv", {
    params: name,
    query: { prefix: Schema.optional(Schema.String) },
    success: KvList,
    error: [NotFound, Forbidden, BadRequest, AppletFailed],
  }),
  HttpApiEndpoint.delete("removeKv", "/applets/:name/kv", {
    params: name,
    query: { key: Schema.String },
    success: Ok,
    error: [NotFound, Forbidden, BadRequest, AppletFailed],
  }),
  HttpApiEndpoint.get("blobs", "/applets/:name/blobs", {
    params: name,
    query: { prefix: Schema.optional(Schema.String), cursor: Schema.optional(Schema.String) },
    success: Schema.Struct({
      blobs: Schema.Array(BlobEntry),
      cursor: Schema.NullOr(Schema.String),
    }),
    error: owned,
  }),
  HttpApiEndpoint.get("blob", "/applets/:name/blob", {
    params: name,
    query: { key: Schema.String },
    success: HttpApiSchema.StreamUint8Array(),
    error: owned,
  }),
  HttpApiEndpoint.put("putBlob", "/applets/:name/blob", {
    params: name,
    query: { key: Schema.String, content_type: Schema.optional(Schema.String) },
    payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    success: Ok,
    error: [...owned, BadRequest],
  }),
  HttpApiEndpoint.delete("removeBlob", "/applets/:name/blob", {
    params: name,
    query: { key: Schema.String },
    success: Ok,
    error: owned,
  }),
);

const secrets = HttpApiGroup.make("secrets").add(
  HttpApiEndpoint.get("list", "/applets/:name/secrets", {
    params: name,
    success: Schema.Struct({ secrets: Schema.Array(SecretEntry) }),
    error: owned,
  }),
  HttpApiEndpoint.put("put", "/applets/:name/secrets", {
    params: name,
    payload: Schema.Struct({ name: Schema.String, value: Schema.String }),
    success: Ok,
    error: [NotFound, Forbidden, BadRequest],
  }),
  HttpApiEndpoint.delete("remove", "/applets/:name/secrets", {
    params: name,
    query: { name: Schema.String },
    success: Ok,
    error: owned,
  }),
);

/** The platform Logs page: the caller's runs across applets, and the lines one run wrote. */
const runs = HttpApiGroup.make("runs").add(
  HttpApiEndpoint.get("list", "/runs", {
    query: {
      applet: Schema.optional(Schema.String),
      kind: Schema.optional(Schema.Literals(requestKinds)),
      status: Schema.optional(Schema.Literals(["ok", "failed"])),
      before: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
    },
    success: Schema.Struct({ runs: Schema.Array(RequestEntry) }),
  }),
  HttpApiEndpoint.get("logs", "/runs/:id/logs", {
    params: { id: Schema.String },
    success: Schema.Struct({ logs: Schema.Array(LogEntry) }),
  }),
);

/** The caller's own API keys. A new key is in the answer to `create` and nowhere after that. */
const keys = HttpApiGroup.make("keys").add(
  HttpApiEndpoint.get("list", "/keys", {
    success: Schema.Struct({ keys: Schema.Array(ApiKey) }),
  }),
  HttpApiEndpoint.post("create", "/keys", {
    payload: Schema.Struct({ name: Schema.String }),
    success: Schema.Struct({ key: Schema.String }),
  }),
  HttpApiEndpoint.delete("remove", "/keys/:id", { params: { id: Schema.Number }, success: Ok }),
);

/** Who may sign in. Only the admin reads or changes the list. */
const users = HttpApiGroup.make("users").add(
  HttpApiEndpoint.get("list", "/users", {
    success: Schema.Struct({ users: Schema.Array(User) }),
    error: Forbidden,
  }),
  HttpApiEndpoint.put("add", "/users/:email", {
    params: { email: Schema.String },
    success: Ok,
    error: Forbidden,
  }),
  HttpApiEndpoint.delete("remove", "/users/:email", {
    params: { email: Schema.String },
    success: Ok,
    error: Forbidden,
  }),
);

/** The caller's browser sessions. A caller with a key or the local dev user has none. */
const sessions = HttpApiGroup.make("sessions").add(
  HttpApiEndpoint.get("list", "/sessions", {
    success: Schema.Struct({ sessions: Schema.Array(Session) }),
  }),
  HttpApiEndpoint.delete("revoke", "/sessions/:id", {
    params: { id: Schema.String },
    success: Ok,
    error: NotFound,
  }),
);

const platform = HttpApiGroup.make("platform").add(
  HttpApiEndpoint.get("me", "/me", { success: Me }),
  HttpApiEndpoint.get("info", "/platform", { success: Platform, error: Forbidden }),
  HttpApiEndpoint.get("unclaimed", "/emails/unclaimed", {
    query: Window,
    success: Schema.Struct({ emails: Schema.Array(EmailEntry) }),
    error: Forbidden,
  }),
  HttpApiEndpoint.get("logs", "/platform/logs", {
    query: {
      level: Schema.optional(Schema.Literals(logLevels)),
      applet: Schema.optional(Schema.String),
      before: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
    },
    success: Schema.Struct({ logs: Schema.Array(PlatformLogEntry) }),
    error: Forbidden,
  }),
);

export const api = HttpApi.make("applets").add(
  applets,
  versions,
  storage,
  secrets,
  runs,
  keys,
  users,
  sessions,
  platform,
);
