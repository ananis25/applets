import { indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { updateFile, useStore } from "../store.ts";

/** Highlighting by file extension, for the kinds of file an applet holds. */
const languages = new Map<string, () => Extension>([
  ["ts", () => javascript({ typescript: true })],
  ["tsx", () => javascript({ typescript: true, jsx: true })],
  ["js", () => javascript()],
  ["jsx", () => javascript({ jsx: true })],
  ["html", () => html()],
  ["css", () => css()],
  ["json", () => json()],
  ["md", () => markdown()],
  ["xml", () => xml()],
  ["svg", () => xml()],
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--font-mono)" },
});

/** A file's editor state, with its own undo history, from the store's text. */
const stateFor = (path: string, readOnly: boolean) =>
  EditorState.create({
    doc: useStore.getState().files.get(path) ?? "",
    extensions: [
      basicSetup,
      keymap.of([indentWithTab]),
      languages.get(path.split(".").pop() ?? "")?.() ?? [],
      theme,
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) updateFile(path, update.state.doc.toString());
      }),
    ],
  });

/**
 * The code pane: one CodeMirror view, switched between the open files' states,
 * so each file keeps its undo history. The store holds the text; each change
 * reports back through `updateFile`. The states are dropped whenever the store
 * reloads files (the generation) or the pane turns read-only.
 */
export function Code() {
  const applet = useStore((state) => state.applet);
  const activeFile = useStore((state) => state.activeFile);
  const generation = useStore((state) => state.generation);
  const readOnly = useStore((state) => state.version !== null);
  const parent = useRef<HTMLDivElement>(null);
  const states = useRef(new Map<string, EditorState>());
  const view = useRef<EditorView>(null);

  // SYNC: the CodeMirror view; the states go with it.
  useEffect(() => {
    if (parent.current === null) return;
    states.current = new Map();
    const editor = new EditorView({ parent: parent.current });
    view.current = editor;

    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [applet, generation, readOnly]);

  // SYNC: which file's state the view shows; the file's state is kept when another takes its place.
  useEffect(() => {
    const editor = view.current;

    if (activeFile === null || editor === null) return;
    editor.setState(states.current.get(activeFile) ?? stateFor(activeFile, readOnly));
    editor.focus();

    return () => {
      states.current.set(activeFile, editor.state);
    };
  }, [activeFile, readOnly]);

  return (
    <>
      {activeFile === null && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No file open
        </div>
      )}
      <div
        ref={parent}
        className={activeFile === null ? "hidden" : "min-h-0 flex-1 overflow-hidden bg-card"}
      />
    </>
  );
}
