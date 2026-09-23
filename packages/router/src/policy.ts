/**
 * Who may do what, in one function. A member has a role, an applet has an owner
 * and a visibility, and `can` turns the pair into a yes or a no. Nothing else in
 * the router decides access. No `cloudflare:workers` import, so vitest loads it.
 */

export const visibilities = ["private", "family", "public"] as const;

export type Visibility = (typeof visibilities)[number];

/** `admin` is the owner from `OWNER_EMAIL`; `user` is a row in `users`. */
export type Member = { readonly role: "admin" | "user"; readonly email: string };

/** No valid session or key is `null`. */
export type Subject = Member | null;

/**
 * `use` is reaching the applet over HTTP. `edit` is everything about its code:
 * source, drafts, deploys, logs, requests, emails, settings. `remove` deletes it.
 */
export type Action = "use" | "edit" | "remove";

type Guarded = { readonly owner: string; readonly visibility: Visibility };

export function can(subject: Subject, action: Action, applet: Guarded): boolean {
  const isOwner = subject !== null && subject.email === applet.owner;

  if (isOwner) return true;

  if (action === "edit") return false;

  if (action === "remove") return subject?.role === "admin";

  if (applet.visibility === "public") return true;

  return applet.visibility === "family" && subject !== null;
}

/**
 * Whether a page on another origin sent this request. Browsers set `Origin` on
 * cross-origin writes and `Sec-Fetch-Site` when Origin is absent.
 */
export function isCrossOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  if (origin !== null) return origin !== new URL(request.url).origin;

  const site = request.headers.get("sec-fetch-site");

  return site === "same-site" || site === "cross-site";
}

/** A page on another host must not use the shared session cookie to change an applet. */
export function isCrossOriginSessionWrite(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;

  if (!request.headers.has("cookie")) return false;

  if (request.headers.get("authorization")?.startsWith("Bearer ")) return false;

  return isCrossOrigin(request);
}
