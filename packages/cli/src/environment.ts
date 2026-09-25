/** Where the platform is: host suffix, package paths and the host's secrets. Env vars override the defaults. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Data, Effect, FileSystem } from "effect";

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

const repoRoot = path.join(import.meta.dirname, "..", "..", "..");

export const paths = {
  repoRoot,
  routerPackage: path.join(repoRoot, "packages", "router"),
  bundlerPackage: path.join(repoRoot, "packages", "bundler"),
  browserPackage: path.join(repoRoot, "packages", "browser"),
  editorPackage: path.join(repoRoot, "packages", "editor"),
  secretsFile: path.join(repoRoot, "secrets.env"),
};

const parseSecrets = (contents: string): Map<string, string> => {
  const entries = new Map<string, string>();

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    const separator = trimmed.indexOf("=");

    if (trimmed === "" || trimmed.startsWith("#") || separator === -1) continue;

    entries.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }

  return entries;
};

/**
 * The host suffix from `secrets.env` or the environment, `.localhost` by
 * default. Read synchronously because every URL the scripts print derives from it.
 */
const hostSuffix = (): string => {
  if (process.env.APPLET_HOST_SUFFIX !== undefined) return process.env.APPLET_HOST_SUFFIX;

  try {
    return (
      parseSecrets(readFileSync(paths.secretsFile, "utf8")).get("APPLET_HOST_SUFFIX") ??
      ".localhost"
    );
  } catch {
    return ".localhost";
  }
};

/** A public origin on the suffix: plain HTTP on the local `wrangler dev` port for `.localhost`, else HTTPS. */
export const originFor = (host: string, suffix: string): string =>
  suffix === ".localhost" ? `http://${host}${suffix}:8787` : `https://${host}${suffix}`;

const suffix = hostSuffix();

export const box = {
  hostSuffix: suffix,
  adminUrl: originFor("admin", suffix),
};

export const appletUrl = (name: string) => originFor(name, box.hostSuffix);

const secrets = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return parseSecrets(yield* fs.readFileString(paths.secretsFile));
}).pipe(Effect.mapError(failed(`Could not read ${paths.secretsFile}`)));

/** `key` from the process environment, else from `secrets.env`. Fails naming `key` when neither has it. */
const required = (found: Map<string, string>, key: string): Effect.Effect<string, CliError> => {
  const value = process.env[key] ?? found.get(key);

  if (value === undefined) {
    return new CliError({
      message: `${key} is not set in ${paths.secretsFile} or the environment`,
    });
  }

  return Effect.succeed(value);
};

/** The browser script's one var, when `secrets.env` names another CDP provider; nothing otherwise. */
export const browserVars = Effect.map(secrets, (found) => {
  const url = process.env.BROWSER_CDP_URL ?? found.get("BROWSER_CDP_URL");

  return url === undefined ? {} : { BROWSER_CDP_URL: url };
});

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
