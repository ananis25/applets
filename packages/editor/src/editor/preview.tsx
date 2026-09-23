import { useState } from "react";
import { Button } from "@applets/ui/components/ui/button";
import { Input } from "@applets/ui/components/ui/input";
import { useSuspenseQuery } from "@tanstack/react-query";
import { appletQuery } from "../queries.ts";
import { liveUrl } from "../urls.ts";
import { setPreviewPath, togglePreview, useStore } from "../store.ts";

/** The live applet in an iframe. It reloads when the live version changes, and on request. */
export function Preview({ name }: { name: string }) {
  const path = useStore((state) => state.previewPath);
  const live = useSuspenseQuery(appletQuery(name)).data.applet.current_version;
  const [reloads, setReloads] = useState(0);
  const reload = () => setReloads((count) => count + 1);
  const base = liveUrl(name);

  return (
    <aside className="flex w-2/5 shrink-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        <a
          className="truncate font-mono text-xs underline"
          href={base}
          target="_blank"
          rel="noopener"
        >
          {base}
        </a>
        <Input
          className="h-7 flex-1 font-mono text-xs"
          value={path}
          onChange={(event) => setPreviewPath(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && reload()}
        />
        <Button variant="outline" size="icon-xs" onClick={reload} title="Reload">
          ↻
        </Button>
        <Button variant="outline" size="icon-xs" onClick={() => togglePreview(false)} title="Close">
          ×
        </Button>
      </div>
      <iframe
        key={`${live}:${reloads}`}
        className="min-h-0 flex-1 bg-white"
        src={base + path}
        title="preview"
      />
    </aside>
  );
}
