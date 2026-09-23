/**
 * Applet-to-applet calls. A Worker's `fetch()` to a host on its own zone skips
 * Workers, so `Egress` hands a request for a host under the suffix back to the
 * router's own ingress instead of the network.
 */
import { reservedHosts } from "./types.ts";

export const depthHeader = "x-applet-depth";

const maxDepth = 4;

const maxInFlight = 16;

let inFlight = 0;

/**
 * The request ingress gets for an applet's call to `<applet><suffix>`, or the
 * refusal. It carries no session, so only a public applet answers it, and it
 * counts the hops so a chain of applets calling each other ends.
 */
export function internalCall(request: Request, suffix: string): Request | Response {
  const host = new URL(request.url).hostname;

  if (reservedHosts.includes(host.slice(0, -suffix.length))) {
    return Response.json({ error: "not an applet", host }, { status: 403 });
  }

  const depth = Number(request.headers.get(depthHeader) ?? 0);

  if (depth >= maxDepth) {
    return Response.json({ error: "applet call depth exceeded", host }, { status: 508 });
  }

  const headers = new Headers(request.headers);
  headers.delete("cookie");
  headers.delete("authorization");
  headers.set(depthHeader, String(depth + 1));

  return new Request(request, { headers });
}

/**
 * Runs one applet-to-applet call unless 16 are already in flight in this
 * isolate. An applet's fresh `fetch()` drops the depth header, so a loop is
 * caught here instead: every level of it holds a call open until the one below
 * answers. It is a counter, not a queue; calls under the cap run concurrently.
 */
export async function underCap(call: () => Promise<Response>): Promise<Response> {
  if (inFlight >= maxInFlight) {
    return Response.json({ error: "too many applet calls in flight" }, { status: 508 });
  }

  inFlight += 1;

  try {
    return await call();
  } finally {
    inFlight -= 1;
  }
}
