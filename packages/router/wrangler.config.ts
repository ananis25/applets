import { defineWranglerConfig } from "wrangler/experimental-config";

/** What `cf` hands to wrangler, its bundler: `docs.ts` imports the docs as text for the MCP server's `help`. */
export default defineWranglerConfig({
  types: { generate: false },
  rules: [{ type: "Text", globs: ["**/*.md"], fallthrough: true }],
});
