import { Badge } from "@applets/ui/components/ui/badge";
import { Button } from "@applets/ui/components/ui/button";
import { useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import type { Version } from "@applets/api";
import { appletQuery } from "../queries.ts";
import { ask } from "../ask.tsx";
import { appletLink, relTime } from "../urls.ts";
import { useStore } from "../store.ts";
import { usePatchApplet } from "./mutations.ts";

function describeChange(changed: Version["changed"]): string {
  if (changed.length > 4) return `${changed.length} files changed`;

  return changed
    .map((c) =>
      c.change === "added" ? `+${c.path}` : c.change === "deleted" ? `−${c.path}` : c.path,
    )
    .join(", ");
}

/** The version list, newest first: open one read only, or roll back to it. */
export function Versions({ name }: { name: string }) {
  const { applet, versions } = useSuspenseQuery(appletQuery(name)).data;
  const viewing = useStore((state) => state.version);
  const patch = usePatchApplet(name);

  const rollback = async (id: number) => {
    const agreed = await ask({
      title: `Roll back to v${id}?`,
      description: "It becomes the live version immediately.",
      action: "Roll back",
    });

    if (!agreed) return;

    patch.mutate(
      { current_version: id },
      {
        onSuccess: () => toast(`rolled back to v${id}`),
        onError: (error) => toast.error(error.message),
      },
    );
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-card">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide">
        Versions
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {versions.length === 0 && (
          <div className="p-3 text-sm text-muted-foreground">No versions yet.</div>
        )}
        {versions.map((version) => (
          <div
            key={version.id}
            className="flex items-center gap-3 border-b border-border px-3 py-2 font-mono text-xs"
          >
            <span className="w-8 font-semibold">v{version.id}</span>
            <span className="min-w-0 flex-1 truncate">{describeChange(version.changed)}</span>
            {version.id === applet.current_version && <Badge variant="secondary">current</Badge>}
            {version.id === viewing && <Badge>viewing</Badge>}
            <span className="w-16 text-right text-muted-foreground">
              {relTime(version.created_at)}
            </span>
            <Button
              variant="outline"
              size="xs"
              nativeButton={false}
              disabled={version.id === viewing}
              render={<Link {...appletLink(name, "code", version.id)} />}
            >
              view
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={version.id === applet.current_version}
              onClick={() => void rollback(version.id)}
            >
              rollback
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
