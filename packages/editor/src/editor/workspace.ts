/** The open applet's buffer transitions, keyboard actions and mutations. */
import type { Files } from "@applets/api";
import { useEffect, useEffectEvent } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { ask } from "../ask.tsx";
import { call, type Api } from "../client.ts";
import { appletQuery, filesQuery } from "../queries.ts";
import { appletLink, type View } from "../urls.ts";
import {
  anyDirty,
  draftSnapshot,
  isCurrentDraft,
  load,
  markSaved,
  matchesSaved,
  setProblems,
  useStore,
  type DraftSnapshot,
} from "../store.ts";
import { openPalette } from "./palette.tsx";

/**
 * Keeps the buffer on the applet and version the URL names. A buffer with unsaved edits is
 * kept, or discarded only once the user agrees; a clean one follows the router's copy.
 */
export function useWorkspace(
  name: string,
  version: number | null,
  view: View,
  files: Files | undefined,
) {
  useShortcuts(name);
  const loaded = useStore((state) => state.applet === name && state.version === version);
  const navigate = useNavigate();

  // SYNC: the edit buffer, filled from the router's files.
  useEffect(() => {
    if (files === undefined) return;
    const state = useStore.getState();

    if (loaded && (anyDirty(state) || matchesSaved(state, files))) return;

    if (!loaded && state.applet !== null && anyDirty(state)) {
      const { applet, version: held } = state;

      let cancelled = false;

      void ask({
        title: `Discard unsaved changes to "${applet}"?`,
        description: "They are not saved as a draft and cannot be recovered.",
        action: "Discard",
        destructive: true,
      }).then((agreed) => {
        if (cancelled) return;

        if (agreed) load(name, version, files);
        else void navigate({ ...appletLink(applet, view, held), replace: true });
      });

      return () => {
        cancelled = true;
      };
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

/** Whether the applet has a save or deploy in progress, wherever it started. */
export const useWorking = (name: string) => useIsMutating({ mutationKey: ["workspace", name] }) > 0;

/** Whether a deploy is in progress, including one started from Settings. */
export const useDeploying = (name: string) =>
  useIsMutating({ mutationKey: ["workspace", name, "deploy"] }) > 0;

/** Saves a snapshot; later edits remain dirty, and a replacement buffer is left alone. */
export function useSaveDraft(name: string) {
  const client = useQueryClient();
  const working = useWorking(name);

  const mutation = useMutation({
    mutationKey: ["workspace", name, "save"],
    mutationFn: (draft: DraftSnapshot) =>
      call((api) => api.applets.saveDraft({ params: { name }, payload: { files: draft.files } })),
    onMutate: () => client.cancelQueries({ queryKey: filesQuery(name, null).queryKey }),
    onSuccess: ({ updated_at }, draft) => {
      if (isCurrentDraft(draft)) {
        client.setQueryData(filesQuery(name, null).queryKey, {
          files: draft.files,
          hasDraft: true,
          draftUpdatedAt: updated_at,
        });
        markSaved(draft.files);
      } else void client.invalidateQueries({ queryKey: filesQuery(name, null).queryKey });
      toast("draft saved");
    },
    onError: (error) => toast.error(error.message),
  });

  return () => {
    if (working || !anyDirty()) return;
    const draft = draftSnapshot(name);

    if (draft !== undefined) mutation.mutate(draft);
  };
}

/** Deploys the submitted draft and attributes success or failure to that editing session. */
export function useDeploy(name: string) {
  const client = useQueryClient();
  const router = useRouter();
  const working = useWorking(name);

  const mutation = useMutation({
    mutationKey: ["workspace", name, "deploy"],
    mutationFn: ({ draft, fresh }: { draft: DraftSnapshot; fresh: boolean }) =>
      call((api) =>
        api.versions.deploy({
          params: { name },
          query: { fresh: fresh || undefined },
          payload: { files: draft.files },
        }),
      ),
    onMutate: () => client.cancelQueries({ queryKey: filesQuery(name, null).queryKey }),
    onSuccess: (result, { draft }) => {
      if (isCurrentDraft(draft)) {
        client.setQueryData(filesQuery(name, null).queryKey, {
          files: draft.files,
          hasDraft: false,
          draftUpdatedAt: null,
        });
        markSaved(draft.files);
        setProblems((result.warnings ?? []).map((text) => ({ kind: "warning", text })));
      }

      void client.invalidateQueries({ queryKey: ["applet", name] });
      void client.invalidateQueries({ queryKey: ["applets"] });
      const exports = result.exports.join(", ") || "none";
      const installed = result.installed.join(", ") || "none";
      toast(`v${result.version} deployed · exports ${exports} · installed ${installed}`);
    },
    onError: (error, { draft }) => {
      if (isCurrentDraft(draft)) {
        setProblems(error.message.split("\n").map((text) => ({ kind: "error", text })));
        void router.navigate(appletLink(name));
      }

      toast.error("deploy failed");
    },
  });

  return {
    deploy: (fresh: boolean) => {
      if (working) return;
      const draft = draftSnapshot(name);

      if (draft !== undefined) mutation.mutate({ draft, fresh });
    },
  };
}

type Patch = Parameters<Api["applets"]["patch"]>[0]["payload"];

/** Changes the registry row; the cached row takes the router's answer. */
export function usePatchApplet(name: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (payload: Patch) =>
      call((api) => api.applets.patch({ params: { name }, payload })).then((data) => data.applet),
    onSuccess: (next) => {
      client.setQueryData(appletQuery(next.name).queryKey, (held) =>
        held === undefined ? undefined : { ...held, applet: next },
      );
      void client.invalidateQueries({ queryKey: ["applets"] });
    },
  });
}
