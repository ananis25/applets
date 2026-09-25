/** The browser script's binding. */
declare global {
  namespace Cloudflare {
    interface Env {
      readonly BROWSER: Fetcher;
    }
  }
}

export {};
