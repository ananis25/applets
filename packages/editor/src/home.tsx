import { Card } from "@applets/ui/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@applets/ui/components/ui/empty";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { AppletSummary } from "@applets/api";
import { Badges, ErrorDot, NewApplet } from "./applets.tsx";
import { appletsQuery, useMe } from "./queries.ts";
import { Failure } from "./failure.tsx";
import { appletLink, relTime } from "./urls.ts";

const recentCount = 6;

function AppletCard({ applet }: { applet: AppletSummary }) {
  return (
    <Link {...appletLink(applet.name)}>
      <Card size="sm" className="h-full px-4 transition-colors hover:bg-accent">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{applet.name}</span>
          <ErrorDot applet={applet} />
        </div>
        <p className="line-clamp-2 min-h-10 text-sm">
          {applet.description || <span className="text-muted-foreground">No description</span>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Badges applet={applet} />
        </div>
        <span className="font-mono text-xs">
          {applet.current_version ? `v${applet.current_version}` : "no version"} · updated{" "}
          {relTime(applet.updated_at)}
        </span>
      </Card>
    </Link>
  );
}

/** The first page: the user's most recently changed applets as cards. */
export function Home() {
  const { data: me } = useMe();
  const { data: applets, error } = useQuery(appletsQuery);

  const recent = applets
    ?.filter((applet) => applet.owner === me?.email)
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, recentCount);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Home</h1>
        <NewApplet />
      </div>
      <Failure error={error} />
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg">Recently changed</h2>
        <Link to="/applets" className="text-sm underline">
          All applets
        </Link>
      </div>
      {me !== undefined && recent?.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No applets yet</EmptyTitle>
            <EmptyDescription>Create one to see it here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {me !== undefined &&
          recent?.map((applet) => <AppletCard key={applet.name} applet={applet} />)}
      </div>
    </div>
  );
}
