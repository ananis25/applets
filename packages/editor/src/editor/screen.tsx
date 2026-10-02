import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useState } from "react";
import { Button } from "@applets/ui/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@applets/ui/components/ui/sheet";
import { Failure } from "../failure.tsx";
import { appletQuery, filesQuery } from "../queries.ts";
import { AppletRail, RailFrame } from "../rail.tsx";
import { isStream, type View } from "../urls.ts";
import { isDirty, useStore } from "../store.ts";
import { Blobs } from "./blobs.tsx";
import { Kv } from "./kv.tsx";
import { useWorkspace } from "./workspace.ts";
import { Palette } from "./palette.tsx";
import { Preview } from "./preview.tsx";
import { Problems } from "./problems.tsx";
import { Secrets } from "./secrets.tsx";
import { Settings } from "./settings.tsx";
import { Sqlite } from "./sqlite.tsx";
import { Stream } from "./streams.tsx";
import { Tabs } from "./tabs.tsx";
import { Topbar, usePill } from "./topbar.tsx";
import { Tree } from "./tree.tsx";
import { Versions } from "./versions.tsx";

/** CodeMirror is most of the editor, so the code pane loads on its own, only once the code page shows. */
const Code = lazy(() => import("./code.tsx").then((module) => ({ default: module.Code })));

/** An open applet: top bar, left rail, and the page the URL names. The URL is the source; the buffer follows it. */
export function Screen({
  name,
  view,
  version,
}: {
  name: string;
  view: View;
  version: number | null;
}) {
  const applet = useQuery(appletQuery(name));
  const files = useQuery(filesQuery(name, version));
  const loaded = useWorkspace(name, version, view, files.data?.files);

  const error = (applet.data ? null : applet.error) ?? (files.data ? null : files.error);

  if (error !== null) {
    return <Failure className="m-10" title={`Can't open "${name}"`} error={error} />;
  }

  if (!loaded || applet.data === undefined) {
    return (
      <RailFrame>
        <AppletRail name={name} version={version} />
      </RailFrame>
    );
  }

  return (
    <RailFrame>
      <title>{`${name} — Applets`}</title>
      <AppletRail name={name} version={version} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar name={name} view={view} />
        <main className="flex min-h-0 min-w-0 flex-1">
          {view === "code" && <CodePage name={name} />}
          {isStream(view) && <Stream name={name} view={view} version={version} />}
          {view === "sqlite" && <Sqlite name={name} />}
          {view === "kv" && <Kv name={name} />}
          {view === "blobs" && <Blobs name={name} />}
          {view === "secrets" && <Secrets name={name} />}
          {view === "versions" && <Versions name={name} />}
          {view === "settings" && <Settings name={name} />}
        </main>
      </div>
      <Palette name={name} />
    </RailFrame>
  );
}

/** The status line: the state pill, then the open file, or the reason there is none. */
function StatusLine({ name }: { name: string }) {
  const pill = usePill(name);
  const viewing = useStore((state) => state.version !== null);
  const activeFile = useStore((state) => state.activeFile);

  const lines = useStore((state) =>
    state.activeFile === null ? 0 : (state.files.get(state.activeFile) ?? "").split("\n").length,
  );

  const dirty = useStore((state) => state.activeFile !== null && isDirty(state, state.activeFile));

  const detail = viewing
    ? "read only"
    : activeFile === null
      ? "⌘/Ctrl P to go to a file"
      : `${activeFile}  ·  ${lines} lines${dirty ? "  ·  ● unsaved" : ""}`;

  return (
    <div className="truncate border-t border-border px-3 py-1 font-mono text-xs">
      {pill}
      {viewing || activeFile === null ? " — " : "  ·  "}
      {detail}
    </div>
  );
}

function CodePage({ name }: { name: string }) {
  const previewOpen = useStore((state) => state.previewOpen);
  const [filesOpen, setFilesOpen] = useState(false);

  return (
    <>
      <div className="hidden md:flex">
        <Tree />
      </div>
      <section className="flex min-w-0 flex-1 flex-col border-x border-border bg-card">
        <div className="border-b p-1 md:hidden">
          <Sheet open={filesOpen} onOpenChange={setFilesOpen}>
            <SheetTrigger render={<Button variant="outline" size="sm" />}>Files</SheetTrigger>
            <SheetContent side="left" className="w-72 gap-0 p-0" showCloseButton={false}>
              <SheetHeader className="border-b">
                <SheetTitle>Files</SheetTitle>
              </SheetHeader>
              <Tree onOpenFile={() => setFilesOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>
        <Tabs />
        <Suspense fallback={<div className="flex-1" />}>
          <Code />
        </Suspense>
        <Problems />
        <StatusLine name={name} />
      </section>
      {previewOpen && <Preview name={name} />}
    </>
  );
}
