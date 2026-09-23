import { useRef, useState } from "react";
import { Badge } from "@applets/ui/components/ui/badge";
import { Button } from "@applets/ui/components/ui/button";
import { Card } from "@applets/ui/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@applets/ui/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@applets/ui/components/ui/empty";
import { Input } from "@applets/ui/components/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { AppletSummary, Files } from "@applets/api";
import { call } from "./client.ts";
import { unzip } from "./editor/unzip.ts";
import { appletsQuery, useMe } from "./queries.ts";
import { askText } from "./ask.tsx";
import { Failure } from "./failure.tsx";
import { appletLink, relTime } from "./urls.ts";

const template = `/** A JSON API. */
export function fetch(request: Request): Response {
  return Response.json({ path: new URL(request.url).pathname });
}
`;

/** Visibility and one badge per trigger the applet declares. */
export function Badges({ applet }: { applet: AppletSummary }) {
  return (
    <>
      <Badge variant={applet.visibility === "private" ? "secondary" : "default"}>
        {applet.visibility}
      </Badge>
      {applet.schedule && <Badge variant="secondary">schedule</Badge>}
      {applet.email && <Badge variant="secondary">email</Badge>}
    </>
  );
}

/** A red dot when the last 24 hours had failed runs. */
export function ErrorDot({ applet }: { applet: AppletSummary }) {
  if (applet.failures === 0) return null;
  const label = `${applet.failures} failed ${applet.failures === 1 ? "run" : "runs"} in the last 24 hours`;

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="size-2.5 rounded-full bg-destructive"
    />
  );
}

/** The name a downloaded source zip suggests: `hello-v3.zip` was `hello`. */
const nameFromZip = (filename: string) => filename.replace(/\.zip$/i, "").replace(/-v\d+$/, "");

/** The New applet button and the dialog that names it, from the template or from a zip of source files. A new applet opens in the editor. */
export function NewApplet() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<{ name: string; files: Files }>();
  const [error, setError] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  const client = useQueryClient();
  const navigate = useNavigate();

  /** The new applet is deployed as v1, so it has a registry row, a host and a place for drafts from the start. */
  const deploy = useMutation({
    mutationFn: (applet: string) =>
      call((api) =>
        api.versions.deploy({
          params: { name: applet },
          query: {},
          payload: { files: files?.files ?? { "main.ts": template } },
        }),
      ),
    onSuccess: (_, applet) => {
      void client.invalidateQueries({ queryKey: ["applets"] });
      void navigate(appletLink(applet));
    },
    onError: (cause) => setError(cause.message),
  });

  const create = () => {
    const trimmed = name.trim();

    if (trimmed === "") return;

    setError(undefined);
    deploy.mutate(trimmed);
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;

    try {
      const unpacked = await unzip(await file.arrayBuffer());

      if (!("main.ts" in unpacked)) throw new Error("the zip has no main.ts");

      setFiles({ name: file.name, files: unpacked });
      setError(undefined);

      if (name.trim() === "") setName(nameFromZip(file.name));
    } catch (cause) {
      setFiles(undefined);
      setError(`Can't read ${file.name}: ${String(cause)}`);
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>New applet</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New applet</DialogTitle>
            <DialogDescription>
              The name is its hostname: lowercase letters and digits joined by single dashes.
            </DialogDescription>
          </DialogHeader>
          <Failure error={error} />
          <div className="flex gap-2">
            <Input
              autoFocus
              value={name}
              placeholder="new-applet-name"
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && create()}
            />
            <Button onClick={create}>Create</Button>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <input
              ref={picker}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(event) => void pick(event.target.files?.[0])}
            />
            <Button variant="outline" size="xs" onClick={() => picker.current?.click()}>
              from a zip
            </Button>
            <span className="font-mono">
              {files
                ? `${files.name}: ${Object.keys(files.files).length} files`
                : "or start from the template"}
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

const row = "flex-row items-center gap-3 px-4";

function Summary({ applet }: { applet: AppletSummary }) {
  return (
    <>
      <span className="font-semibold">{applet.name}</span>
      <ErrorDot applet={applet} />
      <span className="font-mono text-xs">
        {applet.current_version ? `v${applet.current_version}` : "no version"}
      </span>
      <Badges applet={applet} />
      <span className="min-w-0 flex-1 truncate text-xs">{applet.description}</span>
    </>
  );
}

/** Every applet the user may see, with search. The admin also sees other users' applets, which do not open and can be removed. */
export function Applets() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const { data: applets, error } = useQuery(appletsQuery);
  const [query, setQuery] = useState("");

  const removal = useMutation({
    mutationFn: (name: string) => call((api) => api.applets.remove({ params: { name } })),
    onSuccess: () => client.invalidateQueries(appletsQuery),
  });

  const needle = query.trim().toLowerCase();

  const shown = applets?.filter((applet) =>
    `${applet.name} ${applet.description} ${applet.owner}`.toLowerCase().includes(needle),
  );

  const remove = async (applet: AppletSummary) => {
    const typed = await askText({
      title: `Delete "${applet.name}"?`,
      description: `It belongs to ${applet.owner}. Its versions, logs, secrets and storage go with it.`,
      action: "Delete",
      destructive: true,
      input: { label: `Type ${applet.name} to confirm`, match: applet.name },
    });

    if (typed === applet.name) removal.mutate(applet.name);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Applets</h1>
        <NewApplet />
      </div>
      <Failure error={error ?? removal.error} />
      <Input
        value={query}
        placeholder="Search by name, description or owner"
        autoComplete="off"
        onChange={(event) => setQuery(event.target.value)}
      />
      {shown?.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{needle ? "No applet matches" : "No applets yet"}</EmptyTitle>
            <EmptyDescription>
              {needle ? "Try another search." : "Create one to see it here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <div className="flex flex-col gap-2">
        {shown?.map((applet) =>
          me !== undefined && applet.owner !== me.email ? (
            <Card key={applet.name} size="sm" className={row}>
              <Summary applet={applet} />
              <span className="font-mono text-xs">{applet.owner}</span>
              <Button variant="outline" size="xs" onClick={() => void remove(applet)}>
                remove
              </Button>
            </Card>
          ) : (
            <Link key={applet.name} {...appletLink(applet.name)}>
              <Card size="sm" className={`${row} transition-colors hover:bg-accent`}>
                <Summary applet={applet} />
                <span className="text-xs">{relTime(applet.updated_at)}</span>
              </Card>
            </Link>
          ),
        )}
      </div>
    </div>
  );
}
