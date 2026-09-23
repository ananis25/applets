import { useState } from "react";
import { Button } from "@applets/ui/components/ui/button";
import { Input } from "@applets/ui/components/ui/input";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { visibilities, type Visibility } from "@applets/api";
import { ask, askText } from "../ask.tsx";
import { Failure } from "../failure.tsx";
import { call } from "../client.ts";
import { appletQuery, filesQuery } from "../queries.ts";
import { appletLink, liveUrl } from "../urls.ts";
import { closeEditor, renameBuffer, useStore } from "../store.ts";
import { download } from "./download.ts";
import { useDeploy, useDeploying, usePatchApplet } from "./mutations.ts";
import { zip } from "./zip.ts";

const audiences: Record<Visibility, string> = {
  private: "only you",
  family: "everyone who can sign in",
  public: "anyone, with no sign-in",
};

/** Saves the live version's source as `<name>-v<N>.zip`. */
async function downloadSource(name: string, version: number) {
  const { files } = await call((api) =>
    api.versions.source({ params: { name }, query: { version } }),
  );

  download(`${name}-v${version}.zip`, zip(files), "application/zip");
}

/** Removal behind the applet's typed name, since it takes the versions, logs and storage with it. */
function DangerZone({ name, onRemove }: { name: string; onRemove: () => void }) {
  const [typed, setTyped] = useState("");

  return (
    <div className="mt-auto flex flex-col gap-2 border-t border-border p-4">
      <h2 className="text-sm font-semibold text-destructive">Danger zone</h2>
      <p className="text-xs">
        Removing the applet deletes its versions, logs, secrets and storage. This can't be undone.
        Type <span className="font-mono font-semibold">{name}</span> to confirm.
      </p>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Applet name to confirm removal"
          className="h-8 max-w-64 font-mono text-xs"
          placeholder={name}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          disabled={typed !== name}
          onClick={onRemove}
        >
          Remove applet
        </Button>
      </div>
    </div>
  );
}

/** What the registry knows about the applet. The name, visibility, egress, schedule and email switch change here, a schedule fires on demand, and the source forks into a new applet. */
export function Settings({ name }: { name: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { applet: row, versions } = useSuspenseQuery(appletQuery(name)).data;
  const hasDraft = useQuery(filesQuery(name, null)).data?.hasDraft ?? false;
  const patch = usePatchApplet(name);
  const deploy = useDeploy(name);
  const deploying = useDeploying(name);
  const viewing = useStore((state) => state.version !== null);
  const [error, setError] = useState<string>();
  const url = liveUrl(name);
  const live = row.current_version;
  const installed = versions.find((version) => version.id === live)?.installed ?? [];

  const perform = (action: Promise<unknown>, onError?: () => void) => {
    setError(undefined);
    void action.catch((cause: unknown) => {
      onError?.();
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const rename = (next: string) =>
    patch.mutateAsync({ name: next }).then((applet) => {
      renameBuffer(applet.name);
      void navigate({ ...appletLink(applet.name, "settings"), replace: true });
      toast(`renamed to ${applet.name}`);
    });

  const fork = async () => {
    const next = await askText({
      title: "Fork the live version",
      description: "The new applet starts from this one's live source, with its own storage.",
      action: "Fork",
      input: { label: "Name of the new applet", initial: `${name}-copy` },
    });

    if (!next) return;

    perform(
      call((api) => api.applets.fork({ params: { name }, payload: { name: next } })).then(
        ({ applet }) => {
          void client.invalidateQueries({ queryKey: ["applets"] });
          void navigate(appletLink(applet.name));
        },
      ),
    );
  };

  const reResolve = async () => {
    const agreed = await ask({
      title: "Re-resolve the dependencies?",
      description:
        "The open files deploy as a new version with the dependencies resolved from npm again. Loose ranges may pick newer packages.",
      action: "Deploy",
    });

    if (agreed) deploy.mutate(true);
  };

  const discardDraft = async () => {
    const agreed = await ask({
      title: "Discard the saved draft?",
      description: "The editor reloads the deployed version.",
      action: "Discard",
      destructive: true,
    });

    if (!agreed) return;

    perform(
      call((api) => api.applets.discardDraft({ params: { name } })).then(() => {
        closeEditor();
        void client.invalidateQueries({ queryKey: filesQuery(name, null).queryKey });
        toast("draft discarded");
      }),
    );
  };

  const remove = () =>
    perform(
      call((api) => api.applets.remove({ params: { name } })).then(() => {
        closeEditor();
        client.removeQueries({ queryKey: ["applet", name] });
        void client.invalidateQueries({ queryKey: ["applets"] });
        void navigate({ to: "/applets" });
      }),
    );

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-card">
      <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide">
        Settings
      </div>
      <Failure className="m-4 w-auto" error={error} />
      <dl className="grid max-w-2xl grid-cols-[8rem_1fr] items-center gap-x-4 gap-y-3 p-4 text-sm">
        <dt className="font-semibold">Name</dt>
        <dd>
          <Input
            key={name}
            aria-label="Applet name"
            className="max-w-64 font-mono text-xs"
            defaultValue={name}
            onBlur={async (event) => {
              const input = event.currentTarget;
              const next = input.value.trim();

              const revert = () => {
                input.value = name;
              };

              if (next === name || next === "") return revert();

              const agreed = await ask({
                title: `Rename to ${next}?`,
                description: "The old hostname and email address stop working.",
                action: "Rename",
              });

              if (agreed) perform(rename(next), revert);
              else revert();
            }}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          />
        </dd>
        <dt className="font-semibold">URL</dt>
        <dd>
          <a className="font-mono text-xs underline" href={url} target="_blank" rel="noopener">
            {url}
          </a>
        </dd>
        <dt className="font-semibold">Description</dt>
        <dd>
          <Input
            key={row.description}
            defaultValue={row.description}
            placeholder="one line on what it does"
            maxLength={200}
            onBlur={(event) => {
              const input = event.currentTarget;
              const description = input.value.trim();

              if (description === row.description) return;

              perform(
                patch.mutateAsync({ description }).then(() => toast("description saved")),
                () => {
                  input.value = row.description;
                },
              );
            }}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          />
        </dd>
        <dt className="font-semibold">Visibility</dt>
        <dd className="flex items-center gap-2">
          {visibilities.map((visibility) => (
            <Button
              key={visibility}
              variant={row.visibility === visibility ? "default" : "outline"}
              size="xs"
              onClick={() =>
                perform(
                  patch
                    .mutateAsync({ visibility })
                    .then(() => toast(`visibility set to ${visibility}`)),
                )
              }
            >
              {visibility}
            </Button>
          ))}
          <span className="font-mono text-xs">{audiences[row.visibility]}</span>
        </dd>
        <dt className="font-semibold">Egress</dt>
        <dd className="flex items-center gap-2">
          <span className="font-mono text-xs">{row.egress}</span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              const egress = row.egress === "none" ? "open" : "none";
              perform(patch.mutateAsync({ egress }).then(() => toast(`egress set to ${egress}`)));
            }}
          >
            {row.egress === "none" ? "allow outbound fetch" : "block outbound fetch"}
          </Button>
        </dd>
        <dt className="font-semibold">Schedule</dt>
        <dd className="flex items-center gap-2 font-mono text-xs">
          <Input
            key={row.schedule}
            aria-label="Cron expression"
            className="h-8 max-w-48 font-mono text-xs"
            defaultValue={row.schedule ?? ""}
            placeholder="0 9 * * *"
            onBlur={(event) => {
              const input = event.currentTarget;
              const schedule = input.value.trim() || null;

              if (schedule === row.schedule) return;

              perform(
                patch
                  .mutateAsync({ schedule })
                  .then(() => toast(schedule === null ? "schedule removed" : "schedule set")),
                () => {
                  input.value = row.schedule ?? "";
                },
              );
            }}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
          />
          <span>
            {row.schedule === null ? "none · five fields, UTC, calls scheduled()" : "UTC"}
          </span>
          {row.schedule && (
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                perform(
                  call((api) => api.applets.run({ params: { name } })).then(() =>
                    toast("scheduled() ran"),
                  ),
                )
              }
            >
              run now
            </Button>
          )}
        </dd>
        <dt className="font-semibold">Email</dt>
        <dd className="flex items-center gap-2 font-mono text-xs">
          <span>{row.email ? `mail to ${name}@ calls inbox()` : "off"}</span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              const email = row.email === 0;
              perform(
                patch
                  .mutateAsync({ email })
                  .then(() => toast(email ? "email turned on" : "email turned off")),
              );
            }}
          >
            {row.email ? "turn off" : "receive mail"}
          </Button>
        </dd>
        <dt className="font-semibold">Dependencies</dt>
        <dd className="flex flex-wrap items-center gap-2 font-mono text-xs">
          {installed.join(", ") || "none"}
          {installed.length > 0 && (
            <Button
              variant="outline"
              size="xs"
              disabled={deploying || viewing}
              onClick={() => void reResolve()}
            >
              re-resolve
            </Button>
          )}
        </dd>
        <dt className="font-semibold">Source</dt>
        <dd className="flex items-center gap-2 font-mono text-xs">
          <span>{live === null ? "no version yet" : `v${live}`}</span>
          {live !== null && (
            <>
              <Button
                variant="outline"
                size="xs"
                onClick={() => perform(downloadSource(name, live))}
              >
                download zip
              </Button>
              <Button variant="outline" size="xs" onClick={() => void fork()}>
                fork
              </Button>
            </>
          )}
        </dd>
        <dt className="font-semibold">Draft</dt>
        <dd className="flex items-center gap-2 font-mono text-xs">
          {hasDraft ? "saved on the router" : "none"}
          {hasDraft && (
            <Button variant="outline" size="xs" onClick={() => void discardDraft()}>
              discard
            </Button>
          )}
        </dd>
      </dl>
      <DangerZone name={name} onRemove={remove} />
    </section>
  );
}
