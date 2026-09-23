/**
 * The platform's own log: every `Effect.log` line at info or above that the
 * router writes, kept in the registry's `platform_logs` table so the editor's
 * Logs page shows it beside the console line Workers Logs keeps. A logger is
 * synchronous, so lines queue in the isolate and `flush` writes the queue in
 * one batch after the response, under `waitUntil`.
 */
import type { LogLevel } from "@applets/api";
import type { Json } from "@applets/api/capabilities";
import { Cause, Context, Effect, Logger, Option, References, Schema, Tracer } from "effect";

import { Registry } from "./registry.ts";

export type NewPlatformLog = {
  readonly level: LogLevel;
  readonly message: string;
  readonly data: string | null;
  readonly applet: string | null;
  readonly trace_id: string | null;
  readonly at: string;
};

const levels = new Map<string, LogLevel>([
  ["Info", "info"],
  ["Warn", "warn"],
  ["Error", "error"],
  ["Fatal", "error"],
]);

const queue: Array<NewPlatformLog> = [];

/** The `applet` annotation, which the router sets as the applet's name. */
const appletName = Schema.decodeUnknownOption(Schema.String);

/**
 * Queues one line per `Effect.log` call. Debug lines never reach a logger,
 * since the minimum level is info. The annotations are the line's `data`,
 * except `applet`, which is a column of its own, and a failure's cause is
 * added as text.
 */
export const collector = Logger.make(({ logLevel, message, cause, fiber, date }) => {
  const level = levels.get(logLevel);

  if (level === undefined) return;

  const parts: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message];
  const span = Context.getOrUndefined(fiber.context, Tracer.ParentSpan);
  const { applet, ...rest } = fiber.getRef(References.CurrentLogAnnotations);
  const data = cause.reasons.length > 0 ? { ...rest, cause: Cause.pretty(cause) } : rest;

  queue.push({
    level,
    message: parts.map(String).join(" "),
    data: Object.keys(data).length === 0 ? null : JSON.stringify(data),
    applet: Option.getOrNull(appletName(applet)),
    trace_id: span?.traceId ?? null,
    at: date.toISOString(),
  });
});

/** Fields logged beside a line's message. */
type Fields = Readonly<Record<string, Json | undefined>>;

const line =
  (write: (message: string) => Effect.Effect<void>) =>
  (message: string, fields: Fields = {}) =>
    write(message).pipe(Effect.annotateLogs(fields));

/** The router's log lines, one call each: `yield* log.info("deployed", { applet, version })`. */
export const log = {
  info: line(Effect.logInfo),
  warn: line(Effect.logWarning),
  error: line(Effect.logError),
};

/** Writes every queued line in one batch. Nothing to write is nothing done. */
export const flush = Effect.gen(function* () {
  if (queue.length === 0) return;

  const registry = yield* Registry;
  yield* registry.writePlatformLogs(queue.splice(0));
});
