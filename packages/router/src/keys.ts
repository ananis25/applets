/** API keys: minted once for their creator to see, kept as a SHA-256 hash. No `cloudflare:workers` import, so `admin.ts` stays loadable in vitest. */

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function mintKey(): Promise<{ key: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = `applets_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

  return { key, hash: await sha256(key) };
}
