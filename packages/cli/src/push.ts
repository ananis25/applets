/** `vp run push <path>`: upload an applet directory to the admin API, which bundles and serves it. */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { api, visibilities, type Files, type Visibility } from "@applets/api";
import { Console, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

import { adminToken, appletUrl, attempt, box, CliError, paths } from "./environment.ts";

export { visibilities, type Visibility };

const textExtensions = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
  ".css",
  ".html",
  ".txt",
  ".md",
  ".svg",
];

/** Every text file in the applet directory, keyed by its path relative to the directory. */
const readAppletFiles = (directory: string) =>
  attempt(`Could not read ${directory}`, async () => {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files: Record<string, string> = {};

    for (const entry of entries) {
      if (!entry.isFile() || !textExtensions.some((extension) => entry.name.endsWith(extension)))
        continue;

      const file = path.join(entry.parentPath, entry.name);
      files[path.relative(directory, file).replaceAll(path.sep, "/")] = await readFile(
        file,
        "utf8",
      );
    }

    return files;
  });

/** The admin API's client, every call with the bearer token from `secrets.env`. */
const admin = Effect.gen(function* () {
  const token = yield* adminToken;

  return yield* HttpApiClient.make(api, {
    baseUrl: box.adminUrl,
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
  });
}).pipe(Effect.provide(FetchHttpClient.layer));

/** A refused call as the message `vp run push` prints. */
const failed = (error: { readonly _tag: string; readonly message: string }): CliError => {
  if (error._tag === "HttpClientError")
    return new CliError({
      message: `Could not reach the admin API at ${box.adminUrl}: ${error.message}`,
    });

  return new CliError({ message: `${error._tag}: ${error.message}` });
};

/** One GET of the applet's front page, which must answer 2xx: ingress, the supervisor, the loader and the facet all ran. */
const answers = (name: string) =>
  Effect.gen(function* () {
    const url = appletUrl(name);
    const response = yield* attempt(`Could not reach ${url}`, () => fetch(url));

    if (!response.ok)
      return yield* new CliError({ message: `GET ${url} returned ${response.status}` });
  });

/** The applet is named after its directory. With a visibility the push sets it, and a `public` applet is checked to answer without a session. */
export const push = (appletPath: string, visibility?: Visibility) =>
  Effect.gen(function* () {
    const directory = path.resolve(appletPath);
    const name = path.basename(directory);
    const files: Files = yield* readAppletFiles(directory);
    const client = yield* admin;

    const deployed = yield* client.versions
      .deploy({ params: { name }, query: {}, payload: { files } })
      .pipe(
        Effect.catchTag(
          "BuildFailed",
          (build) =>
            new CliError({
              message: `build failed:\n${build.errors.map((error) => `  ${error}`).join("\n")}`,
            }),
        ),
        Effect.mapError(failed),
      );

    if (visibility !== undefined)
      yield* client.applets
        .patch({ params: { name }, payload: { visibility } })
        .pipe(Effect.mapError(failed));

    if (visibility === "public") yield* answers(name);

    for (const warning of deployed.warnings ?? []) yield* Console.warn(`warning: ${warning}`);

    if (deployed.installed.length > 0)
      yield* Console.log(`installed ${deployed.installed.join(", ")}`);

    yield* Console.log(
      `deployed ${name} v${deployed.version} at ${appletUrl(name)}${visibility === undefined ? "" : ` (${visibility})`}`,
    );
  });

/** Examples that spend the OpenRouter key, so they are pushed private and not checked to answer. */
const privateExamples = ["chat"];

/** `vp run push --examples`: every applet under `examples/`, public, so each one is checked to answer: the check after a platform change. */
export const pushExamples = Effect.gen(function* () {
  const entries = yield* attempt(`Could not read ${paths.examples}`, () =>
    readdir(paths.examples, { withFileTypes: true }),
  );

  for (const entry of entries) {
    if (entry.isDirectory())
      yield* push(
        path.join(paths.examples, entry.name),
        privateExamples.includes(entry.name) ? "private" : "public",
      );
  }
});

/** `vp run remove <name>`: delete the applet from the registry with its versions, storage and blobs. */
export const remove = (name: string) =>
  Effect.gen(function* () {
    const client = yield* admin;

    yield* client.applets.remove({ params: { name } }).pipe(Effect.mapError(failed));
    yield* Console.log(`removed ${name}`);
  });
