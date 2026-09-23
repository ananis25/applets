import { createFileRoute } from "@tanstack/react-router";
import { Logs } from "../logs.tsx";
import { logsSearch } from "../urls.ts";

export const Route = createFileRoute("/_platform/logs")({
  validateSearch: logsSearch,
  component: Logs,
});
