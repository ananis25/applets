import { defineWranglerConfig } from "wrangler/experimental-config";

/** What `cf` hands to wrangler, its bundler: where the built page is. */
export default defineWranglerConfig({
  types: { generate: false },
  assetsDirectory: "./dist",
});
