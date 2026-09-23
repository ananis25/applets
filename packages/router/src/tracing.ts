/**
 * Spans and logs into Workers Logs, which `vp run tail` follows. Every
 * `Effect.fn` in the router opens a span; this tracer prints one line as each
 * span ends, so a request reads as its spans under one trace id. `Effect.log`
 * lines go out structured, with their annotations, and to the platform log
 * in the registry, which the editor shows.
 */
import { Cause, Effect, Exit, Layer, Logger, Option, Tracer } from "effect";

import { collector } from "./platformLog.ts";

/** Internal headers used to carry a trace from ingress to a Supervisor's `fetch`. */
export const traceHeaders = {
  traceId: "x-applets-trace-id",
  spanId: "x-applets-parent-span-id",
};

/**
 * A span's identity as it crosses an RPC hop. Cloudflare RPC carries no headers, so a Supervisor
 * method takes this as its last argument, the way `traceparent` rides on a request.
 */
export type TraceParent = { readonly traceId: string; readonly spanId: string };

/** The current span as a `TraceParent`, or undefined outside any span. */
export const currentTrace: Effect.Effect<TraceParent | undefined> = Effect.currentSpan.pipe(
  Effect.map((span) => ({ traceId: span.traceId, spanId: span.spanId })),
  Effect.orElseSucceed(() => undefined),
);

/** Runs an Effect under a parent from another hop, or as is when there is none. */
export const under =
  (parent: TraceParent | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    parent === undefined ? effect : Effect.withParentSpan(effect, Tracer.externalSpan(parent));

class ConsoleSpan extends Tracer.NativeSpan {
  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit);

    console.log({
      span: this.name,
      trace: this.traceId,
      id: this.spanId,
      parent: Option.getOrUndefined(this.parent)?.spanId,
      ms: Number(endTime - this.startTime) / 1_000_000,
      error: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined,
      ...Object.fromEntries(this.attributes),
    });
  }
}

export const tracing = Layer.mergeAll(
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new ConsoleSpan(options) })),
  Logger.layer([Logger.consoleStructured, collector]),
);
