/** Settings shared by the platform scripts and the editor's development server. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const repoRoot = path.join(import.meta.dirname, "..", "..", "..");

export const secretsFile = path.join(repoRoot, "secrets.env");

/** Reads KEY=value lines, then applies environment overrides. The file is optional when the environment supplies the settings. */
export function readSettings(): Map<string, string> {
  const contents = existsSync(secretsFile) ? readFileSync(secretsFile, "utf8") : "";
  const settings = new Map<string, string>();

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    const at = trimmed.indexOf("=");

    if (trimmed === "" || trimmed.startsWith("#") || at === -1) continue;
    settings.set(trimmed.slice(0, at).trim(), trimmed.slice(at + 1).trim());
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) settings.set(key, value);
  }

  return settings;
}

/** An origin on the selected platform, using Wrangler's port locally. */
export function originFor(host: string, suffix: string): string {
  return suffix === ".localhost" ? `http://${host}${suffix}:8787` : `https://${host}${suffix}`;
}
