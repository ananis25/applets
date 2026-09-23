/**
 * The platform Logs page: one list of runs across the user's applets, newest
 * first. The filters live in the query string, so a filtered list is a link. A
 * row opens to the lines that run wrote. The admin has a second view, the
 * platform's own lines: deploys, sign-ins, mail, loads and failures.
 */
import { useState } from "react";
import { Button } from "@applets/ui/components/ui/button";
import { Card } from "@applets/ui/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@applets/ui/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@applets/ui/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@applets/ui/components/ui/select";
import { Label } from "@applets/ui/components/ui/label";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { logLevels, type PlatformLogEntry, type RequestEntry } from "@applets/api";
import { call } from "./client.ts";
import { LogRow, levelColor, runDetail, runSource, runTone, stamp } from "./editor/streams.tsx";
import { appletsQuery, useMe } from "./queries.ts";
import { Failure } from "./failure.tsx";
import { appletLink, logsSearch, type LogsSearch } from "./urls.ts";

const pageSize = 50;

const kinds = [
  ["http", "http"],
  ["schedule", "schedule"],
  ["manual", "run now"],
  ["email", "email"],
] as const;

function Filter(props: {
  label: string;
  value: string;
  options: ReadonlyArray<readonly [value: string, label: string]>;
  onChange: (value: string) => void;
}) {
  return (
    <Label className="gap-1 text-xs">
      {props.label}
      <Select
        items={[["", "all"] as const, ...props.options].map(([value, label]) => ({ value, label }))}
        value={props.value}
        onValueChange={(value) => props.onChange(value ?? "")}
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">all</SelectItem>
          {props.options.map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Label>
  );
}

/** One run. Opening it fetches the lines it wrote. */
function RunRow({ run }: { run: RequestEntry }) {
  const [open, setOpen] = useState(false);

  const { data: lines } = useQuery({
    queryKey: ["run", run.request_id],
    queryFn: () =>
      call((api) => api.runs.logs({ params: { id: run.request_id } })).then((data) => data.logs),
    enabled: open,
  });

  const detail = runDetail(run);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-b border-border/20 font-mono text-xs"
    >
      <div className={`flex items-center gap-2 px-3 py-1 ${runTone(run)}`}>
        <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer gap-2 text-left">
          <span className="shrink-0 text-muted-foreground">{stamp(run.at)}</span>
          <span className="w-16 shrink-0 font-semibold">{runSource(run)}</span>
          <span className="min-w-0 flex-1 truncate" title={detail}>
            {detail}
          </span>
          <span>{run.status ?? "error"}</span>
          <span className="w-16 text-right text-muted-foreground">{run.duration_ms}ms</span>
        </CollapsibleTrigger>
        <Link {...appletLink(run.applet, "logs")} className="w-32 shrink-0 truncate underline">
          {run.applet}
        </Link>
      </div>
      <CollapsibleContent className="ml-4 border-l border-border py-1">
        {lines?.length === 0 && <div className="px-3 text-muted-foreground">No log lines.</div>}
        {lines?.map((entry) => (
          <LogRow key={entry.id} entry={entry} version />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One line the platform wrote. Its data is JSON, shown as it is. */
function PlatformRow({ entry }: { entry: PlatformLogEntry }) {
  return (
    <div
      className={`flex gap-2 border-b border-border/20 px-3 py-1 font-mono text-xs ${levelColor[entry.level]}`}
    >
      <span className="shrink-0 text-muted-foreground">{stamp(entry.at)}</span>
      <span className="w-10 shrink-0">{entry.level}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">
        {entry.message}
        {entry.data && <span className="text-muted-foreground"> {entry.data}</span>}
      </span>
      {entry.applet && (
        <Link {...appletLink(entry.applet, "logs")} className="w-32 shrink-0 truncate underline">
          {entry.applet}
        </Link>
      )}
    </div>
  );
}

/** The page after the last row, while pages come back full. */
const olderThan = <Row extends { readonly id: number }>(rows: ReadonlyArray<Row>) =>
  rows.length === pageSize ? rows.at(-1)?.id : undefined;

/** The platform's own lines, newest first, paged back by id. */
type Filter = (key: keyof LogsSearch) => (value: string) => void;

function PlatformLogs({ search, filter }: { search: LogsSearch; filter: Filter }) {
  const { level, applet } = search;

  const pages = useInfiniteQuery({
    queryKey: ["platform-logs", level, applet],
    queryFn: ({ pageParam }) =>
      call((api) =>
        api.platform.logs({ query: { level, applet, before: pageParam, limit: pageSize } }),
      ).then((data) => data.logs),
    // SAFETY: the first page has no cursor; later ones are the last id of the page before.
    initialPageParam: undefined as number | undefined,
    getNextPageParam: olderThan,
  });

  const lines = pages.data?.pages.flatMap((page) => page);

  return (
    <>
      <div className="flex flex-wrap items-center gap-4">
        <Filter
          label="level"
          value={level ?? ""}
          options={logLevels.map((level) => [level, level] as const)}
          onChange={filter("level")}
        />
        <Button
          variant="outline"
          size="xs"
          className="ml-auto"
          onClick={() => void pages.refetch()}
        >
          refresh
        </Button>
      </div>
      <Failure error={pages.error} retry={() => void pages.refetch()} />
      {lines?.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No lines</EmptyTitle>
            <EmptyDescription>
              Deploys, sign-ins, mail, worker loads and failures show here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {lines !== undefined && lines.length > 0 && (
        <Card className="gap-0 py-0">
          {lines.map((entry) => (
            <PlatformRow key={entry.id} entry={entry} />
          ))}
        </Card>
      )}
      {pages.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="self-center"
          onClick={() => void pages.fetchNextPage()}
        >
          older
        </Button>
      )}
    </>
  );
}

export function Logs() {
  const { data: me } = useMe();
  const { data: applets } = useQuery(appletsQuery);
  const search = useSearch({ from: "/_platform/logs" });
  const navigate = useNavigate({ from: "/logs" });
  const { applet, kind, status: outcome } = search;
  const platform = search.view === "platform";

  const pages = useInfiniteQuery({
    queryKey: ["runs", applet, kind, outcome],
    queryFn: ({ pageParam }) =>
      call((api) =>
        api.runs.list({
          query: { applet, kind, status: outcome, before: pageParam, limit: pageSize },
        }),
      ).then((data) => data.runs),
    // SAFETY: the first page has no cursor; later ones are the last id of the page before.
    initialPageParam: undefined as number | undefined,
    getNextPageParam: olderThan,
    enabled: !platform,
  });

  const runs = pages.data?.pages.flatMap((page) => page);

  /** Sets one filter in the URL; an empty value clears it, and a value the schema rejects drops. */
  const filter: Filter = (key) => (value) =>
    void navigate({
      to: ".",
      search: (held) => logsSearch.parse({ ...held, [key]: value === "" ? undefined : value }),
    });

  const own =
    applets
      ?.values()
      .filter((applet) => applet.owner === me?.email)
      .map((applet) => [applet.name, applet.name] as const)
      .toArray() ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center gap-4">
        <h1 className="text-3xl">Logs</h1>
        {me?.role === "admin" && (
          <div className="flex gap-1">
            <Button
              variant={platform ? "outline" : "default"}
              size="xs"
              onClick={() => filter("view")("")}
            >
              runs
            </Button>
            <Button
              variant={platform ? "default" : "outline"}
              size="xs"
              onClick={() => filter("view")("platform")}
            >
              platform
            </Button>
          </div>
        )}
      </div>
      {platform && <PlatformLogs search={search} filter={filter} />}
      {!platform && (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <Filter label="applet" value={applet ?? ""} options={own} onChange={filter("applet")} />
            <Filter
              label="status"
              value={outcome ?? ""}
              options={[
                ["ok", "ok"],
                ["failed", "failed"],
              ]}
              onChange={filter("status")}
            />
            <Filter label="trigger" value={kind ?? ""} options={kinds} onChange={filter("kind")} />
            <Button
              variant="outline"
              size="xs"
              className="ml-auto"
              onClick={() => void pages.refetch()}
            >
              refresh
            </Button>
          </div>
          <Failure error={pages.error} retry={() => void pages.refetch()} />
          {runs?.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No runs</EmptyTitle>
                <EmptyDescription>
                  Requests, schedule runs and received mail show here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {runs !== undefined && runs.length > 0 && (
            <Card className="gap-0 py-0">
              {runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </Card>
          )}
          {pages.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              className="self-center"
              onClick={() => void pages.fetchNextPage()}
            >
              older
            </Button>
          )}
        </>
      )}
    </div>
  );
}
