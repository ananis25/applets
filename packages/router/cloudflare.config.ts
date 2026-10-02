import { bindings, defineConfig, exports, triggers } from "cf/config";

import { localRegistryId, readSettings } from "../cli/src/config.ts";

/**
 * The router: ingress, auth, the admin API and one Supervisor Durable Object
 * per applet. The two host-specific values come in at deploy: the wildcard
 * route on the suffix's zone, only in `production` mode because local dev
 * rewrites the request host and the router routes by host, and the registry's
 * database id in `APPLETS_REGISTRY_ID`, which `vp run deploy` sets after
 * creating the database when the account has none. Without the id the deploy
 * would inherit one from the deployed router, which fails once that database
 * has been deleted. Local dev keys its simulated database by a fixed id.
 */
export default defineConfig(({ mode }) => {
  const suffix = readSettings().get("APPLET_HOST_SUFFIX") ?? ".localhost";
  const zone = suffix.slice(1);

  return {
    worker: {
      name: "applets-router",
      compatibilityDate: "2026-09-01",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "src/index.ts",
      observability: { logs: { enabled: true } },
      triggers: [
        // every 10 minutes, vacuums old rows
        triggers.scheduled({ schedule: "*/10 * * * *" }),
        ...(mode === "production" ? [triggers.fetch({ pattern: `*${suffix}/*`, zone })] : []),
      ],
      exports: {
        Supervisor: exports.durableObject({ storage: "sqlite" }),
      },
      env: {
        LOADER: bindings.workerLoader(),
        REGISTRY: bindings.d1({
          name: "applets-registry",
          id: process.env.APPLETS_REGISTRY_ID ?? localRegistryId,
        }),
        APPLET_BLOBS: bindings.r2({ name: "applets-blobs" }),
        MAILER: bindings.sendEmail({}),
        SUPERVISOR: bindings.durableObject({ worker: "applets-router", exportName: "Supervisor" }),
        BUNDLER: bindings.worker({ worker: "applets-bundler", exportName: "Bundler" }),
        BROWSER: bindings.worker({ worker: "applets-browser", exportName: "Browser" }),
        EDITOR: bindings.worker({ worker: "applets-editor" }),
      },
    },
  };
});
