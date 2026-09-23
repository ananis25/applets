import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Shell } from "../shell.tsx";

/** Every page that is not an open applet sits in the shell, beside the global rail. */
export const Route = createFileRoute("/_platform")({
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
});
