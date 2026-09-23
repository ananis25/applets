import { createFileRoute, redirect, type ErrorComponentProps } from "@tanstack/react-router";
import { Screen } from "../editor/screen.tsx";
import { appletQuery } from "../queries.ts";
import { Failure } from "../failure.tsx";
import { Shell } from "../shell.tsx";
import { appletSearch, views } from "../urls.ts";

/** One page of an open applet. The registry row loads before the page shows; the files load inside it, since they depend on `?version`. */
export const Route = createFileRoute("/applets/$name/$view")({
  validateSearch: appletSearch,
  beforeLoad: ({ params }) => {
    if (!views.some((known) => known === params.view)) {
      throw redirect({
        to: "/applets/$name/$view",
        params: { name: params.name, view: "code" },
        replace: true,
      });
    }
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(appletQuery(params.name)),
  component: Page,
  errorComponent: Failed,
});

function Failed({ error }: ErrorComponentProps) {
  const { name } = Route.useParams();

  return (
    <Shell>
      <Failure
        className="m-10 w-auto"
        title={`Can't open "${name}"`}
        error={error instanceof Error ? error : String(error)}
      />
    </Shell>
  );
}

function Page() {
  const { name, view } = Route.useParams();
  const { version = null } = Route.useSearch();

  return (
    <Screen name={name} view={views.find((known) => known === view) ?? "code"} version={version} />
  );
}
