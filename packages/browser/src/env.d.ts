/** The browser script's bindings and vars. */
declare global {
  namespace Cloudflare {
    interface Env {
      readonly BROWSER: Fetcher;
      /** A CDP WebSocket URL of another provider. Set, every page opens there instead of Browser Run. */
      readonly BROWSER_CDP_URL?: string;
    }
  }
}

export {};
