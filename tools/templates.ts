/**
 * `vp run templates`: embeds every directory under `examples/` into `packages/api/src/templates.json`,
 * which the router's MCP server and the editor's New applet dialog offer as templates. A template's
 * description is the docstring at the top of its `main.ts`.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe } from "@applets/api";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "examples");
const target = path.join(root, "packages/api/src/templates.json");

async function readFiles(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(directory, file).replaceAll(path.sep, "/")] = await readFile(file, "utf8");
  }

  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

const templates: Record<string, { description: string; files: Record<string, string> }> = {};

for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const files = await readFiles(path.join(source, entry.name));
  const main = files["main.ts"];
  if (main === undefined) throw new Error(`${entry.name} has no main.ts`);
  const description = describe(main);
  if (description === "") throw new Error(`${entry.name}/main.ts must start with a docstring, the template's description`);
  templates[entry.name] = { description, files };
}

await writeFile(target, `${JSON.stringify(templates, null, 2)}\n`);
console.log(`${Object.keys(templates).length} templates written to ${path.relative(root, target)}`);
