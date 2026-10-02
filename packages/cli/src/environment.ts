/** Where the platform is: host suffix, package paths and the host's secrets. Env vars override the defaults. */
import { createHash } from "node:crypto";
import path from "node:path";

import { Data, Effect } from "effect";
import { originFor, readSettings, repoRoot, secretsFile } from "./config.ts";

export { originFor } from "./config.ts";

export class CliError extends Data.TaggedError("CliError")<{
  readonly message: string;
}> {}

/** A failure on the way out, as the message the command prints. */
export const failed =
  (message: string) =>
  (cause: { readonly message: string }): CliError =>
    new CliError({ message: `${message}: ${cause.message}` });

export const attempt = <Value>(message: string, operation: () => Promise<Value>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => new CliError({ message: `${message}: ${String(cause)}` }),
  });

export const paths = {
  repoRoot,
  routerPackage: path.join(repoRoot, "packages", "router"),
  bundlerPackage: path.join(repoRoot, "packages", "bundler"),
  browserPackage: path.join(repoRoot, "packages", "browser"),
  editorPackage: path.join(repoRoot, "packages", "editor"),
  secretsFile,
};

const suffix = readSettings().get("APPLET_HOST_SUFFIX") ?? ".localhost";

export const box = {
  hostSuffix: suffix,
  apiUrl: originFor("api", suffix),
};

export const appletUrl = (name: string) => originFor(name, box.hostSuffix);

const secrets = Effect.try({
  try: readSettings,
  catch: (cause) => new CliError({ message: `Could not read ${secretsFile}: ${String(cause)}` }),
});

/** `key` from the process environment, else from `secrets.env`. Fails naming `key` when neither has it. */
const required = (found: Map<string, string>, key: string): Effect.Effect<string, CliError> => {
  const value = found.get(key);

  if (value === undefined) {
    return new CliError({
      message: `${key} is not set in ${paths.secretsFile} or the environment`,
    });
  }

  return Effect.succeed(value);
};

/** The host-only bearer token; the router only ever holds its SHA-256 hash. */
export const adminToken = Effect.gen(function* () {
  const token = yield* required(yield* secrets, "ADMIN_TOKEN");

  if (token.length < 32) {
    return yield* new CliError({
      message: "ADMIN_TOKEN must be a random token of at least 32 characters",
    });
  }

  return token;
});

/** The router's vars, gathered from `secrets.env` and the environment for a platform deploy. */
export const routerVars = Effect.gen(function* () {
  const found = yield* secrets;
  const token = yield* adminToken;

  return {
    ADMIN_TOKEN_HASH: createHash("sha256").update(token).digest("hex"),
    HOST_SUFFIX: box.hostSuffix,
    AUTH_URL: originFor("auth", box.hostSuffix),
    MCP_URL: `${originFor("mcp", box.hostSuffix)}/`,
    BETTER_AUTH_SECRET: yield* required(found, "BETTER_AUTH_SECRET"),
    EMAIL_FROM: yield* required(found, "EMAIL_FROM"),
    OWNER_EMAIL: yield* required(found, "OWNER_EMAIL"),
    OPENROUTER_API_KEY: yield* required(found, "OPENROUTER_API_KEY"),
  };
});
