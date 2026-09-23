/** The bundler's bindings. */
declare global {
  namespace Cloudflare {
    interface Env {
      readonly DEPS: R2Bucket;
    }
  }
}

export {};
