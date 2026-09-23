/**
 * Platform settings, one section per URL under `/settings/`. The first group is for every
 * user; the second is the admin's, and the router refuses its routes to anyone else.
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@applets/ui/components/ui/badge";
import { Button, buttonVariants } from "@applets/ui/components/ui/button";
import { Input } from "@applets/ui/components/ui/input";
import { Link, Navigate } from "@tanstack/react-router";
import type { Me } from "@applets/api";
import { call } from "./client.ts";
import { EmailRow } from "./editor/streams.tsx";
import { appletsQuery, useMe } from "./queries.ts";
import { Failure } from "./failure.tsx";
import { appletLink, relTime, siblingUrl } from "./urls.ts";

const line = "flex items-center gap-3 font-mono text-xs";

/** Who is signed in. Signing out happens on the sign-in host, which owns the session cookie. */
function Profile({ me }: { me: Me }) {
  return (
    <section className="flex flex-col gap-3">
      <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
        <dt className="font-semibold">Email</dt>
        <dd className="font-mono text-xs">{me.email}</dd>
        <dt className="font-semibold">Role</dt>
        <dd>
          <Badge variant={me.role === "admin" ? "default" : "secondary"}>{me.role}</Badge>
        </dd>
      </dl>
      <div>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<a href={siblingUrl("auth")} />}
        >
          Sign out…
        </Button>
      </div>
    </section>
  );
}

/** The browsers signed in as this user. Revoking one signs it out within a few minutes, when its cached cookie expires. */
function Sessions() {
  const client = useQueryClient();

  const { data: sessions, error: loadError } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => call((api) => api.sessions.list()).then((data) => data.sessions),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => call((api) => api.sessions.revoke({ params: { id } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["sessions"] }),
  });

  const error = loadError ?? revoke.error;

  return (
    <section className="flex flex-col gap-2">
      <Failure error={error} />
      {sessions?.length === 0 && <p className="font-mono text-xs">No browser session.</p>}
      {sessions?.map((session) => (
        <div key={session.id} className={line}>
          <span className="min-w-0 flex-1 truncate">{session.user_agent ?? "unknown browser"}</span>
          <span>{session.ip}</span>
          <span>signed in {relTime(session.created_at)}</span>
          {session.current ? (
            <Badge>this browser</Badge>
          ) : (
            <Button variant="outline" size="xs" onClick={() => revoke.mutate(session.id)}>
              revoke
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}

/** Who may sign in besides the admin: the `users` table, with add and remove. Only the admin sees it. */
function Users() {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [invalid, setInvalid] = useState(false);

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => call((api) => api.users.list()).then((data) => data.users),
  });

  const invite = useMutation({
    mutationFn: (address: string) => call((api) => api.users.add({ params: { email: address } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["users"] }),
  });

  const remove = useMutation({
    mutationFn: (address: string) =>
      call((api) => api.users.remove({ params: { email: address } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["users"] }),
  });

  const add = () => {
    const trimmed = email.trim().toLowerCase();
    setInvalid(!trimmed.includes("@"));

    if (!trimmed.includes("@")) return;

    setEmail("");
    invite.mutate(trimmed);
  };

  const error = invalid
    ? "Enter an email address"
    : (users.error ?? invite.error ?? remove.error)?.message;

  return (
    <section className="flex flex-col gap-2">
      <Failure error={error} />
      <div className="flex gap-2">
        <Input
          value={email}
          placeholder="someone@example.com"
          autoComplete="off"
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && add()}
        />
        <Button variant="outline" onClick={add}>
          Add
        </Button>
      </div>
      {users.data?.map((user) => (
        <div key={user.email} className="flex items-center gap-3 font-mono text-xs">
          <span>{user.email}</span>
          <span className="ml-auto">{relTime(user.added_at)}</span>
          <Button variant="outline" size="xs" onClick={() => remove.mutate(user.email)}>
            remove
          </Button>
        </div>
      ))}
    </section>
  );
}

/** The signed-in user's API keys. A new key is shown once, right after it is made. */
function Keys() {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [unnamed, setUnnamed] = useState(false);

  const keys = useQuery({
    queryKey: ["keys"],
    queryFn: () => call((api) => api.keys.list()).then((data) => data.keys),
  });

  const mint = useMutation({
    mutationFn: (key: string) => call((api) => api.keys.create({ payload: { name: key } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["keys"] }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => call((api) => api.keys.remove({ params: { id } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["keys"] }),
  });

  const create = () => {
    const trimmed = name.trim();
    setUnnamed(trimmed === "");

    if (trimmed === "") return;

    setName("");
    mint.mutate(trimmed);
  };

  const error = unnamed ? "Name the key" : (keys.error ?? mint.error ?? remove.error)?.message;
  const minted = mint.data?.key;

  return (
    <section className="flex flex-col gap-2">
      <Failure error={error} />
      <div className="flex gap-2">
        <Input
          value={name}
          placeholder="what the key is for"
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && create()}
        />
        <Button variant="outline" onClick={create}>
          New key
        </Button>
      </div>
      {minted && (
        <p className="font-mono text-xs break-all">Copy it now, it is not shown again: {minted}</p>
      )}
      {keys.data?.map((key) => (
        <div key={key.id} className="flex items-center gap-3 font-mono text-xs">
          <span>{key.name}</span>
          <span className="ml-auto">
            {key.last_used_at ? `used ${relTime(key.last_used_at)}` : "never used"}
          </span>
          <Button variant="outline" size="xs" onClick={() => remove.mutate(key.id)}>
            remove
          </Button>
        </div>
      ))}
    </section>
  );
}

/** How to connect an agent: the MCP server's URL, and the one command that adds it to Claude Code. OAuth does the rest in the browser. */
function Agents() {
  const mcpUrl = `${siblingUrl("mcp")}/`;

  return (
    <section className="flex flex-col gap-3 text-sm">
      <p>
        The MCP server lets an agent list, read, deploy and inspect your applets as you. Add it to
        Claude Code with:
      </p>
      <pre className="overflow-x-auto rounded-md border bg-card p-3 font-mono text-xs">
        claude mcp add --transport http applets {mcpUrl}
      </pre>
      <p>
        On first use the agent opens this site to sign you in and ask for consent. Any other MCP
        client that speaks OAuth takes the same URL. The API behind it is documented at{" "}
        <a className="underline" href={`${siblingUrl("admin")}/docs`}>
          admin/docs
        </a>
        , where an API key from the section above is the bearer token.
      </p>
    </section>
  );
}

/** Mail that reached the platform for no applet. Only the admin sees it. */
function Unclaimed() {
  const { data: emails = [], error } = useQuery({
    queryKey: ["unclaimed"],
    queryFn: () =>
      call((api) => api.platform.unclaimed({ query: { limit: 50 } })).then((data) => data.emails),
  });

  return (
    <section className="flex flex-col gap-2">
      <Failure error={error} />
      {emails.length === 0 && <p className="font-mono text-xs">none</p>}
      {emails.length > 0 && (
        <div className="rounded-md border bg-card p-2 font-mono text-xs">
          {emails.map((entry) => (
            <EmailRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Every applet with a schedule, across users. */
function Schedules({ me }: { me: Me }) {
  const { data, error } = useQuery(appletsQuery);
  const applets = data?.filter((applet) => applet.schedule !== null);

  return (
    <section className="flex flex-col gap-2">
      <Failure error={error} />
      {applets?.length === 0 && <p className="font-mono text-xs">No applet has a schedule.</p>}
      {applets?.map((applet) => (
        <div key={applet.name} className={line}>
          {applet.owner === me.email ? (
            <Link {...appletLink(applet.name, "settings")} className="w-40 truncate underline">
              {applet.name}
            </Link>
          ) : (
            <span className="w-40 truncate">{applet.name}</span>
          )}
          <span className="w-32">{applet.schedule}</span>
          <span className="ml-auto">{applet.owner}</span>
        </div>
      ))}
    </section>
  );
}

/** What this deployment is set to. Read only: these change with a deploy. */
function PlatformInfo() {
  const { data: platform, error } = useQuery({
    queryKey: ["platform"],
    queryFn: () => call((api) => api.platform.info()),
  });

  if (error) return <Failure error={error} />;

  if (!platform) return null;

  const rows = [
    ["Host suffix", platform.host_suffix],
    ["Admin", platform.owner],
    ["Mail from", platform.email_from],
    ["Default model", platform.default_model],
    ["Logs and requests", `kept ${platform.log_retention_days} days`],
    ["Emails", `kept ${platform.email_retention_days} days`],
  ];

  return (
    <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="font-semibold">{label}</dt>
          <dd className="font-mono text-xs">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

type Section = { slug: string; label: string; admin: boolean; render: (me: Me) => ReactNode };

const sections: Section[] = [
  { slug: "profile", label: "Profile", admin: false, render: (me) => <Profile me={me} /> },
  { slug: "sessions", label: "Sessions", admin: false, render: () => <Sessions /> },
  { slug: "keys", label: "API keys", admin: false, render: () => <Keys /> },
  { slug: "agents", label: "Agents", admin: false, render: () => <Agents /> },
  { slug: "users", label: "Users", admin: true, render: () => <Users /> },
  { slug: "schedules", label: "Schedules", admin: true, render: (me) => <Schedules me={me} /> },
  { slug: "mail", label: "Unclaimed mail", admin: true, render: () => <Unclaimed /> },
  { slug: "platform", label: "Platform", admin: true, render: () => <PlatformInfo /> },
];

function SectionLinks({ admin, current }: { admin: boolean; current: string }) {
  return sections
    .values()
    .filter((section) => section.admin === admin)
    .map((section) => (
      <Link
        key={section.slug}
        to="/settings/$section"
        params={{ section: section.slug }}
        className={buttonVariants({
          variant: section.slug === current ? "secondary" : "ghost",
          className: "justify-start",
        })}
      >
        {section.label}
      </Link>
    ))
    .toArray();
}

/** The settings page: the list of sections on the left, the one the URL names on the right. */
export function Settings({ section: slug }: { section: string }) {
  const { data: me, error } = useMe();
  const section = sections.find((known) => known.slug === slug);

  if (section === undefined) {
    return <Navigate to="/settings/$section" params={{ section: "profile" }} replace />;
  }

  if (error) return <Failure className="m-10 w-auto" error={error} />;

  if (me === undefined) return null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10">
      <h1 className="text-3xl">Settings</h1>
      <div className="flex gap-8">
        <nav className="flex w-40 shrink-0 flex-col gap-1">
          <SectionLinks admin={false} current={section.slug} />
          {me.role === "admin" && (
            <>
              <span className="mt-4 px-3 text-xs font-semibold uppercase tracking-wide">Admin</span>
              <SectionLinks admin current={section.slug} />
            </>
          )}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <h2 className="text-lg">{section.label}</h2>
          {section.admin && me.role !== "admin" ? (
            <p className="font-mono text-xs">Only the admin sees this.</p>
          ) : (
            section.render(me)
          )}
        </div>
      </div>
    </div>
  );
}
