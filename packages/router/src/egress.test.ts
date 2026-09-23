/** An applet's call to another applet, as `Egress` rewrites or refuses it. */
import { expect, test } from "vite-plus/test";

import { depthHeader, internalCall, underCap } from "./egress.ts";

const call = (host: string, headers: Record<string, string> = {}) =>
  internalCall(new Request(`https://${host}.example.test/path`, { headers }), ".example.test");

test("the internal request carries no session, so a private target answers 401", () => {
  const request = call("api", { cookie: "applets.session=abc", authorization: "Bearer token" });

  expect(request).toBeInstanceOf(Request);
  expect(request.headers.get("cookie")).toBeNull();
  expect(request.headers.get("authorization")).toBeNull();
});

test("each hop counts one deeper, and the fifth is refused with a 508", () => {
  expect(call("api").headers.get(depthHeader)).toBe("1");
  expect(call("api", { [depthHeader]: "3" }).headers.get(depthHeader)).toBe("4");
  expect(call("api", { [depthHeader]: "4" })).toMatchObject({ status: 508 });
});

test("the platform's own hosts are not applets", () => {
  for (const host of ["admin", "app", "auth"]) {
    expect(call(host)).toMatchObject({ status: 403 });
  }
});

test("a loop of calls ends in a 508 at the sixteenth level", async () => {
  let levels = 0;

  const loop = (): Promise<Response> => {
    levels += 1;

    return underCap(loop);
  };

  expect(await underCap(loop)).toMatchObject({ status: 508 });
  expect(levels).toBe(16);
});

test("calls under the cap run concurrently, and the count drops when they finish", async () => {
  let running = 0;
  let peak = 0;

  const call = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;

    return new Response("ok");
  };

  const first = await Promise.all(Array.from({ length: 10 }, () => underCap(call)));
  const second = await Promise.all(Array.from({ length: 10 }, () => underCap(call)));

  expect(peak).toBe(10);
  expect([...first, ...second].map((response) => response.status)).toEqual(Array(20).fill(200));
});
