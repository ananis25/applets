import { createFileRoute } from "@tanstack/react-router";
import { Settings } from "../settings.tsx";

export const Route = createFileRoute("/_platform/settings/$section")({ component: Page });

function Page() {
  return <Settings section={Route.useParams().section} />;
}
