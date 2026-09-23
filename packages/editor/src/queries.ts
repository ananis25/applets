/**
 * The router's data as TanStack Query options, for the queries more than one
 * page reads or a mutation refreshes. Every key about one applet starts with
 * `["applet", name]`, so invalidating that prefix refreshes all of it.
 */
import { QueryClient, queryOptions, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { Me } from "@applets/api";
import { call } from "./client.ts";

/** One client per page. Every failure shows at once, so nothing retries. */
export const newQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 10_000 } } });

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => call((api) => api.platform.me()),
});

export const appletsQuery = queryOptions({
  queryKey: ["applets"],
  queryFn: () => call((api) => api.applets.list()).then((data) => data.applets),
});

/** The registry row and the version list, newest first. */
export const appletQuery = (name: string) =>
  queryOptions({
    queryKey: ["applet", name],
    queryFn: () => call((api) => api.applets.get({ params: { name } })),
  });

/** One version's source, or with no version the draft if there is one, else the live source. */
export const filesQuery = (name: string, version: number | null) =>
  queryOptions({
    queryKey: ["applet", name, "files", version],
    queryFn: async () => {
      if (version !== null) {
        const { files } = await call((api) =>
          api.versions.source({ params: { name }, query: { version } }),
        );

        return { files, hasDraft: false, draftUpdatedAt: null };
      }

      const draft = await call((api) => api.applets.draft({ params: { name } }));

      if (draft.files !== null) {
        return { files: draft.files, hasDraft: true, draftUpdatedAt: draft.updated_at };
      }

      const live = await call((api) => api.versions.source({ params: { name }, query: {} }));

      return { files: live.files, hasDraft: false, draftUpdatedAt: null };
    },
  });

/** Who is signed in: `data` once the router has answered, `error` when it would not. */
export function useMe(): UseQueryResult<Me> {
  return useQuery(meQuery);
}
