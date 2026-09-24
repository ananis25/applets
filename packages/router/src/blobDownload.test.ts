import { expect, test, vi } from "vite-plus/test";

import { blobDownloadUrl, verifyBlobDownload } from "./blobDownload.ts";

test("a blob link is scoped to its applet and key and expires after five minutes", async () => {
  const secret = "test signing secret";

  const url = new URL(
    await blobDownloadUrl("https://mcp.example.test/", secret, "applet-id", "images/a.png"),
  );

  expect(await verifyBlobDownload(url, secret)).toEqual({ id: "applet-id", key: "images/a.png" });

  const changed = new URL(url);
  changed.searchParams.set("key", "images/b.png");
  expect(await verifyBlobDownload(changed, secret)).toBeNull();

  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60_000 + 1);

  try {
    expect(await verifyBlobDownload(url, secret)).toBeNull();
  } finally {
    clock.mockRestore();
  }
});
