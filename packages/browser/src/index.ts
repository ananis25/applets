/**
 * The browser script. One entrypoint, `Browser`, whose unit is a session: one
 * page in a headless browser, opened on a URL and held until closed. `goto`,
 * `evaluate` and `screenshot` reattach to it by id, do their work and detach
 * again, so no call holds a connection open and a forgotten session ends on
 * its own once it has idled for `keepAlive`. Browser Run is the default; a
 * `BROWSER_CDP_URL` var points every session at another provider's CDP
 * endpoint instead, reached over the Workers WebSocket.
 *
 * Not built, but the shape is settled: the same five calls as MCP tools,
 * `browser_open`, `browser_goto`, `browser_evaluate`, `browser_screenshot` and
 * `browser_close`, so an agent with no machine of its own can find a page's
 * selectors and wait condition against the live site, then write the applet once.
 */
import type { Json, LoadOptions, ScreenshotOptions } from "@applets/api/capabilities";
import puppeteer, {
  type Browser as Session,
  type ConnectionTransport,
  type Page,
} from "@cloudflare/puppeteer";
import { WorkerEntrypoint } from "cloudflare:workers";

/** How long a session outlives its last call, in milliseconds. */
const keepAlive = 120_000;

/** Puppeteer's transport over a Workers WebSocket. `fetch` with `Upgrade` opens it, and unlike `new WebSocket` accepts a URL with a key in it. */
async function connectOverWebSocket(url: string): Promise<ConnectionTransport> {
  const response = await fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;

  if (socket === null)
    throw new Error(`no WebSocket upgrade from the CDP endpoint: ${response.status}`);

  socket.accept();

  const transport: ConnectionTransport = {
    send: (message) => socket.send(message),
    close: () => socket.close(),
  };

  socket.addEventListener("message", (event) =>
    // SAFETY: CDP frames are JSON text; a browser never sends a binary frame.
    transport.onmessage?.(event.data as string),
  );
  socket.addEventListener("close", () => transport.onclose?.());

  return transport;
}

const launch = async (env: Cloudflare.Env): Promise<Session> =>
  env.BROWSER_CDP_URL === undefined
    ? puppeteer.launch(env.BROWSER, { keep_alive: keepAlive })
    : puppeteer.connect({ transport: await connectOverWebSocket(env.BROWSER_CDP_URL) });

/** Another provider has one browser behind its URL, so the id only matters to Browser Run. */
const reattach = async (env: Cloudflare.Env, id: string): Promise<Session> =>
  env.BROWSER_CDP_URL === undefined
    ? puppeteer.connect(env.BROWSER, id)
    : puppeteer.connect({ transport: await connectOverWebSocket(env.BROWSER_CDP_URL) });

/** The session's one page: the tab the browser opened with, which `open` navigated. */
async function pageOf(session: Session): Promise<Page> {
  const [page] = await session.pages();

  return page ?? session.newPage();
}

/** Reattaches to the session, hands its page to `work`, and detaches however `work` ends. */
async function withSession<T>(
  env: Cloudflare.Env,
  id: string,
  work: (page: Page) => Promise<T>,
): Promise<T> {
  const session = await reattach(env, id);

  try {
    return await work(await pageOf(session));
  } finally {
    await session.disconnect();
  }
}

/** What the router's `Browser` capability calls. */
export class Browser extends WorkerEntrypoint<Cloudflare.Env> {
  /** Opens a browser on `url` and returns the session's id. */
  async open(url: string, options: LoadOptions = {}): Promise<string> {
    const session = await launch(this.env);

    try {
      const page = await pageOf(session);
      await page.goto(url, { waitUntil: options.waitUntil ?? "domcontentloaded" });

      return session.sessionId();
    } finally {
      await session.disconnect();
    }
  }

  async goto(id: string, url: string, options: LoadOptions = {}): Promise<void> {
    await withSession(this.env, id, async (page) => {
      await page.goto(url, { waitUntil: options.waitUntil ?? "domcontentloaded" });
    });
  }

  /** What `script`, a JavaScript expression run in the page, evaluates to. */
  evaluate(id: string, script: string): Promise<Json> {
    // SAFETY: a value that came back from the page is what CDP could serialize, which is JSON.
    return withSession(this.env, id, async (page) => (await page.evaluate(script)) as Json);
  }

  /** A PNG of the page. */
  screenshot(id: string, options: ScreenshotOptions = {}): Promise<Uint8Array> {
    return withSession(this.env, id, async (page) => {
      if (options.width !== undefined || options.height !== undefined)
        await page.setViewport({ width: options.width ?? 1280, height: options.height ?? 800 });

      return new Uint8Array(await page.screenshot({ fullPage: options.fullPage ?? false }));
    });
  }

  /** Ends the session, which stops its billing. */
  async close(id: string): Promise<void> {
    const session = await reattach(this.env, id);
    await session.close();
  }
}

export default {
  fetch: () =>
    new Response("the browser has no ingress; the router calls it over a service binding", {
      status: 404,
    }),
};
