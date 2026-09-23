/**
 * The library applets import: `sql`, `kv`, `blob`, `email`, `ai`, `secret`, `log`
 * and `page`. SQLite and KV use the applet's Durable Object storage through
 * `bind(ctx)`. Blobs, email and AI use applet-scoped capabilities on the router.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { env, waitUntil } from "cloudflare:workers";

import type {
  AppletEnv,
  BlobList,
  Cell,
  ChatParams,
  Inspection,
  InspectionResult,
  Json,
  LogLevel,
  OutboundEmail,
} from "@applets/api/capabilities";

export type {
  BlobList,
  Cell,
  ChatMessage,
  ChatParams,
  InboundEmail,
  Inspection,
  InspectionResult,
  Json,
  OutboundEmail,
  ScheduledEvent,
} from "@applets/api/capabilities";

export type BlobValue = string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream;

export type ChatUsage = {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
};

/** An OpenAI chat completion, the fields most callers read. */
export type ChatCompletion = {
  readonly id: string;
  readonly model: string;
  readonly choices: ReadonlyArray<{
    readonly message: { readonly role: "assistant"; readonly content: string | null };
    readonly finish_reason: string | null;
  }>;
  readonly usage?: ChatUsage;
};

/** One event of a streamed chat completion. A reasoning model sends `delta.reasoning` before any `content`. */
export type ChatChunk = {
  readonly id: string;
  readonly model: string;
  readonly choices: ReadonlyArray<{
    readonly delta: { readonly content?: string | null; readonly reasoning?: string | null };
    readonly finish_reason: string | null;
  }>;
  readonly usage?: ChatUsage | null;
};

declare global {
  namespace Cloudflare {
    interface Env extends AppletEnv {}
  }
}

let bound: DurableObjectState | undefined;

/** Called once by the generated entry, in the applet class constructor. */
export function bind(ctx: DurableObjectState): void {
  bound = ctx;
}

const currentRequest = new AsyncLocalStorage<string | undefined>();

/**
 * Called by the generated entry for a scheduled or inbox run. Runs the handler with the router's id
 * for this run in scope, so `log` can stamp it on each line. The facet serves runs concurrently, so
 * a module variable would not do.
 */
export function call<T>(id: string | undefined, work: () => T | Promise<T>): Promise<T> {
  return currentRequest.run(id, async () => work());
}

/**
 * Called by the generated entry for every request, the same way. A streamed body is pulled after the
 * handler has returned, outside that scope, so each pull is put back in it: a line written while
 * streaming keeps the run's id too.
 */
export async function handle(
  request: Request,
  handler: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  const id = request.headers.get("x-applet-request") ?? undefined;
  const response = await call(id, () => handler(request));

  if (response.body === null) return response;

  const reader = response.body.getReader();

  const body = new ReadableStream<Uint8Array>({
    pull: (controller) =>
      currentRequest.run(id, async () => {
        const { done, value } = await reader.read();

        if (done) controller.close();
        else controller.enqueue(value);
      }),
    cancel: (reason) => reader.cancel(reason),
  });

  return new Response(body, response);
}

/** One of the applet's secrets, set by its owner on the editor's Secrets page. Throws when it is not set. */
export function secret(name: string): string {
  const value = env.SECRETS[name];

  if (value === undefined)
    throw new Error(`secret ${name} is not set; add it on the applet's Secrets page`);

  return value;
}

const storage = (): DurableObjectStorage => {
  if (bound === undefined) throw new Error("@std is only usable inside an applet handler");

  return bound.storage;
};

export type Statement = { sql: string; args?: ReadonlyArray<SqlStorageValue> };

export type Row = Record<string, SqlStorageValue>;

export type ExecResult<R extends Row = Row> = {
  readonly rows: ReadonlyArray<R>;
  readonly rowsAffected: number;
  readonly lastInsertRowid: number;
};

/** A failed statement, carrying the SQL SQLite's own message leaves out. */
export class SqlError extends Error {
  readonly sql: string;

  constructor(sql: string, cause: Error) {
    super(`${cause.message}\n  in: ${sql}`, { cause });
    this.name = "SqlError";
    this.sql = sql;
  }
}

const toStatement = (statement: Statement | string): Statement =>
  statement instanceof Object ? statement : { sql: statement };

function run<R extends Row>(statement: Statement): ExecResult<R> {
  const db = storage().sql;

  try {
    const cursor = db.exec<R>(statement.sql, ...(statement.args ?? []));
    const rows = cursor.toArray();
    const rowid = db.exec<{ id: number }>("SELECT last_insert_rowid() AS id").one().id;

    return { rows, rowsAffected: cursor.rowsWritten, lastInsertRowid: rowid };
  } catch (cause) {
    throw new SqlError(statement.sql, cause instanceof Error ? cause : new Error(String(cause)));
  }
}

/** The applet's own SQLite database: `execute({ sql, args })` with rows as records. */
export const sql = {
  execute<R extends Row = Row>(statement: Statement | string): ExecResult<R> {
    return run<R>(toStatement(statement));
  },

  /** Runs every statement in one transaction; the first failure rolls back all of them. */
  batch<R extends Row = Row>(statements: ReadonlyArray<Statement | string>): Array<ExecResult<R>> {
    return storage().transactionSync(() =>
      statements.map((statement) => run<R>(toStatement(statement))),
    );
  },
};

const toCell = (value: SqlStorageValue): Cell =>
  value instanceof ArrayBuffer ? { blob: Buffer.from(value).toString("hex") } : value;

/**
 * Called by the generated entry when the supervisor inspects the applet's storage for its owner. A
 * statement SQLite refuses is an answer, not a throw, so the router can tell it from a platform failure.
 */
export function inspect(call: Inspection): InspectionResult {
  if (call.kind === "kv") {
    const entries = storage().kv.list({ prefix: call.prefix, limit: call.limit });

    return {
      entries: [...entries].map(([key, value]) => ({
        key,
        value: JSON.stringify(value) ?? String(value),
      })),
    };
  }

  if (call.kind === "kv-delete") {
    storage().kv.delete(call.key);

    return { entries: [] };
  }

  try {
    const cursor = storage().sql.exec(call.sql);
    const rows = [...cursor.raw()];

    return {
      columns: cursor.columnNames,
      rows: rows.map((row) => row.map(toCell)),
      rowsWritten: cursor.rowsWritten,
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Key-value storage in the same SQLite file as `sql`, for settings, cursors
 * and caches. Values are anything structured clone can carry.
 */
export const kv = {
  get<T>(key: string): T | undefined {
    return storage().kv.get<T>(key);
  },

  set<T>(key: string, value: T): void {
    storage().kv.put(key, value);
  },

  delete(key: string): boolean {
    return storage().kv.delete(key);
  },

  list<T>(options: { prefix?: string; limit?: number } = {}): Array<[string, T]> {
    return [...storage().kv.list<T>(options)];
  },
};

/** Async object storage, private to this applet and shared across its versions. */
export const blob = {
  /** Returns the value as a Response, or undefined when the key does not exist. */
  async get(key: string): Promise<Response | undefined> {
    const object = await env.BLOBS.get(key);

    if (object === null) return undefined;

    return new Response(object.body, {
      headers: object.contentType === undefined ? {} : { "content-type": object.contentType },
    });
  },

  /** Stores text, bytes, a Blob or a stream, with an optional content type. */
  async set(key: string, value: BlobValue, options: { contentType?: string } = {}): Promise<void> {
    await env.BLOBS.put(key, await new Response(value).arrayBuffer(), options.contentType);
  },

  /** Reads JSON without runtime schema validation; missing keys return undefined. */
  async getJSON<T = Json>(key: string): Promise<T | undefined> {
    const response = await blob.get(key);

    return response?.json<T>();
  },

  /** Stores a JSON value with the application/json content type. */
  async setJSON(key: string, value: Json): Promise<void> {
    await blob.set(key, JSON.stringify(value), { contentType: "application/json" });
  },

  /** Keys under the prefix in sorted order, at most `limit` of them. */
  list(options: { prefix?: string; limit?: number } = {}): Promise<BlobList> {
    return env.BLOBS.list(options.prefix ?? "", options.limit ?? 1000);
  },

  /** Deletes a key; deleting a missing key succeeds. */
  async delete(key: string): Promise<void> {
    await env.BLOBS.delete(key);
  },
};

/** Mail from `<applet>@<domain>`. The router picks the sender and logs every message. */
export const email = {
  /** Sends one message and returns its id. Throws when the router's mailer refuses it. */
  send(message: OutboundEmail): Promise<string> {
    return env.EMAIL.send(message);
  },

  /** The bytes of one attachment of a received message, fetched on demand. */
  async attachment(emailId: string, attachmentId: string): Promise<Response> {
    const object = await env.EMAIL.attachment(emailId, attachmentId);

    return new Response(object.body, { headers: { "content-type": object.contentType } });
  },
};

/** The `data:` payloads of a server-sent event stream, without the `[DONE]` that ends it. */
async function* eventData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buffer = "";

  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    const lines = (buffer + text).split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ") && line !== "data: [DONE]") yield line.slice(6);
    }
  }
}

/**
 * Chat completions in the OpenAI format, through the router's OpenRouter key,
 * which the applet never sees. Both calls throw when OpenRouter refuses the request.
 */
export const ai = {
  /** One completion; the text is `choices[0].message.content`. */
  async chat(params: ChatParams): Promise<ChatCompletion> {
    const response = await env.AI.chat({ ...params, stream: false }, currentRequest.getStore());

    return response.json<ChatCompletion>();
  },

  /**
   * The same completion as it is generated; each chunk's text is `choices[0].delta.content`.
   * OpenRouter reports a failure after the stream has started as an `error` event, which throws here.
   */
  async *stream(params: ChatParams): AsyncGenerator<ChatChunk> {
    const response = await env.AI.chat({ ...params, stream: true }, currentRequest.getStore());

    if (response.body === null) throw new Error("the AI stream came back without a body");

    for await (const data of eventData(response.body)) {
      // SAFETY: the router only returns a 2xx body from OpenRouter, whose events are chat chunks or one error event.
      const event = JSON.parse(data) as ChatChunk | { error: { message?: string } };

      if ("error" in event)
        throw new Error(
          `the AI stream failed: ${event.error.message ?? JSON.stringify(event.error)}`,
        );

      yield event;
    }
  },
};

const write = (level: LogLevel) => (message: string, data?: Json) => {
  const entry = { level, message, data, request_id: currentRequest.getStore() };

  console.log(JSON.stringify({ ...entry, applet: env.APPLET_NAME, version: env.APPLET_VERSION }));
  waitUntil(
    env.LOGS.write(entry).catch((cause: Error) => {
      console.error(`log line not delivered to the router: ${cause.message}`);
    }),
  );
};

/**
 * Structured logs. Every line goes to the console, which Workers Logs keeps,
 * and to the router over an RPC the applet does not wait for, so
 * the editor's Logs page sees it within a second.
 */
export const log = {
  debug: write("debug"),
  info: write("info"),
  warn: write("warn"),
  error: write("error"),
};

/** The HTML shell a web applet returns: an empty root and the client bundle the entry serves at `/main.js`. */
export const page = (options: { title: string; script?: string }): Response =>
  new Response(
    [
      "<!doctype html>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${options.title}</title>`,
      '<div id="app"></div>',
      `<script type="module" src="${options.script ?? "/main.js"}"></script>`,
      "",
    ].join("\n"),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
