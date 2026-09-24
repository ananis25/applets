import { useRef, useState } from "react";
import { Button } from "@applets/ui/components/ui/button";
import { Input } from "@applets/ui/components/ui/input";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ask } from "../ask.tsx";
import { blobUrl, call } from "../client.ts";
import { Failure } from "../failure.tsx";
import { relTime } from "../urls.ts";

const size = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;

  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/** The applet's blobs by key prefix, a page at a time: upload one under the prefix, download or delete one. */
export function Blobs({ name }: { name: string }) {
  const client = useQueryClient();
  const [prefix, setPrefix] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  const pages = useInfiniteQuery({
    queryKey: ["applet", name, "blobs", prefix],
    queryFn: ({ pageParam }) =>
      call((api) => api.storage.blobs({ params: { name }, query: { prefix, cursor: pageParam } })),
    // SAFETY: the first page has no cursor; later ones are the cursor the page before returned.
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor ?? undefined,
  });

  const remove = useMutation({
    mutationFn: (key: string) =>
      call((api) => api.storage.removeBlob({ params: { name }, query: { key } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["applet", name, "blobs"] }),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const payload = new Uint8Array(await file.arrayBuffer());

      return call((api) =>
        api.storage.putBlob({
          params: { name },
          query: { key: `${prefix}${file.name}`, content_type: file.type || undefined },
          payload,
        }),
      );
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["applet", name, "blobs"] }),
  });

  const blobs = pages.data?.pages.flatMap((page) => page.blobs);
  const error = pages.error ?? remove.error ?? upload.error;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-card">
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide">Blobs</span>
        <Input
          aria-label="Key prefix"
          className="h-7 max-w-64 font-mono text-xs"
          placeholder="prefix"
          value={prefix}
          onChange={(event) => setPrefix(event.target.value)}
        />
        <input
          ref={picker}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";

            if (file !== undefined) upload.mutate(file);
          }}
        />
        <Button
          variant="outline"
          size="xs"
          className="ml-auto"
          title="Store a file under the prefix, keyed by its name"
          disabled={upload.isPending}
          onClick={() => picker.current?.click()}
        >
          upload
        </Button>
        <Button variant="outline" size="xs" onClick={() => void pages.refetch()}>
          refresh
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
        <Failure className="m-3 w-auto" error={error} retry={() => void pages.refetch()} />
        {blobs?.length === 0 && <div className="p-3 text-muted-foreground">No blobs.</div>}
        {blobs?.map((blob) => (
          <div
            key={blob.key}
            className="flex items-center gap-3 border-b border-border/20 px-3 py-1"
          >
            <a
              className="min-w-0 flex-1 truncate underline"
              href={blobUrl(name, blob.key)}
              download
              title={blob.key}
            >
              {blob.key}
            </a>
            <span className="w-40 truncate text-muted-foreground">{blob.content_type}</span>
            <span className="w-20 text-right">{size(blob.size)}</span>
            <span className="w-16 text-right text-muted-foreground">
              {relTime(blob.uploaded_at)}
            </span>
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                void ask({
                  title: `Delete the blob "${blob.key}"?`,
                  action: "Delete",
                  destructive: true,
                }).then((agreed) => agreed && remove.mutate(blob.key))
              }
            >
              delete
            </Button>
          </div>
        ))}
        {pages.hasNextPage && (
          <Button
            variant="outline"
            size="xs"
            className="m-3"
            onClick={() => void pages.fetchNextPage()}
          >
            more
          </Button>
        )}
      </div>
    </section>
  );
}
