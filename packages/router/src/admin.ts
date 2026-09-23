/**
 * The admin API: the router's side of the `@applets/api` contract, one
 * handler per endpoint, and the `AdminApi` service that ingress runs a request
 * through once it has decided who the caller is. Every route about an applet
 * asks `owned` first, which is the policy check.
 */
import {
  api,
  BadRequest,
  BuildFailed,
  Forbidden,
  NotFound,
  type AppletPatch,
  type Files,
} from "@applets/api";
import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";
import { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";

import { Auth } from "./auth.ts";
import { Bundler, Supervisors, Vars } from "./bindings.ts";
import { Caller, owned } from "./caller.ts";
import { isCron } from "./cron.ts";
import { mintKey } from "./keys.ts";
import { can } from "./policy.ts";
import { log } from "./platformLog.ts";
import { fileSizeErrors, Registry } from "./registry.ts";
import { storage } from "./storage.ts";
import { defaultModel, isAppletName, isSecretName, retention, targetOf } from "./types.ts";

const ok = { ok: true } as const;

const maxDescription = 200;

const admin = Effect.gen(function* () {
  const caller = yield* Caller;

  if (caller.role !== "admin") return yield* new Forbidden({ message: "the admin only" });

  return caller;
});

const sized = (files: Files) => {
  const errors = fileSizeErrors(files);

  return errors.length > 0 ? Effect.fail(new BuildFailed({ errors })) : Effect.void;
};

const applets = HttpApiBuilder.group(api, "applets", (handlers) =>
  handlers.handleAll({
    list: () =>
      Effect.gen(function* () {
        const caller = yield* Caller;
        const registry = yield* Registry;

        return { applets: yield* registry.listApplets(caller.email, caller.role === "admin") };
      }),
    get: ({ params }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;

        return { applet, versions: yield* registry.listVersions(applet.id) };
      }),
    patch: ({ params, payload }) => patch(params.name, payload),
    remove: ({ params }) => remove(params.name),
    fork: ({ params, payload }) => fork(params.name, payload.name),
    run: ({ params }) =>
      Effect.gen(function* () {
        const target = targetOf(yield* owned(params.name));

        if (target === undefined) return yield* new NotFound({ message: "applet has no version" });

        const supervisors = yield* Supervisors;
        yield* supervisors.run(target, "manual");

        return ok;
      }),
    draft: ({ params }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;
        const draft = yield* registry.getDraft(applet.id);

        return Option.getOrElse(draft, () => ({ files: null, updated_at: null }));
      }),
    saveDraft: ({ params, payload }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        yield* sized(payload.files);
        const registry = yield* Registry;

        return { updated_at: yield* registry.putDraft(applet.id, payload.files) };
      }),
    discardDraft: ({ params }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;
        yield* registry.deleteDraft(applet.id);

        return ok;
      }),
    logs: ({ params, query }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;

        return { logs: yield* registry.listLogs(applet.id, query) };
      }),
    requests: ({ params, query }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;

        return { requests: yield* registry.listRequests(applet.id, query) };
      }),
    traffic: ({ params }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;

        return { hours: yield* registry.countRequests(applet.id) };
      }),
    emails: ({ params, query }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;

        return { emails: yield* registry.listEmails(applet.id, query) };
      }),
  }),
);

/** Removes the applet: its supervisor with the facet's storage and blobs, then its rows. */
export const remove = Effect.fn("Admin.remove")(function* (name: string) {
  const applet = yield* owned(name, "remove");
  const supervisors = yield* Supervisors;
  const registry = yield* Registry;
  yield* supervisors.remove(applet.id);
  yield* registry.deleteApplet(applet.id);
  yield* log.info("applet removed", { applet: name });

  return ok;
});

/** A name nobody holds that ingress can serve, or the refusal. */
const freeName = Effect.fn("Admin.freeName")(function* (name: string) {
  const registry = yield* Registry;

  if (!isAppletName(name))
    return yield* new BadRequest({
      message:
        "a name is lowercase letters and digits joined by single dashes, and not a platform host",
    });

  if (Option.isSome(yield* registry.getApplet(name)))
    return yield* new Forbidden({ message: `${name} is taken` });
});

/** A new applet of the caller's from the current version's source. Storage, secrets and logs stay with the original. */
export const fork = Effect.fn("Admin.fork")(function* (name: string, to: string) {
  const source = yield* owned(name);
  const caller = yield* Caller;
  const registry = yield* Registry;
  yield* freeName(to);
  const forked = yield* registry.forkApplet(source, to, caller.email);

  if (Option.isNone(forked)) return yield* new NotFound({ message: "applet has no version" });

  yield* log.info("forked", { applet: name, to });

  return { applet: forked.value };
});

/**
 * A change of `current_version` is a rollback. A change of `schedule` goes to the supervisor, which owns the alarm.
 * A change of `name` moves the hostname and the email address; the id, storage, versions and logs stay, and the
 * facet reloads on its next request.
 */
export const patch = Effect.fn("Admin.patch")(function* (name: string, body: AppletPatch) {
  const applet = yield* owned(name);
  const registry = yield* Registry;

  if (body.description !== undefined && body.description.length > maxDescription)
    return yield* new BadRequest({
      message: `a description is at most ${maxDescription} characters`,
    });

  if (body.schedule !== undefined && body.schedule !== null && !isCron(body.schedule))
    return yield* new BadRequest({
      message: `"${body.schedule}" is not a five-field cron expression`,
    });

  if (body.name !== undefined && body.name !== name) yield* freeName(body.name);

  if (body.current_version !== undefined) {
    const version = yield* registry.getVersion(applet.id, body.current_version);

    if (Option.isNone(version))
      return yield* new NotFound({ message: `no version ${body.current_version}` });
  }

  const updated = yield* registry.patchApplet(applet.id, {
    ...body,
    description: body.description?.trim(),
  });

  if (Option.isNone(updated)) return yield* new NotFound({ message: `no applet ${name}` });

  if (body.name !== undefined && body.name !== name)
    yield* log.info("renamed", { applet: name, to: body.name });

  if (body.current_version !== undefined)
    yield* log.info("rolled back", { applet: name, version: body.current_version });

  if (body.schedule !== undefined) {
    const supervisors = yield* Supervisors;
    yield* supervisors.setSchedule(applet.id, body.schedule);
  }

  if (
    body.visibility !== undefined ||
    body.egress !== undefined ||
    body.schedule !== undefined ||
    body.email !== undefined
  )
    yield* log.info("settings changed", {
      applet: name,
      visibility: body.visibility,
      egress: body.egress,
      schedule: body.schedule,
      email: body.email,
    });

  return { applet: updated.value };
});

/** Bundles the uploaded files, records the version and makes it current. The first version makes the caller the applet's owner. */
export const deploy = Effect.fn("Admin.deploy")(function* (
  name: string,
  files: Files,
  fresh: boolean,
) {
  const caller = yield* Caller;
  const registry = yield* Registry;

  if (!isAppletName(name))
    return yield* new BuildFailed({
      errors: [
        "a name is lowercase letters and digits joined by single dashes, and not a platform host",
      ],
    });

  const existing = yield* registry.getApplet(name);

  if (Option.isSome(existing) && !can(caller, "edit", existing.value))
    return yield* new Forbidden({ message: `${name} belongs to another user` });

  yield* sized(files);
  const bundler = yield* Bundler;
  const started = Date.now();

  const build = yield* bundler
    .build(files, fresh)
    .pipe(
      Effect.tapError((failed) =>
        log.warn("build failed", { applet: name, ms: Date.now() - started, errors: failed.errors }),
      ),
    );

  const applet = yield* registry
    .putVersion(name, caller.email, {
      server: build.server,
      files,
      exports: build.exports,
      installed: build.installed,
    })
    .pipe(
      Effect.catchTag(
        "Registry.NameTaken",
        () => new Forbidden({ message: `${name} belongs to another user` }),
      ),
    );

  const version = applet.current_version ?? 0;
  yield* registry.deleteDraft(applet.id);

  yield* log.info("deployed", {
    applet: name,
    version,
    ms: Date.now() - started,
    packages: build.installed.length,
    cached: build.cached,
    fresh,
    warnings: build.warnings,
  });

  return {
    version,
    exports: build.exports,
    installed: build.installed,
    warnings: build.warnings,
  };
});

const versions = HttpApiBuilder.group(api, "versions", (handlers) =>
  handlers.handleAll({
    deploy: ({ params, query, payload }) =>
      deploy(params.name, payload.files, query.fresh ?? false),
    source: ({ params, query }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;
        const id = query.version ?? applet.current_version;

        const version = id === null ? Option.none() : yield* registry.getVersion(applet.id, id);

        if (Option.isNone(version)) return yield* new NotFound({ message: `no version ${id}` });

        return {
          version: version.value.id,
          files: yield* registry.getFiles(applet.id, version.value.id),
        };
      }),
  }),
);

/** An applet's secrets: names out, values in. A change takes effect on the applet's next request. */
const secrets = HttpApiBuilder.group(api, "secrets", (handlers) =>
  handlers.handleAll({
    list: ({ params }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;

        return { secrets: yield* registry.listSecrets(applet.id) };
      }),
    put: ({ params, payload }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);

        if (!isSecretName(payload.name))
          return yield* new BadRequest({
            message: "a secret name is capitals, digits and underscores, like API_KEY",
          });

        const registry = yield* Registry;
        yield* registry.putSecret(applet.id, payload.name, payload.value);
        yield* log.info("secret set", { applet: params.name, name: payload.name });

        return ok;
      }),
    remove: ({ params, query }) =>
      Effect.gen(function* () {
        const applet = yield* owned(params.name);
        const registry = yield* Registry;
        yield* registry.putSecret(applet.id, query.name, null);
        yield* log.info("secret removed", { applet: params.name, name: query.name });

        return ok;
      }),
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

export class AdminApi extends Context.Service<AdminApi, Effect.Success<typeof build>>()(
  "applets/AdminApi",
) {}

export const layer = Layer.effect(AdminApi, build);
