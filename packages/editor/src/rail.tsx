import type { ReactNode } from "react";
import { Link, useMatchRoute, type LinkOptions } from "@tanstack/react-router";
import {
  ArrowLeftRightIcon,
  CodeIcon,
  DatabaseIcon,
  HistoryIcon,
  HomeIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  LockIcon,
  MailIcon,
  PackageIcon,
  ScrollTextIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";
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
  SidebarTrigger,
  useSidebar,
} from "@applets/ui/components/ui/sidebar";
import { useMe } from "./queries.ts";
import { appletLink, versioned, views, type View } from "./urls.ts";
import { useStore } from "./store.ts";

/**
 * One rail entry. It is lit on its own path, whatever the query, and, unless `exact`, on every path under it.
 * Collapsed, only the icon shows and the tooltip carries the label.
 */
function RailLink({
  link,
  exact,
  icon: Icon,
  label,
  tooltip = label,
  children,
}: {
  link: LinkOptions;
  exact?: boolean;
  icon: LucideIcon;
  label: string;
  tooltip?: string;
  children?: ReactNode;
}) {
  const matchRoute = useMatchRoute();
  const { setOpenMobile } = useSidebar();
  const active = matchRoute({ to: link.to, params: link.params, fuzzy: !exact }) !== false;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={tooltip}
        render={<Link {...link} onClick={() => setOpenMobile(false)} />}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
      {children}
    </SidebarMenuItem>
  );
}

/**
 * The rail, headed by its own toggle, the platform's name and who is signed in.
 * Collapsed, it narrows to a strip of icons and the header keeps only the toggle.
 */
function Rail({ children }: { children: ReactNode }) {
  const { data: me, error } = useMe();

  return (
    <Sidebar collapsible="icon" className="border-r">
      <SidebarHeader className="flex-row items-center gap-2 border-b p-2">
        <SidebarTrigger title="Toggle navigation" />
        <div className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
          <span className="font-semibold">Applets</span>
          <span
            className={`truncate text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
            title={error?.message ?? me?.email}
          >
            {error ? "not signed in" : me === undefined ? "\u00a0" : `${me.email} · ${me.role}`}
          </span>
        </div>
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
      <RailLink link={{ to: "/" }} exact icon={HomeIcon} label="Home" />
      <RailLink link={{ to: "/applets" }} icon={LayoutGridIcon} label="Applets" />
      <RailLink link={{ to: "/logs" }} icon={ScrollTextIcon} label="Logs" />
      <RailLink
        link={{ to: "/settings/$section", params: { section: "profile" } }}
        icon={SettingsIcon}
        label="Settings"
      />
    </Rail>
  );
}

const pages: Record<View, { label: string; icon: LucideIcon }> = {
  code: { label: "Code", icon: CodeIcon },
  logs: { label: "Logs", icon: ScrollTextIcon },
  requests: { label: "Requests", icon: ArrowLeftRightIcon },
  emails: { label: "Emails", icon: MailIcon },
  sqlite: { label: "SQLite", icon: DatabaseIcon },
  kv: { label: "KV", icon: KeyRoundIcon },
  blobs: { label: "Blobs", icon: PackageIcon },
  secrets: { label: "Secrets", icon: LockIcon },
  versions: { label: "Versions", icon: HistoryIcon },
  settings: { label: "Settings", icon: SettingsIcon },
};

/**
 * One entry per page of the open applet. A version being viewed stays in view across the pages that have one.
 * Problems in the code show as a badge, and in the tooltip once the badge is collapsed away.
 */
export function AppletRail({ name, version }: { name: string; version: number | null }) {
  const problems = useStore((state) => state.problems.length);

  return (
    <Rail>
      {views.map((view) => {
        const badged = view === "code" && problems > 0;

        return (
          <RailLink
            key={view}
            link={appletLink(name, view, versioned(view) ? version : null)}
            icon={pages[view].icon}
            label={pages[view].label}
            tooltip={badged ? `Code · ${problems} problems` : undefined}
          >
            {badged && (
              <SidebarMenuBadge className="bg-destructive text-white">{problems}</SidebarMenuBadge>
            )}
          </RailLink>
        );
      })}
    </Rail>
  );
}

/**
 * The row a rail sits in: the sidebar's context around the rail and the page beside it.
 * The rail reopens the way it was last left, which the sidebar remembers in a cookie.
 */
export function RailFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <SidebarProvider
      defaultOpen={!document.cookie.includes("sidebar_state=false")}
      className={`min-h-0 bg-background ${className ?? "h-full"}`}
    >
      {children}
    </SidebarProvider>
  );
}

/** Opens the rail on a phone, where it is a drawer over the page. Wider, the rail carries its own toggle. */
export function RailTrigger() {
  return <SidebarTrigger className="md:hidden" title="Open navigation" />;
}
