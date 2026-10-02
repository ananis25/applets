import { bindings, defineConfig } from "cf/config";

/**
 * The bundler: esbuild-wasm plus an npm installer, reached by the router over
 * a service binding. One R2 bucket caches installed dependency sets. No ingress
 * of its own. Deployed together with the router by `vp run deploy`, never alone.
 */
export default defineConfig({
  worker: {
    name: "applets-bundler",
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    // reached only over the router's service binding, so no public URL of its own
    workersDev: false,
    previewUrls: false,
    // A cold npm install runs past the 30 second default.
    limits: { cpuMs: 60000 },
    env: {
      DEPS: bindings.r2({ name: "applets-deps" }),
    },
  },
});
