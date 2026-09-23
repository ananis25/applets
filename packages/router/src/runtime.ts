/**
 * The router's Effect runtime, one per request or call. Workers ties every
 * promise, stream and I/O call to the request that made it, so nothing built for
 * one request is handed to another: each builds its services from its own `env`,
 * which is cheap since no layer does I/O while it is built. Ingress, the Durable
 * Object and the capabilities all run their Effects this way.
 */
import { Effect, Layer, ManagedRuntime, Scheduler } from "effect";

import { AdminApi, layer as adminLayer } from "./admin.ts";
import { Auth, layer as authLayer } from "./auth.ts";
import { bindings, Bucket, Bundler, Editor, Mailer, Supervisors, Vars } from "./bindings.ts";
import { flush } from "./platformLog.ts";
import { layer as registryLayer, Registry } from "./registry.ts";
import { tracing } from "./tracing.ts";

export type Services =
  | Registry
  | Vars
  | Editor
  | Supervisors
  | Bundler
  | Bucket
  | Mailer
  | Auth
  | AdminApi;

/**
 * Fibers resume on microtasks, never on a timer. The default scheduler batches
 * every fiber's next step onto one shared `setTimeout(0)`; on Workers a timer
 * belongs to the request that set it, so a concurrent request whose step landed
 * on another request's timer never resumes once that request ends, and the
 * runtime cancels it as hung.
 */
const scheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));

/** Every service over one request's bindings, with spans and logs to the console. */
const live = (env: Cloudflare.Env): Layer.Layer<Services> =>
  adminLayer.pipe(
    Layer.provideMerge(authLayer(env.REGISTRY)),
    Layer.provideMerge(Layer.mergeAll(registryLayer(env.REGISTRY), bindings(env))),
    Layer.merge(tracing),
    Layer.merge(scheduler),
    Layer.orDie,
  );

/** A fresh runtime for one request or call. */
export const runtimeFor = (env: Cloudflare.Env): ManagedRuntime.ManagedRuntime<Services, never> =>
  ManagedRuntime.make(live(env));

/** Anything with a `waitUntil`: the Worker's context, or a Durable Object's. */
export type Keeper = Pick<ExecutionContext, "waitUntil">;

/**
 * Hands the platform log lines queued so far to `waitUntil`, so they are written
 * after the answer has gone, then closes the runtime so its layers' finalizers run.
 */
export const flushLater = (
  runtime: ManagedRuntime.ManagedRuntime<Services, never>,
  ctx: Keeper,
): void => ctx.waitUntil(runtime.runPromise(flush).finally(() => runtime.dispose()));

/** One Effect from a Promise-shaped edge: a Durable Object method, a capability, the `email` or `scheduled` handler. Its log lines are written once it settles. */
export const run = <A, E>(
  env: Cloudflare.Env,
  ctx: Keeper,
  effect: Effect.Effect<A, E, Services>,
): Promise<A> => {
  const runtime = runtimeFor(env);
  const promise = runtime.runPromise(effect);
  const settled = () => flushLater(runtime, ctx);
  promise.then(settled, settled);

  return promise;
};
