import type { ReactNode } from "react";
import { Link, useMatchRoute, type LinkOptions } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@applets/ui/components/ui/sidebar";
import { useMe } from "./queries.ts";
import { appletLink, versioned, views, type View } from "./urls.ts";
import { useStore } from "./store.ts";

/** One rail entry. It is lit on its own path, whatever the query, and, unless `exact`, on every path under it. */
function RailLink({
  link,
  exact,
  children,
}: {
  link: LinkOptions;
  exact?: boolean;
  children: ReactNode;
}) {
  const matchRoute = useMatchRoute();
  const active = matchRoute({ to: link.to, params: link.params, fuzzy: !exact }) !== false;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} render={<Link {...link} />}>
        {children}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** The rail, headed by the platform's name and who is signed in. */
function Rail({ children }: { children: ReactNode }) {
  const { data: me, error } = useMe();

  return (
    <Sidebar collapsible="none" className="w-48 border-r">
      <SidebarHeader className="gap-0.5 border-b px-4 py-3">
        <span className="font-semibold">Applets</span>
        <span
          className={`truncate text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
          title={error?.message ?? me?.email}
        >
          {error ? "not signed in" : me === undefined ? "\u00a0" : `${me.email} · ${me.role}`}
        </span>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>{children}</SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

/** The platform's pages, on every screen but an open applet. */
export function GlobalRail() {
  return (
    <Rail>
      <RailLink link={{ to: "/" }} exact>
        Home
      </RailLink>
      <RailLink link={{ to: "/applets" }}>Applets</RailLink>
      <RailLink link={{ to: "/logs" }}>Logs</RailLink>
      <RailLink link={{ to: "/settings/$section", params: { section: "profile" } }}>
        Settings
      </RailLink>
    </Rail>
  );
}

const labels: Record<View, string> = {
  code: "Code",
  logs: "Logs",
  requests: "Requests",
  emails: "Emails",
  sqlite: "SQLite",
  kv: "KV",
  blobs: "Blobs",
  secrets: "Secrets",
  versions: "Versions",
  settings: "Settings",
};

/** One entry per page of the open applet. A version being viewed stays in view across the pages that have one. */
export function AppletRail({ name, version }: { name: string; version: number | null }) {
  const problems = useStore((state) => state.problems.length);

  return (
    <Rail>
      {views.map((view) => (
        <RailLink key={view} link={appletLink(name, view, versioned(view) ? version : null)}>
          {labels[view]}
          {view === "code" && problems > 0 && (
            <SidebarMenuBadge className="bg-destructive text-white">{problems}</SidebarMenuBadge>
          )}
        </RailLink>
      ))}
    </Rail>
  );
}

/** The row a rail sits in: the sidebar's context around the rail and the page beside it. */
export function RailFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <SidebarProvider className={`min-h-0 bg-background ${className ?? "h-full"}`}>
      {children}
    </SidebarProvider>
  );
}
