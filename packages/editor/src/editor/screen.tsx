import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useEffectEvent, useRef } from "react";
import type { Files } from "@applets/api";
import { ask } from "../ask.tsx";
import { Failure } from "../failure.tsx";
import { appletQuery, filesQuery } from "../queries.ts";
import { AppletRail, RailFrame } from "../rail.tsx";
import { appletLink, isStream, type View } from "../urls.ts";
import { anyDirty, isDirty, load, matchesSaved, useStore } from "../store.ts";
import { Blobs } from "./blobs.tsx";
import { Kv } from "./kv.tsx";
import { useSaveDraft } from "./mutations.ts";
import { Palette, openPalette } from "./palette.tsx";
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

/**
 * Keeps the buffer on the applet and version the URL names. A buffer with unsaved edits is
 * kept, or discarded only once the user agrees; a clean one follows the router's copy.
 */
function useBuffer(name: string, version: number | null, view: View, files: Files | undefined) {
  const loaded = useStore((state) => state.applet === name && state.version === version);
  const navigate = useNavigate();
  const asking = useRef(false);

  // SYNC: the edit buffer, filled from the router's files.
  useEffect(() => {
    if (files === undefined || asking.current) return;
    const state = useStore.getState();

    if (loaded && (anyDirty(state) || matchesSaved(state, files))) return;

    if (!loaded && state.applet !== null && anyDirty(state)) {
      const { applet, version: held } = state;
      asking.current = true;

      void ask({
        title: `Discard unsaved changes to "${applet}"?`,
        description: "They are not saved as a draft and cannot be recovered.",
        action: "Discard",
        destructive: true,
      }).then((agreed) => {
        asking.current = false;

        if (agreed) load(name, version, files);
        else void navigate({ ...appletLink(applet, view, held), replace: true });
      });

      return;
    }

    load(name, version, files);
  }, [name, version, view, files, loaded, navigate]);

  return loaded;
}

/** ⌘S saves and ⌘P goes to a file, wherever focus is. */
function useShortcuts(name: string) {
  const save = useSaveDraft(name);

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();

    if (key !== "s" && key !== "p") return;
    event.preventDefault();

    if (key === "s") save();
    else openPalette();
  });

  // SYNC: the document's keydown listener, registered once; `onKey` always sees the latest `save`.
  useEffect(() => {
    document.addEventListener("keydown", onKey, true);

    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
}

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
  const loaded = useBuffer(name, version, view, files.data?.files);
  useShortcuts(name);

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
    <div className="flex h-full flex-col bg-background">
      <title>{`${name} — applets`}</title>
      <Topbar name={name} view={view} />
      <RailFrame className="flex-1">
        <AppletRail name={name} version={version} />
        <main className="flex min-w-0 flex-1">
          {view === "code" && <CodePage name={name} />}
          {isStream(view) && <Stream name={name} view={view} version={version} />}
          {view === "sqlite" && <Sqlite name={name} />}
          {view === "kv" && <Kv name={name} />}
          {view === "blobs" && <Blobs name={name} />}
          {view === "secrets" && <Secrets name={name} />}
          {view === "versions" && <Versions name={name} />}
          {view === "settings" && <Settings name={name} />}
        </main>
      </RailFrame>
      <Palette name={name} />
    </div>
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

  return (
    <>
      <Tree />
      <section className="flex min-w-0 flex-1 flex-col border-x border-border bg-card">
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
