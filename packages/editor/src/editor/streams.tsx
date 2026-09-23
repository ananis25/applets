import { Button } from "@applets/ui/components/ui/button";
import { Checkbox } from "@applets/ui/components/ui/checkbox";
import { Label } from "@applets/ui/components/ui/label";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { EmailEntry, LogEntry, RequestEntry } from "@applets/api";
import { call } from "../client.ts";
import { appletQuery } from "../queries.ts";
import type { StreamView } from "../urls.ts";
import { Traffic } from "./traffic.tsx";

export const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 8);

/** The day too, for lists that span more than one. */
export const stamp = (iso: string) =>
  `${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clock(iso)}`;

export const levelColor = {
  debug: "text-muted-foreground",
  info: "",
  warn: "text-amber-700",
  error: "text-destructive",
};

/** How a request went, as a text colour: red for an error or a 5xx, amber for a 4xx or an odd status. */
export const runTone = (entry: RequestEntry) =>
  entry.error !== null || entry.status === null || entry.status >= 500
    ? "text-destructive"
    : entry.status >= 400 || (entry.kind !== "http" && (entry.status < 200 || entry.status >= 300))
      ? "text-amber-700"
      : "";

/** What started the request, in a word. */
export const runSource = (entry: RequestEntry) =>
  entry.kind === "http" ? entry.method : entry.kind === "manual" ? "run now" : entry.kind;

/** The path, or the error, or that it completed. */
export const runDetail = (entry: RequestEntry) =>
  entry.kind === "http"
    ? entry.error === null
      ? entry.path
      : `${entry.path}: ${entry.error}`
    : (entry.error ?? "completed");

type Followed<Row> = { rows: ReadonlyArray<Row>; after: number | undefined };

/**
 * One stream, polled every two seconds from its start and appended to: `fetchAfter` gives the rows
 * after a cursor. The rows go when the page does, so each visit starts over; clearing drops the
 * rows but keeps the cursor. Polling is quiet, so it never shows the loading bar.
 */
function useStream<Row extends { readonly id: number }>(
  queryKey: ReadonlyArray<unknown>,
  fetchAfter: (after: number | undefined) => Promise<ReadonlyArray<Row>>,
  enabled: boolean,
) {
  const client = useQueryClient();

  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async (): Promise<Followed<Row>> => {
      const held = client.getQueryData<Followed<Row>>(queryKey) ?? { rows: [], after: undefined };
      const rows = await fetchAfter(held.after);

      if (rows.length === 0) return held;

      return { rows: [...held.rows, ...rows], after: rows.at(-1)?.id };
    },
    refetchInterval: 2000,
    staleTime: 0,
    gcTime: 0,
  });

  const clear = () =>
    client.setQueryData<Followed<Row>>(queryKey, (held) => held && { ...held, rows: [] });

  return { rows: query.data?.rows ?? [], error: query.error, clear };
}

/** One of the three stream pages: the rows of the version being viewed, else the live one, or every version's with `?all`. */
export function Stream({
  name,
  view,
  version: viewing,
}: {
  name: string;
  view: StreamView;
  version: number | null;
}) {
  const allVersions = useSearch({ from: "/applets/$name/$view" }).all === true;
  const navigate = useNavigate({ from: "/applets/$name/$view" });
  const live = useSuspenseQuery(appletQuery(name)).data.applet.current_version;
  const viewed = viewing ?? live;
  const version = allVersions || viewed === null ? undefined : viewed;

  const logs = useStream(
    ["applet", name, "stream", "logs", version],
    (after) =>
      call((api) => api.applets.logs({ params: { name }, query: { version, after, limit: 50 } }), {
        quiet: true,
      }).then((data) => data.logs),
    view === "logs",
  );

  const requests = useStream(
    ["applet", name, "stream", "requests", version],
    (after) =>
      call(
        (api) => api.applets.requests({ params: { name }, query: { version, after, limit: 50 } }),
        { quiet: true },
      ).then((data) => data.requests),
    view !== "emails",
  );

  const emails = useStream(
    ["applet", name, "stream", "emails"],
    (after) =>
      call((api) => api.applets.emails({ params: { name }, query: { after, limit: 50 } }), {
        quiet: true,
      }).then((data) => data.emails),
    view === "emails",
  );

  const shown = view === "logs" ? logs : view === "requests" ? requests : emails;
  const error = logs.error ?? requests.error ?? emails.error;

  const toggleAll = (all: boolean) =>
    void navigate({ to: ".", search: (held) => ({ ...held, all: all || undefined }) });

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-card">
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide">{view}</span>
        {view !== "emails" && (
          <Label className="whitespace-nowrap text-xs">
            <Checkbox checked={allVersions} onCheckedChange={toggleAll} />
            all versions
          </Label>
        )}
        {error && (
          <span className="font-mono text-xs text-destructive">
            polling failed: {error.message}
          </span>
        )}
        <Button variant="outline" size="xs" className="ml-auto" onClick={shown.clear}>
          clear
        </Button>
      </div>
      {view === "requests" && <Traffic name={name} latest={requests.rows.at(-1)?.id} />}
      <Tail>
        {view === "logs" &&
          groupByRun(logs.rows).map((group) => (
            <Run
              key={group.lines[0]?.id}
              group={group}
              request={requests.rows.find((entry) => entry.request_id === group.run)}
              version={allVersions}
            />
          ))}
        {view === "requests" &&
          requests.rows.map((entry) => (
            <RequestRow key={entry.id} entry={entry} version={allVersions} />
          ))}
        {view === "emails" && emails.rows.map((entry) => <EmailRow key={entry.id} entry={entry} />)}
      </Tail>
    </section>
  );
}

/** A list that follows its tail, like a terminal: reversed columns keep the scroll at the bottom as rows arrive, and let go once scrolled up. */
function Tail({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-auto py-1 font-mono text-xs">
      <div>{children}</div>
    </div>
  );
}

function Version({ show, version }: { show: boolean; version: number }) {
  return show ? <span className="shrink-0 text-muted-foreground">v{version}</span> : null;
}

type RunGroup = { run: string | null; lines: LogEntry[] };

/** Lines gathered under the run that wrote them, in the order each run first spoke. A line from outside any run stands alone. */
function groupByRun(logs: ReadonlyArray<LogEntry>): RunGroup[] {
  const groups: RunGroup[] = [];
  const open = new Map<string, RunGroup>();

  for (const entry of logs) {
    const group = entry.request_id === null ? undefined : open.get(entry.request_id);

    if (group !== undefined) {
      group.lines.push(entry);
      continue;
    }

    const started = { run: entry.request_id, lines: [entry] };
    groups.push(started);

    if (entry.request_id !== null) open.set(entry.request_id, started);
  }

  return groups;
}

/** One run's lines under its request row. The row arrives when the run ends, so until then the head says so. */
function Run(props: { group: RunGroup; request: RequestEntry | undefined; version: boolean }) {
  const lines = props.group.lines.map((entry) => (
    <LogRow key={entry.id} entry={entry} version={props.version} />
  ));

  if (props.group.run === null) return lines;

  return (
    <div className="mt-1">
      {props.request === undefined ? (
        <div className="px-3 text-muted-foreground">run {props.group.run.slice(0, 8)}</div>
      ) : (
        <RequestRow entry={props.request} version={false} />
      )}
      <div className="ml-4 border-l border-border">{lines}</div>
    </div>
  );
}

export function LogRow({ entry, version }: { entry: LogEntry; version: boolean }) {
  return (
    <div className={`flex gap-2 px-3 ${levelColor[entry.level]}`}>
      <span className="shrink-0 text-muted-foreground">{clock(entry.at)}</span>
      <Version show={version} version={entry.version} />
      <span className="w-10 shrink-0">{entry.level}</span>
      <span className="whitespace-pre-wrap break-all">{entry.message}</span>
      {entry.data && <span className="text-muted-foreground break-all">{entry.data}</span>}
    </div>
  );
}

function RequestRow({ entry, version }: { entry: RequestEntry; version: boolean }) {
  const detail = runDetail(entry);

  return (
    <div className={`flex gap-2 px-3 ${runTone(entry)}`}>
      <span className="shrink-0 text-muted-foreground">{clock(entry.at)}</span>
      <Version show={version} version={entry.version} />
      <span className="w-20 shrink-0 font-semibold">{runSource(entry)}</span>
      <span className="min-w-0 flex-1 truncate" title={detail}>
        {detail}
      </span>
      <span>{entry.status ?? "error"}</span>
      <span className="w-16 text-right text-muted-foreground">{entry.duration_ms}ms</span>
    </div>
  );
}

export function EmailRow({ entry }: { entry: EmailEntry }) {
  const other = entry.direction === "in" ? entry.sender : entry.recipient;

  const color =
    entry.status === "failed"
      ? "text-destructive"
      : entry.status === "unclaimed"
        ? "text-amber-700"
        : "";

  return (
    <div className={`flex gap-2 px-3 ${color}`}>
      <span className="shrink-0 text-muted-foreground">{clock(entry.at)}</span>
      <span>{entry.direction === "in" ? "←" : "→"}</span>
      <span className="max-w-48 truncate">{other}</span>
      <span className="w-20 shrink-0">{entry.status}</span>
      <span className="min-w-0 flex-1 truncate">{entry.subject}</span>
      {entry.detail && <span className="truncate text-muted-foreground">{entry.detail}</span>}
    </div>
  );
}
