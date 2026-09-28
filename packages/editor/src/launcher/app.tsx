/**
 * The launcher on the home hostname, the page a phone installs. The router
 * answers `/api/applets` with the applets the signed-in person may open, and
 * this page shows them as large cards. Tapping one opens the applet in a frame
 * under a bar with a Home button, so the URL bar never appears. The chosen
 * applet is in the URL's `open` param and the history, so Android's back button
 * returns to the list.
 */
import { Suspense, use, useEffect, useState } from "react";

import type { AppletSummary } from "@applets/api";
import { Button } from "@applets/ui/components/ui/button";
import { Card } from "@applets/ui/components/ui/card";
import { ArrowLeftIcon } from "lucide-react";
import { Failure } from "../failure.tsx";

/** An applet's live URL: this page is on `home.`, the applet on `<name>.`. */
const appletUrl = (name: string) =>
  `${location.protocol}//${location.host.replace(/^home\./, `${name}.`)}`;

/** `shopping-list` reads as `Shopping list` on a card. */
const titleOf = (name: string) => {
  const words = name.replaceAll(/[-_]+/g, " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
};

const openedNow = () => new URLSearchParams(location.search).get("open");

type Listing = { applets: Array<AppletSummary>; error: string | null };

const applets: Promise<Listing> = fetch("/api/applets")
  .then(async (response) => {
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);

    // SAFETY: the router's `/api/applets` answers `{ applets }` filtered from the admin API's own listing
    return { ...((await response.json()) as { applets: Array<AppletSummary> }), error: null };
  })
  .catch((error: Error) => ({ applets: [], error: error.message }));

function AppletCard({ applet, onOpen }: { applet: AppletSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="text-left">
      <Card className="h-full flex-row items-center gap-4 px-4 py-4 active:bg-accent">
        <img src={`${appletUrl(applet.name)}/favicon.ico`} alt="" className="size-12 shrink-0" />
        <div className="min-w-0">
          <div className="truncate text-lg font-semibold">{titleOf(applet.name)}</div>
          {applet.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">{applet.description}</p>
          )}
        </div>
      </Card>
    </button>
  );
}

function List({ onOpen }: { onOpen: (name: string) => void }) {
  const { applets: list, error } = use(applets);

  if (error !== null) return <Failure error={error} className="m-4" />;

  if (list.length === 0)
    return <p className="p-8 text-center text-muted-foreground">Nothing here yet.</p>;

  return (
    <div className="mx-auto grid max-w-2xl gap-3 p-4 sm:grid-cols-2">
      {list.map((applet) => (
        <AppletCard key={applet.name} applet={applet} onOpen={() => onOpen(applet.name)} />
      ))}
    </div>
  );
}

function Frame({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Home">
          <ArrowLeftIcon />
        </Button>
        <span className="truncate font-semibold">{titleOf(name)}</span>
      </div>
      <iframe src={appletUrl(name)} title={titleOf(name)} className="min-h-0 flex-1 bg-white" />
    </div>
  );
}

export function Launcher() {
  const [opened, setOpened] = useState(openedNow);

  // SYNC: the window's popstate, so Android's back button leaves the frame
  useEffect(() => {
    const onPop = () => setOpened(openedNow());
    addEventListener("popstate", onPop);

    return () => removeEventListener("popstate", onPop);
  }, []);

  const open = (name: string) => {
    history.pushState(null, "", `/?open=${encodeURIComponent(name)}`);
    setOpened(name);
  };

  const back = () => {
    history.pushState(null, "", "/");
    setOpened(null);
  };

  if (opened !== null) return <Frame name={opened} onBack={back} />;

  return (
    <div className="min-h-full">
      <h1 className="px-4 pt-6 text-2xl font-semibold">Home</h1>
      <Suspense fallback={<p className="p-8 text-center text-muted-foreground">Loading…</p>}>
        <List onOpen={open} />
      </Suspense>
    </div>
  );
}
