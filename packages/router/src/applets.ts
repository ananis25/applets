/** Applet operations shared by the HTTP API and MCP tools. */
import {
  BadRequest,
  BuildFailed,
  describe,
  Forbidden,
  NotFound,
  templates,
  type AppletPatch,
  type Edit,
  type Files,
} from "@applets/api";
import { Effect, Option } from "effect";
import { Bundler, Supervisors, Vars } from "./bindings.ts";
import { Caller, owned } from "./caller.ts";
import { isCron } from "./cron.ts";
import { isAppletName } from "./hosts.ts";
import { can } from "./policy.ts";
import { log } from "./platformLog.ts";
import { fileSizeErrors, Registry, type LogQuery, type WindowQuery } from "./registry.ts";
import { isSecretName, targetOf } from "./types.ts";

const ok = { ok: true } as const;

const maxDescription = 200;

const sized = (files: Files) => {
  const errors = fileSizeErrors(files);

  return errors.length > 0 ? Effect.fail(new BuildFailed({ errors })) : Effect.void;
};

/** An applet's mail in and out, using the same window for the API and MCP. */
export const emails = Effect.fn("Applets.emails")(function* (name: string, query: WindowQuery) {
  const applet = yield* owned(name);
  const registry = yield* Registry;

  return { emails: yield* registry.listEmails(applet.id, query) };
});

/** Removes the applet: its supervisor with the facet's storage and blobs, then its rows. */
export const remove = Effect.fn("Applets.remove")(function* (name: string) {
  const applet = yield* owned(name, "remove");
  const supervisors = yield* Supervisors;
  const registry = yield* Registry;
  yield* supervisors.remove(applet.id);
  yield* registry.deleteApplet(applet.id);
  yield* log.info("applet removed", { applet: name });

  return ok;
});

/** A name nobody holds that ingress can serve, or the refusal. */
const freeName = Effect.fn("Applets.freeName")(function* (name: string) {
  const registry = yield* Registry;

  const { HOST_SUFFIX, MCP_URL } = yield* Vars;

  if (!isAppletName(name, HOST_SUFFIX, MCP_URL))
    return yield* new BadRequest({
      message:
        "a name is lowercase letters and digits joined by single dashes, and not a platform host",
    });

  if (Option.isSome(yield* registry.getApplet(name)))
    return yield* new Forbidden({ message: `${name} is taken` });
});

/** A new applet of the caller's from the current version's source. Storage, secrets and logs stay with the original. */
export const fork = Effect.fn("Applets.fork")(function* (name: string, to: string) {
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
export const patch = Effect.fn("Applets.patch")(function* (name: string, body: AppletPatch) {
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

/** Bundles the uploaded files, records the version and makes it current. The first version makes the caller the applet's owner and its `main.ts` docstring the description. */
export const deploy = Effect.fn("Applets.deploy")(function* (
  name: string,
  files: Files,
  fresh: boolean,
) {
  const caller = yield* Caller;
  const registry = yield* Registry;

  const { HOST_SUFFIX, MCP_URL } = yield* Vars;

  if (!isAppletName(name, HOST_SUFFIX, MCP_URL))
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
      description: describe(files["main.ts"] ?? "").slice(0, maxDescription),
    })
    .pipe(
      Effect.catchTag(
        "Registry.NameTaken",
        () => new Forbidden({ message: `${name} belongs to another user` }),
      ),
    );

  const version = applet.current_version ?? 0;
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

/** A new applet from a template, with `files` laid over the template's. A name that exists is refused: deploy changes an applet. */
export const create = Effect.fn("Applets.create")(function* (
  name: string,
  template: string,
  files: Files | undefined,
) {
  const chosen = templates[template];

  if (chosen === undefined)
    return yield* new BadRequest({
      message: `no template ${template}; one of ${Object.keys(templates).join(", ")}`,
    });

  const registry = yield* Registry;

  if (Option.isSome(yield* registry.getApplet(name)))
    return yield* new BadRequest({ message: `${name} exists; deploy files or edits to change it` });

  return yield* deploy(name, { ...chosen.files, ...files }, false);
});

/** The files of the current version, or of `version`, of an applet the caller may edit. */
export const source = Effect.fn("Applets.source")(function* (name: string, version?: number) {
  const applet = yield* owned(name);
  const registry = yield* Registry;
  const id = version ?? applet.current_version;

  const found = id === null ? Option.none() : yield* registry.getVersion(applet.id, id);

  if (Option.isNone(found)) return yield* new NotFound({ message: `no version ${id}` });

  return { version: found.value.id, files: yield* registry.getFiles(applet.id, found.value.id) };
});

/** The files after the edits, or the first edit that does not fit them. */
export const applyEdits = (
  files: Files,
  edits: ReadonlyArray<Edit>,
): Effect.Effect<Files, BadRequest> =>
  Effect.gen(function* () {
    const next = { ...files };

    for (const { path, old, new: text } of edits) {
      const current = next[path];

      if (old === "") {
        if (current !== undefined)
          return yield* new BadRequest({ message: `${path} exists; give the text to replace` });

        next[path] = text;
        continue;
      }

      if (current === undefined) return yield* new BadRequest({ message: `no file ${path}` });

      const at = current.indexOf(old);

      if (at === -1)
        return yield* new BadRequest({ message: `${path} does not contain the old text` });

      if (current.indexOf(old, at + 1) !== -1)
        return yield* new BadRequest({
          message: `the old text occurs more than once in ${path}; give more of it`,
        });

      next[path] = current.slice(0, at) + text + current.slice(at + old.length);
    }

    return next;
  });

/** The current files with the edits applied, deployed as a new version. */
export const edit = Effect.fn("Applets.edit")(function* (name: string, edits: ReadonlyArray<Edit>) {
  const { files } = yield* source(name);

  return yield* deploy(name, yield* applyEdits(files, edits), false);
});

/** Applets visible in the management list, including everyone's for the admin. */
export const list = Effect.fn("Applets.list")(function* () {
  const caller = yield* Caller;
  const registry = yield* Registry;

  return { applets: yield* registry.listApplets(caller.email, caller.role === "admin") };
});

/** An applet's settings and version history, for its owner. */
export const get = Effect.fn("Applets.get")(function* (name: string) {
  const applet = yield* owned(name);
  const registry = yield* Registry;

  return { applet, versions: yield* registry.listVersions(applet.id) };
});

/** Calls the scheduled handler once, using the same path as an alarm. */
export const run = Effect.fn("Applets.run")(function* (name: string) {
  const target = targetOf(yield* owned(name));

  if (target === undefined) return yield* new NotFound({ message: "applet has no version" });
  const supervisors = yield* Supervisors;
  yield* supervisors.run(target, "manual");

  return ok;
});

/** Lines logged by an applet the caller owns. */
export const logs = Effect.fn("Applets.logs")(function* (name: string, query: LogQuery) {
  const applet = yield* owned(name);
  const registry = yield* Registry;

  return { logs: yield* registry.listLogs(applet.id, query) };
});

/** Runs of an applet the caller owns. */
export const requests = Effect.fn("Applets.requests")(function* (name: string, query: WindowQuery) {
  const applet = yield* owned(name);
  const registry = yield* Registry;

  return { requests: yield* registry.listRequests(applet.id, query) };
});

/** Secret names, never their values. */
export const listSecrets = Effect.fn("Applets.listSecrets")(function* (name: string) {
  const applet = yield* owned(name);
  const registry = yield* Registry;

  return { secrets: yield* registry.listSecrets(applet.id) };
});

/** Sets a secret and records the change; the next load receives its value. */
export const setSecret = Effect.fn("Applets.setSecret")(function* (
  name: string,
  secret: string,
  value: string,
) {
  const applet = yield* owned(name);

  if (!isSecretName(secret))
    return yield* new BadRequest({
      message: "a secret name is capitals, digits and underscores, like API_KEY",
    });
  const registry = yield* Registry;
  yield* registry.putSecret(applet.id, secret, value);
  yield* log.info("secret set", { applet: name, name: secret });

  return ok;
});

/** Removes a secret and records the change. */
export const removeSecret = Effect.fn("Applets.removeSecret")(function* (
  name: string,
  secret: string,
) {
  const applet = yield* owned(name);
  const registry = yield* Registry;
  yield* registry.putSecret(applet.id, secret, null);
  yield* log.info("secret removed", { applet: name, name: secret });

  return ok;
});

/** Saves a draft after validating the source file sizes. */
export const saveDraft = Effect.fn("Applets.saveDraft")(function* (name: string, files: Files) {
  const applet = yield* owned(name);
  yield* sized(files);
  const registry = yield* Registry;

  return { updated_at: yield* registry.putDraft(applet.id, files) };
});
