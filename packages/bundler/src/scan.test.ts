/** What the scanner reads out of applet source, and what it leaves alone. */
import { expect, test } from "vite-plus/test";

import { rewriteSpecifiers, scan } from "./scan.ts";

const main = (body: string) => ({ "main.ts": `${body}\nexport function fetch() {}\n` });

test("npm specifiers become the dependency map, across one-line, multi-line and side-effect imports", () => {
  const scanned = scan(
    main(
      [
        'import { z } from "npm:zod@3";',
        "import {",
        "  Hono,",
        '} from "npm:hono@^4/tiny";',
        'import "npm:@scope/polyfill";',
        'export { nanoid } from "npm:nanoid@5";',
      ].join("\n"),
    ),
  );

  expect(scanned).toMatchObject({
    dependencies: { zod: "3", hono: "^4", "@scope/polyfill": "*", nanoid: "5" },
  });
});

test("import-looking text in a comment, a string or a dynamic import is not scanned", () => {
  const scanned = scan(
    main(
      [
        '// import("left-pad")',
        "const text = \"see import x from 'lodash'\";",
        'const lazy = () => import("whatever");',
      ].join("\n"),
    ),
  );

  expect(scanned).toMatchObject({ dependencies: {} });
});

test("the lexer ignores static imports inside block comments", () => {
  const source = '/*\nimport "lodash";\n*/';
  const scanned = scan(main(source));

  expect(scanned).toMatchObject({ dependencies: {} });
  expect(rewriteSpecifiers("main.ts", source, "applet-std.ts")).toBe(source);
});

test("TSX keeps static npm imports through the JSX fallback", () => {
  const files = {
    ...main(""),
    "client/main.tsx": 'import { h } from "npm:preact@10";\nexport const view = <div />;',
  };

  expect(scan(files)).toMatchObject({ dependencies: { preact: "10" } });
  expect(rewriteSpecifiers("client/main.tsx", files["client/main.tsx"], "applet-std.ts")).toContain(
    'from "preact"',
  );
});

test("a bare specifier, a URL import and two ranges of one package are errors that name the file", () => {
  const scanned = scan({
    ...main(
      'import a from "lodash";\nimport b from "https://esm.sh/x";\nimport c from "npm:zod@3";',
    ),
    "shared/util.ts": 'import { z } from "npm:zod@4";',
  });

  expect(scanned).toEqual({
    errors: [
      expect.stringMatching(/^main\.ts: .*"lodash" must carry the "npm:" prefix/),
      expect.stringMatching(/^main\.ts: URL import/),
      expect.stringMatching(/^shared\/util\.ts: .*"zod@4" but "3" is already required/),
    ],
  });
});

test("the client rules: no @std in client/, no client/ import from the server", () => {
  const scanned = scan({
    ...main('import "./client/main.tsx";'),
    "client/main.tsx": 'import { sql } from "@std";',
  });

  expect(scanned).toEqual({
    errors: [
      expect.stringMatching(/^main\.ts: server code/),
      expect.stringMatching(/^client\/main\.tsx: client code/),
    ],
  });
});

test("the trigger handlers are read from main.ts as exports", () => {
  expect(
    scan(main("export function scheduled() {}\nexport async function inbox() {}")),
  ).toMatchObject({ exports: expect.arrayContaining(["fetch", "scheduled", "inbox"]) });
});

test("rewriting strips the npm prefix and range, and points @std at the bundled copy", () => {
  const text = 'import { z } from "npm:zod@3/v4";\nimport { sql } from "@std";\n';

  expect(rewriteSpecifiers("shared/db.ts", text, "applet-std.ts")).toBe(
    'import { z } from "zod/v4";\nimport { sql } from "../applet-std.ts";\n',
  );
});
