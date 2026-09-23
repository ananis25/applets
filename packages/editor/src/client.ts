/**
 * The admin API from the page: the client `@applets/api` derives, called as a
 * Promise with every failure as an `Error` whose message the pages show.
 */
import { api, BuildFailed } from "@applets/api";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { create } from "zustand";

/** `fetch` is looked up on every call, so a test's stub on `globalThis.fetch` is the one used. */
const http = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch, (input, init) => globalThis.fetch(input, init)),
  ),
);

const client = Effect.runSync(
  HttpApiClient.make(api, { baseUrl: new URL("/api", location.origin) }).pipe(Effect.provide(http)),
);

export type Api = typeof client;

type Failure = { readonly _tag: string; readonly message: string };

/** How many calls are in flight, which the loading bar shows. A `quiet` call is not counted. */
export const usePending = create<number>()(() => 0);

const count = (by: number) => usePending.setState((pending) => pending + by, true);

/**
 * One call. A refused or unreachable request becomes an Error carrying the router's message lines.
 * Background polling passes `quiet`, so the loading bar only shows for what the user is waiting on.
 */
export const call = <A, E extends Failure>(
  request: (api: Api) => Effect.Effect<A, E>,
  options: { readonly quiet?: boolean } = {},
): Promise<A> => {
  const by = options.quiet === true ? 0 : 1;
  count(by);

  return Effect.runPromise(
    request(client).pipe(
      Effect.mapError(
        (failure) =>
          new Error(failure instanceof BuildFailed ? failure.errors.join("\n") : failure.message),
      ),
    ),
  ).finally(() => count(-by));
};

/** The download link of one blob, for an anchor rather than a call. */
export const blobUrl = (name: string, key: string) =>
  `/api/applets/${name}/blob?key=${encodeURIComponent(key)}`;
