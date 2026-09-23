/** The router config `vp run deploy` writes for wrangler. */
import { expect, test } from "vite-plus/test";

import { routerConfig } from "./platform.ts";

const committed = `// a comment, as the committed config has
{
  "name": "applets-router",
  "d1_databases": [{ "binding": "REGISTRY", "database_name": "applets-registry" }],
}
`;

test("the deployed config gains the wildcard route, the zone and the registry's id, and no vars", () => {
  const written = routerConfig(committed, ".example.test", "0000-id");

  expect(written).toContain(
    '"routes": [{"pattern":"*.example.test/*","zone_name":"example.test"}]',
  );
  expect(written).toContain('"database_name": "applets-registry", "database_id": "0000-id"');
  expect(written).not.toContain('"vars"');
  expect(written.trimEnd().endsWith("}")).toBe(true);
});
