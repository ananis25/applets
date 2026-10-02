/**
 * `postinstall`: links the hoisted `wrangler` into every workspace package that declares it.
 * `cf` only looks in the package's own `node_modules` for its bundler, so npm's hoisting hides
 * it. The links point at one copy, nothing is duplicated.
 */
import { existsSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const hoisted = path.join(root, "node_modules", "wrangler");

for (const name of ["bundler", "browser", "editor", "router"]) {
  const pkg = path.join(root, "packages", name);
  const manifest = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  if (manifest.devDependencies?.wrangler === undefined) continue;

  const link = path.join(pkg, "node_modules", "wrangler");
  if (existsSync(link)) continue;
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(path.relative(path.dirname(link), hoisted), link);
}
