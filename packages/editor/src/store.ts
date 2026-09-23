/**
 * The edit buffer: the open applet's files as the user edits them, and the
 * code page's own UI. What the router owns lives in TanStack Query (see
 * `queries.ts`), and which page and version show is the URL's.
 *
 * File text lives in `files`; `saved` is the copy the router has. A file is
 * dirty when the two differ, so there is no per-file bookkeeping. The buffer
 * belongs to `applet` at `version`, null for the current draft or source, and
 * outlives visits to other pages, so unsaved edits survive.
 */
import { create } from "zustand";
import type { Files } from "@applets/api";

export type Problem = { kind: "error" | "warning"; text: string };

export type State = {
  applet: string | null;
  version: number | null;
  files: Map<string, string>;
  saved: Map<string, string>;
  /** Bumped whenever `files` is replaced wholesale, so the code pane starts a fresh edit session. */
  generation: number;
  openFiles: string[];
  activeFile: string | null;
  problems: Problem[];
  previewOpen: boolean;
  previewPath: string;
};

const initial: State = {
  applet: null,
  version: null,
  files: new Map(),
  saved: new Map(),
  generation: 0,
  openFiles: [],
  activeFile: null,
  problems: [],
  previewOpen: false,
  previewPath: "/",
};

export const useStore = create<State>()(() => initial);

const { getState, setState } = useStore;

export function isDirty(state: State, path: string): boolean {
  return state.files.get(path) !== state.saved.get(path);
}

export function anyDirty(state: State = getState()): boolean {
  for (const path of state.files.keys()) if (isDirty(state, path)) return true;

  for (const path of state.saved.keys()) if (!state.files.has(path)) return true;

  return false;
}

/** Whether `files` is what the buffer last had from the router. */
export function matchesSaved(state: State, files: Files): boolean {
  const entries = Object.entries(files);

  return (
    entries.length === state.saved.size &&
    entries.every(([path, text]) => state.saved.get(path) === text)
  );
}

/* ------------------------ session ------------------------ */

type Session = { open: string[]; active: string | null };

const sessionKey = (name: string) => `applets.session:${name}`;

function readSession(name: string): Session | null {
  try {
    const raw = localStorage.getItem(sessionKey(name));

    // SAFETY: only `saveSession` writes this key, and a stale shape just opens no files.
    return raw === null ? null : (JSON.parse(raw) as Session);
  } catch {
    return null;
  }
}

function saveSession() {
  const { applet, version, openFiles, activeFile } = getState();

  if (!applet || version !== null) return;

  try {
    const session: Session = { open: openFiles, active: activeFile };
    localStorage.setItem(sessionKey(applet), JSON.stringify(session));
  } catch {
    /* private mode; nothing to do */
  }
}

/* ------------------------ files ------------------------ */

/** Replaces the buffer with an applet's files and reopens the tabs its last session had. */
export function load(applet: string, version: number | null, files: Files) {
  const map = new Map(Object.entries(files));
  const state = getState();

  setState({
    applet,
    version,
    files: map,
    saved: new Map(map),
    generation: state.generation + 1,
    openFiles: [],
    activeFile: null,
    problems: state.applet === applet ? state.problems : [],
  });

  const session = version === null ? readSession(applet) : null;
  const reopened = session?.open.filter((path) => map.has(path)) ?? [];

  if (reopened.length > 0) {
    const active = session?.active && reopened.includes(session.active) ? session.active : null;
    setState({ openFiles: reopened, activeFile: active ?? reopened[0]! });
  } else if (map.has("main.ts")) openFile("main.ts");
  else if (map.size) openFile(map.keys().next().value!);
}

export function openFile(path: string) {
  const state = getState();

  if (!state.files.has(path)) return;
  const openFiles = state.openFiles.includes(path) ? state.openFiles : [...state.openFiles, path];
  setState({ openFiles, activeFile: path });
  saveSession();
}

/** The code pane reports every edit here; `files` is the live text. */
export function updateFile(path: string, content: string) {
  const state = getState();

  if (state.files.get(path) === content) return;
  const files = new Map(state.files);
  files.set(path, content);
  setState({ files });
}

/** Closes a tab and drops its unsaved changes; a file the router never had goes with it. */
export function closeFile(path: string) {
  const state = getState();
  const files = new Map(state.files);
  const saved = state.saved.get(path);

  if (saved === undefined) files.delete(path);
  else files.set(path, saved);
  closeTab(path, files);
}

/** Takes the file out of the buffer; the deletion reaches the router on the next save or deploy. */
export function deleteFile(path: string) {
  const files = new Map(getState().files);
  files.delete(path);
  closeTab(path, files);
}

function closeTab(path: string, files: Map<string, string>) {
  const state = getState();
  const openFiles = state.openFiles.filter((open) => open !== path);
  const activeFile = state.activeFile === path ? (openFiles[0] ?? null) : state.activeFile;
  setState({ openFiles, files, activeFile });
  saveSession();
}

/** Opens `path`, adding it empty when the buffer has no such file. */
export function addFile(path: string) {
  const state = getState();

  if (!state.files.has(path)) setState({ files: new Map(state.files).set(path, "") });
  openFile(path);
}

/** After a save or deploy the router has `files`; edits made while it ran stay dirty. */
export function markSaved(files: Files) {
  setState({ saved: new Map(Object.entries(files)) });
}

/** The applet's new name, so the buffer stays open across a rename. */
export function renameBuffer(applet: string) {
  setState({ applet });
}

/** Forgets the open applet, unsaved edits included. */
export function closeEditor() {
  const { previewOpen } = getState();
  setState({ ...initial, previewOpen, generation: getState().generation + 1 });
}

/* ------------------------ problems, preview ------------------------ */

export function setProblems(problems: Problem[]) {
  setState({ problems });
}

export function clearProblems() {
  setState({ problems: [] });
}

export function togglePreview(open = !getState().previewOpen) {
  setState({ previewOpen: open });
}

export function setPreviewPath(previewPath: string) {
  setState({ previewPath });
}
