/** Platform hostnames and the names available to applets. */
export const platformHosts = ["api", "app", "auth", "home", "mcp"] as const;

type PlatformHost = (typeof platformHosts)[number];

/** Classifies a platform hostname, including the configured MCP origin. */
export function platformHost(
  host: string,
  suffix: string,
  mcpUrl: string,
): PlatformHost | undefined {
  if (host === new URL(mcpUrl).hostname) return "mcp";

  return platformHosts.find((name) => host === `${name}${suffix}`);
}

/** A single DNS label that cannot shadow a platform hostname. */
export function isAppletName(name: string, suffix: string, mcpUrl: string): boolean {
  return (
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) &&
    platformHost(`${name}${suffix}`, suffix, mcpUrl) === undefined
  );
}
