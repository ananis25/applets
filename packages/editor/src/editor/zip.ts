/**
 * A zip archive of text files, stored without compression: an applet's source is small, and the
 * format with no deflate is a header per file, the bytes, and a directory at the end.
 */

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;

  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;

  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);

  return (crc ^ 0xffffffff) >>> 0;
}

/** Little-endian fields, each a `[byte width, value]` pair, as one record. */
function record(fields: ReadonlyArray<readonly [width: 2 | 4, value: number]>): Uint8Array {
  const bytes = new Uint8Array(fields.reduce((total, [width]) => total + width, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;

  for (const [width, value] of fields) {
    if (width === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);

    offset += width;
  }

  return bytes;
}

const utf8Names = 0x0800;

export function zip(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const body: Array<Uint8Array> = [];
  const directory: Array<Uint8Array> = [];
  let offset = 0;

  for (const [path, text] of Object.entries(files)) {
    const name = encoder.encode(path);
    const data = encoder.encode(text);

    const shared = [
      [2, 20],
      [2, utf8Names],
      [2, 0],
      [2, 0],
      [2, 0],
      [4, crc32(data)],
      [4, data.length],
      [4, data.length],
      [2, name.length],
      [2, 0],
    ] as const;

    const local = [record([[4, 0x04034b50], ...shared]), name, data];

    directory.push(
      record([[4, 0x02014b50], [2, 20], ...shared, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]]),
      name,
    );
    body.push(...local);
    offset += local.reduce((total, part) => total + part.length, 0);
  }

  const directorySize = directory.reduce((total, part) => total + part.length, 0);
  const count = Object.keys(files).length;

  const end = record([
    [4, 0x06054b50],
    [2, 0],
    [2, 0],
    [2, count],
    [2, count],
    [4, directorySize],
    [4, offset],
    [2, 0],
  ]);

  const archive = new Uint8Array(offset + directorySize + end.length);
  let at = 0;

  for (const part of [...body, ...directory, end]) {
    archive.set(part, at);
    at += part.length;
  }

  return archive;
}
