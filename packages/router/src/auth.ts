/**
 * Better Auth as the `Auth` service, sharing the registry's D1 database. Magic
 * link is the only way in, sent through the mailer. A stranger never gets a
 * link or a user row: `sendMagicLink` and `databaseHooks.user.create.before`
 * both check the owner and the `users` table first. The same instance is the
 * OAuth authorization server for the MCP host: an MCP client registers itself,
 * sends the person through sign-in and consent on the auth host, and gets an
 * access token bound to `MCP_URL`. `subject` is the one place a request's
 * headers become a subject for `policy.ts`.
 */
import { NotFound, type Session } from "@applets/api";
import { mcp } from "@better-auth/mcp";
import { APIError, betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { jwt, magicLink } from "better-auth/plugins";
import { Context, Effect, Layer, Option } from "effect";

import { Mailer, Vars } from "./bindings.ts";
import { sha256 } from "./keys.ts";
import type { Member, Subject } from "./policy.ts";
import { log } from "./platformLog.ts";
import { Registry } from "./registry.ts";

export class Auth extends Context.Service<
  Auth,
  {
    /** Who is asking: the creator of a bearer key, the user behind an OAuth access token, else the session behind the cookies, else a stranger. */
    readonly subject: (headers: Headers) => Effect.Effect<Subject>;
    /** Better Auth's own routes under `/api/auth/`. */
    readonly handle: (request: Request) => Effect.Effect<Response>;
    /** The caller's browser sessions, or none for a key or the local dev user. */
    readonly sessions: (headers: Headers) => Effect.Effect<ReadonlyArray<Session>>;
    readonly revoke: (headers: Headers, id: string) => Effect.Effect<void, NotFound>;
  }
>()("applets/Auth") {}

const hour = 60 * 60;

const day = 24 * hour;

const year = 365 * day;

/** What an MCP client may ask for: the applets, and a refresh token. Advertised by the MCP host's resource metadata, since the provider leaves `offline_access` out of it. */
export const mcpScopes = ["applets", "offline_access"] as const;

/**
 * The link we email points at a page with a button, not at the verify route.
 * Mail scanners such as Outlook's Safe Links open every link they see, and
 * the verify route consumes the one-time token on first use.
 */
const confirmUrl = (authUrl: string, verifyUrl: string): string =>
  `${authUrl}/confirm${new URL(verifyUrl).search}`;

const make = (db: D1Database) =>
  Effect.gen(function* () {
    const vars = yield* Vars;
    const registry = yield* Registry;
    const mailer = yield* Mailer;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());

    /** The subject behind an email, or null when it is neither the owner nor a row in `users`. */
    const memberFor = Effect.fn("Auth.memberFor")(function* (email: string) {
      if (email === vars.OWNER_EMAIL) return { role: "admin", email } satisfies Member;

      return (yield* registry.isUser(email)) ? ({ role: "user", email } satisfies Member) : null;
    });

    const sendLink = Effect.fn("Auth.sendLink")(function* (email: string, url: string) {
      if ((yield* memberFor(email.toLowerCase())) === null)
        return yield* log.warn("sign-in refused, not a member", { email });

      yield* log.info("sign-in link sent", { email });

      // Local mail goes nowhere, so the link is logged for a person at the terminal to open.
      if (vars.HOST_SUFFIX === ".localhost")
        yield* log.info("sign-in link", { url: confirmUrl(vars.AUTH_URL, url) });

      yield* mailer.send(
        { email: vars.EMAIL_FROM, name: "applets" },
        {
          to: email,
          subject: "Sign in to applets",
          text: `Open this link and press the button to sign in. It works once and expires in an hour.\n\n${confirmUrl(vars.AUTH_URL, url)}`,
        },
      );
    });

    const instance = betterAuth({
      database: db,
      secret: vars.BETTER_AUTH_SECRET,
      baseURL: vars.AUTH_URL,
      trustedOrigins: [`http://*${vars.HOST_SUFFIX}:8787`, `https://*${vars.HOST_SUFFIX}`],
      emailAndPassword: { enabled: false },
      plugins: [
        magicLink({
          expiresIn: 60 * 60,
          sendMagicLink: ({ email, url }) => run(sendLink(email, url)),
        }),
        // The provider signs access tokens with this plugin's keys under this issuer, for the MCP host; `verifyJWT` checks the same two.
        jwt({ jwt: { issuer: `${vars.AUTH_URL}/api/auth`, audience: vars.MCP_URL } }),
        mcp({
          loginPage: "/",
          consentPage: "/consent",
          resource: vars.MCP_URL,
          scopes: [...mcpScopes],
          allowDynamicClientRegistration: true,
          allowUnauthenticatedClientRegistration: true,
          // A short access token and a refresh token that slides a year at each use: a person signs in once, and again only after a year away.
          accessTokenExpiresIn: hour,
          refreshTokenExpiresIn: year,
        }),
      ],
      session: {
        expiresIn: 30 * day,
        updateAge: day,
        cookieCache: { enabled: true, maxAge: 5 * 60 },
      },
      rateLimit: { enabled: true },
      hooks: {
        /**
         * An MCP client on a laptop is a native app with an `http://localhost` redirect, which the
         * provider only allows when the registration says so, and clients rarely do. A client is
         * also a public client, with no secret to keep, and granted refresh tokens, unless it
         * registers otherwise: the provider's defaults are a secret and the code grant alone.
         */
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path !== "/oauth2/register") return;

          return {
            context: {
              body: {
                application_type: "native",
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code", "refresh_token"],
                ...ctx.body,
              },
            },
          };
        }),
      },
      advanced: {
        // the check would be a dangling D1 query in whichever request builds the runtime; the registry creates these tables itself
        database: { validateSchema: false },
        ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
        cookiePrefix: "applets",
        useSecureCookies: vars.AUTH_URL.startsWith("https:"),
        crossSubDomainCookies: { enabled: true, domain: vars.HOST_SUFFIX },
      },
      databaseHooks: {
        user: {
          create: {
            before: async (user) => {
              if ((await run(memberFor(user.email.toLowerCase()))) === null)
                throw new APIError("FORBIDDEN", { message: "this email may not sign in" });
            },
          },
        },
      },
    });

    // NOTE: Better Auth starts its init the moment it is constructed and every call
    // awaits that promise. The instance is built per request, so waiting here
    // keeps init inside the request that owns it and surfaces an init failure
    // as a build failure instead of a hang in the first `getSession`.
    yield* Effect.promise(() => instance.$context);

    /** A bearer key acts as the user who created it. `ADMIN_TOKEN` from `secrets.env` is the bootstrap key and acts as the owner. */
    const subjectForKey = Effect.fn("Auth.subjectForKey")(function* (key: string) {
      const hash = yield* Effect.promise(() => sha256(key));

      if (hash === vars.ADMIN_TOKEN_HASH)
        return { role: "admin", email: vars.OWNER_EMAIL } satisfies Member;

      const email = yield* registry.useKey(hash);

      return Option.isNone(email) ? null : yield* memberFor(email.value);
    });

    /**
     * An OAuth access token acts as the user who granted it. The token is a JWT
     * the jwt plugin signed, checked here against the keys in the registry, the
     * issuer and the MCP host as audience, with no network call.
     */
    const subjectForToken = Effect.fn("Auth.subjectForToken")(function* (token: string) {
      const verified = yield* Effect.promise(() => instance.api.verifyJWT({ body: { token } }));

      if (verified.payload === null) return null;

      const email = yield* registry.userEmail(verified.payload.sub);

      return Option.isNone(email) ? null : yield* memberFor(email.value);
    });

    const currentSession = (headers: Headers) =>
      Effect.promise(() => instance.api.getSession({ headers }));

    return Auth.of({
      /** On the local platform every request without a key is `DEV_USER`, since `*.localhost` cannot hold the sign-in cookie; the suffix check keeps that off a deployed router. */
      subject: Effect.fn("Auth.subject")(function* (headers) {
        const authorization = headers.get("authorization");

        if (authorization?.startsWith("Bearer ")) {
          const credential = authorization.slice("Bearer ".length);

          return credential.split(".").length === 3
            ? yield* subjectForToken(credential)
            : yield* subjectForKey(credential);
        }

        if (vars.DEV_USER !== undefined && vars.HOST_SUFFIX === ".localhost")
          return { role: "admin", email: vars.DEV_USER } satisfies Member;

        const session = yield* currentSession(headers);

        return session === null ? null : yield* memberFor(session.user.email);
      }),
      handle: (request) => Effect.promise(() => instance.handler(request)),
      sessions: Effect.fn("Auth.sessions")(function* (headers) {
        const current = yield* currentSession(headers);

        if (current === null) return [];

        const sessions = yield* Effect.promise(() => instance.api.listSessions({ headers }));

        return sessions.map((session) => ({
          id: session.id,
          created_at: session.createdAt.toISOString(),
          expires_at: session.expiresAt.toISOString(),
          user_agent: session.userAgent ?? null,
          ip: session.ipAddress ?? null,
          current: session.id === current.session.id,
        }));
      }),
      revoke: Effect.fn("Auth.revoke")(function* (headers, id) {
        const sessions = yield* Effect.promise(() => instance.api.listSessions({ headers }));
        const target = sessions.find((session) => session.id === id);

        if (target === undefined) return yield* new NotFound({ message: `no session ${id}` });

        yield* Effect.promise(() =>
          instance.api.revokeSession({ headers, body: { token: target.token } }),
        );
      }),
    });
  });

/** Better Auth over the registry's database. The registry layer has created its tables. */
export const layer = (db: D1Database) => Layer.effect(Auth, make(db));
