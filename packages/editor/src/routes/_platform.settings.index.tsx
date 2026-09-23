import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/settings` is the profile section. */
export const Route = createFileRoute("/_platform/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/$section", params: { section: "profile" }, replace: true });
  },
});
