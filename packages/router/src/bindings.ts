/**
 * The router's bindings as services, one live layer built from `env`. Each
 * service is the seam a test can stand in for: the vars, the editor script,
 * the supervisors, the bundler, the blobs bucket and the mailer. The registry
 * and Better Auth have their own modules.
 */
import { AppletFailed, BuildFailed, type Files } from "@applets/api";
import type {
  InboundEmail,
  Inspection,
  InspectionResult,
  OutboundEmail,
} from "@applets/api/capabilities";
import { Context, Effect, Layer, Schema } from "effect";

import { currentTrace } from "./tracing.ts";

import type { Built, ScheduleRun, Sender, Target } from "./types.ts";

/** The router's vars and secrets. */
export class Vars extends Context.Service<
  Vars,
  Pick<
    Cloudflare.Env,
    | "HOST_SUFFIX"
    | "AUTH_URL"
    | "MCP_URL"
    | "OWNER_EMAIL"
    | "EMAIL_FROM"
    | "ADMIN_TOKEN_HASH"
    | "OPENROUTER_API_KEY"
    | "BETTER_AUTH_SECRET"
    | "DEV_USER"
  >
>()("applets/Vars") {}

/** The editor script: the page and its assets, reached over the service binding. */
export class Editor extends Context.Service<
  Editor,
  { readonly fetch: (request: Request) => Effect.Effect<Response> }
>()("applets/Editor") {}

/** One Supervisor per applet, addressed by the applet's id. A call that runs applet code fails with `AppletFailed` when that code throws. */
export class Supervisors extends Context.Service<
  Supervisors,
  {
    readonly fetch: (target: Target, request: Request) => Effect.Effect<Response, AppletFailed>;
    readonly run: (target: Target, kind: ScheduleRun) => Effect.Effect<void, AppletFailed>;
    readonly deliver: (target: Target, message: InboundEmail) => Effect.Effect<void, AppletFailed>;
    readonly inspect: (
      target: Target,
      call: Inspection,
    ) => Effect.Effect<InspectionResult, AppletFailed>;
    readonly setSchedule: (id: string, expression: string | null) => Effect.Effect<void>;
    readonly remove: (id: string) => Effect.Effect<void>;
  }
>()("applets/Supervisors") {}

/** The bundler script. A build the bundler refuses is a `BuildFailed` with its messages. */
export class Bundler extends Context.Service<
  Bundler,
  { readonly build: (files: Files, fresh: boolean) => Effect.Effect<Built, BuildFailed> }
>()("applets/Bundler") {}

/** The blobs bucket: applet blobs under `<applet id>/`, received attachments under `_email/<applet id>/`. */
export class Bucket extends Context.Service<
  Bucket,
  {
    readonly get: (key: string) => Effect.Effect<R2ObjectBody | null>;
    readonly put: (
      key: string,
      body: ArrayBuffer | ArrayBufferView | string,
      contentType?: string,
    ) => Effect.Effect<R2Object | null>;
    readonly list: (options: R2ListOptions) => Effect.Effect<R2Objects>;
    readonly delete: (keys: string | Array<string>) => Effect.Effect<void>;
    /** Every object under a prefix; `<applet id>/` is every blob that applet owns. */
    readonly removePrefix: (prefix: string) => Effect.Effect<void>;
  }
>()("applets/Bucket") {}

/** Cloudflare refused the message. */
export class MailFailed extends Schema.TaggedError<MailFailed>()("MailFailed", {
  message: Schema.String,
}) {}

/** Email through Cloudflare Email Service, the one send the magic link and applets share. Answers the message id. */
export class Mailer extends Context.Service<
  Mailer,
  { readonly send: (from: Sender, message: OutboundEmail) => Effect.Effect<string, MailFailed> }
>()("applets/Mailer") {}

const appletFailed = (cause: unknown) => new AppletFailed({ message: String(cause) });

/** Each call carries the caller's span, so the Supervisor's work joins the request's trace. */
const supervisors = (namespace: Cloudflare.Env["SUPERVISOR"]) =>
  Supervisors.of({
    fetch: (target, request) =>
      Effect.tryPromise({
        try: () => namespace.getByName(target.id).fetch(request),
        catch: appletFailed,
      }),
    run: (target, kind) =>
      currentTrace.pipe(
        Effect.flatMap((parent) =>
          Effect.tryPromise({
            try: () => namespace.getByName(target.id).run(target, kind, parent),
            catch: appletFailed,
          }),
        ),
      ),
    deliver: (target, message) =>
      currentTrace.pipe(
        Effect.flatMap((parent) =>
          Effect.tryPromise({
            try: () => namespace.getByName(target.id).deliver(target, message, parent),
            catch: appletFailed,
          }),
        ),
      ),
    // The stub types a union result as a union of promises, which only an `await` joins.
    inspect: (target, call) =>
      currentTrace.pipe(
        Effect.flatMap((parent) =>
          Effect.tryPromise({
            try: async () => namespace.getByName(target.id).inspect(target, call, parent),
            catch: appletFailed,
          }),
        ),
      ),
    setSchedule: (id, expression) =>
      currentTrace.pipe(
        Effect.flatMap((parent) =>
          Effect.promise(() => namespace.getByName(id).setSchedule(expression, parent)),
        ),
      ),
    remove: (id) =>
      currentTrace.pipe(
        Effect.flatMap((parent) => Effect.promise(() => namespace.getByName(id).remove(parent))),
      ),
  });

const bucket = (blobs: R2Bucket) =>
  Bucket.of({
    get: (key) => Effect.promise(() => blobs.get(key)),
    put: (key, body, contentType) =>
      Effect.promise(() =>
        blobs.put(key, body, {
          httpMetadata: contentType === undefined ? undefined : { contentType },
        }),
      ),
    list: (options) => Effect.promise(() => blobs.list(options)),
    delete: (keys) => Effect.promise(() => blobs.delete(keys)),
    removePrefix: (prefix) =>
      Effect.promise(async () => {
        for (;;) {
          const page = await blobs.list({ prefix });

          if (page.objects.length === 0) return;

          await blobs.delete(page.objects.map((object) => object.key));
        }
      }),
  });

const mailer = (send: SendEmail) =>
  Mailer.of({
    send: (from, message) =>
      Effect.tryPromise({
        try: async () => {
          const { messageId } = await send.send({
            from,
            to: [message.to].flat(),
            subject: message.subject,
            text: message.text,
            html: message.html,
            replyTo: message.replyTo,
          });

          return messageId;
        },
        catch: (cause) => new MailFailed({ message: String(cause) }),
      }),
  });

/** Every binding service over this isolate's `env`. */
export const bindings = (env: Cloudflare.Env) =>
  Layer.mergeAll(
    Layer.succeed(Vars, env),
    Layer.succeed(Editor, { fetch: (request) => Effect.promise(() => env.EDITOR.fetch(request)) }),
    Layer.succeed(Supervisors, supervisors(env.SUPERVISOR)),
    Layer.succeed(Bundler, {
      build: (files, fresh) =>
        Effect.promise(() => env.BUNDLER.build(files, fresh)).pipe(
          Effect.flatMap((build) =>
            "errors" in build
              ? Effect.fail(new BuildFailed({ errors: build.errors }))
              : Effect.succeed(build),
          ),
        ),
    }),
    Layer.succeed(Bucket, bucket(env.APPLET_BLOBS)),
    Layer.succeed(Mailer, mailer(env.MAILER)),
  );
