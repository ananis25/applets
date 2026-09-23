import * as React from "react";

const MOBILE_BREAKPOINT = 768;

const query = () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

const subscribe = (onChange: () => void) => {
  const mql = query();
  mql.addEventListener("change", onChange);

  return () => mql.removeEventListener("change", onChange);
};

const isMobile = () => query().matches;

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, isMobile, () => false);
}
