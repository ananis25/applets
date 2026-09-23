/**
 * The sign-in pages on the auth hostname. The router forwards `/`, `/confirm`
 * and `/consent` here and answers `/api/auth/` itself with Better Auth, so
 * every call below is same-origin. `/` asks for a magic link or shows who is
 * signed in; `/confirm` is what the emailed link opens, one button that submits
 * the token to the verify route, so a mail scanner opening the link never
 * spends it. An MCP client's OAuth flow passes through both: Better Auth sends
 * the person to `/` with the authorization query when they are not signed in,
 * and the link's callback returns them to the authorize route with it, then to
 * `/consent`, where one button finishes the grant.
 */
import { Suspense, use, useState } from "react";

import { Button } from "@applets/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@applets/ui/components/ui/card";
import { Input } from "@applets/ui/components/ui/input";
import { Failure } from "../failure.tsx";

const query = new URLSearchParams(location.search);

const appUrl = location.origin.replace("//auth", "//app");

/** The OAuth authorization request that sent the person here, to return to once signed in. */
const authorizeUrl = query.has("client_id")
  ? `${location.origin}/api/auth/oauth2/authorize${location.search}`
  : null;

/** Where to land after sign-in: the OAuth flow it interrupted, the page that redirected here, else the editor. */
const landing = authorizeUrl ?? query.get("redirectTo") ?? appUrl;

type Session = { user: { email: string } } | null;

function SignedIn({ email }: { email: string }) {
  const signOut = async () => {
    await fetch("/api/auth/sign-out", { method: "POST" });
    location.reload();
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Signed in</CardTitle>
        <CardDescription>{email}</CardDescription>
      </CardHeader>
      <CardFooter className="gap-2">
        <Button render={<a href={landing} />}>
          {authorizeUrl === null ? "Open the editor" : "Continue"}
        </Button>
        <Button variant="outline" onClick={signOut}>
          Sign out
        </Button>
      </CardFooter>
    </Card>
  );
}

function SignIn() {
  const [status, setStatus] = useState<string | null>(null);

  const request = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");

    const response = await fetch("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, callbackURL: landing }),
    });

    setStatus(
      response.ok
        ? "If that address may sign in, a link is on its way. Open it in this browser."
        : `Could not send the link: ${await response.text()}`,
    );
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in to applets</CardTitle>
        <CardDescription>
          We email you a link. It works once and expires in an hour.
        </CardDescription>
      </CardHeader>
      <form onSubmit={request}>
        <CardContent className="flex flex-col gap-3">
          <Input name="email" type="email" placeholder="you@example.com" required autoFocus />
          <Button type="submit">Email me a link</Button>
          {status && <p className="text-sm">{status}</p>}
        </CardContent>
      </form>
    </Card>
  );
}

function Confirm() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Finish signing in</CardTitle>
        <CardDescription>Press the button to use your sign-in link.</CardDescription>
      </CardHeader>
      <form method="get" action="/api/auth/magic-link/verify">
        <CardContent>
          {[...query].map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <Button type="submit">Sign in</Button>
        </CardContent>
      </form>
    </Card>
  );
}

/** The consent page of the OAuth flow: what the client asks for, and one button to grant it. */
function Consent() {
  const [status, setStatus] = useState<string | null>(null);

  const answer = async (accept: boolean) => {
    const response = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }),
    });

    if (!response.ok) return setStatus(`Could not finish: ${await response.text()}`);

    // SAFETY: the consent route answers `{ redirect: true, url }`, the client's redirect URI with the code.
    const { url } = (await response.json()) as { url: string };
    location.href = url;
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Allow access?</CardTitle>
        <CardDescription>
          {query.get("client_name") ?? query.get("client_id")} asks to act as you on applets: list,
          read, deploy and inspect your applets through the MCP server.
        </CardDescription>
      </CardHeader>
      <CardFooter className="gap-2">
        <Button onClick={() => void answer(true)}>Allow</Button>
        <Button variant="outline" onClick={() => void answer(false)}>
          Deny
        </Button>
      </CardFooter>
      {status && (
        <CardContent>
          <p className="text-sm">{status}</p>
        </CardContent>
      )}
    </Card>
  );
}

type Asked = { session: Session } | { failed: string };

let asked: Promise<Asked> | undefined;

/** Who is signed in, asked once per page load; `use` needs the same promise on every render. It never rejects, so a failure renders as text rather than unmounting the page. */
const currentSession = () =>
  (asked ??= fetch("/api/auth/get-session")
    .then(async (response): Promise<Asked> => {
      if (!response.ok) return { failed: `${response.status} ${await response.text()}` };

      // SAFETY: Better Auth's get-session answers `null` or `{ session, user }` with a 200.
      return { session: (await response.json()) as Session };
    })
    .catch((cause: unknown) => ({
      failed: cause instanceof Error ? cause.message : String(cause),
    })));

function Home() {
  const asked = use(currentSession());

  if ("failed" in asked) {
    return <Failure title="Could not check the session" error={asked.failed} />;
  }

  return asked.session === null ? <SignIn /> : <SignedIn email={asked.session.user.email} />;
}

export function Auth() {
  return (
    <main className="flex min-h-full items-center justify-center bg-card p-4">
      {location.pathname === "/confirm" ? (
        <Confirm />
      ) : location.pathname === "/consent" ? (
        <Consent />
      ) : (
        <Suspense>
          <Home />
        </Suspense>
      )}
    </main>
  );
}
