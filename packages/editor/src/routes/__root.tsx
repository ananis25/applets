import { Toaster } from "@applets/ui/components/ui/sonner";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { Asker } from "../ask.tsx";
import { usePending } from "../client.ts";
import { Missing, Shell } from "../shell.tsx";
import { anyDirty } from "../store.ts";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  notFoundComponent: () => (
    <Shell>
      <Missing title="Not found" description="No page lives at this address." />
    </Shell>
  ),
});

/** Around every page: the loading bar, the toasts, and the warning against leaving unsaved edits. */
function Root() {
  // SYNC: the window's beforeunload prompt.
  useEffect(() => {
    // Unsaved edits outlive a visit to another page, so the warning is armed on every page.
    const onLeave = (event: BeforeUnloadEvent) => {
      if (anyDirty()) event.preventDefault();
    };

    window.addEventListener("beforeunload", onLeave);

    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  return (
    <>
      <LoadingBar />
      <Outlet />
      <Asker />
      <Toaster position="bottom-right" />
    </>
  );
}

/** A thin bar across the top while any call is in flight. It fades in after 150 ms, so a quick call never flickers it. */
function LoadingBar() {
  const busy = usePending((pending) => pending > 0);

  if (!busy) return null;

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 h-1 animate-appear overflow-hidden"
      role="progressbar"
      aria-label="loading"
    >
      <div className="h-full w-1/3 animate-loading bg-primary" />
    </div>
  );
}
