import { useState } from "react";
import { Button } from "@applets/ui/components/ui/button";
import { Input } from "@applets/ui/components/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "../ask.tsx";
import { call } from "../client.ts";
import { Failure } from "../failure.tsx";

/** The applet's `kv` keys with their values as JSON, filtered by prefix. The first 500 keys show. */
export function Kv({ name }: { name: string }) {
  const client = useQueryClient();
  const [prefix, setPrefix] = useState("");

  const entries = useQuery({
    queryKey: ["applet", name, "kv", prefix],
    queryFn: () =>
      call((api) => api.storage.kv({ params: { name }, query: { prefix } })).then(
        (data) => data.entries,
      ),
  });

  const remove = useMutation({
    mutationFn: (key: string) =>
      call((api) => api.storage.removeKv({ params: { name }, query: { key } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["applet", name, "kv"] }),
  });

  const error = entries.error ?? remove.error;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-card">
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide">KV</span>
        <Input
          aria-label="Key prefix"
          className="h-7 max-w-64 font-mono text-xs"
          placeholder="prefix"
          value={prefix}
          onChange={(event) => setPrefix(event.target.value)}
        />
        <Button
          variant="outline"
          size="xs"
          className="ml-auto"
          onClick={() => void entries.refetch()}
        >
          refresh
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
        <Failure className="m-3 w-auto" error={error} retry={() => void entries.refetch()} />
        {entries.data?.length === 0 && <div className="p-3 text-muted-foreground">No keys.</div>}
        {entries.data?.map((entry) => (
          <div
            key={entry.key}
            className="flex items-start gap-3 border-b border-border/20 px-3 py-1"
          >
            <span className="w-64 shrink-0 truncate font-semibold" title={entry.key}>
              {entry.key}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{entry.value}</span>
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                void ask({
                  title: `Delete the key "${entry.key}"?`,
                  action: "Delete",
                  destructive: true,
                }).then((agreed) => agreed && remove.mutate(entry.key))
              }
            >
              delete
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
