/**
 * The account, through the `cf` CLI: what the deploy needs that is not a
 * `wrangler deploy`. The Email Routing catch-all rule, emptying a bucket, and
 * listing and deleting what the account holds. `cf` prints JSON and takes the
 * account from its own login, so there is no token or account id here.
 *
 * That login has no DNS scope, which is why the wildcard record stays a by-hand step.
 */
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { box, CliError, failed } from "./environment.ts";

/** One `cf` command, its stdout decoded as `output`. A failed command reports what `cf` printed on stderr. */
const cf = <S extends Schema.Top>(args: ReadonlyArray<string>, output: S) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(ChildProcess.make("cf", [...args, "--quiet"]));

      const [stdout, stderr] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
        ],
        { concurrency: 2 },
      );

      if ((yield* handle.exitCode) !== 0) {
        return yield* new CliError({ message: `cf ${args.join(" ")} failed: ${stderr.trim()}` });
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(output))(stdout);
    }),
  ).pipe(Effect.mapError(failed(`cf ${args.join(" ")} failed`)));

/** A mutating `cf` command: no confirmation prompt, and the answer is not read. */
const cfRun = (args: ReadonlyArray<string>) => cf([...args, "--force"], Schema.Unknown);

const zone = ["--zone", box.hostSuffix.slice(1)];

/**
 * Points the zone's catch-all rule at `worker` and turns it on. Cloudflare
 * turns the rule off when the worker it names is deleted, so every router
 * deploy sets it again. Destination addresses and every other rule are left alone.
 */
export const routeMailTo = (worker: string) =>
  Effect.gen(function* () {
    const routing = yield* cf(
      ["email-routing", "settings", "get", ...zone],
      Schema.Struct({ enabled: Schema.Boolean }),
    );

    if (!routing.enabled)
      return yield* new CliError({
        message: "Email Routing is off for the zone; enable it once in the Cloudflare dashboard",
      });

    yield* cf(
      [
        "email-routing",
        "rules",
        "catch-all",
        "update",
        ...zone,
        "--enabled",
        "--name",
        `every address to ${worker}`,
        "--matchers",
        JSON.stringify([{ type: "all" }]),
        "--actions",
        JSON.stringify([{ type: "worker", value: [worker] }]),
      ],
      Schema.Unknown,
    );
  });

const Named = Schema.Array(Schema.Struct({ name: Schema.String }));

/** The names of the account's workers. */
export const workerNames = Effect.map(cf(["workers", "list"], Named), (workers) =>
  workers.map((worker) => worker.name),
);

/** Deletes a worker with its Durable Object storage, its routes and its triggers. */
export const deleteWorker = (name: string) =>
  cfRun(["workers", "delete", name, "--delete-with-references"]);

const Database = Schema.Struct({ uuid: Schema.String, name: Schema.String });

/** The account's D1 databases as name to id. */
export const databaseIds = Effect.map(
  cf(["d1", "list"], Schema.Array(Database)),
  (databases) => new Map(databases.map((database) => [database.name, database.uuid])),
);

/** Creates an empty D1 database and answers its id. */
export const createDatabase = (name: string) =>
  Effect.map(cf(["d1", "create", "--name", name], Database), (created) => created.uuid);

export const deleteDatabase = (id: string) => cfRun(["d1", "delete", id]);

/** The names of the account's R2 buckets. */
export const bucketNames = Effect.map(
  cf(["r2", "buckets", "list"], Schema.Struct({ buckets: Named })),
  ({ buckets }) => buckets.map((bucket) => bucket.name),
);

/** Empties the bucket, then deletes it; Cloudflare refuses to delete one that holds objects. */
export const deleteBucket = (name: string) =>
  Effect.gen(function* () {
    yield* cfRun(["r2", "objects", "bulk-delete", "--bucket-name", name, "--prefix", ""]);
    yield* cfRun(["r2", "buckets", "delete", name]);
  });
