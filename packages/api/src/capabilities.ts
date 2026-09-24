/**
 * The capabilities a loaded applet receives, as `@std` calls them over RPC and
 * as the router's entrypoints implement them, plus the shapes that cross that
 * hop. Type-only and dependency-free on purpose: `@std` imports it as types,
 * so nothing here lands in an applet's bundle, and the router `implements` it,
 * so the two sides cannot drift apart.
 */
/// <reference types="@cloudflare/workers-types" />

export type Json =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

export type LogLevel = "debug" | "info" | "warn" | "error";

/** One line as `@std`'s `log` sends it. `request_id` is absent for a line written outside any run. */
export type LogEntry = {
  readonly level: LogLevel;
  readonly message: string;
  readonly data?: Json;
  readonly request_id?: string;
};

export type Logs = {
  write(entry: LogEntry): Promise<void>;
};

export type BlobList = { readonly keys: ReadonlyArray<string>; readonly truncated: boolean };

/** A stored value. Bytes, not a stream; streaming over RPC is a later improvement. */
export type BlobObject = { readonly body: ArrayBuffer; readonly contentType?: string };

/** Per-applet object storage; the router prefixes every key with the applet's name. */
export type Blobs = {
  get(key: string): Promise<BlobObject | null>;
  put(key: string, body: ArrayBuffer, contentType?: string): Promise<void>;
  list(prefix: string, limit: number): Promise<BlobList>;
  delete(key: string): Promise<void>;
};

/** What the supervisor hands `scheduled(event)`: the expression that fired and when. A manual run carries the applet's schedule, or "" when it has none. */
export type ScheduledEvent = {
  readonly cron: string;
  readonly scheduledTime: Date;
};

/** A received email as `inbox(message)` gets it. */
export type InboundEmail = {
  readonly id: string;
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly headers: Record<string, string>;
  readonly attachments: ReadonlyArray<{
    readonly id: string;
    readonly filename: string;
    readonly contentType: string;
    readonly size: number;
  }>;
};

export type OutboundEmail = {
  readonly to: string | ReadonlyArray<string>;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly replyTo?: string;
};

export type Attachment = { readonly body: ArrayBuffer; readonly contentType: string };

export type Email = {
  /** Sends one message; the id comes back, or the reason Cloudflare refused it. */
  send(message: OutboundEmail): Promise<string>;
  /** The bytes of one attachment of a message this applet received. */
  attachment(emailId: string, attachmentId: string): Promise<Attachment>;
};

export type ChatMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
};

/** An OpenAI chat completion request. Any other OpenAI or OpenRouter option passes through. */
export type ChatParams = {
  /** An OpenRouter model id. The router picks its default when this is left out. */
  readonly model?: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly [option: string]: Json | undefined;
};

export type AI = {
  /**
   * One chat completion. Throws when OpenRouter refuses it; with `stream: true` the body is the
   * event stream. `request_id` is the run making the call, so the router's line about it joins that run.
   */
  chat(params: ChatParams, request_id?: string): Promise<Response>;
};

/** The env the supervisor gives every loaded applet. */
export type AppletEnv = {
  readonly APPLET_NAME: string;
  readonly APPLET_VERSION: number;
  readonly AI: AI;
  readonly BLOBS: Blobs;
  readonly EMAIL: Email;
  readonly LOGS: Logs;
  readonly SECRETS: Record<string, string>;
};

/** A SQLite value as JSON can carry it: a BLOB travels as hex. */
export type Cell = string | number | null | { readonly blob: string };

/**
 * What the editor's storage pages and the MCP tools ask of an applet's own storage, answered inside
 * its facet. A `readonly` statement is rolled back if it wrote; `kv-put` takes the value as JSON text.
 */
export type Inspection =
  | { readonly kind: "sql"; readonly sql: string; readonly readonly?: boolean }
  | { readonly kind: "sql-batch"; readonly statements: ReadonlyArray<string> }
  | { readonly kind: "kv"; readonly prefix: string; readonly limit: number }
  | { readonly kind: "kv-get"; readonly key: string }
  | { readonly kind: "kv-put"; readonly key: string; readonly value: string }
  | { readonly kind: "kv-delete"; readonly key: string };

export type Statement = {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<Cell>>;
  readonly rowsWritten: number;
};

export type InspectionResult =
  | Statement
  | { readonly results: ReadonlyArray<Statement> }
  | { readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }> }
  | { readonly error: string };
