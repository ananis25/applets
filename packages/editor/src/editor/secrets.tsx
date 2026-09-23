import { useState, type FormEvent } from "react";
import { Button } from "@applets/ui/components/ui/button";
import { Input } from "@applets/ui/components/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ask } from "../ask.tsx";
import { call } from "../client.ts";
import { Failure } from "../failure.tsx";

/**
 * The applet's secrets, which its code reads with `secret("NAME")` from `@std`. Values go in and never
 * come back, so changing one means setting it again. A change reaches the applet on its next request.
 */
export function Secrets({ name }: { name: string }) {
  const client = useQueryClient();
  const [secret, setSecret] = useState("");
  const [value, setValue] = useState("");
  const queryKey = ["applet", name, "secrets"];

  const secrets = useQuery({
    queryKey,
    queryFn: () =>
      call((api) => api.secrets.list({ params: { name } })).then((data) => data.secrets),
  });

  const put = useMutation({
    mutationFn: () =>
      call((api) => api.secrets.put({ params: { name }, payload: { name: secret, value } })),
    onSuccess: () => {
      setSecret("");
      setValue("");

      return client.invalidateQueries({ queryKey });
    },
  });

  const remove = useMutation({
    mutationFn: (target: string) =>
      call((api) => api.secrets.remove({ params: { name }, query: { name: target } })),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });

  const save = (event: FormEvent) => {
    event.preventDefault();
    put.mutate();
  };

  const error = secrets.error ?? put.error ?? remove.error;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-card">
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide">Secrets</span>
        <span className="font-mono text-xs text-muted-foreground">
          read one with secret("NAME") from @std
        </span>
      </div>
      <form className="flex items-center gap-2 border-b border-border px-3 py-2" onSubmit={save}>
        <Input
          aria-label="Secret name"
          className="h-7 max-w-64 font-mono text-xs"
          placeholder="API_KEY"
          value={secret}
          onChange={(event) => setSecret(event.target.value.toUpperCase())}
        />
        <Input
          aria-label="Secret value"
          type="password"
          autoComplete="off"
          className="h-7 max-w-96 font-mono text-xs"
          placeholder="value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" size="xs" disabled={secret === "" || value === ""}>
          Set
        </Button>
      </form>
      <div className="min-h-0 flex-1 overflow-auto font-mono text-xs">
        <Failure className="m-3 w-auto" error={error} />
        {secrets.data?.length === 0 && <div className="p-3 text-muted-foreground">No secrets.</div>}
        {secrets.data?.map((entry) => (
          <div
            key={entry.name}
            className="flex items-center gap-3 border-b border-border/20 px-3 py-1"
          >
            <span className="w-64 shrink-0 truncate font-semibold">{entry.name}</span>
            <span className="flex-1 text-muted-foreground">
              set {new Date(entry.updated_at).toLocaleString()}
            </span>
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                void ask({
                  title: `Delete the secret ${entry.name}?`,
                  action: "Delete",
                  destructive: true,
                }).then((agreed) => agreed && remove.mutate(entry.name))
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
