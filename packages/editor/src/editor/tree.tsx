import { Button } from "@applets/ui/components/ui/button";
import { Card } from "@applets/ui/components/ui/card";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { ask, askText } from "../ask.tsx";
import { addFile, deleteFile, isDirty, openFile, useStore } from "../store.ts";

// SAFETY: custom properties are valid inline styles; React's type only lists the standard ones.
const treeStyle = {
  "--trees-theme-list-active-selection-bg": "var(--main)",
  "--trees-theme-list-hover-bg": "var(--background)",
  "--trees-theme-focus-ring": "var(--border)",
} as React.CSSProperties;

/** Asks for a path and opens that file, new and empty unless it exists. */
async function add() {
  const typed = await askText({
    title: "New file",
    action: "Open",
    input: { label: "Path inside the applet, like lib/util.ts" },
  });

  const path = typed?.replace(/^\/+/, "");

  if (!path) return;

  if (useStore.getState().files.has(path)) toast(`${path} already exists`);
  addFile(path);
}

/** The file list on Pierre's tree: click opens, right-click deletes, the active file is selected. */
export function Tree() {
  const files = useStore((state) => state.files);
  const activeFile = useStore((state) => state.activeFile);
  const viewing = useStore((state) => state.version !== null);

  const dirty = useStore(
    useShallow((state) => [...state.files.keys()].filter((path) => isDirty(state, path))),
  );

  const paths = [...files.keys()].sort().join("\n");

  const { model } = useFileTree({
    paths: paths.split("\n"),
    initialExpansion: "open",
    density: "compact",
    icons: "minimal",
    composition: { contextMenu: { enabled: true, triggerMode: "right-click" } },
    onSelectionChange(selected) {
      const path = selected[0];

      if (path && model.getItem(path)?.isDirectory() === false) openFile(path);
    },
  });

  // SYNC: the tree model's paths.
  useEffect(() => {
    model.resetPaths(paths ? paths.split("\n") : []);
  }, [model, paths]);

  // SYNC: the tree model's selection.
  useEffect(() => {
    for (const path of model.getSelectedPaths()) {
      if (path !== activeFile) model.getItem(path)?.deselect();
    }

    if (activeFile) model.getItem(activeFile)?.select();
  }, [model, activeFile, paths]);

  // SYNC: the tree model's modified marks.
  useEffect(() => {
    const modified = dirty;
    model.setGitStatus(modified.map((path) => ({ path, status: "modified" })));
  }, [model, dirty]);

  return (
    <aside className="flex w-56 shrink-0 flex-col bg-background">
      <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide">
        Files
        <Button
          variant="outline"
          size="icon-xs"
          disabled={viewing}
          onClick={() => void add()}
          title="Add a file"
        >
          +
        </Button>
      </div>
      <FileTree
        model={model}
        className="min-h-0 flex-1 font-mono text-xs"
        style={treeStyle}
        renderContextMenu={(item, context) =>
          item.kind === "file" && !viewing ? (
            <Card size="sm" className="p-1">
              <Button
                variant="destructive"
                size="xs"
                onClick={() => {
                  context.close();

                  void ask({
                    title: `Delete ${item.path}?`,
                    description: "It goes on the next save or deploy.",
                    action: "Delete",
                    destructive: true,
                  }).then((agreed) => agreed && deleteFile(item.path));
                }}
              >
                Delete {item.name}
              </Button>
            </Card>
          ) : null
        }
      />
    </aside>
  );
}
