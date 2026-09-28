import { useState } from "react";
import { Button } from "@applets/ui/components/ui/button";
import { RotateCwIcon, XIcon } from "lucide-react";
import { Hint } from "../hint.tsx";
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
    <aside className="fixed inset-0 z-40 flex flex-col bg-background md:static md:w-2/5 md:shrink-0">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1">
        <Button
          variant="link"
          size="xs"
          className="min-w-0 justify-start px-0 font-mono"
          render={<a href={base} target="_blank" rel="noopener" />}
        >
          <span className="truncate">{base}</span>
        </Button>
        <Input
          className="h-7 flex-1 font-mono text-xs"
          value={path}
          onChange={(event) => setPreviewPath(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && reload()}
        />
        <Hint label="Reload">
          <Button variant="outline" size="icon-xs" onClick={reload}>
            <RotateCwIcon />
          </Button>
        </Hint>
        <Hint label="Close">
          <Button variant="outline" size="icon-xs" onClick={() => togglePreview(false)}>
            <XIcon />
          </Button>
        </Hint>
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
