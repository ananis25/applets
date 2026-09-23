/** The editor's URLs: an applet's pages and their search params, and the platform's sibling hosts. The routes themselves are in `routes/`. */
import { linkOptions } from "@tanstack/react-router";
import { z } from "zod";
import { logLevels, requestKinds } from "@applets/api";

export const views = [
  "code",
  "logs",
  "requests",
  "emails",
  "sqlite",
  "kv",
  "blobs",
  "secrets",
  "versions",
  "settings",
] as const;

export type View = (typeof views)[number];

export type StreamView = "logs" | "requests" | "emails";

export const isStream = (view: View): view is StreamView =>
  view === "logs" || view === "requests" || view === "emails";

/** The pages a version means something on: its code, its streams, and the list it sits in. Storage and settings are the applet's, not a version's. */
export const versioned = (view: View) => view === "code" || view === "versions" || isStream(view);

/** An applet page's search: `version` views that version read only, `all` widens a stream to every version. A bad value drops rather than failing the page. */
export const appletSearch = z.object({
  version: z.number().int().positive().optional().catch(undefined),
  all: z.literal(true).optional().catch(undefined),
});

export type AppletSearch = z.infer<typeof appletSearch>;

/** The Logs page's filters; `view` switches to the platform's own log. */
export const logsSearch = z.object({
  view: z.literal("platform").optional().catch(undefined),
  applet: z.string().optional().catch(undefined),
  kind: z.enum(requestKinds).optional().catch(undefined),
  status: z.enum(["ok", "failed"]).optional().catch(undefined),
  level: z.enum(logLevels).optional().catch(undefined),
});

export type LogsSearch = z.infer<typeof logsSearch>;

/** A link to one page of an applet; a version opens that version read only, where the page has one. */
export const appletLink = (name: string, view: View = "code", version: number | null = null) =>
  linkOptions({
    to: "/applets/$name/$view",
    params: { name, view },
    search: version === null || !versioned(view) ? {} : { version },
  });

/** A sibling host of this page's: the page is on `app.`, sign-in on `auth.`, the MCP server on `mcp.`. */
export const siblingUrl = (host: "auth" | "mcp" | "admin") =>
  location.origin.replace("//app.", `//${host}.`);

export function liveUrl(name: string): string {
  const suffix: string | undefined = import.meta.env.VITE_HOST_SUFFIX;

  if (suffix) return `${suffix.startsWith(".localhost") ? "http" : "https"}://${name}${suffix}`;

  return `${location.protocol}//${location.host.replace(/^app\./, `${name}.`)}`;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);

  if (seconds < 5) return "just now";

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);

  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}
