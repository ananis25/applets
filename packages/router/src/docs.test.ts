import { expect, test } from "vite-plus/test";

import { index, topics } from "./docs.ts";

test("every section of both docs is a topic named by its heading, and the index says when to read each", () => {
  expect(Object.keys(topics)).toEqual(
    expect.arrayContaining(["applets", "storage", "npm-packages", "platform", "access"]),
  );
  expect(topics.storage?.text.startsWith("## Storage")).toBe(true);
  expect(topics.storage?.text).toContain("### Rules");
  expect(topics.storage?.text).not.toContain("## Schedules");
  expect(index).toContain("- storage: Use when the applet keeps data between requests.");
  expect(topics.applets?.text).toContain("## Limits");
});
