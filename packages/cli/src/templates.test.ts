import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vite-plus/test";

import { templates } from "@applets/api";

const source = path.resolve(import.meta.dirname, "../../../examples");

test("templates.json matches the examples directory, so `vp run templates` has been run", async () => {
  const directories = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  expect(Object.keys(templates).sort()).toEqual(directories.sort());

  for (const [name, template] of Object.entries(templates)) {
    for (const [file, text] of Object.entries(template.files)) {
      expect(await readFile(path.join(source, name, file), "utf8"), `${name}/${file}`).toBe(text);
    }
  }
});
