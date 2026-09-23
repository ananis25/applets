import { readFileSync } from "node:fs";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { ui } from "@applets/ui/vite";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

/**
 * `vp dev` serves the page from localhost and proxies `/api/` to a router's
 * admin host with the admin token from `secrets.env`, so the page sees applets
 * without a session. Which router is `APPLET_HOST_SUFFIX`: `vp run dev` sets
 * `.localhost` for the local platform, and `vp run dev:remote` leaves it to
 * `secrets.env`, the deployed one. The live-preview origin is on the same suffix.
 *
 * `vp test` runs the page's tests in a headless Chromium through Vitest browser
 * mode, with `fetch` stubbed in each test, so no router is needed.
 */
function secrets(): Map<string, string> {
  const lines = readFileSync(new URL("../../secrets.env", import.meta.url), "utf8").split("\n");
  return new Map(
    lines
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
}

/**
 * Two pages: the editor at `/` and the sign-in page at `/auth`, both served by
 * the editor script. The sign-in page is a top-level `auth.html`, not
 * `auth/index.html`: the router forwards every sign-in path as `/auth`, and
 * the assets binding would redirect that to `/auth/` for a nested `index.html`.
 */
const build = {
  rollupOptions: {
    input: {
      editor: new URL("index.html", import.meta.url).pathname,
      auth: new URL("auth.html", import.meta.url).pathname,
    },
  },
};

/** File-based routes under `src/routes`, each page in its own chunk, so CodeMirror only loads with the code page. The plugin writes `routeTree.gen.ts` and must run before React's. */
const plugins = () => [tanstackRouter({ target: "react", autoCodeSplitting: true }), ...ui()];

const test = {
  include: ["src/**/*.test.tsx"],
  browser: {
    enabled: true,
    headless: true,
    provider: playwright(),
    instances: [{ browser: "chromium" as const }],
  },
};

export default defineConfig(({ command }) => {
  if (command === "build") return { plugins: plugins(), build, test };

  const env = secrets();
  const named = process.env.APPLET_HOST_SUFFIX ?? env.get("APPLET_HOST_SUFFIX") ?? ".localhost";
  const suffix = named === ".localhost" ? ".localhost:8787" : named;
  const scheme = suffix.startsWith(".localhost") ? "http" : "https";
  process.env.VITE_HOST_SUFFIX = suffix;

  return {
    plugins: plugins(),
    build,
    test,
    server: {
      proxy: {
        "/api": {
          target: `${scheme}://admin${suffix}`,
          changeOrigin: true,
          rewrite: (path) => path.slice("/api".length),
          headers: { Authorization: `Bearer ${env.get("ADMIN_TOKEN") ?? ""}` },
        },
      },
    },
  };
});
