/**
 * The generated entry: wraps `main.ts` in the Durable Object class the supervisor runs as a facet.
 * `fetch` is served as the applet's HTTP handler; `scheduled` and `inbox` are RPC methods the
 * supervisor calls, and each throws when `main.ts` has no such export, which the supervisor records as a failed run.
 */

export const clientModule = "applet:client";

export function renderEntry(options: {
  std: string;
  client: boolean;
  handlers: ReadonlyArray<string>;
}): string {
  const missing = (name: string) => `throw new Error("main.ts has no ${name} export");`;

  const lines = [
    'import { DurableObject } from "cloudflare:workers";',
    `import { bind, call, handle, inspect, type Inspection, type InboundEmail, type ScheduledEvent } from "./${options.std}";`,
    options.client ? `import client from "${clientModule}";` : "",
    'import * as applet from "./main.ts";',
    "",
    "export class App extends DurableObject {",
    "  constructor(ctx: DurableObjectState, env: unknown) {",
    "    super(ctx, env);",
    "    bind(ctx);",
    "  }",
    "",
    "  async fetch(request: Request): Promise<Response> {",
  ];

  if (options.client) {
    lines.push(
      '    if (new URL(request.url).pathname === "/main.js") {',
      '      return new Response(client, { headers: { "content-type": "text/javascript; charset=utf-8" } });',
      "    }",
    );
  }

  lines.push(
    "    return handle(request, applet.fetch);",
    "  }",
    "",
    "  scheduled(id: string, event: ScheduledEvent): Promise<void> {",
    options.handlers.includes("scheduled")
      ? "    return call(id, () => applet.scheduled(event));"
      : `    ${missing("scheduled")}`,
    "  }",
    "",
    "  inbox(id: string, message: InboundEmail): Promise<void> {",
    options.handlers.includes("inbox")
      ? "    return call(id, () => applet.inbox(message));"
      : `    ${missing("inbox")}`,
    "  }",
    "",
    "  inspect(inspection: Inspection) {",
    "    return inspect(inspection);",
    "  }",
    "}",
    "",
  );

  return lines.join("\n");
}
