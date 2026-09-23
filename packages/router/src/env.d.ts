/** The router's bindings and vars, and the shape of `ctx.exports`. */
import type { Bundler } from "./types.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly LOADER: WorkerLoader;
      readonly REGISTRY: D1Database;
      readonly APPLET_BLOBS: R2Bucket;
      readonly MAILER: SendEmail;
      readonly SUPERVISOR: DurableObjectNamespace<import("./supervisor.ts").Supervisor>;
      readonly BUNDLER: Bundler;
      readonly EDITOR: Fetcher;
      readonly ADMIN_TOKEN_HASH: string;
      readonly HOST_SUFFIX: string;
      readonly AUTH_URL: string;
      /** The MCP server's own URL, the OAuth resource its tokens are bound to; its hostname is the MCP host. */
      readonly MCP_URL: string;
      readonly BETTER_AUTH_SECRET: string;
      readonly EMAIL_FROM: string;
      readonly OWNER_EMAIL: string;
      readonly OPENROUTER_API_KEY: string;
      /** Only in the local platform's `.dev.vars`: the email every request is signed in as. */
      readonly DEV_USER?: string;
    }

    interface GlobalProps {
      mainModule: typeof import("./index.ts");
      durableNamespaces: "Supervisor";
    }
  }
}
