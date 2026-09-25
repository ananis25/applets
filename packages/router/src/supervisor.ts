/**
 * One Supervisor per applet. It loads the applet's current bundle from the
 * registry, runs the applet's `App` class as the facet "app", swaps the facet
 * when the version changes while keeping the facet's storage, calls the
 * applet's `scheduled` export from its own alarm, and hands received mail to its `inbox`.
 */
import type { EgressMode, RequestKind } from "@applets/api";
import type {
  InboundEmail,
  Inspection,
  InspectionResult,
  ScheduledEvent,
} from "@applets/api/capabilities";
import { DurableObject } from "cloudflare:workers";
import { Effect, Option } from "effect";

import { Bucket } from "./bindings.ts";
import { nextRun } from "./cron.ts";
import { attachmentPrefix } from "./email.ts";
import { log } from "./platformLog.ts";
import { Registry } from "./registry.ts";
import { run } from "./runtime.ts";
import { traceHeaders, type TraceParent, under } from "./tracing.ts";
import {
  targetHeaders,
  targetOf,
  type AppletProps,
  type ScheduleRun,
  type Target,
} from "./types.ts";

export const compatibility = { date: "2026-09-01", flags: ["nodejs_compat"] };

/** Per request, far under the paid plan's defaults: a loop or a fetch fan-out in an applet ends early. */
const limits = { cpuMs: 10_000, subRequests: 100 };

/** Reads the target ingress stamped on the request, and strips it. */
function readTarget(request: Request) {
  const headers = new Headers(request.headers);
  const id = headers.get(targetHeaders.id) ?? "";
  const name = headers.get(targetHeaders.name) ?? "";
  const version = Number(headers.get(targetHeaders.version));
  const egress: EgressMode = headers.get(targetHeaders.egress) === "none" ? "none" : "open";
  const secrets = Number(headers.get(targetHeaders.secrets));

  for (const header of Object.values(targetHeaders)) headers.delete(header);

  for (const header of Object.values(traceHeaders)) headers.delete(header);

  return {
    target: { id, name, version, egress, secrets },
    request: new Request(request, { headers }),
  };
}

/** The applet's generated `App` class, as far as the supervisor calls it over RPC. `id` is the run's id, for the applet's log lines. */
declare class App extends DurableObject {
  scheduled(id: string, event: ScheduledEvent): Promise<void>;
  inbox(id: string, message: InboundEmail): Promise<void>;
  inspect(call: Inspection): InspectionResult;
}

export class Supervisor extends DurableObject<Cloudflare.Env> {
  fetch(incoming: Request): Promise<Response> {
    const traceId = incoming.headers.get(traceHeaders.traceId);
    const spanId = incoming.headers.get(traceHeaders.spanId);
    const parent = traceId === null || spanId === null ? undefined : { traceId, spanId };
    const { target, request } = readTarget(incoming);

    return this.traced("Supervisor.fetch", parent, async (span) =>
      (await this.facet(target, span)).fetch(request),
    );
  }

  /** Calls the applet's `scheduled` export with the expression that fired. Throws what the handler threw, once the run is recorded. */
  run(target: Target, kind: ScheduleRun, parent?: TraceParent): Promise<void> {
    return this.traced("Supervisor.run", parent, (span) => {
      const event: ScheduledEvent = { cron: this.expression() ?? "", scheduledTime: new Date() };

      return this.recorded(target, kind, span, (facet, id) => facet.scheduled(id, event));
    });
  }

  /** Hands a received message to the applet's `inbox` export. Throws what the handler threw, once the run is recorded. */
  deliver(target: Target, message: InboundEmail, parent?: TraceParent): Promise<void> {
    return this.traced("Supervisor.deliver", parent, (span) =>
      this.recorded(target, "email", span, (facet, id) => facet.inbox(id, message)),
    );
  }

  /** One run of a handler the supervisor calls itself, as a `requests` row: 200 when it returned, 500 with the error when it threw. */
  private async recorded(
    target: Target,
    kind: RequestKind,
    span: TraceParent,
    work: (facet: Fetcher<App>, id: string) => Promise<void>,
  ): Promise<void> {
    const started = Date.now();
    const request_id = crypto.randomUUID();
    let error: string | undefined;

    try {
      await work(await this.facet(target, span), request_id);
    } catch (cause) {
      error = String(cause);
      throw cause;
    } finally {
      this.ctx.waitUntil(
        run(
          this.env,
          this.ctx,
          Registry.use((db) =>
            db.writeRequest(target.id, {
              request_id,
              version: target.version,
              kind,
              method: "",
              path: "",
              status: error === undefined ? 200 : 500,
              error,
              duration_ms: Date.now() - started,
            }),
          ),
        ),
      );
    }
  }

  /**
   * Reads or changes the applet's own storage for its owner's storage pages. It runs inside the
   * facet because only the facet can reach its SQLite. A version bundled before `inspect` existed throws.
   */
  inspect(target: Target, call: Inspection, parent?: TraceParent): Promise<InspectionResult> {
    return this.traced("Supervisor.inspect", parent, async (span) =>
      (await this.facet(target, span)).inspect(call),
    );
  }

  /** Stores the schedule's cron expression and arms the alarm for its next occurrence, or disarms on null. */
  setSchedule(expression: string | null, parent?: TraceParent): Promise<void> {
    return this.traced("Supervisor.setSchedule", parent, () => {
      this.ctx.storage.kv.put("schedule", expression);

      return this.arm();
    });
  }

  async alarm(): Promise<void> {
    await this.arm();

    const id = this.appletId();

    const applet = await run(
      this.env,
      this.ctx,
      Registry.use((db) => db.getAppletById(id)),
    );

    const target = Option.isNone(applet) ? undefined : targetOf(applet.value);

    if (target === undefined) return;

    try {
      await this.run(target, "schedule");
    } catch (cause) {
      await run(
        this.env,
        this.ctx,
        Effect.all([
          Registry.use((db) =>
            db.writeLog(target.id, target.version, { level: "error", message: String(cause) }),
          ),
          log.warn("schedule run failed", {
            applet: target.name,
            version: target.version,
            cause: String(cause),
          }),
        ]),
      );
    }
  }

  /** Drops the facet, its storage and the supervisor's own storage. */
  remove(parent?: TraceParent): Promise<void> {
    return this.traced("Supervisor.remove", parent, async (span) => {
      this.ctx.facets.delete("app");
      const id = this.appletId();
      await run(
        this.env,
        this.ctx,
        Bucket.use((bucket) =>
          Effect.all([bucket.removePrefix(`${id}/`), bucket.removePrefix(attachmentPrefix(id))]),
        ).pipe(under(span)),
      );
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    });
  }

  /** The supervisor is addressed by the applet's id. */
  private appletId(): string {
    return this.ctx.id.name ?? "";
  }

  /**
   * One RPC method as one span, under the caller's span when the call carried one. The work gets
   * this span to hand on: to the facet's cold load, and to any Effect it runs on a fresh fiber.
   */
  private traced<A>(
    name: string,
    parent: TraceParent | undefined,
    work: (span: TraceParent) => Promise<A>,
  ): Promise<A> {
    return run(
      this.env,
      this.ctx,
      Effect.currentSpan.pipe(
        Effect.flatMap(({ traceId, spanId }) =>
          Effect.tryPromise({ try: () => work({ traceId, spanId }), catch: (cause) => cause }),
        ),
        Effect.orDie,
        Effect.withSpan(name, { attributes: { applet: this.appletId() } }),
        under(parent),
      ),
    );
  }

  private expression(): string | null {
    return this.ctx.storage.kv.get<string | null>("schedule") ?? null;
  }

  private async arm(): Promise<void> {
    const expression = this.expression();
    const due = expression === null ? undefined : nextRun(expression, new Date());

    if (due === undefined) return this.ctx.storage.deleteAlarm();

    await this.ctx.storage.setAlarm(due);
  }

  private async facet(target: Target, parent?: TraceParent): Promise<Fetcher<App>> {
    const key = `${target.version}:${target.egress}:${target.secrets}:${target.name}`;
    const seen = this.ctx.storage.kv.get<string>("running");

    if (seen !== undefined && seen !== key) {
      this.ctx.facets.abort("app", "new version");
      await run(
        this.env,
        this.ctx,
        log
          .info("facet restarted", { applet: target.name, from: seen, to: key })
          .pipe(under(parent)),
      );
    }

    this.ctx.storage.kv.put("running", key);

    return this.ctx.facets.get<App>("app", async () => {
      const worker = await this.loadWorker(target, parent);

      return { class: worker.getDurableObjectClass<App>("App") };
    });
  }

  private async loadWorker(target: Target, parent?: TraceParent): Promise<WorkerStub> {
    const props: AppletProps = { id: target.id, name: target.name, version: target.version };

    // The key carries the egress mode, the secrets revision and the name: the loader caches by key,
    // and `globalOutbound` and `env` are fixed at load. The bundle and the secrets are read inside
    // the callback, so a load the loader already holds makes no D1 read.
    const key = `${target.id}@${target.version}:${target.egress}:${target.secrets}:${target.name}`;

    return this.env.LOADER.get(key, async () => {
      const started = Date.now();

      const load = Registry.use((db) =>
        Effect.all({
          bundle: db.getBundle(target.id, target.version),
          secrets: db.getSecrets(target.id),
        }),
      ).pipe(
        Effect.tap(() =>
          log.info("worker loaded", {
            applet: target.name,
            version: target.version,
            ms: Date.now() - started,
          }),
        ),
        Effect.withSpan("Supervisor.loadWorker"),
      );

      const { bundle, secrets } = await run(this.env, this.ctx, load.pipe(under(parent)));

      if (Option.isNone(bundle))
        throw new Error(`no version ${target.version} for applet ${target.name}`);

      return {
        compatibilityDate: compatibility.date,
        compatibilityFlags: compatibility.flags,
        limits,
        mainModule: "entry.js",
        modules: { "entry.js": bundle.value },
        env: {
          APPLET_NAME: target.name,
          APPLET_VERSION: target.version,
          AI: this.ctx.exports.AI({ props }),
          BLOBS: this.ctx.exports.Blobs({ props }),
          BROWSER: this.ctx.exports.Browser({ props }),
          EMAIL: this.ctx.exports.Email({ props }),
          LOGS: this.ctx.exports.Logs({ props }),
          SECRETS: secrets,
        },
        globalOutbound: target.egress === "none" ? null : this.ctx.exports.Egress({ props }),
      };
    });
  }
}
