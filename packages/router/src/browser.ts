/**
 * The `Browser` capability a loaded applet receives: a headless browser, run by
 * the browser script over its service binding. Each call ends as one line in
 * the applet's log with the session, the URL where there is one and how long
 * it took, or what went wrong.
 */
import type {
  Browser as BrowserCapability,
  Json,
  LoadOptions,
  LogEntry,
  ScreenshotOptions,
} from "@applets/api/capabilities";
import { WorkerEntrypoint } from "cloudflare:workers";

import { Registry } from "./registry.ts";
import { run } from "./runtime.ts";
import type { AppletProps } from "./types.ts";

/** What `@std`'s `browser` calls from inside an applet. */
export class Browser
  extends WorkerEntrypoint<Cloudflare.Env, AppletProps>
  implements BrowserCapability
{
  open(url: string, options?: LoadOptions, request_id?: string): Promise<string> {
    return this.logged("browser open", { url }, request_id, () =>
      this.env.BROWSER.open(url, options),
    );
  }

  goto(session: string, url: string, options?: LoadOptions, request_id?: string): Promise<void> {
    return this.logged("browser goto", { session, url }, request_id, () =>
      this.env.BROWSER.goto(session, url, options),
    );
  }

  evaluate(session: string, script: string, request_id?: string): Promise<Json> {
    return this.logged("browser evaluate", { session }, request_id, () =>
      this.env.BROWSER.evaluate(session, script),
    );
  }

  screenshot(
    session: string,
    options?: ScreenshotOptions,
    request_id?: string,
  ): Promise<Uint8Array> {
    return this.logged("browser screenshot", { session }, request_id, () =>
      this.env.BROWSER.screenshot(session, options),
    );
  }

  close(session: string, request_id?: string): Promise<void> {
    return this.logged("browser close", { session }, request_id, () =>
      this.env.BROWSER.close(session),
    );
  }

  private async logged<T>(
    message: string,
    data: Record<string, string>,
    request_id: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();

    const write = (entry: LogEntry) =>
      run(
        this.env,
        this.ctx,
        Registry.use((db) =>
          db.writeLog(this.ctx.props.id, this.ctx.props.version, { ...entry, request_id }),
        ),
      );

    try {
      const result = await work();
      await write({ level: "info", message, data: { ...data, ms: Date.now() - started } });

      return result;
    } catch (cause) {
      await write({
        level: "error",
        message: `${message} failed`,
        data: { ...data, ms: Date.now() - started, error: String(cause) },
      });

      throw cause;
    }
  }
}
