import { bindings, defineConfig } from "cf/config";

/**
 * The editor: a static page that edits and deploys applet source. The entry
 * only serves assets; the router forwards the editor hostname to it over a
 * service binding and answers `/api/` there with the admin API. `vp run deploy`
 * runs the Vite build into `dist/`, named in `wrangler.config.ts`, and deploys
 * this together with the router.
 */
export default defineConfig({
  worker: {
    name: "applets-editor",
    compatibilityDate: "2026-09-01",
    entrypoint: "src/worker.ts",
    // reached only over the router's service binding, so no public URL of its own
    workersDev: false,
    previewUrls: false,
    // a missing path is answered by the worker: index.html for a deep link, 404 for a chunk that is gone
    assets: { notFoundHandling: "none" },
    env: {
      ASSETS: bindings.assets(),
    },
  },
});
