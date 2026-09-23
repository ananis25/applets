/**
 * The dependency cache: one R2 object per dependency set, holding the
 * `node_modules` tree the installer produced and the versions it picked. A
 * later build with the same set writes the tree back and never calls npm, so
 * a loose range stays pinned to what resolved first until the object is
 * deleted: a range pins on first deploy.
 */
import type { InMemoryFileSystem } from "@cloudflare/worker-bundler";

export type Installed = {
  readonly files: Record<string, string>;
  readonly installed: ReadonlyArray<string>;
};

const prefix = "node_modules/";

/** The object key: a hash of the sorted dependency map. */
export async function depsKey(dependencies: Record<string, string>): Promise<string> {
  const sorted = Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b));

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sorted)),
  );

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readDeps(bucket: R2Bucket, key: string): Promise<Installed | null> {
  const object = await bucket.get(key);

  return object === null ? null : await object.json<Installed>();
}

export async function writeDeps(
  bucket: R2Bucket,
  key: string,
  installed: Installed,
): Promise<void> {
  await bucket.put(key, JSON.stringify(installed));
}

/** Everything under `node_modules/` in the filesystem, as the object stores it. */
export function nodeModules(fileSystem: InMemoryFileSystem): Installed["files"] {
  return Object.fromEntries(
    fileSystem.list(prefix).map((path) => [path, fileSystem.read(path) ?? ""]),
  );
}

export function restoreNodeModules(
  fileSystem: InMemoryFileSystem,
  files: Record<string, string>,
): void {
  for (const [path, text] of Object.entries(files)) fileSystem.write(path, text);
}
