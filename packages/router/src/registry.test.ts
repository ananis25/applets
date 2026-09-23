/** How a bundle splits into the parts D1 stores, the size guard on an upload, and the shape of an applet id. */
import { expect, test } from "vite-plus/test";

import { fileSizeErrors, splitText, uuidv7 } from "./registry.ts";

test("an applet id is a UUID v7, and one made later sorts later", async () => {
  const first = uuidv7();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = uuidv7();

  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(second > first).toBe(true);
});

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

test("pieces join back to the text and none passes the byte limit", () => {
  const text = "abcdefghij".repeat(10) + "k";
  const pieces = splitText(text, 10);

  expect(pieces).toHaveLength(11);
  expect(pieces.every((piece) => bytes(piece) <= 10)).toBe(true);
  expect(pieces.join("")).toBe(text);
});

test("a piece never ends inside a multi-byte character", () => {
  const text = "abc😀dé😀";

  expect(splitText(text, 5)).toEqual(["abc", "😀d", "é", "😀"]);
});

test("a file past the row limit is an error that names the file, its size and the limit", () => {
  const errors = fileSizeErrors({ "main.ts": "export {};", "data.ts": "x".repeat(2_000_000) });

  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/^data\.ts is 2000000 bytes.*2 MB/);
});

test("multi-byte source counts by its UTF-8 size, not its length", () => {
  expect(fileSizeErrors({ "main.ts": "é".repeat(1_000_000) })).toHaveLength(1);
});
