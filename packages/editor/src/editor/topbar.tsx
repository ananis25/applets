import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@applets/ui/components/ui/breadcrumb";
import { Badge } from "@applets/ui/components/ui/badge";
import { Button } from "@applets/ui/components/ui/button";
import { Kbd } from "@applets/ui/components/ui/kbd";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { appletQuery, filesQuery } from "../queries.ts";
import { appletLink, liveUrl, relTime, type View } from "../urls.ts";
import { anyDirty, togglePreview, useStore } from "../store.ts";
import { useDeploy, useDeploying, useSaveDraft } from "./mutations.ts";

/** The state of the applet in a few words: the version showing, and whether it is a draft, deployed or rolled back. */
export function usePill(name: string): string {
  const version = useStore((state) => state.version);
  const dirty = useStore((state) => anyDirty(state));
  const { applet: row, versions } = useSuspenseQuery(appletQuery(name)).data;
  const draft = useQuery(filesQuery(name, null)).data;

  if (version !== null) return `viewing v${version}`;

  if (draft?.hasDraft) {
    return dirty ? "draft · unsaved" : `draft · saved ${relTime(draft.draftUpdatedAt)}`;
  }

  const current = row.current_version ?? 0;

  if (versions.some((known) => known.id > current)) return `v${current} · rolled back`;

  return `v${current} · deployed ${relTime(row.updated_at)}`;
}

/** Breadcrumb on the left, the state pill and the two actions that matter on the right. */
export function Topbar({ name, view }: { name: string; view: View }) {
  const pill = usePill(name);
  const hasDraft = useQuery(filesQuery(name, null)).data?.hasDraft ?? false;
  const activeFile = useStore((state) => state.activeFile);
  const viewing = useStore((state) => state.version !== null);
  const dirty = useStore((state) => anyDirty(state));
  const previewOpen = useStore((state) => state.previewOpen);
  const save = useSaveDraft(name);
  const deploy = useDeploy(name);
  const deploying = useDeploying(name);
  const crumb = view === "code" ? activeFile : view;

  return (
    <header className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
      <Breadcrumb className="min-w-0">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/applets" />}>applets</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            {crumb ? (
              <BreadcrumbLink render={<Link {...appletLink(name)} />}>{name}</BreadcrumbLink>
            ) : (
              <BreadcrumbPage>{name}</BreadcrumbPage>
            )}
          </BreadcrumbItem>
          {crumb && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="truncate font-mono text-xs">{crumb}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      <Badge className="ml-2" variant={hasDraft && !viewing ? "default" : "secondary"}>
        {pill}
      </Badge>
      <span className="ml-auto hidden items-center gap-1 text-xs lg:flex">
        <Kbd>⌘P</Kbd> go to file · <Kbd>⌘S</Kbd> save
      </span>
      {viewing && (
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link {...appletLink(name, view)} />}
        >
          back to current
        </Button>
      )}
      {view === "code" && (
        <Button
          variant={previewOpen ? "default" : "outline"}
          size="sm"
          onClick={() => togglePreview()}
        >
          Preview
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        nativeButton={false}
        render={<a href={liveUrl(name)} target="_blank" rel="noopener" />}
      >
        open ↗
      </Button>
      <Button variant="outline" size="sm" disabled={deploying || viewing || !dirty} onClick={save}>
        Save
      </Button>
      <Button size="sm" disabled={deploying || viewing} onClick={() => deploy.mutate(false)}>
        {deploying ? "deploying…" : "Deploy"}
      </Button>
    </header>
  );
}
