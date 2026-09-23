/** The shapes the router's modules share beyond the API contract: the bundler's contract, the supervisor's target, and what travels between them. */
import type { Applet, EgressMode, Files, LogLevel, RequestKind } from "@applets/api";

/** The hostnames under the suffix the router answers itself, so no applet may take them. */
export const reservedHosts = ["admin", "app", "auth"];

const appletNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether ingress can serve an applet of this name: one DNS label, not a reserved host. */
export const isAppletName = (name: string): boolean =>
  appletNamePattern.test(name) && !reservedHosts.includes(name);

/** The model an `ai` call gets when it names none. */
export const defaultModel = "~deepseek/deepseek-flash-latest";

/** How long `vacuum` keeps log and request rows, and email rows. */
export const retention = { logDays: 7, emailDays: 7 } as const;

const secretNamePattern = /^[A-Z_][A-Z0-9_]*$/;

export const isSecretName = (name: string): boolean => secretNamePattern.test(name);

/** The editor's unsaved files for an applet, read back from `drafts` and `file_contents`. */
export type Draft = {
  readonly files: Files;
  readonly updated_at: string;
};

/** The filters of the platform Logs page. `before` is the id to page back from. */
export type RunQuery = {
  readonly applet?: string;
  readonly kind?: RequestKind;
  readonly failed?: boolean;
  readonly before?: number;
  readonly limit?: number;
};

/** The filters of the platform Logs page's platform view. */
export type PlatformLogQuery = {
  readonly level?: LogLevel;
  readonly applet?: string;
  readonly before?: number;
  readonly limit?: number;
};

export type Sender = string | { readonly email: string; readonly name: string };

/** The bundler's contract: `Bundler.build(files, fresh)` in `packages/bundler`. */
export type Bundler = {
  build(files: Files, fresh?: boolean): Promise<import("../../bundler/src/index.ts").Build>;
};

/** A build that produced a bundle. */
export type Built = Extract<import("../../bundler/src/index.ts").Build, { server: string }>;

/** The props stamped on the capabilities a loaded applet receives: which applet, by id and name, and which version of it, is calling. */
export type AppletProps = { readonly id: string; readonly name: string; readonly version: number };

/**
 * What the supervisor needs to run one version, carried from ingress in headers. `id` addresses the supervisor and
 * every row and blob; `name` is what the applet sees, so a rename reloads it like a secrets change.
 */
export type Target = {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly egress: EgressMode;
  readonly secrets: number;
};

/** The target for an applet's current version, or undefined before its first deploy. `secrets` is the revision of its secrets. */
export const targetOf = (applet: Applet): Target | undefined =>
  applet.current_version === null
    ? undefined
    : {
        id: applet.id,
        name: applet.name,
        version: applet.current_version,
        egress: applet.egress,
        secrets: applet.secrets_rev,
      };

export const targetHeaders = {
  id: "x-applet-id",
  name: "x-applet-name",
  version: "x-applet-version",
  egress: "x-applet-egress",
  secrets: "x-applet-secrets",
} as const;

/** What fires an applet's `scheduled` handler: its alarm, or 'run now'. */
export type ScheduleRun = "schedule" | "manual";

/** The id of one run, minted by ingress or the supervisor. `@std`'s `log` stamps it on every line the run writes. */
export const requestHeader = "x-applet-request";

/** The user a private or family applet is answering, set by ingress and never trusted from a caller. */
export const userHeader = "x-applet-user";
