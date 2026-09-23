import { createFileRoute } from "@tanstack/react-router";
import { Applets } from "../applets.tsx";

export const Route = createFileRoute("/_platform/applets/")({ component: Applets });
