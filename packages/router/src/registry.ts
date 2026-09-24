/**
 * The registry: the tables in the router's D1 database and the queries on them, as one
 * Effect service on `@effect/sql-d1`. The tables come from `migrations/`, which deploy and
 * dev apply before the router starts, so building the layer does no I/O. Multi-statement writes go through D1's atomic
 * `batch`, since D1 has no transactions.
 */
import { D1Client } from "@effect/sql-d1";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

import {
  ApiKey,
  Applet,
  AppletSummary,
  EmailEntry,
  LogEntry as LogRow,
  PlatformLogEntry,
  RequestEntry,
  SecretEntry,
  TrafficHour,
  User,
  Version,
  type EgressMode,
  type FileChange,
  type Files,
  type Visibility,
} from "@applets/api";

import type { LogEntry } from "@applets/api/capabilities";

import type { NewPlatformLog } from "./platformLog.ts";
import { retention, type Draft, type PlatformLogQuery, type RunQuery } from "./types.ts";

/** An `emails` row to write. `applet_id` is null for mail nobody claimed. */
export type NewEmail = Omit<EmailEntry, "id" | "at" | "applet"> & {
  readonly applet_id: string | null;
};

export type NewVersion = {
  readonly server: string;
  readonly files: Files;
  readonly exports: ReadonlyArray<string>;
  readonly installed: ReadonlyArray<string>;
  /** Set on the applet when this version creates it; a later version leaves the setting alone. */
  readonly description: string;
};

/** The settings a patch changes. `schedule` null stops the timer; leaving a field out keeps it. */
export type AppletPatch = {
  readonly name?: string;
  readonly description?: string;
  readonly visibility?: Visibility;
  readonly egress?: EgressMode;
  readonly schedule?: string | null;
  readonly email?: boolean;
  readonly current_version?: number;
};

/** Which rows to read from `logs` or `requests`: one version or all, the last `limit` or everything after an id. */
export type WindowQuery = {
  readonly version?: number;
  readonly limit?: number;
  readonly after?: number;
};

export type LogQuery = WindowQuery & { readonly level?: string };

export type NewRequest = {
  readonly request_id: string;
  readonly version: number;
  readonly kind?: RequestEntry["kind"];
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly error?: string;
  readonly duration_ms: number;
};

/** `putVersion` on a name another user's applet already holds. */
export class NameTaken extends Schema.TaggedError<NameTaken>()("Registry.NameTaken", {
  name: Schema.String,
}) {}

const now = () => new Date().toISOString();

/** A UUID version 7: the millisecond in the first 48 bits, random after, so ids made later sort later. */
export function uuidv7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  new DataView(bytes.buffer).setUint32(0, Math.floor(ms / 0x10000));
  new DataView(bytes.buffer).setUint16(4, ms % 0x10000);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The files that differ between two versions, for the history view. */
export function diffFiles(
  before: Record<string, string>,
  after: Record<string, string>,
): Array<FileChange> {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  return paths.flatMap((path): Array<FileChange> => {
    if (!(path in before)) return [{ path, change: "added" }];

    if (!(path in after)) return [{ path, change: "deleted" }];

    return before[path] === after[path] ? [] : [{ path, change: "changed" }];
  });
}

/** D1 caps a row at 2 MB; the rest is headroom for the row's keys. */
export const maxTextBytes = 1_900_000;

/** One error per source file too large for the one `file_contents` row it is stored in. */
export const fileSizeErrors = (files: Files): Array<string> =>
  Object.entries(files).flatMap(([path, content]) => {
    const bytes = new TextEncoder().encode(content).byteLength;

    return bytes > maxTextBytes
      ? [
          `${path} is ${bytes} bytes, past the ${maxTextBytes} a file can be under D1's 2 MB row limit`,
        ]
      : [];
  });

/** Splits text into pieces of at most `limit` UTF-8 bytes, never inside a character. */
export function splitText(text: string, limit = maxTextBytes): Array<string> {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  const pieces: Array<string> = [];
  let start = 0;

  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);

    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;

    pieces.push(decoder.decode(bytes.subarray(start, end)));
    start = end;
  }

  return pieces;
}

/** Text stored once per applet, in `file_contents` or `bundle_parts`, under its SHA-256. */
type Hashed = { readonly hash: string; readonly text: string };

const hashText = (text: string) =>
  Effect.promise(async (): Promise<Hashed> => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

    return {
      hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
      text,
    };
  });

/** A file map as the path-to-hash map a row stores, and the contents those hashes name. */
const hashFiles = Effect.fnUntraced(function* (files: Files) {
  const paths = Object.keys(files);
  const contents = yield* Effect.forEach(Object.values(files), hashText);

  return {
    hashes: Object.fromEntries(paths.map((path, index) => [path, contents[index]!.hash])),
    contents,
  };
});

const FileRow = Schema.Struct({ path: Schema.String, content: Schema.String });

const Hashes = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const fileMap = (rows: ReadonlyArray<typeof FileRow.Type>): Record<string, string> =>
  Object.fromEntries(rows.map((row) => [row.path, row.content]));

/** The columns of a `versions` row without its `files` and `bundle` hash lists, and the applet's name. */
const versionColumns =
  "versions.id, applets.name AS applet, exports, installed, changed, versions.created_at";

const versionsOf = (sql: SqlClient.SqlClient, id: string) =>
  sql`FROM versions JOIN applets ON applets.id = versions.applet_id WHERE versions.applet_id = ${id}`;

const day = 86_400_000;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const d1 = yield* D1Client.D1Client;

  /** Every row of a query, decoded. */
  const rows = <S extends Schema.Top>(schema: S) =>
    Schema.decodeUnknownEffect(Schema.Array(schema));

  /** The first row of a query, decoded, or none. */
  const first =
    <S extends Schema.Top>(schema: S) =>
    (result: ReadonlyArray<object>) =>
      result.length === 0
        ? Effect.succeed(Option.none<S["Type"]>())
        : Effect.map(Schema.decodeUnknownEffect(schema)(result[0]), Option.some);

  /** The last `limit` rows of a per-applet table, oldest first, or everything after a known id when following. The row carries the applet's name as `applet`. */
  const window = <S extends Schema.Top>(
    schema: S,
    table: "logs" | "requests",
    id: string,
    query: WindowQuery,
    extra = sql.literal(""),
  ) =>
    Effect.gen(function* () {
      const limit = query.limit ?? 50;
      const version = query.version ?? null;
      const t = sql.literal(table);
      const from = sql`FROM ${t} JOIN applets ON applets.id = ${t}.applet_id WHERE applet_id = ${id} AND (${version} IS NULL OR version = ${version}) ${extra}`;

      const result = yield* rows(schema)(
        yield* query.after === undefined
          ? sql`SELECT ${t}.*, applets.name AS applet ${from} ORDER BY ${t}.id DESC LIMIT ${limit}`
          : sql`SELECT ${t}.*, applets.name AS applet ${from} AND ${t}.id > ${query.after} ORDER BY ${t}.id ASC LIMIT ${limit}`,
      );

      return query.after === undefined ? result.toReversed() : result;
    });

  /** Inserts for the texts the applet's table does not hold yet, so unchanged content is never sent again. */
  const missing = (
    table: "file_contents" | "bundle_parts",
    id: string,
    texts: ReadonlyArray<Hashed>,
  ) =>
    Effect.gen(function* () {
      const held = yield* rows(Schema.Struct({ hash: Schema.String }))(
        yield* sql`SELECT hash FROM ${sql.literal(table)} WHERE applet_id = ${id}`,
      );

      const known = new Set(held.map((row) => row.hash));

      return texts.flatMap((item) =>
        known.has(item.hash)
          ? []
          : [
              sql`INSERT INTO ${sql.literal(table)} (applet_id, hash, text) VALUES (${id}, ${item.hash}, ${item.text}) ON CONFLICT (applet_id, hash) DO NOTHING`,
            ],
      );
    });

  const getApplet = Effect.fn("Registry.getApplet")(function* (name: string) {
    return yield* first(Applet)(yield* sql`SELECT * FROM applets WHERE name = ${name}`);
  }, Effect.orDie);

  const getAppletById = Effect.fn("Registry.getAppletById")(function* (id: string) {
    return yield* first(Applet)(yield* sql`SELECT * FROM applets WHERE id = ${id}`);
  }, Effect.orDie);

  const getVersion = Effect.fn("Registry.getVersion")(function* (id: string, version: number) {
    return yield* first(Version)(
      yield* sql`SELECT ${sql.literal(versionColumns)} ${versionsOf(sql, id)} AND versions.id = ${version}`,
    );
  }, Effect.orDie);

  return {
    getApplet,
    getAppletById,
    getVersion,

    /** The viewer's applets, or every applet when `all`. Failed runs are counted on the viewer's own only, since requests belong to the owner. */
    listApplets: Effect.fn("Registry.listApplets")(function* (viewer: string, all: boolean) {
      const since = new Date(Date.now() - day).toISOString();

      return yield* rows(AppletSummary)(
        yield* sql`SELECT applets.*, (
             SELECT COUNT(*) FROM requests
             WHERE requests.applet_id = applets.id AND applets.owner = ${viewer} AND requests.at > ${since}
               AND (requests.error IS NOT NULL OR requests.status >= 500)
           ) AS failures
           FROM applets WHERE ${all ? 1 : 0} OR owner = ${viewer} ORDER BY name`,
      );
    }, Effect.orDie),

    listVersions: Effect.fn("Registry.listVersions")(function* (id: string) {
      return yield* rows(Version)(
        yield* sql`SELECT ${sql.literal(versionColumns)} ${versionsOf(sql, id)} ORDER BY versions.id DESC`,
      );
    }, Effect.orDie),

    /** A version's source files by path, empty when the version does not exist. */
    getFiles: Effect.fn("Registry.getFiles")(function* (id: string, version: number) {
      return fileMap(
        yield* rows(FileRow)(
          yield* sql`SELECT entry.key AS path, file_contents.text AS content
           FROM versions
           CROSS JOIN json_each(versions.files) AS entry
           CROSS JOIN file_contents ON file_contents.applet_id = versions.applet_id AND file_contents.hash = entry.value
           WHERE versions.applet_id = ${id} AND versions.id = ${version}`,
        ),
      );
    }, Effect.orDie),

    /** A version's built server module, joined from its pieces, or none when the version does not exist. */
    getBundle: Effect.fn("Registry.getBundle")(function* (id: string, version: number) {
      const parts = yield* rows(Schema.Struct({ text: Schema.String }))(
        yield* sql`SELECT bundle_parts.text AS text
           FROM versions
           CROSS JOIN json_each(versions.bundle) AS entry
           CROSS JOIN bundle_parts ON bundle_parts.applet_id = versions.applet_id AND bundle_parts.hash = entry.value
           WHERE versions.applet_id = ${id} AND versions.id = ${version}
           ORDER BY entry.key`,
      );

      return parts.length === 0
        ? Option.none()
        : Option.some(parts.map((row) => row.text).join(""));
    }, Effect.orDie),

    /**
     * Records the next version of an applet, numbered from 1, and makes it
     * current. The applet row is created on the
     * first version, with a fresh id. The version row and the new text it
     * names land in one batch. Fails with `NameTaken` when another user's
     * applet holds the name. Answers the applet as it stands after.
     */
    putVersion: Effect.fn("Registry.putVersion")(
      function* (name: string, owner: string, version: NewVersion) {
        const at = now();

        yield* sql`INSERT INTO applets (id, name, owner, description, created_at, updated_at)
           VALUES (${uuidv7()}, ${name}, ${owner}, ${version.description}, ${at}, ${at}) ON CONFLICT (name) DO NOTHING`;

        const applet = yield* getApplet(name);

        if (Option.isNone(applet) || applet.value.owner !== owner)
          return yield* new NameTaken({ name });

        const { id, current_version } = applet.value;

        const previous =
          current_version === null
            ? Option.none()
            : yield* first(Schema.Struct({ files: Hashes }))(
                yield* sql`SELECT files FROM versions WHERE applet_id = ${id} AND id = ${current_version}`,
              );

        const before = Option.match(previous, { onNone: () => ({}), onSome: (row) => row.files });
        const files = yield* hashFiles(version.files);
        const bundle = yield* Effect.forEach(splitText(version.server), hashText);

        yield* d1.batch([
          sql`INSERT INTO versions (id, applet_id, files, bundle, exports, installed, changed, created_at)
             VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM versions WHERE applet_id = ${id}),
               ${id}, ${JSON.stringify(files.hashes)}, ${JSON.stringify(bundle.map((part) => part.hash))},
               ${JSON.stringify(version.exports)}, ${JSON.stringify(version.installed)},
               ${JSON.stringify(diffFiles(before, files.hashes))}, ${at})`,
          ...(yield* missing("file_contents", id, files.contents)),
          ...(yield* missing("bundle_parts", id, bundle)),
          sql`UPDATE applets SET current_version = (SELECT MAX(id) FROM versions WHERE applet_id = ${id}), updated_at = ${at}
             WHERE id = ${id}`,
        ]);

        return yield* getAppletById(id).pipe(Effect.map(Option.getOrThrow));
      },
      Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }),
    ),

    /**
     * A new applet from another's current version: the same files, bundle,
     * exports and dependencies as its version 1, a fresh id, no storage,
     * secrets, logs or triggers. The name is the caller's to check first.
     */
    forkApplet: Effect.fn("Registry.forkApplet")(function* (
      source: Applet,
      name: string,
      owner: string,
    ) {
      const version = yield* first(Schema.Struct({ files: Hashes }))(
        yield* sql`SELECT files FROM versions WHERE applet_id = ${source.id} AND id = ${source.current_version}`,
      );

      if (Option.isNone(version)) return Option.none<Applet>();

      const id = uuidv7();
      const at = now();
      const changed = diffFiles({}, version.value.files);

      yield* d1.batch([
        sql`INSERT INTO applets (id, name, owner, description, current_version, created_at, updated_at)
           VALUES (${id}, ${name}, ${owner}, ${source.description}, 1, ${at}, ${at})`,
        sql`INSERT INTO file_contents (applet_id, hash, text)
           SELECT ${id}, hash, text FROM file_contents WHERE applet_id = ${source.id} AND hash IN (
             SELECT value FROM versions, json_each(versions.files)
             WHERE versions.applet_id = ${source.id} AND versions.id = ${source.current_version})`,
        sql`INSERT INTO bundle_parts (applet_id, hash, text)
           SELECT ${id}, hash, text FROM bundle_parts WHERE applet_id = ${source.id} AND hash IN (
             SELECT value FROM versions, json_each(versions.bundle)
             WHERE versions.applet_id = ${source.id} AND versions.id = ${source.current_version})`,
        sql`INSERT INTO versions (id, applet_id, files, bundle, exports, installed, changed, created_at)
           SELECT 1, ${id}, files, bundle, exports, installed, ${JSON.stringify(changed)}, ${at}
           FROM versions WHERE applet_id = ${source.id} AND id = ${source.current_version}`,
      ]);

      return yield* getAppletById(id);
    }, Effect.orDie),

    patchApplet: Effect.fn("Registry.patchApplet")(function* (id: string, patch: AppletPatch) {
      const setsSchedule = patch.schedule === undefined ? 0 : 1;
      const email = patch.email === undefined ? null : patch.email ? 1 : 0;

      yield* sql`UPDATE applets SET
             name = COALESCE(${patch.name ?? null}, name),
             description = COALESCE(${patch.description ?? null}, description),
             visibility = COALESCE(${patch.visibility ?? null}, visibility),
             egress = COALESCE(${patch.egress ?? null}, egress),
             schedule = CASE WHEN ${setsSchedule} THEN ${patch.schedule ?? null} ELSE schedule END,
             email = COALESCE(${email}, email),
             current_version = COALESCE(${patch.current_version ?? null}, current_version),
             updated_at = ${now()}
           WHERE id = ${id}`;

      return yield* getAppletById(id);
    }, Effect.orDie),

    getDraft: Effect.fn("Registry.getDraft")(function* (id: string) {
      const draft = yield* first(Schema.Struct({ updated_at: Schema.String }))(
        yield* sql`SELECT updated_at FROM drafts WHERE applet_id = ${id}`,
      );

      if (Option.isNone(draft)) return Option.none<Draft>();

      const files = yield* rows(FileRow)(
        yield* sql`SELECT entry.key AS path, file_contents.text AS content
           FROM drafts
           CROSS JOIN json_each(drafts.files) AS entry
           CROSS JOIN file_contents ON file_contents.applet_id = drafts.applet_id AND file_contents.hash = entry.value
           WHERE drafts.applet_id = ${id}`,
      );

      return Option.some<Draft>({ files: fileMap(files), updated_at: draft.value.updated_at });
    }, Effect.orDie),

    /**
     * The editor's unsaved-to-a-version files. A deploy of the applet clears it.
     * A save writes only the contents the applet does not hold yet.
     */
    putDraft: Effect.fn("Registry.putDraft")(function* (id: string, source: Files) {
      const files = yield* hashFiles(source);
      const at = now();

      yield* d1.batch([
        ...(yield* missing("file_contents", id, files.contents)),
        sql`INSERT INTO drafts (applet_id, files, updated_at) VALUES (${id}, ${JSON.stringify(files.hashes)}, ${at})
            ON CONFLICT (applet_id) DO UPDATE SET files = excluded.files, updated_at = excluded.updated_at`,
      ]);

      return at;
    }, Effect.orDie),

    deleteDraft: Effect.fn("Registry.deleteDraft")(function* (id: string) {
      yield* sql`DELETE FROM drafts WHERE applet_id = ${id}`;
    }, Effect.orDie),

    deleteApplet: Effect.fn("Registry.deleteApplet")(function* (id: string) {
      yield* d1.batch([
        sql`DELETE FROM versions WHERE applet_id = ${id}`,
        sql`DELETE FROM file_contents WHERE applet_id = ${id}`,
        sql`DELETE FROM bundle_parts WHERE applet_id = ${id}`,
        sql`DELETE FROM drafts WHERE applet_id = ${id}`,
        sql`DELETE FROM logs WHERE applet_id = ${id}`,
        sql`DELETE FROM requests WHERE applet_id = ${id}`,
        sql`DELETE FROM emails WHERE applet_id = ${id}`,
        sql`DELETE FROM secrets WHERE applet_id = ${id}`,
        sql`DELETE FROM applets WHERE id = ${id}`,
      ]);
    }, Effect.orDie),

    /** The names of an applet's secrets. No query here returns a value to the API. */
    listSecrets: Effect.fn("Registry.listSecrets")(function* (id: string) {
      return yield* rows(SecretEntry)(
        yield* sql`SELECT name, updated_at FROM secrets WHERE applet_id = ${id} ORDER BY name`,
      );
    }, Effect.orDie),

    /** Every secret by name, for the supervisor to place in the loaded `env`. */
    getSecrets: Effect.fn("Registry.getSecrets")(function* (id: string) {
      const secrets = yield* rows(Schema.Struct({ name: Schema.String, value: Schema.String }))(
        yield* sql`SELECT name, value FROM secrets WHERE applet_id = ${id}`,
      );

      return Object.fromEntries(secrets.map((row) => [row.name, row.value]));
    }, Effect.orDie),

    /** Sets one secret, or removes it on null, and bumps `secrets_rev` so the next request loads the applet with the new set. */
    putSecret: Effect.fn("Registry.putSecret")(function* (
      id: string,
      name: string,
      value: string | null,
    ) {
      yield* d1.batch([
        value === null
          ? sql`DELETE FROM secrets WHERE applet_id = ${id} AND name = ${name}`
          : sql`INSERT INTO secrets (applet_id, name, value, updated_at) VALUES (${id}, ${name}, ${value}, ${now()})
                ON CONFLICT (applet_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        sql`UPDATE applets SET secrets_rev = secrets_rev + 1 WHERE id = ${id}`,
      ]);
    }, Effect.orDie),

    /** One line from `@std`'s `log`, attributed to the version that wrote it. */
    writeLog: Effect.fn("Registry.writeLog")(function* (
      id: string,
      version: number,
      entry: LogEntry,
    ) {
      const data = entry.data === undefined ? null : JSON.stringify(entry.data);

      yield* sql`INSERT INTO logs (applet_id, version, level, message, data, request_id, at)
        VALUES (${id}, ${version}, ${entry.level}, ${entry.message}, ${data}, ${entry.request_id ?? null}, ${now()})`;
    }, Effect.orDie),

    listLogs: Effect.fn("Registry.listLogs")(function* (id: string, query: LogQuery) {
      const level = query.level ?? null;

      return yield* window(
        LogRow,
        "logs",
        id,
        query,
        sql`AND (${level} IS NULL OR level = ${level})`,
      );
    }, Effect.orDie),

    /** One row per HTTP request or completed trigger execution. */
    writeRequest: Effect.fn("Registry.writeRequest")(function* (id: string, entry: NewRequest) {
      yield* sql`INSERT INTO requests (request_id, applet_id, version, kind, method, path, status, error, duration_ms, at)
        VALUES (${entry.request_id}, ${id}, ${entry.version}, ${entry.kind ?? "http"}, ${entry.method}, ${entry.path},
          ${entry.status}, ${entry.error ?? null}, ${entry.duration_ms}, ${now()})`;
    }, Effect.orDie),

    listRequests: Effect.fn("Registry.listRequests")(function* (id: string, query: WindowQuery) {
      return yield* window(RequestEntry, "requests", id, query);
    }, Effect.orDie),

    /** Requests per hour over the retention window, hours with none left out. */
    countRequests: Effect.fn("Registry.countRequests")(function* (id: string) {
      const since = new Date(Date.now() - retention.logDays * day).toISOString();

      return yield* rows(TrafficHour)(
        yield* sql`SELECT strftime('%Y-%m-%dT%H:00:00.000Z', at) AS hour, COUNT(*) AS total,
             SUM(error IS NOT NULL OR COALESCE(status, 500) >= 500) AS failed
           FROM requests WHERE applet_id = ${id} AND at > ${since} GROUP BY hour ORDER BY hour`,
      );
    }, Effect.orDie),

    /** Runs across every applet `owner` owns, newest first. Requests belong to the owner, so nobody else's appear. */
    listRuns: Effect.fn("Registry.listRuns")(function* (owner: string, query: RunQuery) {
      const applet = query.applet ?? null;
      const kind = query.kind ?? null;
      const failed = query.failed === undefined ? null : Number(query.failed);
      const before = query.before ?? null;

      return yield* rows(RequestEntry)(
        yield* sql`SELECT requests.*, applets.name AS applet FROM requests JOIN applets ON applets.id = requests.applet_id
           WHERE applets.owner = ${owner}
             AND (${applet} IS NULL OR applets.name = ${applet})
             AND (${kind} IS NULL OR requests.kind = ${kind})
             AND (${failed} IS NULL OR (requests.error IS NOT NULL OR COALESCE(requests.status, 500) >= 500) = ${failed})
             AND (${before} IS NULL OR requests.id < ${before})
           ORDER BY requests.id DESC LIMIT ${query.limit ?? 50}`,
      );
    }, Effect.orDie),

    /** The lines one run wrote, oldest first, when `owner` owns the applet that ran. */
    listRunLogs: Effect.fn("Registry.listRunLogs")(function* (owner: string, request_id: string) {
      return yield* rows(LogRow)(
        yield* sql`SELECT logs.*, applets.name AS applet FROM logs JOIN applets ON applets.id = logs.applet_id
           WHERE logs.request_id = ${request_id} AND applets.owner = ${owner} ORDER BY logs.id`,
      );
    }, Effect.orDie),

    writePlatformLogs: Effect.fn("Registry.writePlatformLogs")(function* (
      entries: ReadonlyArray<NewPlatformLog>,
    ) {
      yield* d1.batch(
        entries.map(
          (entry) => sql`INSERT INTO platform_logs (level, message, data, applet, trace_id, at)
            VALUES (${entry.level}, ${entry.message}, ${entry.data}, ${entry.applet}, ${entry.trace_id}, ${entry.at})`,
        ),
      );
    }, Effect.orDie),

    /** The platform's own lines, newest first. */
    listPlatformLogs: Effect.fn("Registry.listPlatformLogs")(function* (query: PlatformLogQuery) {
      const level = query.level ?? null;
      const applet = query.applet ?? null;
      const before = query.before ?? null;

      return yield* rows(PlatformLogEntry)(
        yield* sql`SELECT * FROM platform_logs
           WHERE (${level} IS NULL OR level = ${level})
             AND (${applet} IS NULL OR applet = ${applet})
             AND (${before} IS NULL OR id < ${before})
           ORDER BY id DESC LIMIT ${query.limit ?? 50}`,
      );
    }, Effect.orDie),

    /** One row per email sent by an applet or received by the router. */
    writeEmail: Effect.fn("Registry.writeEmail")(function* (entry: NewEmail) {
      yield* sql`INSERT INTO emails (direction, applet_id, message_id, sender, recipient, subject, status, detail, at)
        VALUES (${entry.direction}, ${entry.applet_id}, ${entry.message_id}, ${entry.sender}, ${entry.recipient},
          ${entry.subject}, ${entry.status}, ${entry.detail}, ${now()})`;
    }, Effect.orDie),

    /** An applet's emails, or with `null` the unclaimed ones that belong to no applet. Same window as logs, no version. */
    listEmails: Effect.fn("Registry.listEmails")(function* (id: string | null, query: WindowQuery) {
      const limit = query.limit ?? 50;
      const where = id === null ? sql`applet_id IS NULL` : sql`applet_id = ${id}`;
      const select = sql`SELECT emails.*, applets.name AS applet FROM emails LEFT JOIN applets ON applets.id = emails.applet_id`;

      const result = yield* rows(EmailEntry)(
        yield* query.after === undefined
          ? sql`${select} WHERE ${where} ORDER BY emails.id DESC LIMIT ${limit}`
          : sql`${select} WHERE ${where} AND emails.id > ${query.after} ORDER BY emails.id ASC LIMIT ${limit}`,
      );

      return query.after === undefined ? result.toReversed() : result;
    }, Effect.orDie),

    /**
     * Drops log, request and platform log rows past `retention.logDays`, the window Workers Logs backs up, email rows
     * past `retention.emailDays`, and the file contents and bundle parts no version or draft names any more.
     */
    vacuum: Effect.fn("Registry.vacuum")(function* () {
      const logCutoff = new Date(Date.now() - retention.logDays * day).toISOString();
      const emailCutoff = new Date(Date.now() - retention.emailDays * day).toISOString();

      yield* d1.batch([
        sql`DELETE FROM logs WHERE at < ${logCutoff}`,
        sql`DELETE FROM requests WHERE at < ${logCutoff}`,
        sql`DELETE FROM platform_logs WHERE at < ${logCutoff}`,
        sql`DELETE FROM emails WHERE at < ${emailCutoff}`,
        sql`DELETE FROM file_contents WHERE (applet_id, hash) NOT IN (
             SELECT applet_id, value FROM versions, json_each(versions.files)
             UNION SELECT applet_id, value FROM drafts, json_each(drafts.files)
           )`,
        sql`DELETE FROM bundle_parts WHERE (applet_id, hash) NOT IN (
             SELECT applet_id, value FROM versions, json_each(versions.bundle)
           )`,
      ]);
    }, Effect.orDie),

    listUsers: Effect.fn("Registry.listUsers")(function* () {
      return yield* rows(User)(yield* sql`SELECT * FROM users ORDER BY email`);
    }, Effect.orDie),

    addUser: Effect.fn("Registry.addUser")(function* (email: string) {
      yield* sql`INSERT INTO users (email, added_at) VALUES (${email}, ${now()}) ON CONFLICT (email) DO NOTHING`;
    }, Effect.orDie),

    /** The user is out at once: their row, sessions and API keys go. Their applets stay and keep running. */
    removeUser: Effect.fn("Registry.removeUser")(function* (email: string) {
      yield* d1.batch([
        sql`DELETE FROM users WHERE email = ${email}`,
        sql`DELETE FROM api_keys WHERE email = ${email}`,
        sql`DELETE FROM "session" WHERE "userId" IN (SELECT "id" FROM "user" WHERE "email" = ${email})`,
      ]);
    }, Effect.orDie),

    /** The email behind a Better Auth user id, which is what an OAuth access token's `sub` names. */
    userEmail: Effect.fn("Registry.userEmail")(function* (id: string) {
      const row = yield* first(Schema.Struct({ email: Schema.String }))(
        yield* sql`SELECT email FROM "user" WHERE id = ${id}`,
      );

      return Option.map(row, (found) => found.email);
    }, Effect.orDie),

    isUser: Effect.fn("Registry.isUser")(function* (email: string) {
      const found = yield* sql`SELECT email FROM users WHERE email = ${email}`;

      return found.length > 0;
    }, Effect.orDie),

    listKeys: Effect.fn("Registry.listKeys")(function* (email: string) {
      return yield* rows(ApiKey)(
        yield* sql`SELECT id, name, created_at, last_used_at FROM api_keys WHERE email = ${email} ORDER BY id`,
      );
    }, Effect.orDie),

    addKey: Effect.fn("Registry.addKey")(function* (email: string, name: string, hash: string) {
      yield* sql`INSERT INTO api_keys (hash, email, name, created_at) VALUES (${hash}, ${email}, ${name}, ${now()})`;
    }, Effect.orDie),

    removeKey: Effect.fn("Registry.removeKey")(function* (email: string, id: number) {
      yield* sql`DELETE FROM api_keys WHERE email = ${email} AND id = ${id}`;
    }, Effect.orDie),

    /** The email of the user who created the key with this hash, stamping the key as used now. */
    useKey: Effect.fn("Registry.useKey")(function* (hash: string) {
      const row = yield* first(Schema.Struct({ email: Schema.String }))(
        yield* sql`UPDATE api_keys SET last_used_at = ${now()} WHERE hash = ${hash} RETURNING email`,
      );

      return Option.map(row, (found) => found.email);
    }, Effect.orDie),
  };
});

/** The registry service. Its shape is what `make` returns, so the methods are declared once. */
export class Registry extends Context.Service<Registry, Effect.Success<typeof make>>()(
  "applets/Registry",
) {}

/** The registry over the D1 binding, tables created. */
export const layer = (db: D1Database) =>
  Layer.effect(Registry, make).pipe(Layer.provide(D1Client.layer({ db })));
