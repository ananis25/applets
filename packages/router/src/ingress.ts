/**
 * Ingress. Routes by hostname: the admin API on `admin.`, sign-in and OAuth on
 * `auth.`, the editor on `app.`, the MCP server on `MCP_URL`'s host, every
 * other host to that applet's Supervisor after the policy check. One Effect over the request in context; the tagged errors it
 * fails with become responses in one place at the bottom. No
 * `cloudflare:workers` import, so vitest loads it with test layers.
 */
import { AppletFailed, Forbidden, NotFound, Unauthorized } from "@applets/api";
import { Context, Effect, Fiber, Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AdminApi, docsPaths } from "./admin.ts";
import { Auth, mcpScopes } from "./auth.ts";
import { Bucket, Editor, Supervisors, Vars } from "./bindings.ts";
import { verifyBlobDownload } from "./blobDownload.ts";
import { Caller } from "./caller.ts";
import { depthHeader } from "./egress.ts";
import { faviconOf } from "./favicon.ts";
import { AppletFetch, serve as mcp } from "./mcp.ts";
import { log } from "./platformLog.ts";
import { can, isCrossOrigin, isCrossOriginSessionWrite, type Member } from "./policy.ts";
import { Registry } from "./registry.ts";
import { traceHeaders } from "./tracing.ts";
import { isAppletName, requestHeader, targetHeaders, targetOf, userHeader } from "./types.ts";

/**
 * How the request arrived: from outside, or from an applet through `Egress`,
 * the only source whose depth header is trusted. `keep` hands a fiber to the
 * Worker's `waitUntil`, so the request record outlives the response.
 */
export class Entry extends Context.Service<
  Entry,
  {
    readonly via: "outside" | "applet";
    readonly keep: (fiber: Fiber.Fiber<void>) => void;
  }
>()("applets/Entry") {}

const web = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.orDie(HttpServerRequest.toWeb(request));

const answer = (response: Response) => HttpServerResponse.fromWeb(response);

const pathOf = (request: HttpServerRequest.HttpServerRequest): string =>
  new URL(request.originalUrl).pathname;

/** The editor script's answer for a page or asset. A miss is logged: a stale page asking for a chunk an older build shipped is how a blank editor starts. */
const fromEditor = (request: Request) =>
  Effect.gen(function* () {
    const editor = yield* Editor;
    const response = yield* editor.fetch(request);

    if (response.status >= 400)
      yield* log.warn("editor asset missing", {
        path: new URL(request.url).pathname,
        status: response.status,
      });

    return answer(response);
  });

/** The auth hostname: Better Auth's own routes under `/api/auth/` and `/.well-known/`, and the sign-in and consent pages, which are the editor script's `/auth` page. Everything else is one of that page's assets. */
const authHost = Effect.fn("Ingress.auth")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const auth = yield* Auth;
  const incoming = yield* web(request);

  if (request.url.startsWith("/api/auth/") || request.url.startsWith("/.well-known/"))
    return answer(yield* auth.handle(incoming));

  const path = pathOf(request);

  if (!["/", "/confirm", "/consent"].includes(path)) return yield* fromEditor(incoming);

  const url = new URL(incoming.url);
  url.pathname = "/auth";

  return yield* fromEditor(new Request(url, incoming));
});

/** The API as `caller`, on the path under the host's prefix. Every line it logs names the caller, and a 5xx is a line of its own. */
const adminApi = (
  request: HttpServerRequest.HttpServerRequest,
  caller: typeof Caller.Service,
  prefix: string,
) =>
  AdminApi.use((api) =>
    api.pipe(
      Effect.tap((response) =>
        response.status < 500
          ? Effect.void
          : log.error("admin API failed", {
              method: request.method,
              path: request.url.slice(prefix.length),
              status: response.status,
            }),
      ),
      Effect.provideService(Caller, caller),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        request.modify({ url: request.url.slice(prefix.length) }),
      ),
      Effect.annotateLogs({ by: caller.email }),
    ),
  );

/** The editor page from the editor script, and the admin API under `/api/` for it. Both need a user, and the API only answers the editor's own page. */
const editorHost = Effect.fn("Ingress.editor")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const auth = yield* Auth;
  const incoming = yield* web(request);
  const subject = yield* auth.subject(incoming.headers);

  if (subject === null) return yield* new Unauthorized({ message: "sign in first" });

  if (!request.url.startsWith("/api/")) return yield* fromEditor(incoming);

  if (isCrossOrigin(incoming))
    return yield* new Forbidden({ message: "the editor's own page only" });

  return yield* adminApi(request, subject, "/api");
});

/** The admin API for scripts. It takes a bearer key and never a cookie, so no page on a sibling host can call it as its visitor. Its OpenAPI document and the docs page over it are open. */
const adminHost = Effect.fn("Ingress.admin")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  if (docsPaths.some((path) => path === pathOf(request)))
    return yield* adminApi(request, { role: "user", email: "" }, "");

  if (!request.headers.authorization?.startsWith("Bearer "))
    return yield* new Unauthorized({ message: "a bearer key is required" });

  const auth = yield* Auth;
  const subject = yield* auth.subject(new Headers(request.headers));

  if (subject === null) return yield* new Unauthorized({ message: "unknown key" });

  return yield* adminApi(request, subject, "");
});

/**
 * The MCP host: the server for a caller with an access token, the resource
 * metadata that tells a client where to get one, and the challenge that
 * points at it. Locally, with no token, the caller is `DEV_USER`.
 */
const mcpHost = Effect.fn("Ingress.mcp")(function* (request: HttpServerRequest.HttpServerRequest) {
  const auth = yield* Auth;
  const { AUTH_URL, BETTER_AUTH_SECRET, MCP_URL } = yield* Vars;
  const incoming = yield* web(request);
  const issuer = `${AUTH_URL}/api/auth`;

  if (pathOf(request) === "/blob" && request.method === "GET") {
    const claim = yield* Effect.promise(() =>
      verifyBlobDownload(new URL(incoming.url), BETTER_AUTH_SECRET),
    );

    if (claim === null) return yield* new NotFound({ message: "download link expired or invalid" });

    const bucket = yield* Bucket;
    const object = yield* bucket.get(`${claim.id}/${claim.key}`);

    if (object === null) return yield* new NotFound({ message: "no blob" });

    const filename = encodeURIComponent(claim.key.split("/").at(-1) ?? claim.key);

    return HttpServerResponse.raw(object.body, {
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      headers: { "content-disposition": `attachment; filename="${filename}"` },
    });
  }

  // The resource metadata is ours, not the provider's: a client asks for the scopes it advertises, and the provider leaves `offline_access` out, so its clients never get a refresh token.
  if (pathOf(request) === "/.well-known/oauth-protected-resource")
    return HttpServerResponse.jsonUnsafe({
      resource: MCP_URL,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: mcpScopes,
    });

  // Some clients look for the authorization server's metadata at the resource's root rather than at the issuer, so it is repeated here.
  if (pathOf(request) === "/.well-known/oauth-authorization-server")
    return answer(
      yield* auth.handle(
        new Request(
          `${issuer.replace("/api/auth", "")}/.well-known/oauth-authorization-server/api/auth`,
        ),
      ),
    );

  // A listen request holds a stream open for notifications the server never sends; refused, a client carries on without it.
  if (request.headers["mcp-method"] === "subscriptions/listen")
    return HttpServerResponse.jsonUnsafe(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32601, message: "this server sends no notifications" },
      },
      { status: 404 },
    );

  const subject = yield* auth.subject(incoming.headers);

  if (subject === null)
    return HttpServerResponse.jsonUnsafe(
      { error: "unauthorized", message: "an OAuth access token is required" },
      {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${MCP_URL}.well-known/oauth-protected-resource"`,
        },
      },
    );

  const context = yield* Effect.context<Registry | Auth | Entry | Supervisors>();

  return yield* mcp.pipe(
    Effect.provideService(Caller, subject),
    Effect.provideService(AppletFetch, (name, request) =>
      appletHost(HttpServerRequest.fromWeb(request), name, subject).pipe(
        Effect.map((response) => HttpServerResponse.toWeb(response)),
        Effect.catchTag("Unauthorized", (error) => new Forbidden({ message: error.message })),
        Effect.provide(context),
      ),
    ),
    Effect.annotateLogs({ by: subject.email }),
  );
});

/** Answered before the applet, so a browser's automatic request never reaches a handler or the `requests` table. */
const favicon = (name: string) =>
  HttpServerResponse.text(faviconOf(name), {
    contentType: "image/svg+xml",
    headers: { "cache-control": "public, max-age=86400" },
  });

/** Runs `work` after the response has gone, under the Worker's `waitUntil`. */
const later = (work: Effect.Effect<void, never, Registry>) =>
  Effect.gen(function* () {
    const entry = yield* Entry;
    entry.keep(yield* Effect.forkDetach(work));
  });

/**
 * Forwards a body chunk by chunk and answers how it ended: undefined for a
 * clean end, else the failure. An applet that streams has sent its status long
 * before its handler can fail, so the request record waits for this.
 */
async function relay(
  body: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
): Promise<string | undefined> {
  const writer = writable.getWriter();

  try {
    for await (const chunk of body) await writer.write(chunk);

    await writer.close();

    return undefined;
  } catch (cause) {
    await writer.abort(cause).catch(() => undefined);

    return `the body ended early: ${String(cause)}`;
  }
}

/** An applet's host: the policy check, then its Supervisor, with the request recorded either way. `given` is the subject when the MCP server fetches as its caller. */
const appletHost = Effect.fn("Ingress.applet")(function* (
  request: HttpServerRequest.HttpServerRequest,
  name: string,
  given?: Member,
) {
  if (!isAppletName(name)) return yield* new NotFound({ message: `no host ${name}` });

  if (pathOf(request) === "/favicon.ico") return favicon(name);

  const registry = yield* Registry;
  const applet = Option.getOrUndefined(yield* registry.getApplet(name));
  const target = applet === undefined ? undefined : targetOf(applet);

  if (applet === undefined || target === undefined)
    return yield* new NotFound({ message: `no applet ${name}` });

  const incoming = yield* web(request);
  const auth = yield* Auth;

  const subject =
    applet.visibility === "public" ? null : (given ?? (yield* auth.subject(incoming.headers)));

  if (!can(subject, "use", applet)) {
    return subject === null
      ? yield* new Unauthorized({ message: "sign in first" })
      : yield* new Forbidden({ message: `${name} is not yours to use` });
  }

  if (applet.visibility !== "public" && isCrossOriginSessionWrite(incoming))
    return yield* new Forbidden({ message: "a page on another host may not write here" });

  const entry = yield* Entry;
  const headers = new Headers(incoming.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete(userHeader);

  if (subject !== null) headers.set(userHeader, subject.email);

  if (entry.via === "outside") headers.delete(depthHeader);

  const request_id = crypto.randomUUID();
  const span = yield* Effect.currentSpan;
  headers.set(requestHeader, request_id);
  headers.set(traceHeaders.traceId, span.traceId);
  headers.set(traceHeaders.spanId, span.spanId);
  headers.set(targetHeaders.id, target.id);
  headers.set(targetHeaders.name, target.name);
  headers.set(targetHeaders.version, String(target.version));
  headers.set(targetHeaders.egress, target.egress);
  headers.set(targetHeaders.secrets, String(target.secrets));

  const started = Date.now();

  const record = (status: number, error?: string) =>
    registry.writeRequest(target.id, {
      request_id,
      version: target.version,
      method: incoming.method,
      path: pathOf(request),
      status,
      error,
      duration_ms: Date.now() - started,
    });

  const supervisors = yield* Supervisors;

  const response = yield* supervisors.fetch(target, new Request(incoming, { headers })).pipe(
    Effect.tapError((failed) =>
      Effect.all([
        log.error("applet failed", { applet: name, request_id, reason: failed.message }),
        later(record(502, failed.message)),
      ]),
    ),
    Effect.mapError(
      () => new AppletFailed({ message: `the applet failed, request ${request_id}` }),
    ),
  );

  if (response.body === null) {
    yield* later(record(response.status));

    return answer(response);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const body = response.body;

  yield* later(
    Effect.promise(() => relay(body, writable)).pipe(
      Effect.flatMap((error) => record(response.status, error)),
    ),
  );

  return answer(new Response(readable, response));
});

/** The answer to a stranger: a redirect to sign-in for a navigation, a 401 for everything else. */
const signIn = (error: Unauthorized) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { AUTH_URL } = yield* Vars;

    if (request.headers["sec-fetch-mode"] !== "navigate") return refuse(401)(error);

    const target = new URL(request.originalUrl);
    target.protocol = new URL(AUTH_URL).protocol;

    return HttpServerResponse.redirect(
      `${AUTH_URL}/?redirectTo=${encodeURIComponent(target.href)}`,
    );
  });

const refuse =
  (status: number) =>
  (error: {
    readonly _tag: string;
    readonly message: string;
  }): HttpServerResponse.HttpServerResponse =>
    HttpServerResponse.jsonUnsafe({ _tag: error._tag, message: error.message }, { status });

/** The whole of ingress, over the `HttpServerRequest` and `Entry` in context. */
export const handle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { HOST_SUFFIX: suffix, MCP_URL } = yield* Vars;
  const host = new URL(request.originalUrl).hostname;

  if (host === `auth${suffix}`) return yield* authHost(request);

  if (host === new URL(MCP_URL).hostname) return yield* mcpHost(request);

  if (host === `app${suffix}`) return yield* editorHost(request);

  if (host === `admin${suffix}`) return yield* adminHost(request);

  return yield* appletHost(request, host.endsWith(suffix) ? host.slice(0, -suffix.length) : "");
}).pipe(
  Effect.withSpan("Ingress.request"),
  Effect.tapDefect((defect) => log.error("ingress crashed", { defect: String(defect) })),
  Effect.catchTags({
    Unauthorized: signIn,
    Forbidden: (error) => Effect.succeed(refuse(403)(error)),
    NotFound: (error) => Effect.succeed(refuse(404)(error)),
    AppletFailed: (error) => Effect.succeed(refuse(502)(error)),
  }),
);
