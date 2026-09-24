/**
 * The starting points for a new applet, which the MCP server's `applet_create` and the editor's New applet
 * dialog offer by name. Generated from `examples/` by `vp run templates`; edit the directories, not the JSON.
 */
import data from "./templates.json" with { type: "json" };

import type { Files } from "./index.ts";

export type Template = { readonly description: string; readonly files: Files };

export const templates: Readonly<Record<string, Template>> = data;

/** The docstring at the top of a `main.ts`, one line: a new applet's description, and a template's. Empty when there is none. */
export const describe = (main: string): string =>
  /^\/\*\*\s*(.*?)\s*\*\//s.exec(main)?.[1]?.replaceAll(/\s*\n\s*\*?\s*/g, " ") ?? "";

/** The templates as the API and the MCP list them: name, description and file paths. */
export const listTemplates = () =>
  Object.entries(templates).map(([name, template]) => ({
    name,
    description: template.description,
    files: Object.keys(template.files),
  }));
