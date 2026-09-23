import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@applets/ui/components/ui/command";
import { create } from "zustand";
import { useNavigate } from "@tanstack/react-router";
import { appletLink } from "../urls.ts";
import { openFile, useStore } from "../store.ts";

const usePalette = create<{ open: boolean }>()(() => ({ open: false }));

export function openPalette() {
  usePalette.setState({ open: true });
}

/** Substring hits first, basename above full path, then subsequence so "srindx" still finds "src/index.js". */
function score(candidate: string, query: string): number {
  const lower = candidate.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  const inBase = base.indexOf(query);

  if (inBase >= 0) return 1000 - inBase;
  const inPath = lower.indexOf(query);

  if (inPath >= 0) return 500 - Math.min(inPath, 400);
  let i = 0;

  for (const ch of lower) if (ch === query[i]) i++;

  return i === query.length ? 1 : -1;
}

/** Go to file: ⌘P opens it, type to filter, arrows and Enter pick the file on the Code page. */
export function Palette({ name }: { name: string }) {
  const open = usePalette((state) => state.open);
  const files = useStore((state) => state.files);
  const version = useStore((state) => state.version);
  const navigate = useNavigate();
  const close = () => usePalette.setState({ open: false });

  const pick = (path: string) => {
    close();
    openFile(path);
    void navigate(appletLink(name, "code", version));
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => !next && close()}
      title="Go to file"
      description="Type to filter the applet's files"
    >
      <Command filter={(path, query) => Math.max(score(path, query.trim().toLowerCase()), 0)}>
        <CommandInput placeholder="Go to file…" />
        <CommandList className="font-mono text-xs">
          <CommandEmpty>No file matches.</CommandEmpty>
          {[...files.keys()].map((path) => (
            <CommandItem key={path} value={path} onSelect={pick}>
              <span>{path.split("/").pop()}</span>
              <span className="text-muted-foreground">
                {path.split("/").slice(0, -1).join("/")}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
