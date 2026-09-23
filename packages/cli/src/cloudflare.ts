/**
 * The Cloudflare API, for what wrangler has no command for: the Email Routing
 * catch-all rule, emptying a bucket, and listing what the account holds. Every
 * call runs with wrangler's own login, so there is no second credential.
 *
 * That login has no DNS scope, which is why the wildcard record stays a by-hand step.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { box, CliError, failed, paths } from "./environment.ts";

const endpoint = "https://api.cloudflare.com/client/v4";

/** One wrangler command with `--json`, its output decoded as `output`. */
const wranglerJson = <S extends Schema.Top>(args: ReadonlyArray<string>, output: S) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const command = ChildProcess.make("vpx", ["wrangler", ...args, "--json"], {
      cwd: paths.routerPackage,
    });

    return yield* Schema.decodeEffect(Schema.fromJsonString(output))(
      yield* spawner.string(command),
    );
  }).pipe(Effect.mapError(failed(`wrangler ${args.join(" ")} failed`)));

const Token = Schema.Struct({ token: Schema.String });

const Whoami = Schema.Struct({ accounts: Schema.Array(Schema.Struct({ id: Schema.String })) });

/** Wrangler's OAuth token and the account it is logged in to. Wrangler takes seconds to start, so a command asks once. */
export class Login extends Context.Service<
  Login,
  { readonly token: string; readonly accountId: string }
>()("cli/Login") {
  static readonly layer = Layer.effect(
    Login,
    Effect.gen(function* () {
      const [{ token }, { accounts }] = yield* Effect.all(
        [wranglerJson(["auth", "token"], Token), wranglerJson(["whoami"], Whoami)],
        { concurrency: 2 },
      );

      const account = accounts[0];

      if (account === undefined) {
        return yield* new CliError({ message: "no account; run `vpx wrangler login`" });
      }

      return { token, accountId: account.id };
    }),
  );
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

type CatchAllRule = {
  readonly enabled: boolean;
  readonly name: string;
  readonly matchers: ReadonlyArray<{ readonly type: "all" }>;
  readonly actions: ReadonlyArray<{
    readonly type: "worker";
    readonly value: ReadonlyArray<string>;
  }>;
};

type Body = CatchAllRule | { readonly name: string };

/** Cloudflare's v4 envelope: `result` on success, `errors` otherwise. */
const Envelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(Schema.Struct({ message: Schema.String })),
  result: Schema.Unknown,
});

/** One API call, answered as the `result` of the envelope decoded as `result`. `route` starts at the account or the zone. */
const call = <S extends Schema.Top>(method: Method, route: string, result: S, body?: Body) =>
  Effect.gen(function* () {
    const { token } = yield* Login;
    const client = yield* HttpClient.HttpClient;

    const base = HttpClientRequest.make(method)(`${endpoint}${route}`).pipe(
      HttpClientRequest.bearerToken(token),
    );

    const request = body === undefined ? base : yield* HttpClientRequest.bodyJson(base, body);
    const response = yield* client.execute(request);
    const answer = yield* Schema.decodeUnknownEffect(Envelope)(yield* response.json);

    if (!answer.success) {
      const messages = answer.errors.map((error) => error.message).join("; ");

      return yield* new CliError({ message: `${method} ${route} failed: ${messages}` });
    }

    return yield* Schema.decodeUnknownEffect(result)(answer.result);
  }).pipe(
    Effect.catchTags({
      HttpClientError: failed(`Could not reach the Cloudflare API for ${route}`),
      SchemaError: failed(`Unexpected answer from the Cloudflare API for ${route}`),
      HttpBodyError: failed(`Could not encode the body for ${route}`),
    }),
  );

const Ids = Schema.Array(Schema.Struct({ id: Schema.String }));

const accountRoute = (route: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* Login;

    return `/accounts/${accountId}${route}`;
  });

const zoneRoute = (route: string) =>
  Effect.gen(function* () {
    const name = box.hostSuffix.slice(1);
    const zone = (yield* call("GET", `/zones?name=${name}`, Ids))[0];

    if (zone === undefined)
      return yield* new CliError({ message: `the account has no zone named ${name}` });

    return `/zones/${zone.id}${route}`;
  });

/**
 * Points the zone's catch-all rule at `worker` and turns it on. Cloudflare
 * turns the rule off when the worker it names is deleted, so every router
 * deploy sets it again. Destination addresses and every other rule are left alone.
 */
export const routeMailTo = (worker: string) =>
  Effect.gen(function* () {
    const routing = yield* call(
      "GET",
      yield* zoneRoute("/email/routing"),
      Schema.Struct({ enabled: Schema.Boolean }),
    );

    if (!routing.enabled)
      return yield* new CliError({
        message: "Email Routing is off for the zone; enable it once in the Cloudflare dashboard",
      });

    yield* call("PUT", yield* zoneRoute("/email/routing/rules/catch_all"), Schema.Unknown, {
      enabled: true,
      name: `every address to ${worker}`,
      matchers: [{ type: "all" }],
      actions: [{ type: "worker", value: [worker] }],
    });
  });

/** The names of the account's worker scripts. */
export const workerNames = Effect.gen(function* () {
  const scripts = yield* call("GET", yield* accountRoute("/workers/scripts"), Ids);

  return scripts.map((script) => script.id);
});

/** Deletes a worker with its Durable Object storage, its routes and its triggers. */
export const deleteWorker = (name: string) =>
  Effect.gen(function* () {
    yield* call(
      "DELETE",
      yield* accountRoute(`/workers/scripts/${name}?force=true`),
      Schema.Unknown,
    );
  });

const Database = Schema.Struct({ uuid: Schema.String, name: Schema.String });

/** The account's D1 databases as name to id. */
export const databaseIds = Effect.gen(function* () {
  const databases = yield* call(
    "GET",
    yield* accountRoute("/d1/database?per_page=1000"),
    Schema.Array(Database),
  );

  return new Map(databases.map((database) => [database.name, database.uuid]));
});

/** Creates an empty D1 database and answers its id. */
export const createDatabase = (name: string) =>
  Effect.gen(function* () {
    const created = yield* call("POST", yield* accountRoute("/d1/database"), Database, { name });

    return created.uuid;
  });

export const deleteDatabase = (id: string) =>
  Effect.gen(function* () {
    yield* call("DELETE", yield* accountRoute(`/d1/database/${id}`), Schema.Unknown);
  });

const Named = Schema.Struct({ name: Schema.String });

/** The names of the account's R2 buckets. */
export const bucketNames = Effect.gen(function* () {
  const { buckets } = yield* call(
    "GET",
    yield* accountRoute("/r2/buckets"),
    Schema.Struct({ buckets: Schema.Array(Named) }),
  );

  return buckets.map((bucket) => bucket.name);
});

/** Deletes every object, a page at a time, then the bucket; Cloudflare refuses to delete one that holds objects. */
export const deleteBucket = (name: string) =>
  Effect.gen(function* () {
    const objects = yield* accountRoute(`/r2/buckets/${name}/objects`);
    const Keys = Schema.Array(Schema.Struct({ key: Schema.String }));

    for (;;) {
      const page = yield* call("GET", `${objects}?per_page=1000`, Keys);

      if (page.length === 0) break;

      yield* Effect.forEach(
        page,
        ({ key }) => call("DELETE", `${objects}/${encodeURIComponent(key)}`, Schema.Unknown),
        { concurrency: 8, discard: true },
      );
    }

    yield* call("DELETE", yield* accountRoute(`/r2/buckets/${name}`), Schema.Unknown);
  });
