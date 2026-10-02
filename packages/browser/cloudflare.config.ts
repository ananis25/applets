import { bindings, defineConfig } from "cf/config";

/**
 * The browser: Puppeteer over Cloudflare's Browser Run binding, reached by the
 * router over a service binding. No ingress of its own. Deployed together with
 * the router by `vp run deploy`, never alone. `remote` only matters to local
 * dev, where the binding runs on the account.
 */
export default defineConfig({
  worker: {
    name: "applets-browser",
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    // reached only over the router's service binding, so no public URL of its own
    workersDev: false,
    previewUrls: false,
    env: {
      BROWSER: bindings.browser({ dev: { remote: true } }),
    },
  },
});
