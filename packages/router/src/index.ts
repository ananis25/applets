/**
 * The primary script. Ingress in `ingress.ts` runs as a web handler over the
 * isolate's runtime; received mail and the cron run one Effect each. Exports
 * the capabilities a loaded applet receives, stamped with the applet's id and name.
 */
import type { LogEntry, Logs as LogsCapability } from "@applets/api/capabilities";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Context, Effect, Fiber, type Scope } from "effect";
import { HttpEffect, type HttpServerRequest } from "effect/unstable/http";

import { internalCall, underCap } from "./egress.ts";
import { handleInbound, vacuumAttachments } from "./email.ts";
import { Entry, handle } from "./ingress.ts";
import { Registry } from "./registry.ts";
import { flushLater, run, runtimeFor, type Services } from "./runtime.ts";
import type { AppletProps } from "./types.ts";

export { AI } from "./ai.ts";

export { Blobs } from "./blobs.ts";

export { Email } from "./email.ts";

export { Supervisor } from "./supervisor.ts";

/** What `@std`'s `log` calls from inside an applet. The props say which applet and version wrote the line. */
export class Logs extends WorkerEntrypoint<Cloudflare.Env, AppletProps> implements LogsCapability {
  write(entry: LogEntry): Promise<void> {
    const { id, version } = this.ctx.props;

    return run(
      this.env,
      this.ctx,
      Registry.use((db) => db.writeLog(id, version, entry)),
    );
  }
}

/** Ingress as a web handler over this request's own services. */
async function serve(
  request: Request,
  env: Cloudflare.Env,
  ctx: ExecutionContext,
  via: "outside" | "applet",
): Promise<Response> {
  const runtime = runtimeFor(env);

  const web = HttpEffect.toWebHandlerWith<
    Services,
    Services | Entry | HttpServerRequest.HttpServerRequest | Scope.Scope
  >(await runtime.context())(handle);

  const response = await web(
    request,
    Context.make(Entry, {
      via,
      keep: (fiber) => ctx.waitUntil(runtime.runPromise(Fiber.join(fiber))),
    }),
  );

  flushLater(runtime, ctx);

  return response;
}

/**
 * Every `fetch()` an applet with open egress makes passes through here. A call
 * to another applet's hostname goes to the router's own ingress; anything else
 * goes to the network.
 */
export class Egress extends WorkerEntrypoint<Cloudflare.Env, AppletProps> {
  override async fetch(request: Request): Promise<Response> {
    if (!new URL(request.url).hostname.endsWith(this.env.HOST_SUFFIX)) return fetch(request);

    const call = internalCall(request, this.env.HOST_SUFFIX);

    if (call instanceof Response) return call;

    return underCap(() => serve(call, this.env, this.ctx, "applet"));
  }
}

export default {
  fetch: (request: Request, env: Cloudflare.Env, ctx: ExecutionContext) =>
    serve(request, env, ctx, "outside"),
  email: (message: ForwardableEmailMessage, env: Cloudflare.Env, ctx: ExecutionContext) =>
    run(env, ctx, handleInbound(message)),
  scheduled: (_controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) =>
    run(
      env,
      ctx,
      Effect.all([Registry.use((db) => db.vacuum()), vacuumAttachments], { discard: true }),
    ),
};
