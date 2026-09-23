/**
 * The text files of a zip archive, as a file map: an applet's source coming
 * back from a download, or a folder zipped on a desktop. Entries are read from
 * the central directory; stored ones are sliced out, deflated ones go through
 * the browser's `DecompressionStream`. Folders, macOS resource forks and a
 * single top-level folder that holds everything are left out of the paths.
 */

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The offset of the end-of-central-directory record, which is the last thing in the archive after its comment. */
function endRecord(bytes: Uint8Array): number {
  const data = view(bytes);

  for (let at = bytes.length - 22; at >= 0; at -= 1) {
    if (data.getUint32(at, true) === 0x06054b50) return at;
  }

  throw new Error("not a zip file");
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const skipped = (path: string) =>
  path.endsWith("/") || path.startsWith("__MACOSX/") || path.split("/").at(-1) === ".DS_Store";

/** Every file of the archive, decoded as UTF-8, by its path. */
export async function unzip(archive: ArrayBuffer): Promise<Record<string, string>> {
  const bytes = new Uint8Array(archive);
  const data = view(bytes);
  const decoder = new TextDecoder();
  const end = endRecord(bytes);
  const count = data.getUint16(end + 10, true);
  const files: Record<string, string> = {};
  let entry = data.getUint32(end + 16, true);

  for (let index = 0; index < count; index += 1) {
    if (data.getUint32(entry, true) !== 0x02014b50) throw new Error("not a zip file");
    const method = data.getUint16(entry + 10, true);
    const compressed = data.getUint32(entry + 20, true);
    const nameLength = data.getUint16(entry + 28, true);
    const extraLength = data.getUint16(entry + 30, true);
    const commentLength = data.getUint16(entry + 32, true);
    const local = data.getUint32(entry + 42, true);
    const path = decoder.decode(bytes.subarray(entry + 46, entry + 46 + nameLength));
    entry += 46 + nameLength + extraLength + commentLength;

    if (skipped(path)) continue;

    if (method !== 0 && method !== 8) throw new Error(`${path} uses an unsupported compression`);

    const start = local + 30 + data.getUint16(local + 26, true) + data.getUint16(local + 28, true);

    const stored = bytes.subarray(start, start + compressed);
    files[path] = decoder.decode(method === 0 ? stored : await inflate(stored));
  }

  return stripFolder(files);
}

/** A folder zipped whole puts everything under its own name; the applet's paths start below it. */
function stripFolder(files: Record<string, string>): Record<string, string> {
  const paths = Object.keys(files);
  const folder = paths[0]?.split("/")[0];

  if (folder === undefined || !paths.every((path) => path.startsWith(`${folder}/`))) return files;

  return Object.fromEntries(
    paths.map((path) => [path.slice(folder.length + 1), files[path]!] as const),
  );
}
