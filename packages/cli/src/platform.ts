/**
 * The platform, deployed and local.
 *
 * `vp run deploy` is the one place that runs `wrangler deploy`: the bundler
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
  Login,
  routeMailTo,
  workerNames,
} from "./cloudflare.ts";
import { box, CliError, failed, originFor, paths, routerVars } from "./environment.ts";

const routerConfigName = "wrangler.local.jsonc";

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

const wrangler = (args: ReadonlyArray<string>, cwd: string, input?: string) =>
  attached("vpx", ["wrangler", ...args], { cwd, input });

/**
 * Applies the registry's pending migrations. Wrangler asks before applying to a
 * remote database; a `y` on its stdin answers, and stdin not being a terminal
 * makes it assume yes anyway.
 */
const applyMigrations = (target: "--local" | "--remote", config: string, cwd: string) =>
  wrangler(["d1", "migrations", "apply", resources.registry, target, "-c", config], cwd, "y\n");

/** Builds the editor page into its `dist/`, which is the directory its wrangler config serves. */
const buildEditor = attached("vp", ["build"], { cwd: paths.editorPackage });

/** Every resource of the platform on the account, by name. The wrangler configs name the same ones. */
const resources = {
  router: "applets-router",
  bundler: "applets-bundler",
  browser: "applets-browser",
  editor: "applets-editor",
  registry: "applets-registry",
  blobs: "applets-blobs",
  deps: "applets-deps",
};

const registryBinding = `"database_name": "${resources.registry}"`;

/**
 * The committed router config with the two host-specific values spliced in:
 * the wildcard route on the suffix's zone, and the registry's database id.
 * No vars; those go up as secrets.
 */
export const routerConfig = (committed: string, suffix: string, databaseId: string): string => {
  const routes = [{ pattern: `*${suffix}/*`, zone_name: suffix.slice(1) }];

  const bound = committed.replace(
    registryBinding,
    `${registryBinding}, "database_id": "${databaseId}"`,
  );

  return `${bound.slice(0, bound.lastIndexOf("}"))}  "routes": ${JSON.stringify(routes)},\n}\n`;
};

/**
 * The registry's database id, creating the database when the account has none.
 * The deploy names the id itself because wrangler would otherwise inherit it
 * from the deployed router's settings, and that fails with error 7404 once the
 * database has been deleted.
 */
const registryId = Effect.gen(function* () {
  const existing = (yield* databaseIds).get(resources.registry);

  return existing ?? (yield* createDatabase(resources.registry));
});

/** Writes `wrangler.local.jsonc`, which git ignores, beside the committed config so `main` resolves the same. */
const writeRouterConfig = (id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const committed = yield* fs.readFileString(path.join(paths.routerPackage, "wrangler.jsonc"));

    yield* fs.writeFileString(
      path.join(paths.routerPackage, routerConfigName),
      routerConfig(committed, box.hostSuffix, id),
    );
  }).pipe(Effect.mapError(failed("Could not write the router config")));

const deployBundler = wrangler(["deploy"], paths.bundlerPackage);

const deployBrowser = wrangler(["deploy"], paths.browserPackage);

const deployEditor = Effect.gen(function* () {
  yield* buildEditor;
  yield* wrangler(["deploy"], paths.editorPackage);
});

/** The router with its route and registry id, then its secrets, then the mail rule that names it. */
const deployRouter = Effect.gen(function* () {
  const vars = yield* routerVars;

  yield* writeRouterConfig(yield* registryId);
  yield* applyMigrations("--remote", routerConfigName, paths.routerPackage);
  yield* wrangler(["deploy", "-c", routerConfigName], paths.routerPackage);
  yield* wrangler(
    ["secret", "bulk", "-c", routerConfigName],
    paths.routerPackage,
    JSON.stringify(vars),
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
  }).pipe(Effect.provide(Login.layer));

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
  }).pipe(Effect.provide(Login.layer));

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
 * The router, the bundler and the browser in one local `wrangler dev`, and the editor page
 * on Vite proxying `/api/` to it. The router's config comes first because the
 * first config gets the listener. The editor worker is left out: its page
 * needs a session, and `*.localhost` cannot hold one. Either process exiting
 * stops the other.
 */
export const platformDev = Effect.gen(function* () {
  yield* writeDevVars;
  yield* applyMigrations("--local", "packages/router/wrangler.jsonc", paths.repoRoot);

  const configs = [
    "-c",
    "packages/router/wrangler.jsonc",
    "-c",
    "packages/bundler/wrangler.jsonc",
    "-c",
    "packages/browser/wrangler.jsonc",
  ];

  yield* Effect.raceFirst(
    attached("vpx", ["wrangler", "dev", ...configs], { cwd: paths.repoRoot }),
    attached("vp", ["dev"], {
      cwd: paths.editorPackage,
      env: { APPLET_HOST_SUFFIX: ".localhost" },
    }),
  );
});
