/** Per-applet object storage: one shared R2 bucket, keys prefixed with the applet's id on this side of the RPC. */
import type { BlobList, BlobObject, Blobs as BlobsCapability } from "@applets/api/capabilities";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect } from "effect";

import { Bucket } from "./bindings.ts";
import { run } from "./runtime.ts";
import type { AppletProps } from "./types.ts";

export class Blobs
  extends WorkerEntrypoint<Cloudflare.Env, AppletProps>
  implements BlobsCapability
{
  /** The stored value, or null when the key does not exist. */
  get(key: string): Promise<BlobObject | null> {
    const stored = this.key(key);

    return run(
      this.env,
      this.ctx,
      Effect.gen(function* () {
        const bucket = yield* Bucket;
        const object = yield* bucket.get(stored);

        if (object === null) return null;

        return {
          body: yield* Effect.promise(() => object.arrayBuffer()),
          contentType: object.httpMetadata?.contentType,
        };
      }),
    );
  }

  put(key: string, body: ArrayBuffer, contentType?: string): Promise<void> {
    return run(
      this.env,
      this.ctx,
      Bucket.use((bucket) => bucket.put(this.key(key), body, contentType)).pipe(Effect.asVoid),
    );
  }

  /** Keys under the prefix in sorted order, at most `limit` of them. */
  list(prefix: string, limit: number): Promise<BlobList> {
    const namespace = this.namespace();

    return run(
      this.env,
      this.ctx,
      Effect.gen(function* () {
        const bucket = yield* Bucket;
        const keys: Array<string> = [];
        let cursor: string | undefined;
        let truncated = false;

        do {
          const page = yield* bucket.list({
            prefix: `${namespace}${prefix}`,
            cursor,
            limit: Math.min(1000, limit - keys.length),
          });

          for (const object of page.objects) keys.push(object.key.slice(namespace.length));

          truncated = page.truncated;
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor !== undefined && keys.length < limit);

        return { keys, truncated };
      }),
    );
  }

  delete(key: string): Promise<void> {
    return run(
      this.env,
      this.ctx,
      Bucket.use((bucket) => bucket.delete(this.key(key))),
    );
  }

  private namespace(): string {
    return `${this.ctx.props.id}/`;
  }

  private key(key: string): string {
    return `${this.namespace()}${key}`;
  }
}
