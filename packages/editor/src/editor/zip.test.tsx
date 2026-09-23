/** A source zip comes back as the files that went in, and a desktop's zip of a folder loses the folder. */
import { expect, test } from "vite-plus/test";
import { unzip } from "./unzip.ts";
import { zip } from "./zip.ts";

const source = {
  "main.ts": "export function fetch() {}\n",
  "shared/util.ts": "export const x = 'é😀';\n",
};

test("a zip of an applet's source unzips to the same files", async () => {
  const archive = zip(source);

  expect(await unzip(archive.buffer)).toEqual(source);
});

test("a zip of one folder yields the paths under it, without resource forks", async () => {
  const archive = zip({
    "hello-v3/main.ts": source["main.ts"],
    "hello-v3/shared/util.ts": source["shared/util.ts"],
    "__MACOSX/hello-v3/._main.ts": "junk",
    "hello-v3/.DS_Store": "junk",
  });

  expect(await unzip(archive.buffer)).toEqual(source);
});
