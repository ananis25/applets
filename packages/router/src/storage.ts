/**
 * The owner's view into an applet's storage, behind the editor's SQLite, KV and
 * Blobs pages. SQLite and KV are answered inside the applet's facet through
 * the supervisor; blobs are read and written straight in the bucket under the
 * applet's prefix.
 */
import { api, AppletFailed, BadRequest, KvList, NotFound, SqlResult } from "@applets/api";
import type { Inspection, InspectionResult } from "@applets/api/capabilities";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { Bucket, Supervisors } from "./bindings.ts";
import { owned } from "./caller.ts";
import { targetOf } from "./types.ts";

const blobPageSize = 200;

/** One blob the owner puts in from outside, as the applet's own `blob.set` would. */
export const putBlob = Effect.fn("Storage.putBlob")(function* (
  name: string,
  key: string,
  body: Uint8Array,
  contentType: string | undefined,
) {
  if (key === "") return yield* new BadRequest({ message: "a blob key is not empty" });

  const applet = yield* owned(name);
  const bucket = yield* Bucket;

  yield* bucket.put(`${applet.id}/${key}`, body, contentType ?? "application/octet-stream");
});

const ok = { ok: true } as const;

/** Runs one inspection in the facet. A version from before `inspect` existed has no such method, and says so. */
export const inspect = Effect.fn("Storage.inspect")(function* (name: string, call: Inspection) {
  const applet = yield* owned(name);
  const target = targetOf(applet);

  if (target === undefined) return yield* new NotFound({ message: "applet has no version" });

  const supervisors = yield* Supervisors;

  const result = yield* supervisors.inspect(target, call).pipe(
    Effect.mapError(
      (failed) =>
        new AppletFailed({
          message: `Deploy this applet again to inspect its storage. ${failed.message}`,
        }),
    ),
  );

  if ("error" in result) return yield* new BadRequest({ message: result.error });

  return result;
});

/** A blob of the applet's, or null when the key does not exist. */
export const getBlob = Effect.fn("Storage.getBlob")(function* (name: string, key: string) {
  const applet = yield* owned(name);
  const bucket = yield* Bucket;

  return yield* bucket.get(`${applet.id}/${key}`);
});

/** One page of the applet's blobs under a prefix, keys without the applet's own prefix. */
export const listBlobs = Effect.fn("Storage.listBlobs")(function* (
  name: string,
  prefix: string,
  cursor: string | undefined,
) {
  const applet = yield* owned(name);
  const bucket = yield* Bucket;
  const namespace = `${applet.id}/`;

  const page = yield* bucket.list({
    prefix: `${namespace}${prefix}`,
    cursor,
    limit: blobPageSize,
    include: ["httpMetadata"],
  });

  return {
    blobs: page.objects.map((object) => ({
      key: object.key.slice(namespace.length),
      size: object.size,
      content_type: object.httpMetadata?.contentType ?? null,
      uploaded_at: object.uploaded.toISOString(),
    })),
    cursor: page.truncated ? page.cursor : null,
  };
});

export const removeBlob = Effect.fn("Storage.removeBlob")(function* (name: string, key: string) {
  const applet = yield* owned(name);
  const bucket = yield* Bucket;
  yield* bucket.delete(`${applet.id}/${key}`);
});

const decoded = <S extends Schema.Top>(schema: S) =>
  Effect.flatMap((result: InspectionResult) =>
    Schema.decodeUnknownEffect(schema)(result).pipe(Effect.orDie),
  );

/** One statement; a `readonly` one that wrote is rolled back and refused. */
export const runSql = (name: string, sql: string, readonly: boolean) =>
  inspect(name, { kind: "sql", sql, readonly }).pipe(decoded(SqlResult));

/** Every statement in one transaction; the first failure rolls back all of them. */
export const runSqlBatch = (name: string, statements: ReadonlyArray<string>) =>
  inspect(name, { kind: "sql-batch", statements }).pipe(
    decoded(Schema.Struct({ results: Schema.Array(SqlResult) })),
  );

export const listKv = (name: string, prefix: string) =>
  inspect(name, { kind: "kv", prefix, limit: 500 }).pipe(decoded(KvList));

export const getKv = (name: string, key: string) =>
  inspect(name, { kind: "kv-get", key }).pipe(
    decoded(KvList),
    Effect.flatMap(({ entries }) =>
      entries[0] === undefined
        ? Effect.fail(new NotFound({ message: `no key ${key}` }))
        : Effect.succeed(entries[0]),
    ),
  );

/** `value` is JSON text, stored as what it parses to. */
export const putKv = (name: string, key: string, value: string) =>
  inspect(name, { kind: "kv-put", key, value }).pipe(Effect.as(ok));

export const removeKv = (name: string, key: string) =>
  inspect(name, { kind: "kv-delete", key }).pipe(Effect.as(ok));

export const storage = HttpApiBuilder.group(api, "storage", (handlers) =>
  handlers.handleAll({
    sql: ({ params, payload }) => runSql(params.name, payload.sql, payload.readonly ?? false),
    sqlBatch: ({ params, payload }) => runSqlBatch(params.name, payload.statements),
    kv: ({ params, query }) => listKv(params.name, query.prefix ?? ""),
    getKv: ({ params, query }) => getKv(params.name, query.key),
    putKv: ({ params, query, payload }) => putKv(params.name, query.key, payload.value),
    removeKv: ({ params, query }) => removeKv(params.name, query.key),
    blobs: ({ params, query }) => listBlobs(params.name, query.prefix ?? "", query.cursor),
    blob: ({ params, query }) =>
      Effect.gen(function* () {
        const object = yield* getBlob(params.name, query.key);

        if (object === null) return yield* new NotFound({ message: `no blob ${query.key}` });

        const filename = encodeURIComponent(query.key.split("/").at(-1) ?? query.key);

        return HttpServerResponse.raw(object.body, {
          contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
          headers: { "content-disposition": `attachment; filename="${filename}"` },
        });
      }),
    putBlob: ({ params, query, payload }) =>
      putBlob(params.name, query.key, payload, query.content_type).pipe(Effect.as(ok)),
    removeBlob: ({ params, query }) => removeBlob(params.name, query.key).pipe(Effect.as(ok)),
  }),
);
