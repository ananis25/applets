/** Ingress over test layers: a public applet, a private one without a session, and an applet calling an applet. */
import { Effect, Fiber, Layer, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { expect, test } from "vite-plus/test";

import { AdminApi } from "./admin.ts";
import { Auth } from "./auth.ts";
import { Bucket, Bundler, Editor, Mailer, Supervisors, Vars } from "./bindings.ts";
import { depthHeader } from "./egress.ts";
import { Entry, handle } from "./ingress.ts";
import { Registry, type NewRequest } from "./registry.ts";
import { targetHeaders, userHeader } from "./types.ts";

const applet = (name: string, visibility: "private" | "public") => ({
  id: `id-${name}`,
  name,
  owner: "owner@example.com",
  description: "",
  visibility,
  egress: "open" as const,
  schedule: null,
  email: 0 as const,
  current_version: 3,
  secrets_rev: 1,
  created_at: "2026-09-22T10:00:00Z",
  updated_at: "2026-09-22T10:00:00Z",
});

const applets = new Map([
  ["hello", applet("hello", "public")],
  ["notes", applet("notes", "private")],
]);

/** What the fake supervisor saw, and the request rows ingress wrote after answering. */
const seen = { headers: new Headers() };

const records: Array<NewRequest> = [];

const layers = Layer.mergeAll(
  Layer.mock(Registry)({
    getApplet: (name) => Effect.succeed(Option.fromNullishOr(applets.get(name))),
    writeRequest: (_name, entry) => Effect.sync(() => void records.push(entry)),
  }),
  Layer.mock(Supervisors)({
    fetch: (target, request) =>
      Effect.sync(() => {
        seen.headers = request.headers;

        return Response.json({ applet: target.id });
      }),
  }),
  Layer.mock(Auth)({ subject: () => Effect.succeed(null) }),
  Layer.succeed(Vars, {
    HOST_SUFFIX: ".example.test",
    AUTH_URL: "https://auth.example.test",
    MCP_URL: "https://mcp.example.test/",
    OWNER_EMAIL: "owner@example.com",
    EMAIL_FROM: "applets@example.test",
    ADMIN_TOKEN_HASH: "",
    OPENROUTER_API_KEY: "",
    BETTER_AUTH_SECRET: "",
    DEV_USER: undefined,
  }),
  Layer.mock(Editor)({}),
  Layer.mock(Bundler)({}),
  Layer.mock(Bucket)({}),
  Layer.mock(Mailer)({}),
  Layer.succeed(AdminApi, Effect.die("no admin API in this test")),
);

/** Runs ingress on one request and waits for what it left for `waitUntil`. */
async function call(request: Request, via: "outside" | "applet" = "outside"): Promise<Response> {
  const kept: Array<Fiber.Fiber<void>> = [];

  const response = await Effect.runPromise(
    handle.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.provideService(Entry, { via, keep: (fiber) => void kept.push(fiber) }),
      Effect.provide(layers),
      Effect.scoped,
      Effect.map((answer) => HttpServerResponse.toWeb(answer)),
    ),
  );

  await Effect.runPromise(Effect.forEach(kept, Fiber.join));

  return response;
}

test("a public applet answers a stranger, stamped with its target and recorded", async () => {
  records.length = 0;

  const response = await call(
    new Request("https://hello.example.test/greet", {
      headers: { cookie: "applets.session=abc", [depthHeader]: "3" },
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ applet: "id-hello" });
  expect(seen.headers.get(targetHeaders.id)).toBe("id-hello");
  expect(seen.headers.get(targetHeaders.name)).toBe("hello");
  expect(seen.headers.get(targetHeaders.version)).toBe("3");
  expect(seen.headers.get("cookie")).toBeNull();
  expect(seen.headers.get(userHeader)).toBeNull();
  expect(seen.headers.get(depthHeader)).toBeNull();
  expect(records).toMatchObject([{ version: 3, method: "GET", path: "/greet", status: 200 }]);
});

test("a private applet refuses a stranger: 401 for a script, a redirect to sign-in for a navigation", async () => {
  const script = await call(new Request("https://notes.example.test/"));

  expect(script.status).toBe(401);
  expect(await script.json()).toEqual({ _tag: "Unauthorized", message: "sign in first" });

  const navigation = await call(
    new Request("https://notes.example.test/list", { headers: { "sec-fetch-mode": "navigate" } }),
  );

  expect(navigation.status).toBe(302);
  expect(navigation.headers.get("location")).toBe(
    "https://auth.example.test/?redirectTo=https%3A%2F%2Fnotes.example.test%2Flist",
  );
});

test("an applet calling an applet keeps its depth, and an unknown host is not found", async () => {
  await call(
    new Request("https://hello.example.test/", { headers: { [depthHeader]: "2" } }),
    "applet",
  );

  expect(seen.headers.get(depthHeader)).toBe("2");

  const missing = await call(new Request("https://nope.example.test/"));

  expect(missing.status).toBe(404);
});
