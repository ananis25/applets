/**
 * The editor page against a stubbed admin API: open an applet, edit, save,
 * deploy, switch pages, roll back. `fetch` is replaced per test with a small
 * table of responses; a question the page asks is answered by clicking in its dialog.
 */
import { render } from "vitest-browser-react";
import { z } from "zod";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { RequestEntry, SqlResult } from "@applets/api";
import { App } from "./app.tsx";
import { dumpSql } from "./editor/dump.ts";
import { zip } from "./editor/zip.ts";
import { closeEditor, updateFile, useStore } from "./store.ts";
import "./styles.css";

type Handler = (body: string) => object | Error | Promise<object | Error>;

/** A refusal in the contract's shape: the tag names the error, the status is its own. */
type Refusal =
  | { readonly _tag: "BadRequest" | "NotFound"; readonly message: string }
  | { readonly _tag: "BuildFailed"; readonly errors: ReadonlyArray<string> };

const refuse = (status: number, body: Refusal) => Response.json(body, { status });

const row = {
  id: "019972c0-0000-7000-8000-000000000001",
  name: "hello",
  owner: "owner@example.com",
  description: "says hello",
  visibility: "private",
  egress: "open",
  schedule: null,
  email: 0,
  current_version: 2,
  secrets_rev: 0,
  created_at: "2026-09-16T10:00:00Z",
  updated_at: "2026-09-16T10:00:00Z",
};

/** Newest first, the order the registry lists them in. */
const version = { applet: "hello", exports: '["fetch"]' };

const versions = [
  {
    ...version,
    id: 2,
    created_at: "2026-09-16T10:00:00Z",
    installed: '["preact@10.27.0"]',
    changed: '[{"path":"main.ts","change":"changed"}]',
  },
  {
    ...version,
    id: 1,
    created_at: "2026-09-16T09:00:00Z",
    installed: "[]",
    changed: '[{"path":"main.ts","change":"added"}]',
  },
];

const source = {
  "main.ts": "export function fetch() {}\n",
  "shared/util.ts": "export const x = 1;\n",
};

/** Another user's applet, as the admin's list carries it. */
const theirs = {
  ...row,
  name: "weather",
  owner: "friend@example.com",
  description: "",
  failures: 0,
};

const session = {
  id: "a",
  created_at: "2026-09-20T10:00:00Z",
  expires_at: "2026-10-20T10:00:00Z",
  user_agent: "Chrome on a laptop",
  ip: "203.0.113.7",
  current: false,
};

/** Every route the tests touch, sharing one "current version" the way the registry would. */
function routes(): Map<string, Handler> {
  let current = 2;
  const applet = () => ({ ...row, current_version: current });

  return new Map<string, Handler>([
    ["GET /api/applets", () => ({ applets: [{ ...applet(), failures: 2 }, theirs] })],
    ["GET /api/emails/unclaimed?limit=50", () => ({ emails: [] })],
    ["GET /api/me", () => ({ email: "owner@example.com", role: "user" })],
    ["GET /api/keys", () => ({ keys: [] })],
    ["GET /api/applets/hello", () => ({ applet: applet(), versions })],
    ["GET /api/applets/hello/draft", () => ({ files: null, updated_at: null })],
    ["GET /api/applets/hello/source", () => ({ version: current, files: source })],
    ["PUT /api/applets/hello/draft", () => ({ updated_at: new Date().toISOString() })],
    [
      "PUT /api/applets/hello/versions",
      () => {
        current = 3;

        return { version: 3, exports: ["fetch"], installed: [] };
      },
    ],
    [
      "PATCH /api/applets/hello",
      (body) => {
        current = z.object({ current_version: z.number() }).parse(JSON.parse(body)).current_version;

        return { applet: applet() };
      },
    ],
  ]);
}

const calls: { key: string; body: string }[] = [];

/** Replace `fetch` with the table; an unknown route fails loudly, an `Error` handler answers a 400 `BadRequest`, and a `Response` goes out as it is. */
function serve(table: Map<string, Handler>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const key = `${request.method} ${request.url.replace(location.origin, "")}`;
    const handler = table.get(key);

    if (!handler) throw new Error(`unstubbed request: ${key}`);
    const body = await request.text();
    calls.push({ key, body });
    const result = await handler(body);

    if (result instanceof Response) return result;

    if (result instanceof Error) {
      return refuse(400, { _tag: "BadRequest", message: result.message });
    }

    return Response.json(result);
  });
}

/** A full-height mount point, as `index.html` gives the page; the tree is virtualised and needs height. */
function root(): HTMLElement {
  const element = document.createElement("div");
  element.id = "root";
  element.className = "isolate";
  document.body.appendChild(element);

  return element;
}

/** The state pill in the top bar; the status line repeats its text, so take the first. */
const pill = (text: string | RegExp) => page.getByText(text).first();

/** The status line under the code pane. */
const status = (text: string | RegExp) => page.getByText(text, { exact: false }).last();

/** Says yes in the open question dialog, whatever its action is called. */
const agree = () =>
  page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(?!Cancel).+/ })
    .click();

const tab = (name: string) => page.getByRole("tab", { name, exact: true }).first();

/** Moves the browser to `path` the way the back button does; the router follows `popstate`. */
function navigate(path: string) {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

async function openAt(path: string, table = routes()) {
  serve(table);
  history.replaceState(null, "", path);
  await render(<App />, { container: root() });
}

async function openHello(table = routes()) {
  await openAt("/applets/hello/code", table);
  await expect.element(pill(/v2 · deployed/)).toBeVisible();
}

beforeEach(async () => {
  await page.viewport(1280, 800);
  calls.length = 0;
  localStorage.clear();
});

afterEach(() => {
  closeEditor();
  vi.restoreAllMocks();
  document.getElementById("root")?.remove();
});

test("opens an applet on main.ts with its files in the tree", async () => {
  await openHello();

  await expect.element(tab("main.ts")).toBeVisible();
  expect(useStore.getState().activeFile).toBe("main.ts");
  await expect.element(page.getByRole("treeitem", { name: /main\.ts/ })).toBeVisible();
  await expect.element(page.getByRole("treeitem", { name: /util\.ts/ })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("an edit enables Save, and saving stores a draft", async () => {
  await openHello();

  updateFile("main.ts", "export function fetch() { return new Response('hi'); }\n");
  await expect.element(status(/● unsaved/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save" })).toBeEnabled();

  await page.getByRole("button", { name: "Save" }).click();
  await expect.element(status("draft saved")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();

  const save = calls.find((call) => call.key === "PUT /api/applets/hello/draft");
  expect(JSON.parse(save?.body ?? "")).toEqual({
    files: { ...source, "main.ts": "export function fetch() { return new Response('hi'); }\n" },
  });
});

test("Ctrl+S saves the draft", async () => {
  await openHello();
  updateFile("main.ts", "// changed\n");

  await userEvent.keyboard("{Control>}s{/Control}");

  await expect.element(status("draft saved")).toBeVisible();
});

test("a deploy makes a new version current and clears the draft", async () => {
  await openHello();
  updateFile("main.ts", "// v3\n");

  await page.getByRole("button", { name: "Deploy" }).click();

  await expect.element(status(/v3 deployed/)).toBeVisible();
  await expect.element(pill(/v3 · deployed/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("a failed deploy lists the bundler's errors and keeps the version", async () => {
  const table = routes();
  table.set("PUT /api/applets/hello/versions", () =>
    refuse(422, {
      _tag: "BuildFailed",
      errors: ["main.ts: bare import 'zod' needs the npm: prefix", "main.ts: no fetch export"],
    }),
  );
  await openHello(table);

  await page.getByRole("button", { name: "Deploy" }).click();

  await expect.element(page.getByText("Problems")).toBeVisible();
  await expect.element(page.getByText(/bare import 'zod'/)).toBeVisible();
  await expect.element(page.getByText(/no fetch export/)).toBeVisible();
  await expect.element(status("deploy failed")).toBeVisible();
  await expect.element(pill(/v2 · deployed/)).toBeVisible();

  await page.getByRole("button", { name: "clear" }).click();
  await expect.element(page.getByText("Problems")).not.toBeInTheDocument();
});

test("the rail switches pages and Versions marks the current one", async () => {
  await openHello();

  await page.getByRole("link", { name: "Versions" }).click();

  await expect.element(page.getByText("v1", { exact: true })).toBeVisible();
  await expect.element(page.getByText("current", { exact: true })).toBeVisible();
  const rollbacks = page.getByRole("button", { name: "rollback" });
  await expect.element(rollbacks.nth(0)).toBeDisabled();
  await expect.element(rollbacks.nth(1)).toBeEnabled();

  await page.getByRole("link", { name: "Code" }).click();
  await expect.element(tab("main.ts")).toBeVisible();
});

test("the Logs page nests each run's lines under its request", async () => {
  const line = {
    applet: "hello",
    version: 2,
    level: "info",
    data: null,
    at: "2026-09-21T10:00:00.000Z",
  };

  const table = routes();
  table.set("GET /api/applets/hello/logs?version=2&limit=50", () => ({
    logs: [
      { ...line, id: 1, message: "fetching weather", request_id: "run-a" },
      { ...line, id: 2, message: "woke up alone", request_id: null },
      { ...line, id: 3, message: "stored 3 rows", request_id: "run-a" },
    ],
  }));
  table.set("GET /api/applets/hello/logs?version=2&after=3&limit=50", () => ({ logs: [] }));
  table.set("GET /api/applets/hello/requests?version=2&limit=50", () => ({
    requests: [
      {
        id: 7,
        request_id: "run-a",
        applet: "hello",
        version: 2,
        kind: "http",
        method: "GET",
        path: "/forecast",
        status: 200,
        error: null,
        duration_ms: 12,
        at: line.at,
      },
    ],
  }));
  table.set("GET /api/applets/hello/requests?version=2&after=7&limit=50", () => ({ requests: [] }));
  await openAt("/applets/hello/logs", table);

  await expect.element(page.getByText("stored 3 rows")).toBeVisible();
  await expect.element(page.getByText("/forecast")).toBeVisible();
  const run = page.getByText("/forecast").element().parentElement?.parentElement;
  expect(run?.textContent).toContain("fetching weather");
  expect(run?.textContent).toContain("stored 3 rows");
  expect(run?.textContent).not.toContain("woke up alone");
});

test("the Requests page charts the last day, and the last week on request", async () => {
  const hour = (ago: number) => new Date(Date.now() - ago * 3_600_000).toISOString();
  const table = routes();
  table.set("GET /api/applets/hello/requests?version=2&limit=50", () => ({ requests: [] }));
  table.set("GET /api/applets/hello/traffic", () => ({
    hours: [
      { hour: hour(72), total: 5, failed: 0 },
      { hour: hour(1), total: 3, failed: 1 },
    ],
  }));
  await openAt("/applets/hello/requests", table);

  await expect.element(page.getByText("3 requests · 1 failed")).toBeVisible();
  await page.getByRole("button", { name: "7d" }).click();
  await expect.element(page.getByText("8 requests · 1 failed")).toBeVisible();
});

test("rollback patches the current version", async () => {
  await openHello();
  await page.getByRole("link", { name: "Versions" }).click();

  await page.getByRole("button", { name: "rollback" }).nth(1).click();
  await agree();

  await expect.element(pill(/v1 · rolled back/)).toBeVisible();
  const patch = calls.find((call) => call.key === "PATCH /api/applets/hello");
  expect(JSON.parse(patch?.body ?? "")).toEqual({ current_version: 1 });
  await expect.element(page.getByText(/rolled back/).first()).toBeVisible();
});

test("viewing an older version is read only and can return to current", async () => {
  const table = routes();
  table.set("GET /api/applets/hello/source?version=1", () => ({
    version: 1,
    files: { "main.ts": "// v1\n" },
  }));
  await openHello(table);
  await page.getByRole("link", { name: "Versions" }).click();

  await page.getByRole("button", { name: "view" }).nth(1).click();

  await expect.element(pill(/viewing v1/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Deploy" })).toBeDisabled();
  expect(useStore.getState().files.get("main.ts")).toBe("// v1\n");

  await page.getByRole("button", { name: "back to current" }).click();
  await expect.element(pill(/v2 · deployed/)).toBeVisible();
  await vi.waitFor(() => expect(useStore.getState().files.get("main.ts")).toBe(source["main.ts"]));
});

test("a deep link opens that page of the applet, and the rail moves the URL", async () => {
  await openAt("/applets/hello/versions");

  await expect.element(page.getByText("current", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Code" }).click();
  await expect.element(tab("main.ts")).toBeVisible();
  expect(location.pathname).toBe("/applets/hello/code");

  history.back();
  await expect.element(page.getByText("current", { exact: true })).toBeVisible();
});

test("a late applet load cannot replace the applet now in the URL", async () => {
  const table = routes();

  type AppletPage = { applet: typeof row; versions: typeof versions };

  let release!: (value: AppletPage) => void;

  const slow = new Promise<AppletPage>((resolve) => {
    release = resolve;
  });

  table.set("GET /api/applets/slow", () => slow);
  await openAt("/applets", table);

  navigate("/applets/slow/code");
  await vi.waitFor(() =>
    expect(calls.some((call) => call.key === "GET /api/applets/slow")).toBe(true),
  );
  navigate("/applets/hello/code");
  await expect.element(tab("main.ts")).toBeVisible();

  release({ applet: { ...row, name: "slow" }, versions });
  await slow;
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(location.pathname).toBe("/applets/hello/code");
  expect(useStore.getState().applet).toBe("hello");
  await expect.element(tab("main.ts")).toBeVisible();
});

test("the applets page links to an applet, and unsaved edits survive a visit to it", async () => {
  await openAt("/applets");

  await page.getByRole("link", { name: /hello/ }).click();
  await expect.element(tab("main.ts")).toBeVisible();
  updateFile("main.ts", "// kept\n");

  await page.getByRole("link", { name: "applets", exact: true }).click();
  await expect.element(page.getByRole("link", { name: "Home" })).toBeVisible();

  await page.getByRole("link", { name: /hello/ }).click();
  await expect.element(status(/● unsaved/)).toBeVisible();
  expect(useStore.getState().files.get("main.ts")).toBe("// kept\n");
});

test("an applet that does not open says why, inside the shell", async () => {
  const table = routes();
  table.set("GET /api/applets/nope", () =>
    refuse(404, { _tag: "NotFound", message: "no applet nope" }),
  );
  await openAt("/applets/nope/code", table);

  await expect.element(page.getByText(/Can't open "nope"/)).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Home" })).toBeVisible();
});

test("home shows the user's own applets as cards, with an error dot for failed runs", async () => {
  await openAt("/");

  await expect.element(page.getByRole("link", { name: /hello/ })).toBeVisible();
  await expect.element(page.getByText("says hello")).toBeVisible();
  await expect.element(page.getByLabelText("2 failed runs in the last 24 hours")).toBeVisible();
  await expect.element(page.getByText(/v2 · updated/)).toBeVisible();
  await expect.element(page.getByText("weather")).not.toBeInTheDocument();
});

test("the applets page searches, and another user's applet does not open", async () => {
  await openAt("/applets");

  await expect.element(page.getByText("friend@example.com")).toBeVisible();
  await expect.element(page.getByRole("link", { name: /weather/ })).not.toBeInTheDocument();

  await page.getByPlaceholder(/Search/).fill("says");
  await expect.element(page.getByText("weather")).not.toBeInTheDocument();
  await expect.element(page.getByRole("link", { name: /hello/ })).toBeVisible();
});

test("the admin must type another applet's name to remove it", async () => {
  const table = routes();
  let applets = [theirs];
  table.set("GET /api/me", () => ({ email: row.owner, role: "admin" }));
  table.set("GET /api/applets", () => ({ applets }));
  table.set("DELETE /api/applets/weather", () => {
    applets = [];

    return { ok: true };
  });
  await openAt("/applets", table);

  await page.getByRole("button", { name: "remove" }).click();
  const typed = page.getByRole("alertdialog").getByRole("textbox");
  await typed.fill("wrong");
  await expect.element(page.getByRole("button", { name: "Delete" })).toBeDisabled();
  expect(calls.some((call) => call.key === "DELETE /api/applets/weather")).toBe(false);

  await typed.fill("weather");
  await agree();
  await vi.waitFor(() =>
    expect(calls.some((call) => call.key === "DELETE /api/applets/weather")).toBe(true),
  );
  await expect.element(page.getByText("weather")).not.toBeInTheDocument();
});

test("New applet deploys the template and opens the editor on it", async () => {
  const table = routes();
  table.set("PUT /api/applets/fresh/versions", () => ({ version: 1, exports: [], installed: [] }));
  table.set("GET /api/applets/fresh", () => ({ applet: { ...row, name: "fresh" }, versions: [] }));
  table.set("GET /api/applets/fresh/draft", () => ({ files: null, updated_at: null }));
  table.set("GET /api/applets/fresh/source", () => ({ version: 2, files: source }));
  await openAt("/", table);

  await page.getByRole("button", { name: "New applet" }).click();
  await page.getByPlaceholder("new-applet-name").fill("fresh");
  await page.getByRole("button", { name: "Create" }).click();

  await expect.element(tab("main.ts")).toBeVisible();
  expect(location.pathname).toBe("/applets/fresh/code");
});

/** Answers a SQL call with the first canned result whose key the statement contains. */
const sqlAnswer = <Result,>(answers: Map<string, Result>, sql: string): Result | Error =>
  answers.entries().find(([part]) => sql.includes(part))?.[1] ??
  new Error(`unexpected sql: ${sql}`);

test("the SQLite page lists tables, runs a query and shows a refused statement's error", async () => {
  const table = routes();

  const answers = new Map<string, object | Error>([
    ["sqlite_master", { columns: [], rows: [["hits", "CREATE TABLE hits (id)"]], rowsWritten: 0 }],
    ["COUNT(*)", { columns: ["COUNT(*)"], rows: [[3]], rowsWritten: 0 }],
    [
      'SELECT * FROM "hits"',
      { columns: ["id"], rows: [[1], [null], [{ blob: "beef" }]], rowsWritten: 0 },
    ],
    ["SELECT nope", new Error("no such column: nope")],
  ]);

  table.set("POST /api/applets/hello/sql", (body) =>
    sqlAnswer(answers, z.object({ sql: z.string() }).parse(JSON.parse(body)).sql),
  );
  await openAt("/applets/hello/sqlite", table);

  await page.getByRole("button", { name: /hits/ }).click();
  await expect.element(page.getByText("x'beef'")).toBeVisible();
  await expect.element(page.getByText("3 rows · 0 written")).toBeVisible();

  await page.getByLabelText("SQL").fill("SELECT nope");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect.element(page.getByText("no such column: nope")).toBeVisible();
});

test("a dump rebuilds the tables with their rows, then the indexes", async () => {
  const answers = new Map<string, SqlResult>([
    ["type = 'table'", { columns: [], rows: [["t", "CREATE TABLE t (a, b)"]], rowsWritten: 0 }],
    ["COUNT(*)", { columns: [], rows: [[2]], rowsWritten: 0 }],
    [
      'SELECT * FROM "t"',
      {
        columns: [],
        rows: [
          [1, "it's"],
          [null, { blob: "00ff" }],
        ],
        rowsWritten: 0,
      },
    ],
    ["type != 'table'", { columns: [], rows: [["i", "CREATE INDEX i ON t (a)"]], rowsWritten: 0 }],
  ]);

  const text = await dumpSql(async (sql) => {
    const answer = sqlAnswer(answers, sql);

    if (answer instanceof Error) throw answer;

    return answer;
  });

  expect(text).toBe(
    [
      "CREATE TABLE t (a, b);",
      `INSERT INTO "t" VALUES (1, 'it''s');`,
      `INSERT INTO "t" VALUES (NULL, X'00ff');`,
      "CREATE INDEX i ON t (a);",
      "",
    ].join("\n"),
  );
});

test("the KV and Blobs pages list the applet's storage and delete from it", async () => {
  const table = routes();
  let keys = [{ key: "cursor", value: '{"page":3}' }];
  table.set("GET /api/applets/hello/kv?prefix=", () => ({ entries: keys }));
  table.set("DELETE /api/applets/hello/kv?key=cursor", () => {
    keys = [];

    return { ok: true };
  });
  table.set("GET /api/applets/hello/blobs?prefix=", () => ({
    blobs: [
      { key: "notes/a.txt", size: 2048, content_type: "text/plain", uploaded_at: row.updated_at },
    ],
    cursor: null,
  }));
  await openAt("/applets/hello/kv", table);

  await expect.element(page.getByText('{"page":3}')).toBeVisible();
  await page.getByRole("button", { name: "delete" }).click();
  await agree();
  await expect.element(page.getByText("No keys.")).toBeVisible();

  await page.getByRole("link", { name: "Blobs" }).click();
  await expect.element(page.getByText("2.0 KB")).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "notes/a.txt" }))
    .toHaveAttribute("href", "/api/applets/hello/blob?key=notes%2Fa.txt");

  table.set("PUT /api/applets/hello/blob?key=notes%2Fb.txt&content_type=text%2Fplain", (body) => {
    expect(body).toBe("hi");

    return { ok: true };
  });
  await page.getByLabelText("Key prefix").fill("notes/");
  table.set("GET /api/applets/hello/blobs?prefix=notes%2F", () => ({
    blobs: [
      { key: "notes/a.txt", size: 2048, content_type: "text/plain", uploaded_at: row.updated_at },
      { key: "notes/b.txt", size: 2, content_type: "text/plain", uploaded_at: row.updated_at },
    ],
    cursor: null,
  }));
  await expect.element(page.getByRole("button", { name: "upload" })).toBeVisible();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');

  if (input === null) throw new Error("no file input");
  const transfer = new DataTransfer();
  transfer.items.add(new File(["hi"], "b.txt", { type: "text/plain" }));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.element(page.getByRole("link", { name: "notes/b.txt" })).toBeVisible();
});

test("late storage responses do not replace a new key prefix", async () => {
  const table = routes();
  let releaseKv!: () => void;
  let releaseBlobs!: () => void;

  const oldKv = new Promise<{ entries: Array<{ key: string; value: string }> }>((resolve) => {
    releaseKv = () => resolve({ entries: [{ key: "old-key", value: "1" }] });
  });

  const oldBlobs = new Promise<{
    blobs: Array<{ key: string; size: number; content_type: string; uploaded_at: string }>;
    cursor: null;
  }>((resolve) => {
    releaseBlobs = () =>
      resolve({
        blobs: [
          { key: "old-blob", size: 1, content_type: "text/plain", uploaded_at: row.updated_at },
        ],
        cursor: null,
      });
  });

  table.set("GET /api/applets/hello/kv?prefix=", () => oldKv);
  table.set("GET /api/applets/hello/kv?prefix=new", () => ({
    entries: [{ key: "new-key", value: "2" }],
  }));
  table.set("GET /api/applets/hello/blobs?prefix=", () => oldBlobs);
  table.set("GET /api/applets/hello/blobs?prefix=new", () => ({
    blobs: [{ key: "new-blob", size: 2, content_type: "text/plain", uploaded_at: row.updated_at }],
    cursor: null,
  }));
  await openAt("/applets/hello/kv", table);
  await vi.waitFor(() =>
    expect(calls.some((call) => call.key === "GET /api/applets/hello/kv?prefix=")).toBe(true),
  );

  await page.getByLabelText("Key prefix").fill("new");
  await expect.element(page.getByText("new-key")).toBeVisible();
  releaseKv();
  await oldKv;
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect.element(page.getByText("old-key")).not.toBeInTheDocument();

  await page.getByRole("link", { name: "Blobs" }).click();
  await vi.waitFor(() =>
    expect(calls.some((call) => call.key === "GET /api/applets/hello/blobs?prefix=")).toBe(true),
  );
  await page.getByLabelText("Key prefix").fill("new");
  await expect.element(page.getByText("new-blob")).toBeVisible();
  releaseBlobs();
  await oldBlobs;
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect.element(page.getByText("old-blob")).not.toBeInTheDocument();
});

test("applet settings re-resolve dependencies, download the source, and remove behind the typed name", async () => {
  const table = routes();
  const deploy = table.get("PUT /api/applets/hello/versions");

  if (deploy) table.set("PUT /api/applets/hello/versions?fresh=true", deploy);

  table.set("GET /api/applets/hello/source?version=3", () => ({ version: 3, files: source }));
  table.set("DELETE /api/applets/hello", () => ({ ok: true }));
  const saved: Array<string> = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      saved.push(this.download);
    },
  );
  await openAt("/applets/hello/settings", table);

  await expect.element(page.getByText("preact@10.27.0")).toBeVisible();
  await page.getByRole("button", { name: "re-resolve" }).click();
  await agree();
  await vi.waitFor(() =>
    expect(calls.map((call) => call.key)).toContain("PUT /api/applets/hello/versions?fresh=true"),
  );

  await expect.element(page.getByText("v3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "download zip" }).click();
  await vi.waitFor(() => expect(saved).toEqual(["hello-v3.zip"]));

  const remove = page.getByRole("button", { name: "Remove applet" });
  await expect.element(remove).toBeDisabled();
  await page.getByLabelText("Applet name to confirm removal").fill("hello");
  await remove.click();
  await vi.waitFor(() => expect(location.pathname).toBe("/applets"));
});

test("a zip holds each file stored, with a directory at the end", () => {
  const archive = zip({ "main.ts": "héllo\n", "lib/a.ts": "" });
  const view = new DataView(archive.buffer);
  const text = new TextDecoder().decode(archive);

  expect(view.getUint32(0, true)).toBe(0x04034b50);
  expect(view.getUint32(14, true)).toBe(0xfdf3a888);
  expect(text).toContain("lib/a.ts");
  expect(view.getUint32(archive.length - 22, true)).toBe(0x06054b50);
  expect(view.getUint16(archive.length - 12, true)).toBe(2);
});

test("the Secrets page sets a secret, lists its name only, and deletes it", async () => {
  const table = routes();
  let secrets: Array<{ name: string; updated_at: string }> = [];
  table.set("GET /api/applets/hello/secrets", () => ({ secrets }));
  table.set("PUT /api/applets/hello/secrets", () => {
    secrets = [{ name: "FEED_KEY", updated_at: row.updated_at }];

    return { ok: true };
  });
  table.set("DELETE /api/applets/hello/secrets?name=FEED_KEY", () => {
    secrets = [];

    return { ok: true };
  });
  await openAt("/applets/hello/secrets", table);

  await expect.element(page.getByText("No secrets.")).toBeVisible();
  await page.getByLabelText("Secret name").fill("feed_key");
  await page.getByLabelText("Secret value").fill("hunter2");
  await page.getByRole("button", { name: "Set" }).click();

  await expect.element(page.getByText("FEED_KEY")).toBeVisible();
  const put = calls.find((call) => call.key === "PUT /api/applets/hello/secrets");
  expect(JSON.parse(put?.body ?? "")).toEqual({ name: "FEED_KEY", value: "hunter2" });
  await expect.element(page.getByLabelText("Secret value")).toHaveValue("");

  await page.getByRole("button", { name: "delete" }).click();
  await agree();
  await expect.element(page.getByText("No secrets.")).toBeVisible();
});

test("the platform Logs page lists runs across applets, filters them, and opens a run's lines", async () => {
  const run = {
    id: 9,
    request_id: "run-b",
    applet: "hello",
    version: 2,
    kind: "schedule",
    method: "GET",
    path: "/",
    status: 500,
    error: "boom",
    duration_ms: 40,
    at: "2026-09-21T10:00:00.000Z",
  };

  const table = routes();
  table.set("GET /api/runs?limit=50", () => ({
    runs: [run, { ...run, id: 8, request_id: "run-a", kind: "http", status: 200, error: null }],
  }));
  table.set("GET /api/runs?status=failed&limit=50", () => ({ runs: [run] }));
  table.set("GET /api/runs/run-b/logs", () => ({
    logs: [
      {
        id: 1,
        applet: "hello",
        version: 2,
        level: "error",
        message: "could not reach the feed",
        data: null,
        request_id: "run-b",
        at: run.at,
      },
    ],
  }));
  await openAt("/logs", table);

  await expect.element(page.getByText("boom")).toBeVisible();
  await expect.element(page.getByText("200", { exact: true })).toBeVisible();

  await page.getByLabelText("status").click();
  await page.getByRole("option", { name: "failed" }).click();
  await expect.element(page.getByText("200", { exact: true })).not.toBeInTheDocument();
  expect(location.search).toBe("?status=failed");

  await page.getByText("boom").click();
  await expect.element(page.getByText("could not reach the feed")).toBeVisible();
});

test("a late Logs response cannot replace the selected filter", async () => {
  const base: Omit<RequestEntry, "id" | "request_id" | "status"> = {
    applet: "hello",
    version: 2,
    kind: "http",
    method: "GET",
    path: "/",
    error: null,
    duration_ms: 4,
    at: row.updated_at,
  };

  const table = routes();

  type RunPage = { runs: RequestEntry[] };

  let release!: (value: RunPage) => void;

  const old = new Promise<RunPage>((resolve) => {
    release = resolve;
  });

  table.set("GET /api/runs?limit=50", () => old);
  table.set("GET /api/runs?status=failed&limit=50", () => ({
    runs: [{ ...base, id: 2, request_id: "failed", status: 500 }],
  }));
  await openAt("/logs", table);
  await vi.waitFor(() =>
    expect(calls.some((call) => call.key === "GET /api/runs?limit=50")).toBe(true),
  );

  await page.getByLabelText("status").click();
  await page.getByRole("option", { name: "failed" }).click();
  await expect.element(page.getByText("500", { exact: true })).toBeVisible();

  release({ runs: [{ ...base, id: 1, request_id: "ok", status: 200 }] });
  await old;
  await new Promise((resolve) => setTimeout(resolve, 10));

  await expect.element(page.getByText("500", { exact: true })).toBeVisible();
  await expect.element(page.getByText("200", { exact: true })).not.toBeInTheDocument();
});

test("a rejected applet setting is visible and restores the saved description", async () => {
  const table = routes();
  table.set("PATCH /api/applets/hello", () => new Error("could not save setting"));
  await openAt("/applets/hello/settings", table);

  const description = page.getByPlaceholder("one line on what it does");
  await description.fill("changed");
  await page.getByText("Visibility", { exact: true }).click();

  await expect.element(page.getByRole("alert")).toHaveTextContent("could not save setting");
  await expect.element(description).toHaveValue("says hello");
});

test("a user's settings have their own sections and none of the admin's", async () => {
  const table = routes();
  table.set("GET /api/sessions", () => ({
    sessions: [
      { ...session, id: "a", current: true },
      { ...session, id: "b", user_agent: "Firefox on a phone" },
    ],
  }));
  table.set("DELETE /api/sessions/b", () => ({ ok: true }));
  await openAt("/settings", table);

  await expect.element(page.getByText("owner@example.com", { exact: true })).toBeVisible();
  expect(location.pathname).toBe("/settings/profile");
  await expect.element(page.getByRole("link", { name: "Users" })).not.toBeInTheDocument();

  await page.getByRole("link", { name: "Sessions" }).click();
  await expect.element(page.getByText("this browser")).toBeVisible();
  await page.getByRole("button", { name: "revoke" }).click();
  await vi.waitFor(() =>
    expect(calls.some((call) => call.key === "DELETE /api/sessions/b")).toBe(true),
  );

  await page.getByRole("link", { name: "API keys" }).click();
  await expect.element(page.getByPlaceholder("what the key is for")).toBeVisible();
});

test("the admin's settings add users, schedules, unclaimed mail and platform info", async () => {
  const table = routes();
  table.set("GET /api/me", () => ({ email: "owner@example.com", role: "admin" }));
  table.set("GET /api/users", () => ({
    users: [{ email: "friend@example.com", added_at: "2026-09-20T10:00:00Z" }],
  }));
  table.set("GET /api/applets", () => ({ applets: [{ ...theirs, schedule: "0 * * * *" }] }));
  table.set("GET /api/platform", () => ({
    host_suffix: ".example.com",
    owner: "owner@example.com",
    email_from: "applets@example.com",
    default_model: "some/model",
    log_retention_days: 7,
    email_retention_days: 7,
  }));
  await openAt("/settings/users", table);

  await expect.element(page.getByText("friend@example.com")).toBeVisible();

  await page.getByRole("link", { name: "Schedules" }).click();
  await expect.element(page.getByText("0 * * * *")).toBeVisible();

  await page.getByRole("link", { name: "Platform" }).click();
  await expect.element(page.getByText("some/model")).toBeVisible();
  await expect.element(page.getByText("kept 7 days").first()).toBeVisible();
});
