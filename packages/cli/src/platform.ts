/**
 * The platform, deployed and local.
 *
 * `vp run deploy` is the one place that runs `cf deploy`: the bundler
 * first, then the browser, the editor from a fresh Vite build, and the router, because the
 * router's service bindings resolve at deploy. The registry's migrations are
 * applied just before the router goes up, since the router expects its tables. The router's vars go up as
 * secrets afterwards, and the mail rule is pointed at it. `vp run deploy editor`
 * deploys one of the four alone.
 *
 * `vp run destroy` deletes all of it from the account.
 *
 * `vp run dev` is the local platform, with the editor page on Vite in front of it,
 * after the registry's migrations are applied to the local database.
 */
import path from "node:path";

import { Console, Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  bucketNames,
  createDatabase,
  databaseIds,
  deleteBucket,
  deleteDatabase,
  deleteWorker,
  routeMailTo,
  workerNames,
} from "./cloudflare.ts";
import { localRegistryId } from "./config.ts";
import { box, CliError, failed, originFor, paths, routerVars } from "./environment.ts";

type Attached = {
  readonly cwd: string;
  readonly input?: string;
  /** Added to the inherited environment, not in place of it. */
  readonly env?: Record<string, string>;
};

/** Runs a command on the caller's terminal until it exits, with `input` on its stdin when given. */
const attached = (command: string, args: ReadonlyArray<string>, options: Attached) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = ChildProcess.make(command, args, {
      cwd: options.cwd,
      env: options.env,
      extendEnv: true,
      stdin:
        options.input === undefined
          ? "inherit"
          : Stream.succeed(new TextEncoder().encode(options.input)),
      stdout: "inherit",
      stderr: "inherit",
    });

    const code = yield* spawner
      .exitCode(child)
      .pipe(Effect.mapError(failed(`Could not run ${command} in ${options.cwd}`)));

    if (code !== 0) {
      return yield* new CliError({
        message: `${command} ${args.join(" ")} exited with code ${code} in ${options.cwd}`,
      });
    }
  });

const cf = (args: ReadonlyArray<string>, cwd: string, env?: Record<string, string>) =>
  attached("cf", args, { cwd, env });

/**
 * Applies the registry's pending migrations, from the router package where the
 * migrations are. The local database lives where the router's dev server keeps
 * its state, which is not where `cf` would put it on its own.
 */
const applyMigrations = (database: string, target: "local" | "remote") =>
  cf(
    [
      "d1",
      "migrations",
      "apply",
      database,
      "--dir",
      "migrations",
      ...(target === "local" ? ["--local", "--persist-to", ".wrangler/state"] : []),
    ],
    paths.routerPackage,
  );

/** Builds the editor page into its `dist/`, which is the directory its `wrangler.config.ts` serves. */
const buildEditor = attached("vp", ["build"], { cwd: paths.editorPackage });

/** Every resource of the platform on the account, by name. The cloudflare configs name the same ones. */
const resources = {
  router: "applets-router",
  bundler: "applets-bundler",
  browser: "applets-browser",
  editor: "applets-editor",
  registry: "applets-registry",
  blobs: "applets-blobs",
  deps: "applets-deps",
};

/**
 * The registry's database id, creating the database when the account has none.
 * The router's config takes it from `APPLETS_REGISTRY_ID`.
 */
const registryId = Effect.gen(function* () {
  const existing = (yield* databaseIds).get(resources.registry);

  return existing ?? (yield* createDatabase(resources.registry));
});

const deployBundler = cf(["deploy"], paths.bundlerPackage);

const deployBrowser = cf(["deploy"], paths.browserPackage);

const deployEditor = Effect.gen(function* () {
  yield* buildEditor;
  yield* cf(["deploy"], paths.editorPackage);
});

/** The router with its route and registry id, then its secrets, then the mail rule that names it. */
const deployRouter = Effect.gen(function* () {
  const vars = yield* routerVars;
  const id = yield* registryId;

  yield* applyMigrations(id, "remote");
  yield* cf(["deploy", "--mode", "production"], paths.routerPackage, { APPLETS_REGISTRY_ID: id });
  yield* cf(
    ["workers", "secrets", "bulk", "--worker", resources.router, "--body", JSON.stringify(vars)],
    paths.routerPackage,
  );
  yield* routeMailTo(resources.router);
});

/** In deploy order: the router's service bindings resolve at its deploy, so it goes last. */
const deployers = {
  bundler: deployBundler,
  browser: deployBrowser,
  editor: deployEditor,
  router: deployRouter,
};

export type Target = keyof typeof deployers;

export const targets: ReadonlyArray<Target> = ["bundler", "browser", "editor", "router"];

/** Deploys the chosen workers, or all four when none is chosen, always in deploy order. */
export const platformDeploy = (chosen: ReadonlyArray<Target>) =>
  Effect.gen(function* () {
    if (box.hostSuffix === ".localhost") {
      return yield* new CliError({
        message:
          "APPLET_HOST_SUFFIX is .localhost, which Cloudflare cannot route; set the public suffix in secrets.env, or run `vp run dev` for the local platform",
      });
    }

    for (const target of targets) {
      if (chosen.length === 0 || chosen.includes(target)) yield* deployers[target];
    }
  });

/**
 * Deletes everything `vp run deploy` creates: the four workers with every
 * applet's storage, the registry and both buckets. The router goes first, since
 * it binds the rest. The zone keeps its DNS record, Email Routing and
 * destination addresses, which hold no state. Without `confirmed` it only lists.
 */
export const platformDestroy = (confirmed: boolean) =>
  Effect.gen(function* () {
    const scripts = yield* workerNames;

    const workers = [
      resources.router,
      resources.bundler,
      resources.browser,
      resources.editor,
    ].filter((name) => scripts.includes(name));

    const database = (yield* databaseIds).get(resources.registry);

    const existing = yield* bucketNames;
    const buckets = [resources.blobs, resources.deps].filter((name) => existing.includes(name));

    const found = [...workers, ...(database === undefined ? [] : [resources.registry]), ...buckets];

    if (found.length === 0) return yield* Console.log("nothing to delete");

    if (!confirmed) {
      yield* Console.log(`would delete: ${found.join(", ")}`);

      return yield* Console.log("run `vp run destroy --yes` to delete them");
    }

    for (const name of workers) {
      yield* Console.log(`deleting ${name}`);
      yield* deleteWorker(name);
    }

    if (database !== undefined) {
      yield* Console.log(`deleting ${resources.registry}`);
      yield* deleteDatabase(database);
    }

    for (const name of buckets) {
      yield* Console.log(`deleting ${name} and its objects`);
      yield* deleteBucket(name);
    }
  });

/**
 * The router's vars as `.dev.vars`, always on `.localhost` whatever suffix
 * `secrets.env` names, with the owner as `DEV_USER` so nothing local asks for sign-in.
 */
const writeDevVars = Effect.gen(function* () {
  const deployed = yield* routerVars;

  const vars = {
    ...deployed,
    HOST_SUFFIX: ".localhost",
    AUTH_URL: originFor("auth", ".localhost"),
    // Better Auth takes an `http:` MCP resource only on `localhost` itself, so the local MCP host is the bare one
    MCP_URL: "http://localhost:8787/",
    DEV_USER: deployed.OWNER_EMAIL,
  };

  const lines = Object.entries(vars).map(([key, value]) => `${key}=${JSON.stringify(value)}`);

  const fs = yield* FileSystem.FileSystem;

  yield* fs
    .writeFileString(path.join(paths.routerPackage, ".dev.vars"), `${lines.join("\n")}\n`)
    .pipe(Effect.mapError(failed("Could not write .dev.vars")));
});

/**
 * The router, the bundler and the browser each in their own local `cf dev`,
 * joined over the local dev registry, and the editor page on Vite proxying
 * `/api/` to the router. The router is on the port the origins name; the
 * other two are only reached over service bindings. They start a few seconds
 * apart because two starting at once can pick the same inspector port and one
 * dies. The editor worker is left out: its page needs a session, and
 * `*.localhost` cannot hold one. Any process exiting stops the rest.
 */
export const platformDev = Effect.gen(function* () {
  yield* writeDevVars;
  yield* applyMigrations(localRegistryId, "local");

  yield* Effect.raceAll([
    cf(["dev", "--port", "8787"], paths.routerPackage),
    cf(["dev", "--port", "8788"], paths.bundlerPackage).pipe(Effect.delay("4 seconds")),
    cf(["dev", "--port", "8789"], paths.browserPackage).pipe(Effect.delay("8 seconds")),
    attached("vp", ["dev"], {
      cwd: paths.editorPackage,
      env: { APPLET_HOST_SUFFIX: ".localhost" },
    }),
  ]);
});
