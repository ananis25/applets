/**
 * The docs under `docs/` for people using the platform, which the MCP server's `read_docs` returns, so an
 * agent reads the same text a person does. Wrangler's `Text` rule and a Vite
 * plugin in the workspace config load a `.md` import as its text.
 */
import applets from "../../../docs/applets.md";
import platform from "../../../docs/platform.md";

export const docs = { applets, platform };
