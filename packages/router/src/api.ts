/**
 * The API: the router's side of the `@applets/api` contract, one
 * handler per endpoint, and the `Api` service that ingress runs a request
 * through once it has decided who the caller is. Every route about an applet
 * asks `owned` first, which is the policy check.
 */
import { api, BadRequest, Forbidden, listTemplates } from "@applets/api";
import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";
import { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";

import * as operations from "./applets.ts";
import { Auth } from "./auth.ts";
import { Vars } from "./bindings.ts";
import { Caller, owned } from "./caller.ts";
import { mintKey } from "./keys.ts";
import { log } from "./platformLog.ts";
import { Registry } from "./registry.ts";
import { storage } from "./storage.ts";
import { defaultModel, retention } from "./types.ts";

const ok = { ok: true } as const;

const admin = Effect.gen(function* () {
  const caller = yield* Caller;

  if (caller.role !== "admin") return yield* new Forbidden({ message: "the admin only" });

  return caller;
});

const applets = HttpApiBuilder.group(api, "applets", (handlers) =>
  handlers.handleAll({
    list: () => operations.list(),
    get: ({ params }) => operations.get(params.name),
    patch: ({ params, payload }) => operations.patch(params.name, payload),
    remove: ({ params }) => operations.remove(params.name),
    templates: () => Effect.succeed({ templates: listTemplates() }),
    fork: ({ params, payload }) => operations.fork(params.name, payload.name),
    run: ({ params }) => operations.run(params.name),
    draft: ({ params }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;
        const draft = yield* registry.getDraft(applet.id);

        return Option.getOrElse(draft, () => ({ files: null, updated_at: null }));
      }),
    saveDraft: ({ params, payload }) => operations.saveDraft(params.name, payload.files),
    discardDraft: ({ params }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;
        yield* registry.deleteDraft(applet.id);

        return ok;
      }),
    logs: ({ params, query }) => operations.logs(params.name, query),
    requests: ({ params, query }) => operations.requests(params.name, query),
    traffic: ({ params }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;

        return { hours: yield* registry.countRequests(applet.id) };
      }),
    emails: ({ params, query }) => operations.emails(params.name, query),
  }),
);

const versions = HttpApiBuilder.group(api, "versions", (handlers) =>
  handlers.handleAll({
    deploy: ({ params, query, payload }) => {
      if (query.template !== undefined)
        return operations.create(params.name, query.template, payload.files);

      return payload.files === undefined
        ? Effect.fail(new BadRequest({ message: "a deploy needs files or a template" }))
        : operations.deploy(params.name, payload.files, query.fresh ?? false);
    },
    edit: ({ params, payload }) => operations.edit(params.name, payload.edits),
    source: ({ params, query }) => operations.source(params.name, query.version),
  }),
);

/** An applet's secrets: names out, values in. A change takes effect on the applet's next request. */
const secrets = HttpApiBuilder.group(api, "secrets", (handlers) =>
  handlers.handleAll({
    list: ({ params }) => operations.listSecrets(params.name),
    put: ({ params, payload }) => operations.setSecret(params.name, payload.name, payload.value),
    remove: ({ params, query }) => operations.removeSecret(params.name, query.name),
  }),
);

const runs = HttpApiBuilder.group(api, "runs", (handlers) =>
  handlers.handleAll({
    list: ({ query }) =>
      Effect.gen(function* () {
        const caller = yield* Caller;
        const registry = yield* Registry;

        return {
          runs: yield* registry.listRuns(caller.email, {
            applet: query.applet,
            kind: query.kind,
            failed: query.status === undefined ? undefined : query.status === "failed",
            before: query.before,
            limit: query.limit,
          }),
        };
      }),
    logs: ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* Caller;
        const registry = yield* Registry;

        return { logs: yield* registry.listRunLogs(caller.email, params.id) };
      }),
  }),
);

const keys = HttpApiBuilder.group(api, "keys", (handlers) =>
  handlers.handleAll({
    list: () =>
      Effect.gen(function* () {
        const caller = yield* Caller;
        const registry = yield* Registry;

        return { keys: yield* registry.listKeys(caller.email) };
      }),
    create: ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* Caller;
        const registry = yield* Registry;
        const { key, hash } = yield* Effect.promise(mintKey);
        yield* registry.addKey(caller.email, payload.name, hash);
        yield* log.info("api key created", { name: payload.name });

        return { key };
      }),
    remove: ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* Caller;
        const registry = yield* Registry;
        yield* registry.removeKey(caller.email, params.id);
        yield* log.info("api key removed", { id: params.id });

        return ok;
      }),
  }),
);

const users = HttpApiBuilder.group(api, "users", (handlers) =>
  handlers.handleAll({
    list: () =>
      Effect.gen(function* () {
        yield* admin;
        const registry = yield* Registry;

        return { users: yield* registry.listUsers() };
      }),
    add: ({ params }) =>
      Effect.gen(function* () {
        yield* admin;
        const registry = yield* Registry;
        yield* registry.addUser(params.email.toLowerCase());
        yield* log.info("user added", { email: params.email });

        return ok;
      }),
    remove: ({ params }) =>
      Effect.gen(function* () {
        yield* admin;
        const registry = yield* Registry;
        yield* registry.removeUser(params.email.toLowerCase());
        yield* log.info("user removed", { email: params.email });

        return ok;
      }),
  }),
);

const sessions = HttpApiBuilder.group(api, "sessions", (handlers) =>
  handlers.handleAll({
    list: ({ request }) =>
      Effect.gen(function* () {
        const auth = yield* Auth;

        return { sessions: yield* auth.sessions(new Headers(request.headers)) };
      }),
    revoke: ({ request, params }) =>
      Effect.gen(function* () {
        const auth = yield* Auth;
        yield* auth.revoke(new Headers(request.headers), params.id);

        return ok;
      }),
  }),
);

const platform = HttpApiBuilder.group(api, "platform", (handlers) =>
  handlers.handleAll({
    me: () => Caller.use(({ email, role }) => Effect.succeed({ email, role })),
    info: () =>
      Effect.gen(function* () {
        yield* admin;
        const vars = yield* Vars;

        return {
          host_suffix: vars.HOST_SUFFIX,
          owner: vars.OWNER_EMAIL,
          email_from: vars.EMAIL_FROM,
          default_model: defaultModel,
          log_retention_days: retention.logDays,
          email_retention_days: retention.emailDays,
        };
      }),
    unclaimed: ({ query }) =>
      Effect.gen(function* () {
        yield* admin;
        const registry = yield* Registry;

        return { emails: yield* registry.listEmails(null, query) };
      }),
    logs: ({ query }) =>
      Effect.gen(function* () {
        yield* admin;
        const registry = yield* Registry;

        return { logs: yield* registry.listPlatformLogs(query) };
      }),
  }),
);

/** The paths that describe the API rather than serve it, answered to anyone. */
export const docsPaths = ["/openapi.json", "/docs"] as const;

/**
 * The API as one HTTP effect over the request in context, which ingress runs
 * after putting the `Caller` there, plus its OpenAPI document and a Scalar
 * page over it. The platform layers under it are what `HttpApiBuilder` asks
 * for to serve files and multipart bodies, which no endpoint here does.
 */
const build = HttpRouter.toHttpEffect(
  HttpApiBuilder.layer(api, { openapiPath: docsPaths[0] }).pipe(
    Layer.merge(HttpApiScalar.layerCdn(api, { path: docsPaths[1] })),
    Layer.provide([applets, versions, storage, secrets, runs, keys, users, sessions, platform]),
    Layer.provide([
      Etag.layerWeak,
      Path.layer,
      FileSystem.layerNoop({}),
      HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
    ]),
  ),
);

export class Api extends Context.Service<Api, Effect.Success<typeof build>>()("applets/Api") {}

export const layer = Layer.effect(Api, build);
