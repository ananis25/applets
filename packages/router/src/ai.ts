/**
 * The `AI` capability a loaded applet receives: chat completions through
 * OpenRouter's OpenAI-compatible API. Only the router holds the key; applets
 * reach it over RPC and get the upstream body back, JSON or a stream of
 * server-sent events, so nothing here reshapes the OpenAI format. Every call
 * ends as one line in the applet's log: model, duration, finish reason and
 * usage, or what went wrong, which a stream would otherwise hide.
 */
import type { LogEntry } from "@applets/api/capabilities";
import type { AI as AICapability, ChatParams } from "@applets/api/capabilities";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect, Schema } from "effect";

import { Vars } from "./bindings.ts";
import { Registry } from "./registry.ts";
import { run } from "./runtime.ts";
import { defaultModel, type AppletProps } from "./types.ts";

const endpoint = "https://openrouter.ai/api/v1/chat/completions";

/** OpenRouter answered outside 2xx, or could not be reached. A 5xx or no answer is retried twice before it reaches the applet. */
class Refused extends Schema.TaggedError<Refused>()("AI.Refused", {
  status: Schema.Number,
  message: Schema.String,
}) {}

const chat = Effect.fn("AI.chat")(
  function* (key: string, params: ChatParams) {
    const upstream = yield* Effect.tryPromise({
      try: () =>
        fetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ ...params, model: params.model ?? defaultModel }),
        }),
      catch: (cause) =>
        new Refused({ status: 503, message: `OpenRouter did not answer: ${String(cause)}` }),
    });

    if (!upstream.ok) {
      const text = yield* Effect.promise(() => upstream.text());

      return yield* new Refused({
        status: upstream.status,
        message: `OpenRouter answered ${upstream.status}: ${text}`,
      });
    }

    return upstream;
  },
  Effect.retry({ times: 2, while: (refused) => refused.status >= 500 }),
);

/** The fields of one completion or stream event that say how it went. OpenRouter reports a failure mid-stream as an `error` event with status 200. */
const Event = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    choices: Schema.optional(
      Schema.Array(Schema.Struct({ finish_reason: Schema.optional(Schema.NullOr(Schema.String)) })),
    ),
    usage: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          prompt_tokens: Schema.Number,
          completion_tokens: Schema.Number,
          total_tokens: Schema.Number,
        }),
      ),
    ),
    error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
  }),
);

const readEvent = Schema.decodeSync(Event);

/** What a completion reported by the time it ended, gathered from the JSON body or the stream's events. */
type Outcome = {
  id?: string;
  model?: string;
  finish_reason?: string | null;
  usage?: NonNullable<(typeof Event)["Type"]["usage"]>;
  error?: string;
};

/** Folds one event's text into the outcome. Text that is not an event is a failure of its own. */
function observe(text: string, outcome: Outcome): void {
  const seen = readEvent(text);

  if (seen.id !== undefined) outcome.id = seen.id;

  if (seen.model !== undefined) outcome.model = seen.model;

  const finish = seen.choices?.[0]?.finish_reason;

  if (finish !== undefined && finish !== null) outcome.finish_reason = finish;

  if (seen.usage) outcome.usage = seen.usage;

  if (seen.error) outcome.error = seen.error.message ?? "OpenRouter reported an error";
}

/** Forwards the event stream chunk by chunk while reading each event for the outcome. Resolves when the stream ends, however it ends. */
async function relay(
  upstream: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
  outcome: Outcome,
): Promise<void> {
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of upstream) {
      await writer.write(chunk);
      const lines = (buffer + decoder.decode(chunk, { stream: true })).split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") observe(line.slice(6), outcome);
      }
    }

    await writer.close();
  } catch (cause) {
    outcome.error ??= String(cause);
    await writer.abort(cause).catch(() => undefined);
  }
}

/** What `@std`'s `ai` calls from inside an applet. */
export class AI extends WorkerEntrypoint<Cloudflare.Env, AppletProps> implements AICapability {
  /** One chat completion. Throws when OpenRouter refuses it; with `stream: true` the body is the event stream. `request_id` is the run the line belongs to. */
  chat(params: ChatParams, request_id?: string): Promise<Response> {
    const started = Date.now();
    const model = params.model ?? defaultModel;

    const write = (entry: LogEntry) =>
      run(
        this.env,
        this.ctx,
        Registry.use((db) =>
          db.writeLog(this.ctx.props.id, this.ctx.props.version, { ...entry, request_id }),
        ),
      );

    const ended = (outcome: Outcome) =>
      write({
        level: outcome.error === undefined ? "info" : "error",
        message: outcome.error === undefined ? "ai chat" : "ai chat failed",
        data: {
          model: outcome.model ?? model,
          stream: params.stream === true,
          ms: Date.now() - started,
          finish_reason: outcome.finish_reason ?? null,
          usage: outcome.usage ?? null,
          error: outcome.error ?? null,
          id: outcome.id ?? null,
        },
      });

    return run(
      this.env,
      this.ctx,
      Vars.use((vars) => chat(vars.OPENROUTER_API_KEY, params)).pipe(
        Effect.tapError((refused) => Effect.promise(() => ended({ error: refused.message }))),
        Effect.flatMap((upstream) =>
          Effect.promise(async () => {
            const headers = {
              "content-type": upstream.headers.get("content-type") ?? "application/json",
            };

            const outcome: Outcome = {};

            if (params.stream !== true || upstream.body === null) {
              const text = await upstream.text();
              observe(text, outcome);
              await ended(outcome);

              return new Response(text, { headers });
            }

            const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
            this.ctx.waitUntil(relay(upstream.body, writable, outcome).then(() => ended(outcome)));

            return new Response(readable, { headers });
          }),
        ),
      ),
    );
  }
}
