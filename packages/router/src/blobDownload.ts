/** Short-lived, signed links for an MCP client to download an applet's blob without exposing its OAuth token. */

const lifetime = 5 * 60_000;

const payload = (id: string, key: string, expires: string) =>
  new TextEncoder().encode(JSON.stringify(["blob-download", id, key, expires]));

const signingKey = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

/** A link good for five minutes, scoped to one applet id and one blob key. */
export async function blobDownloadUrl(
  base: string,
  secret: string,
  id: string,
  key: string,
): Promise<string> {
  const expires = String(Date.now() + lifetime);

  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    payload(id, key, expires),
  );

  const url = new URL("blob", base);
  url.searchParams.set("id", id);
  url.searchParams.set("key", key);
  url.searchParams.set("expires", expires);
  url.searchParams.set("signature", Buffer.from(signature).toString("base64url"));

  return url.href;
}

/** The signed applet id and blob key, or null for an invalid or expired link. */
export async function verifyBlobDownload(
  url: URL,
  secret: string,
): Promise<{ id: string; key: string } | null> {
  const id = url.searchParams.get("id");
  const key = url.searchParams.get("key");
  const expires = url.searchParams.get("expires");
  const signature = url.searchParams.get("signature");

  if (!id || !key || !expires || !signature) return null;

  const until = Number(expires);

  if (!Number.isSafeInteger(until) || until < Date.now() || until > Date.now() + lifetime)
    return null;

  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    Buffer.from(signature, "base64url"),
    payload(id, key, expires),
  );

  return valid ? { id, key } : null;
}
