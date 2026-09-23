import { Button } from "@applets/ui/components/ui/button";
import { Tabs as FileTabs, TabsList, TabsTrigger } from "@applets/ui/components/ui/tabs";
import { XIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { ask } from "../ask.tsx";
import { closeFile, isDirty, openFile, useStore } from "../store.ts";

/** One tab per open file; the dot marks unsaved changes. */
export function Tabs() {
  const openFiles = useStore((state) => state.openFiles);
  const activeFile = useStore((state) => state.activeFile);

  const dirty = useStore(
    useShallow((state) => state.openFiles.filter((path) => isDirty(state, path))),
  );

  const close = async (path: string) => {
    if (isDirty(useStore.getState(), path)) {
      const agreed = await ask({
        title: `Discard unsaved changes to ${path}?`,
        action: "Discard",
        destructive: true,
      });

      if (!agreed) return;
    }

    closeFile(path);
  };

  return (
    <FileTabs
      value={activeFile}
      onValueChange={(path) => openFile(path)}
      className="border-b border-border bg-background"
    >
      <TabsList
        variant="line"
        className="h-9 w-full justify-start overflow-x-auto font-mono text-xs"
      >
        {openFiles.map((path) => (
          <div key={path} title={path} className="flex items-center">
            <TabsTrigger value={path} className="text-xs">
              {path.split("/").pop()}
            </TabsTrigger>
            {dirty.includes(path) && <span title="unsaved">●</span>}
            <Button variant="ghost" size="icon-xs" title="close" onClick={() => void close(path)}>
              <XIcon />
            </Button>
          </div>
        ))}
      </TabsList>
    </FileTabs>
  );
}
