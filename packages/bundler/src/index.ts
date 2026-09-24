/**
 * The bundler script. One entrypoint, `Bundler.build(files)`: scan the applet's
 * source, install its `npm:` dependencies, bundle the client for the browser
 * and the generated entry for the loader, and hand back one module.
 */
import {
  createApp,
  createWorker,
  InMemoryFileSystem,
  installDependencies,
} from "@cloudflare/worker-bundler";
import { WorkerEntrypoint } from "cloudflare:workers";

// @ts-expect-error TypeScript does not know the text import attribute; esbuild embeds the file as a string.
import stdSource from "../../std/src/index.ts" with { type: "text" };

import { depsKey, nodeModules, readDeps, restoreNodeModules, writeDeps } from "./deps.ts";
import { clientModule, renderEntry } from "./entry.ts";
import { isSourceFile, rewriteSpecifiers, scan } from "./scan.ts";

const std: string = stdSource;

export type Build =
  | {
      readonly server: string;
      readonly exports: ReadonlyArray<string>;
      readonly installed: ReadonlyArray<string>;
      /** Whether the dependency set came from the cache rather than the registry. */
      readonly cached: boolean;
      readonly warnings: ReadonlyArray<string>;
    }
  | { readonly errors: ReadonlyArray<string> };

const stdModule = "applet-std.ts";

const entryModule = "applet-entry.ts";

/** JSX for Preact, and text files imported as strings: `import page from "./index.html"`. */
const jsx = {
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".html": "text", ".css": "text", ".svg": "text", ".md": "text", ".txt": "text" },
} as const;

const moduleText = (module: string | { js?: string; text?: string }): string =>
  module instanceof Object ? (module.js ?? module.text ?? "") : module;

/** The dependency set's `node_modules`, from the cache when it has been built before. `fresh` skips the cached set and replaces it. */
async function install(
  fileSystem: InMemoryFileSystem,
  dependencies: Record<string, string>,
  deps: R2Bucket,
  warnings: Array<string>,
  fresh: boolean,
): Promise<{ installed: ReadonlyArray<string>; cached: boolean }> {
  const key = await depsKey(dependencies);
  const cached = fresh ? null : await readDeps(deps, key);

  if (cached !== null) {
    restoreNodeModules(fileSystem, cached.files);

    return { installed: cached.installed, cached: true };
  }

  const result = await installDependencies(fileSystem);
  warnings.push(...result.warnings);
  await writeDeps(deps, key, { files: nodeModules(fileSystem), installed: result.installed });

  return { installed: result.installed, cached: false };
}

async function build(
  files: Record<string, string>,
  deps: R2Bucket,
  fresh: boolean,
): Promise<Build> {
  const scanned = scan(files);

  if ("errors" in scanned) return scanned;

  const project: Record<string, string> = {};

  for (const [path, text] of Object.entries(files)) {
    project[path] = isSourceFile(path) ? rewriteSpecifiers(path, text, stdModule) : text;
  }

  project[stdModule] = std;
  project[entryModule] = renderEntry({
    std: stdModule,
    client: scanned.clientEntry !== undefined,
    handlers: scanned.exports,
  });
  project["package.json"] = JSON.stringify({ dependencies: scanned.dependencies });

  const fileSystem = new InMemoryFileSystem(project);
  const warnings: Array<string> = [];

  const { installed, cached } = await install(
    fileSystem,
    scanned.dependencies,
    deps,
    warnings,
    fresh,
  );

  let client = "";

  if (scanned.clientEntry !== undefined) {
    const app = await createApp({
      files: fileSystem,
      server: stdModule,
      client: scanned.clientEntry,
      minify: true,
      ...jsx,
    });

    const bundle = app.clientBundles?.[0];
    const asset = bundle === undefined ? undefined : app.assets[bundle];

    if (asset === undefined || asset instanceof ArrayBuffer) {
      return { errors: ["the client bundle was not produced"] };
    }

    client = asset;
    warnings.push(...(app.warnings ?? []));
  }

  const server = await createWorker({
    files: fileSystem,
    entryPoint: entryModule,
    minify: true,
    virtualModules: { [clientModule]: `export default ${JSON.stringify(client)};` },
    ...jsx,
  });

  warnings.push(...(server.warnings ?? []));

  const main = server.modules[server.mainModule];

  if (main === undefined) return { errors: ["esbuild produced no main module"] };

  return {
    server: moduleText(main),
    exports: scanned.exports,
    installed,
    cached,
    warnings,
  };
}

export class Bundler extends WorkerEntrypoint<Cloudflare.Env> {
  /** `fresh` resolves the dependencies from npm again, where a build otherwise keeps what the set resolved to first. */
  async build(files: Record<string, string>, fresh = false): Promise<Build> {
    try {
      return await build(files, this.env.DEPS, fresh);
    } catch (cause) {
      return { errors: [cause instanceof Error ? cause.message : String(cause)] };
    }
  }
}

export default {
  fetch: () =>
    new Response("the bundler has no ingress; the router calls it over a service binding", {
      status: 404,
    }),
};
