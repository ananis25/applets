/**
 * The owner's view into an applet's storage, behind the editor's SQLite, KV and
 * Blobs pages. SQLite and KV are answered inside the applet's facet through
 * the supervisor; blobs are read straight from the bucket under the applet's
 * prefix.
 */
import { api, AppletFailed, BadRequest, KvList, NotFound, SqlResult } from "@applets/api";
import type { Inspection } from "@applets/api/capabilities";
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { Bucket, Supervisors } from "./bindings.ts";
import { owned } from "./caller.ts";
import { targetOf } from "./types.ts";

const blobPageSize = 200;

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

export const storage = HttpApiBuilder.group(api, "storage", (handlers) =>
  handlers.handleAll({
    sql: ({ params, payload }) =>
      inspect(params.name, { kind: "sql", sql: payload.sql }).pipe(
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(SqlResult)(result).pipe(Effect.orDie),
        ),
      ),
    kv: ({ params, query }) =>
      inspect(params.name, { kind: "kv", prefix: query.prefix ?? "", limit: 500 }).pipe(
        Effect.flatMap((result) => Schema.decodeUnknownEffect(KvList)(result).pipe(Effect.orDie)),
      ),
    removeKv: ({ params, query }) =>
      inspect(params.name, { kind: "kv-delete", key: query.key }).pipe(Effect.as(ok)),
    blobs: ({ params, query }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const bucket = yield* Bucket;
        const namespace = `${applet.id}/`;

        const page = yield* bucket.list({
          prefix: `${namespace}${query.prefix ?? ""}`,
          cursor: query.cursor,
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
      }),
    blob: ({ params, query }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const bucket = yield* Bucket;
        const object = yield* bucket.get(`${applet.id}/${query.key}`);

        if (object === null) return yield* new NotFound({ message: `no blob ${query.key}` });

        const filename = encodeURIComponent(query.key.split("/").at(-1) ?? query.key);

        return HttpServerResponse.raw(object.body, {
          contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
          headers: { "content-disposition": `attachment; filename="${filename}"` },
        });
      }),
    removeBlob: ({ params, query }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const bucket = yield* Bucket;
        yield* bucket.delete(`${applet.id}/${query.key}`);

        return ok;
      }),
  }),
);
