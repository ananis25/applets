import type { ReactNode } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@applets/ui/components/ui/empty";
import { GlobalRail, RailFrame } from "./rail.tsx";

/** The frame around every platform page: the global rail and the page beside it. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <RailFrame>
      <title>applets</title>
      <GlobalRail />
      <main className="min-w-0 flex-1 overflow-auto">{children}</main>
    </RailFrame>
  );
}

export function Missing({ title, description }: { title: string; description: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
