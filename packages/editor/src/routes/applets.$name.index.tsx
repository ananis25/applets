import { createFileRoute, redirect } from "@tanstack/react-router";

/** An applet with no page named opens on its code. */
export const Route = createFileRoute("/applets/$name/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/applets/$name/$view",
      params: { name: params.name, view: "code" },
      replace: true,
    });
  },
});
