/**
 * The docs under `docs/` for people using the platform, which the MCP server's `help` serves so an
 * agent reads the same text a person does: each `##` section is a topic, named by its heading, and
 * each whole doc is one too. Wrangler's `Text` rule and a Vite plugin in the workspace config load
 * a `.md` import as its text.
 */
import applets from "../../../docs/applets.md";
import platform from "../../../docs/platform.md";

/** One thing `help` can return: a section of a doc, or a doc. `summary` is the section's first line, which says when to read it. */
export type Topic = { readonly title: string; readonly summary: string; readonly text: string };

const slug = (title: string) =>
  title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

const sections = (doc: string): Array<[string, Topic]> =>
  doc
    .split(/^(?=## )/m)
    .slice(1)
    .map((section) => {
      const [heading = "", ...rest] = section.trimEnd().split("\n");
      const title = heading.slice(3);
      const summary = rest.find((line) => line.trim() !== "") ?? "";

      return [slug(title), { title, summary, text: section.trimEnd() }];
    });

export const topics: Readonly<Record<string, Topic>> = Object.fromEntries([
  [
    "applets",
    {
      title: "Applets",
      summary: "The whole guide to writing an applet, every section below.",
      text: applets,
    },
  ],
  ...sections(applets),
  [
    "platform",
    {
      title: "The platform",
      summary: "The whole platform doc: agents, access and secrets.",
      text: platform,
    },
  ],
  ...sections(platform),
]);

/** One line per topic, for the index `help` returns without one. */
export const index = Object.entries(topics)
  .map(([name, topic]) => `- ${name}: ${topic.summary}`)
  .join("\n");
