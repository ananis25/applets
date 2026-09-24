import { Effect } from "effect";
import { expect, test } from "vite-plus/test";

import { applyEdits } from "./admin.ts";

const files = { "main.ts": "export const a = 1;\nexport const b = 2;\n" };

test("edits replace one occurrence each, and an empty old text creates a file", () => {
  const next = Effect.runSync(
    applyEdits(files, [
      { path: "main.ts", old: "a = 1", new: "a = 10" },
      { path: "shared/x.ts", old: "", new: "export const x = 1;\n" },
    ]),
  );

  expect(next).toEqual({
    "main.ts": "export const a = 10;\nexport const b = 2;\n",
    "shared/x.ts": "export const x = 1;\n",
  });
});

test("an ambiguous, absent or misplaced old text is refused with the path", () => {
  const refused = (edits: Parameters<typeof applyEdits>[1]) =>
    Effect.runSync(Effect.flip(applyEdits(files, edits))).message;

  expect(refused([{ path: "main.ts", old: "export const", new: "" }])).toContain("more than once");
  expect(refused([{ path: "main.ts", old: "c = 3", new: "" }])).toContain("main.ts");
  expect(refused([{ path: "other.ts", old: "a", new: "" }])).toBe("no file other.ts");
  expect(refused([{ path: "main.ts", old: "", new: "x" }])).toContain("exists");
});
