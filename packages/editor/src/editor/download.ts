/** Hands the browser a file to save. */
export function download(filename: string, data: BlobPart, type: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([data], { type }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
