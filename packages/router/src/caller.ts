/** Who is calling the admin API, and the applet a route is about once the policy has said yes. */
import { Forbidden, NotFound } from "@applets/api";
import { Context, Effect, Option } from "effect";

import { can, type Action, type Member } from "./policy.ts";
import { Registry } from "./registry.ts";

/** The member behind the request, put in the request context by ingress. */
export class Caller extends Context.Service<Caller, Member>()("applets/Caller") {}

/** The applet behind a route: 404 for no such applet, 403 for someone else's. `edit` is everything but removal. */
export const owned = Effect.fn("Admin.owned")(function* (name: string, action: Action = "edit") {
  const caller = yield* Caller;
  const registry = yield* Registry;
  const applet = yield* registry.getApplet(name);

  if (Option.isNone(applet)) return yield* new NotFound({ message: `no applet ${name}` });

  if (!can(caller, action, applet.value))
    return yield* new Forbidden({ message: `${name} belongs to another user` });

  return applet.value;
});
