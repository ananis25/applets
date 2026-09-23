/**
 * The applet changes more than one part of the editor starts: saving the draft,
 * deploying, and patching the registry row. Each updates the query cache and
 * the buffer, and says how it went in a toast.
 */
import type { Files } from "@applets/api";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRouter } from "@tanstack/react-router";
import { call, type Api } from "../client.ts";
import { appletQuery, filesQuery } from "../queries.ts";
import { appletLink } from "../urls.ts";
import { anyDirty, markSaved, setProblems, useStore } from "../store.ts";

const bufferFiles = (): Files => Object.fromEntries(useStore.getState().files);

/** Whether the buffer still holds `name`'s draft; a call that outlives a visit must not touch another applet's. */
const holds = (name: string) => {
  const state = useStore.getState();

  return state.applet === name && state.version === null;
};

/** Saves the buffer as the applet's draft, when there is anything to save. */
export function useSaveDraft(name: string) {
  const client = useQueryClient();

  const { mutate } = useMutation({
    mutationFn: (files: Files) =>
      call((api) => api.applets.saveDraft({ params: { name }, payload: { files } })),
    onSuccess: ({ updated_at }, files) => {
      if (holds(name)) markSaved(files);
      client.setQueryData(filesQuery(name, null).queryKey, {
        files,
        hasDraft: true,
        draftUpdatedAt: updated_at,
      });
      toast("draft saved");
    },
    onError: (error) => toast.error(error.message),
  });

  return () => {
    const state = useStore.getState();

    if (state.version === null && anyDirty(state)) mutate(bufferFiles());
  };
}

/** Whether a deploy of the applet is running, wherever it started. */
export const useDeploying = (name: string) => useIsMutating({ mutationKey: ["deploy", name] }) > 0;

/** Deploys the buffer. `fresh` also resolves the dependencies from npm again. A failed build lists its errors under the code. */
export function useDeploy(name: string) {
  const client = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationKey: ["deploy", name],
    mutationFn: async (fresh: boolean) => {
      if (!holds(name)) throw new Error("A version being viewed can't be deployed");
      const files = bufferFiles();

      const result = await call((api) =>
        api.versions.deploy({
          params: { name },
          query: { fresh: fresh || undefined },
          payload: { files },
        }),
      );

      return { result, files };
    },
    onSuccess: ({ result, files }) => {
      if (holds(name)) {
        markSaved(files);
        setProblems((result.warnings ?? []).map((text) => ({ kind: "warning", text })));
      }

      void client.invalidateQueries({ queryKey: ["applet", name] });
      void client.invalidateQueries({ queryKey: ["applets"] });
      const exports = result.exports.join(", ") || "none";
      const installed = result.installed.join(", ") || "none";
      toast(`v${result.version} deployed · exports ${exports} · installed ${installed}`);
    },
    onError: (error) => {
      if (holds(name)) {
        setProblems(error.message.split("\n").map((text) => ({ kind: "error", text })));
      }

      toast.error("deploy failed");
      void router.navigate(appletLink(name));
    },
  });
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
