import type { ReactElement } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@applets/ui/components/ui/tooltip";

/** A control with a tooltip that is also its accessible name, for a button whose only content is an icon. */
export function Hint({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} aria-label={label} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
