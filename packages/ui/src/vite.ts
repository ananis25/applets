/**
 * The Vite preset every app that uses `@applets/ui` spreads into its plugins.
 * React and Tailwind are configured here once, so an app's own config stays
 * at the build output and nothing else.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { PluginOption } from "vite";

export function ui(): PluginOption[] {
  return [react(), tailwindcss()];
}
